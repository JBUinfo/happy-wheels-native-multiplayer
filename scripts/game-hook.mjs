import { createHash } from "node:crypto";
import { copyFile, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { spawn } from "node:child_process";

const projectDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const hookPath = path.join(projectDirectory, "src", "game-overlay-preload.js");
const gameDirectory = path.resolve(process.env.HAPPY_WHEELS_DIR || path.join(
  os.homedir(), ".local", "share", "Steam", "steamapps", "common", "Happy Wheels",
));
const resourcesDirectory = path.join(gameDirectory, "resources");
const archivePath = path.join(resourcesDirectory, "app.asar");
const backupPath = path.join(resourcesDirectory, "app.asar.happy-wheels-lan.backup");
const marker = "/* HAPPY_WHEELS_LAN_PRELOAD */";

function parseArchive(archive) {
  if (archive.length < 16) throw new Error("The app.asar file is too short to be valid.");
  const headerPickleSize = archive.readUInt32LE(4);
  const headerStringSize = archive.readUInt32LE(12);
  const bodyOffset = 8 + headerPickleSize;
  const headerEnd = 16 + headerStringSize;
  if (bodyOffset > archive.length || headerEnd > bodyOffset) throw new Error("The app.asar header is invalid.");
  const header = JSON.parse(archive.toString("utf8", 16, headerEnd));
  return { header, bodyOffset };
}

function findFile(header, targetPath) {
  let current = header;
  for (const part of targetPath.split("/")) {
    current = current?.files?.[part];
    if (!current) return null;
  }
  return current;
}

function listPackedFiles(header) {
  const files = [];
  function visit(directory, prefix = "") {
    for (const [name, entry] of Object.entries(directory.files ?? {})) {
      const relativePath = prefix ? `${prefix}/${name}` : name;
      if (entry.files) visit(entry, relativePath);
      else if (!entry.unpacked && !entry.link && entry.offset !== undefined) files.push({ relativePath, entry });
    }
  }
  visit(header);
  return files;
}

function updateIntegrity(entry, contents) {
  const blockSize = 4 * 1024 * 1024;
  const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
  const blocks = [];
  for (let offset = 0; offset < contents.length; offset += blockSize) {
    blocks.push(hash(contents.subarray(offset, Math.min(contents.length, offset + blockSize))));
  }
  entry.integrity = { algorithm: "SHA256", hash: hash(contents), blockSize, blocks };
}

function buildArchive(original, replacements) {
  const { header, bodyOffset } = parseArchive(original);
  const packedFiles = listPackedFiles(header).sort((left, right) => Number(left.entry.offset) - Number(right.entry.offset));
  const bodyChunks = [];
  let sourceCursor = 0;
  let outputCursor = 0;

  for (const file of packedFiles) {
    const oldOffset = Number(file.entry.offset);
    const oldSize = Number(file.entry.size);
    if (!Number.isSafeInteger(oldOffset) || !Number.isSafeInteger(oldSize) || oldOffset < sourceCursor) {
      throw new Error(`Invalid ASAR range for ${file.relativePath}.`);
    }
    if (oldOffset > sourceCursor) {
      const gap = original.subarray(bodyOffset + sourceCursor, bodyOffset + oldOffset);
      bodyChunks.push(gap);
      outputCursor += gap.length;
    }
    const originalContents = original.subarray(bodyOffset + oldOffset, bodyOffset + oldOffset + oldSize);
    if (originalContents.length !== oldSize) throw new Error(`ASAR content is truncated for ${file.relativePath}.`);
    const contents = replacements.get(file.relativePath) ?? originalContents;
    file.entry.offset = String(outputCursor);
    file.entry.size = contents.length;
    if (replacements.has(file.relativePath)) updateIntegrity(file.entry, contents);
    bodyChunks.push(contents);
    outputCursor += contents.length;
    sourceCursor = oldOffset + oldSize;
  }

  const originalBodyEnd = original.length - bodyOffset;
  if (sourceCursor < originalBodyEnd) {
    const tail = original.subarray(bodyOffset + sourceCursor);
    bodyChunks.push(tail);
    outputCursor += tail.length;
  }

  const json = Buffer.from(JSON.stringify(header), "utf8");
  const paddedLength = Math.ceil(json.length / 4) * 4;
  const headerPickle = Buffer.alloc(8 + paddedLength);
  headerPickle.writeUInt32LE(headerPickle.length - 4, 0);
  headerPickle.writeUInt32LE(json.length, 4);
  json.copy(headerPickle, 8);
  const sizePickle = Buffer.alloc(8);
  sizePickle.writeUInt32LE(4, 0);
  sizePickle.writeUInt32LE(headerPickle.length, 4);
  const result = Buffer.concat([sizePickle, headerPickle, ...bodyChunks]);
  const checked = parseArchive(result);
  const preload = findFile(checked.header, "electron/out/preload.js");
  if (!preload) throw new Error("The repacked ASAR is missing electron/out/preload.js.");
  const offset = checked.bodyOffset + Number(preload.offset);
  const extracted = result.subarray(offset, offset + preload.size).toString("utf8");
  if (!extracted.includes(marker)) throw new Error("The repacked ASAR did not retain the LAN preload hook.");
  return result;
}

async function readInstalledPreload(archive) {
  const { header, bodyOffset } = parseArchive(archive);
  const entry = findFile(header, "electron/out/preload.js");
  if (!entry || entry.unpacked) throw new Error("Could not find the packed Happy Wheels preload script.");
  const offset = bodyOffset + Number(entry.offset);
  const contents = archive.subarray(offset, offset + Number(entry.size));
  if (contents.length !== Number(entry.size)) throw new Error("The Happy Wheels preload script is truncated.");
  return contents.toString("utf8");
}

async function installHook() {
  const original = await readFile(archivePath);
  if ((await readInstalledPreload(original)).includes(marker)) throw new Error("The LAN hook is already installed.");
  const hook = await readFile(hookPath, "utf8");
  const existing = await readInstalledPreload(original);
  const patchedPreload = Buffer.from(`${existing}\n\n${marker}\n${hook}\n`, "utf8");
  const patched = buildArchive(original, new Map([["electron/out/preload.js", patchedPreload]]));
  const temporaryPath = `${archivePath}.happy-wheels-lan.${process.pid}.tmp`;

  await copyFile(archivePath, backupPath, 1);
  try {
    await writeFile(temporaryPath, patched, { flag: "wx", mode: 0o644 });
    await rename(temporaryPath, archivePath);
    console.log(`Installed a temporary game hook. Original archive backup: ${backupPath}`);
  } catch (error) {
    await rm(temporaryPath, { force: true });
    await rm(backupPath, { force: true });
    throw error;
  }
}

async function refreshHook() {
  const running = await gamePids();
  if (!running.length) throw new Error("Start Happy Wheels through game:launch before refreshing the hook.");

  const backup = await readFile(backupPath);
  const current = await readFile(archivePath);
  if (!(await readInstalledPreload(current)).includes(marker)) {
    throw new Error("The running game archive does not contain the temporary LAN hook.");
  }
  const originalPreload = await readInstalledPreload(backup);
  if (originalPreload.includes(marker)) throw new Error("The saved app.asar backup is not the original archive.");

  const hook = await readFile(hookPath, "utf8");
  const patchedPreload = Buffer.from(`${originalPreload}\n\n${marker}\n${hook}\n`, "utf8");
  const patched = buildArchive(backup, new Map([["electron/out/preload.js", patchedPreload]]));
  const temporaryPath = `${archivePath}.happy-wheels-lan.refresh.${process.pid}.tmp`;
  await writeFile(temporaryPath, patched, { flag: "wx", mode: 0o644 });
  await rename(temporaryPath, archivePath);
  console.log("Refreshed the temporary preload. Reload the current game page to apply it.");
}

async function restoreArchive({ force = false } = {}) {
  if (!force) {
    const running = await gamePids();
    if (running.length) throw new Error(`Close Happy Wheels before restoring its archive (PID ${running.join(", ")}).`);
  }
  let backup;
  try { backup = await readFile(backupPath); } catch (error) {
    if (error.code === "ENOENT") {
      console.log("No Happy Wheels backup is present; nothing to restore.");
      return false;
    }
    throw error;
  }
  parseArchive(backup);
  const temporaryPath = `${archivePath}.happy-wheels-lan.${process.pid}.restore`;
  await writeFile(temporaryPath, backup, { flag: "wx", mode: 0o644 });
  await rename(temporaryPath, archivePath);
  await rm(backupPath, { force: true });
  console.log("Restored the original Happy Wheels app.asar.");
  return true;
}

async function gamePids() {
  const entries = await readdir("/proc", { withFileTypes: true });
  const pids = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^\d+$/.test(entry.name)) continue;
    try {
      const cmdline = await readFile(`/proc/${entry.name}/cmdline`, "utf8");
      if (cmdline.includes(path.join(gameDirectory, "happy-wheels-bin"))) pids.push(Number(entry.name));
    } catch {}
  }
  return pids;
}

async function launchThroughSteam() {
  const running = await gamePids();
  if (running.length) throw new Error(`Happy Wheels is already running (PID ${running.join(", ")}). Close it first.`);

  await installHook();
  let restoring = false;
  const restoreOnce = async () => {
    if (restoring) return;
    restoring = true;
    await restoreArchive({ force: true });
  };
  const onSignal = (signal) => {
    console.log(`\nReceived ${signal}; restoring the original archive.`);
    void restoreOnce().finally(() => process.exit(signal === "SIGINT" ? 130 : 143));
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);

  try {
    console.log("Launching Happy Wheels through Steam. Keep this terminal open; it restores app.asar when the game closes.");
    const steam = spawn("steam", ["-applaunch", "4705510"], { cwd: gameDirectory, stdio: "inherit" });
    const launched = Date.now();
    let started = false;
    while (Date.now() - launched < 90_000) {
      if (steam.exitCode !== null && steam.exitCode !== 0 && !started) {
        throw new Error(`Steam launch exited with code ${steam.exitCode}.`);
      }
      const pids = await gamePids();
      if (pids.length) {
        started = true;
        break;
      }
      await delay(500);
    }
    if (!started) throw new Error("Happy Wheels did not start within 90 seconds; the original archive will be restored.");
    console.log("Happy Wheels is running with the LAN overlay. Close the game to restore its original archive.");
    while ((await gamePids()).length) await delay(700);
  } finally {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
    await restoreOnce();
  }
}

async function status() {
  const backupExists = await readFile(backupPath).then(() => true, () => false);
  const archive = await readFile(archivePath);
  const patched = (await readInstalledPreload(archive)).includes(marker);
  console.log(JSON.stringify({ gameDirectory, patched, backupExists }, null, 2));
}

const command = process.argv[2] ?? "launch";
try {
  if (command === "launch") await launchThroughSteam();
  else if (command === "restore") await restoreArchive();
  else if (command === "status") await status();
  else if (command === "refresh") await refreshHook();
  else throw new Error("Usage: node scripts/game-hook.mjs [launch|restore|status|refresh]");
} catch (error) {
  if (await readFile(backupPath).then(() => true, () => false)) {
    try { await restoreArchive({ force: true }); } catch (restoreError) {
      console.error(`Automatic restore failed: ${restoreError.message}`);
      console.error(`The original archive remains at ${backupPath}. Run npm run game:restore after closing Happy Wheels.`);
    }
  }
  console.error(error.message);
  process.exitCode = 1;
}
