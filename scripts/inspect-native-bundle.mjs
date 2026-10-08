import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";

// Read-only inspection of the user's installed bundle; no game assets are copied.
const gameDirectory = process.env.HAPPY_WHEELS_DIR || path.join(os.homedir(), ".local/share/Steam/steamapps/common/Happy Wheels");
const source = fs.readFileSync(path.join(gameDirectory, "resources/webroot/js/index.js"), "utf8");
const sandbox = {
  console, TextDecoder, TextEncoder,
  setTimeout: () => 0, setInterval: () => 0, clearTimeout() {}, clearInterval() {},
  navigator: { userAgent: "Chrome", platform: "Linux" },
  location: { hostname: "totaljerkface.com", href: "https://totaljerkface.com/__hw_app__/index.html" },
  document: {},
  atob: (value) => Buffer.from(value, "base64").toString("binary"),
  btoa: (value) => Buffer.from(value, "binary").toString("base64"),
};
sandbox.window = sandbox;
sandbox.self = sandbox;
const context = vm.createContext(sandbox);
let payload = "";
let constructors = 0;
sandbox.Function = function (...args) {
  const body = args.pop();
  if (++constructors === 2) {
    payload = body;
    throw new Error("Payload captured before game initialization");
  }
  return vm.runInContext(`(function(${args.join(",")}){${body}})`, context, { timeout: 15000 });
};
try { vm.runInContext(source, context, { timeout: 15000 }); } catch (error) {
  if (!payload) throw error;
}
if (!payload) throw new Error("The installed bundle format was not recognized.");

function functionEnd(text, start) {
  let depth = 0;
  let quote = null;
  let escaped = false;
  for (let i = text.indexOf("{", start); i < text.length; i++) {
    const char = text[i];
    if (quote) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === "'" || char === '"' || char === "`") quote = char;
    else if (char === "{") depth++;
    else if (char === "}" && --depth === 0) return i + 1;
  }
  throw new Error("Unterminated decoder function");
}
// The obfuscator renames its decoder and string table on every game build.
const decoderMatch = payload.match(/function ([\w$]+)\([\w$]+,[\w$]+\)\{[\w$]+=[\w$]+-0x[\da-f]+;var [\w$]+=([\w$]+)\(\);/i);
if (!decoderMatch) throw new Error("Unknown string decoder layout");
const [, decoderName, tableName] = decoderMatch;
const tableStart = payload.indexOf(`function ${tableName}()`);
const rotation = payload.match(new RegExp(`\\(function\\([\\w$]+,[\\w$]+\\)\\{var [^;]*?=${decoderName.replace(/\$/g, "\\$")}[\\s\\S]*?\\}\\(${tableName.replace(/\$/g, "\\$")},0x[\\da-f]+\\)\\);`));
if (tableStart < 0 || !rotation) throw new Error("Unknown string decoder layout");
const tableSource = payload.slice(tableStart, functionEnd(payload, tableStart));
const decoderSource = payload.slice(decoderMatch.index, functionEnd(payload, decoderMatch.index));
const decoderContext = vm.createContext({});
vm.runInContext(decoderSource + tableSource + rotation[0], decoderContext, { timeout: 10000 });
const decode = decoderContext[decoderName];
const aliases = new Set([decoderName]);
const assignments = [...payload.matchAll(/\b([\w$]+)\s*=\s*([\w$]+)\b/g)];
for (let i = 0; i < 12; i++) {
  const previousSize = aliases.size;
  for (const match of assignments) if (aliases.has(match[2])) aliases.add(match[1]);
  if (aliases.size === previousSize) break;
}
const dictionaries = new Map();
for (const match of payload.matchAll(/\b([\w$]+)\s*=\s*\{([^{}]+)\}/g)) {
  for (const pair of match[2].matchAll(/\b([\w$]+)\s*:\s*(0x[\da-f]+)/gi)) dictionaries.set(`${match[1]}.${pair[1]}`, Number(pair[2]));
}
let readable = payload.replace(/\b([\w$]+)\(\s*(0x[\da-f]+|[\w$]+\.[\w$]+)\s*\)/gi, (full, name, argument) => {
  if (!aliases.has(name)) return full;
  const index = argument.startsWith("0x") ? Number(argument) : dictionaries.get(argument);
  const value = index === undefined ? undefined : decode(index);
  return typeof value === "string" ? JSON.stringify(value) : full;
});
const concatenation = /("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')\s*\+\s*("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')/g;
for (let i = 0; i < 5; i++) {
  const next = readable.replace(concatenation, (full, left, right) => {
    const literal = (text) => text[0] === '"' ? JSON.parse(text) : Function(`return (${text})`)();
    return JSON.stringify(literal(left) + literal(right));
  });
  if (next === readable) break;
  readable = next;
}
const argumentsList = process.argv.slice(2);
const scope = argumentsList.find((argument) => argument.startsWith("--scope="))?.slice(8);
const limit = Number(argumentsList.find((argument) => argument.startsWith("--limit="))?.slice(8) ?? 3);
const span = Number(argumentsList.find((argument) => argument.startsWith("--span="))?.slice(7) ?? 2100);
const from = Number(argumentsList.find((argument) => argument.startsWith("--from="))?.slice(7) ?? 0);
const terms = argumentsList.filter((argument) => !argument.startsWith("--"));
const decodedTableStart = readable.indexOf(`function ${tableName}()`);
if (decodedTableStart >= 0) readable = readable.slice(0, decodedTableStart) + readable.slice(functionEnd(readable, decodedTableStart));
if (scope) {
  const start = readable.indexOf(`var ${scope}=function(`);
  if (start < 0) throw new Error(`No class scope ${scope}`);
  readable = readable.slice(start, functionEnd(readable, start));
}
readable = readable.slice(from);
for (const term of terms.length ? terms : ["loadLevelByID", "openLoadLevelMenu", "initSettingsAndEnterSession", "enterSession"]) {
  let offset = -1;
  let count = 0;
  while ((offset = readable.indexOf(term, offset + 1)) >= 0 && count++ < limit) {
    console.log(`\n${term} @ ${offset + from}\n${readable.slice(Math.max(0, offset - 120), offset + span)}`);
  }
  if (!count) console.log(`${term}: no match in decoded literals`);
}
