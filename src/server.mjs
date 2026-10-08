import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { WebSocket, WebSocketServer } from "ws";
import { readNativeBridgeScript } from "./native-bridge-source.mjs";

const publicDirectory = fileURLToPath(new URL("../public/", import.meta.url));
const MAX_MESSAGE_BYTES = 4096;
const MAX_ROOM_SIZE = 8;
const MAX_INPUTS_PER_SECOND = 120;
const MAX_STATES_PER_SECOND = 30;
const ROOM_PATTERN = /^[a-zA-Z0-9_-]{1,32}$/;
const INPUT_KEYS = new Set(["left", "right", "up", "down", "space", "shift", "ctrl", "z", "accelerate", "brake", "jump", "action"]);
const COLORS = ["#35c9ff", "#ff6f91", "#ffe066", "#a78bfa", "#7ee081", "#ff9f43", "#72ddf7", "#f28482"];

function finiteInRange(value, min, max) {
  return typeof value === "number" && Number.isFinite(value) && value >= min && value <= max;
}

function parseName(value) {
  if (typeof value !== "string") return null;
  const name = value.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 24);
  return name.length ? name : null;
}

function publicPlayer(peer) {
  return {
    id: peer.id,
    name: peer.name,
    color: peer.color,
    characterIndex: peer.characterIndex,
    input: peer.input,
    state: peer.state,
  };
}

function send(ws, value) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(value));
}

function closeWithError(ws, message) {
  send(ws, { type: "error", message });
  ws.close(1008, "invalid multiplayer message");
}

function validSequence(sequence) {
  return Number.isInteger(sequence) && sequence >= 0 && sequence <= 0x7fffffff;
}

function validateInput(message) {
  if (!validSequence(message.seq) || !Array.isArray(message.keys) || message.keys.length > INPUT_KEYS.size) {
    return null;
  }
  const keys = [...new Set(message.keys)];
  if (keys.some((key) => typeof key !== "string" || !INPUT_KEYS.has(key))) return null;
  return { seq: message.seq, keys };
}

function validateAvatar(message) {
  return Number.isInteger(message.characterIndex) && message.characterIndex >= 1 && message.characterIndex <= 11
    ? message.characterIndex
    : null;
}

function validateState(message) {
  if (!validSequence(message.seq)) return null;
  const state = message.state;
  if (!state || typeof state !== "object" || Array.isArray(state)) return null;
  if (!finiteInRange(state.x, -100000, 100000) || !finiteInRange(state.y, -100000, 100000)) return null;
  if (!finiteInRange(state.vx, -10000, 10000) || !finiteInRange(state.vy, -10000, 10000)) return null;
  if (!finiteInRange(state.rotation, -1000, 1000) || typeof state.alive !== "boolean") return null;
  return {
    seq: message.seq,
    state: {
      x: state.x,
      y: state.y,
      vx: state.vx,
      vy: state.vy,
      rotation: state.rotation,
      alive: state.alive,
    },
  };
}

export function createMultiplayerServer() {
  const connections = new Map();
  const rooms = new Map();
  let nextColor = 0;

  const httpServer = createServer(async (request, response) => {
    const pathname = new URL(request.url ?? "/", "http://localhost").pathname;
    const assets = new Map([
      ["/", ["index.html", "text/html; charset=utf-8"]],
      ["/client.js", ["client.js", "text/javascript; charset=utf-8"]],
    ]);

    if (request.method !== "GET") {
      response.writeHead(405, { "content-type": "text/plain; charset=utf-8", allow: "GET" });
      response.end("Method not allowed\n");
      return;
    }
    if (pathname === "/health") {
      response.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
      response.end(JSON.stringify({ ok: true, rooms: rooms.size, clients: connections.size }));
      return;
    }

    if (pathname === "/native-bridge.js") {
      try {
        const script = await readNativeBridgeScript();
        response.writeHead(200, {
          "content-type": "text/javascript; charset=utf-8",
          "cache-control": "no-store",
          "access-control-allow-origin": "https://totaljerkface.com",
        });
        response.end(script);
      } catch {
        response.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
        response.end("Could not read the local native bridge\n");
      }
      return;
    }
    const asset = assets.get(pathname);
    if (!asset) {
      response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      response.end("Not found\n");
      return;
    }
    try {
      const body = await readFile(path.join(publicDirectory, asset[0]));
      response.writeHead(200, {
        "content-type": asset[1],
        "cache-control": "no-cache",
        "x-content-type-options": "nosniff",
        "content-security-policy": "default-src 'self'; connect-src 'self' ws: wss:; style-src 'self' 'unsafe-inline'; script-src 'self'",
      });
      response.end(body);
    } catch {
      response.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
      response.end("Could not read the multiplayer client\n");
    }
  });

  const webSocketServer = new WebSocketServer({
    noServer: true,
    maxPayload: MAX_MESSAGE_BYTES,
    perMessageDeflate: false,
  });

  function broadcast(room, message, except = null) {
    const members = rooms.get(room);
    if (!members) return;
    const encoded = JSON.stringify(message);
    for (const peer of members.values()) {
      if (peer.ws !== except && peer.ws.readyState === WebSocket.OPEN) peer.ws.send(encoded);
    }
  }

  function detach(ws) {
    const connection = connections.get(ws);
    if (!connection) return;
    clearTimeout(connection.joinTimer);
    connections.delete(ws);
    const peer = connection.peer;
    if (!peer) return;
    const members = rooms.get(peer.room);
    members?.delete(peer.id);
    console.log(`[${peer.room}] ${peer.name} left (${members?.size ?? 0}/${MAX_ROOM_SIZE})`);
    broadcast(peer.room, { type: "left", playerId: peer.id });
    if (members?.size === 0) rooms.delete(peer.room);
  }

  function join(ws, connection, message) {
    if (message.type !== "join") return closeWithError(ws, "Join a room before sending other messages.");
    const room = typeof message.room === "string" ? message.room.trim() : "";
    const name = parseName(message.name);
    if (!ROOM_PATTERN.test(room)) return closeWithError(ws, "Room names must be 1-32 letters, numbers, hyphens, or underscores.");
    if (!name) return closeWithError(ws, "Choose a display name.");

    let members = rooms.get(room);
    if (!members) {
      members = new Map();
      rooms.set(room, members);
    }
    if (members.size >= MAX_ROOM_SIZE) return closeWithError(ws, `This room is full (maximum ${MAX_ROOM_SIZE} players).`);

    clearTimeout(connection.joinTimer);
    const peer = {
      ws,
      id: randomUUID(),
      room,
      name,
      color: COLORS[nextColor++ % COLORS.length],
      characterIndex: 1,
      input: { seq: 0, keys: [] },
      state: { x: 80, y: 0, vx: 0, vy: 0, rotation: 0, alive: true },
      lastInputAt: 0,
      lastStateAt: 0,
      lastInputSeq: -1,
      lastStateSeq: -1,
    };
    connection.peer = peer;
    members.set(peer.id, peer);
    console.log(`[${room}] ${name} joined (${members.size}/${MAX_ROOM_SIZE})`);
    send(ws, {
      type: "welcome",
      self: publicPlayer(peer),
      peers: [...members.values()].filter((other) => other !== peer).map(publicPlayer),
      room,
      serverTime: Date.now(),
    });
    broadcast(room, { type: "joined", player: publicPlayer(peer) }, ws);
  }

  function receive(ws, connection, bytes) {
    let message;
    try {
      message = JSON.parse(bytes.toString("utf8"));
    } catch {
      return closeWithError(ws, "Messages must be valid JSON.");
    }
    if (!message || typeof message !== "object" || Array.isArray(message) || typeof message.type !== "string") {
      return closeWithError(ws, "Message must be a JSON object with a type.");
    }
    if (!connection.peer) return join(ws, connection, message);
    if (message.type === "ping") return send(ws, { type: "pong", clientTime: message.clientTime ?? null, serverTime: Date.now() });
    if (message.type === "join") return closeWithError(ws, "This connection has already joined a room.");

    const peer = connection.peer;
    if (message.type === "avatar") {
      const characterIndex = validateAvatar(message);
      if (characterIndex === null) return closeWithError(ws, "Invalid avatar selection.");
      if (characterIndex === peer.characterIndex) return;
      peer.characterIndex = characterIndex;
      broadcast(peer.room, { type: "avatar", playerId: peer.id, characterIndex }, ws);
      return;
    }
    if (message.type === "input") {
      const input = validateInput(message);
      if (!input) return closeWithError(ws, "Invalid input state.");
      if (input.seq <= peer.lastInputSeq) return;
      const now = Date.now();
      if (now - peer.lastInputAt < 1000 / MAX_INPUTS_PER_SECOND) return;
      peer.lastInputAt = now;
      peer.lastInputSeq = input.seq;
      peer.input = input;
      console.log(`[${peer.room}] ${peer.name} input: ${input.keys.join(", ") || "released all"}`);
      broadcast(peer.room, { type: "input", playerId: peer.id, input, serverTime: now }, ws);
      return;
    }
    if (message.type === "state") {
      const update = validateState(message);
      if (!update) return closeWithError(ws, "Invalid racer state.");
      if (update.seq <= peer.lastStateSeq) return;
      const now = Date.now();
      if (now - peer.lastStateAt < 1000 / MAX_STATES_PER_SECOND) return;
      peer.lastStateAt = now;
      peer.lastStateSeq = update.seq;
      peer.state = update.state;
      broadcast(peer.room, {
        type: "state",
        playerId: peer.id,
        state: update.state,
        serverTime: now,
      }, ws);
      return;
    }
    closeWithError(ws, `Unsupported message type: ${message.type.slice(0, 32)}.`);
  }

  httpServer.on("upgrade", (request, socket, head) => {
    const pathname = new URL(request.url ?? "/", "http://localhost").pathname;
    if (pathname !== "/ws") {
      socket.write("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    webSocketServer.handleUpgrade(request, socket, head, (ws) => webSocketServer.emit("connection", ws, request));
  });

  webSocketServer.on("connection", (ws) => {
    const connection = {
      peer: null,
      joinTimer: setTimeout(() => closeWithError(ws, "Join a room within five seconds."), 5000),
    };
    connections.set(ws, connection);
    ws.on("message", (bytes) => receive(ws, connection, bytes));
    ws.on("close", () => detach(ws));
    ws.on("error", () => detach(ws));
  });

  function listen({ host = "0.0.0.0", port = 8765 } = {}) {
    return new Promise((resolve, reject) => {
      const onError = (error) => reject(error);
      httpServer.once("error", onError);
      httpServer.listen(port, host, () => {
        httpServer.off("error", onError);
        resolve(httpServer.address());
      });
    });
  }

  function close() {
    for (const ws of webSocketServer.clients) ws.terminate();
    return new Promise((resolve, reject) => {
      if (!httpServer.listening) return resolve();
      webSocketServer.close(() => {
        httpServer.close((error) => error ? reject(error) : resolve());
      });
    });
  }

  return { httpServer, webSocketServer, listen, close };
}

function readOption(args, name, fallback) {
  const prefix = `${name}=`;
  const equals = args.find((arg) => arg.startsWith(prefix));
  if (equals) return equals.slice(prefix.length);
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : fallback;
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    console.log("Usage: node src/server.mjs [--host HOST] [--port PORT]");
    process.exit(0);
  }
  const host = readOption(args, "--host", process.env.HOST ?? process.env.HW_MP_HOST ?? "0.0.0.0");
  const portValue = readOption(args, "--port", process.env.PORT ?? process.env.HW_MP_PORT ?? "8765");
  const port = Number(portValue);
  if (!host || !Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error("Host must be non-empty and port must be between 0 and 65535.");
  }

  const app = createMultiplayerServer();
  const address = await app.listen({ host, port });
  console.log("Happy Wheels multiplayer relay listening at http://" + address.address + ":" + address.port);
  console.log("LAN mode has no account or encryption; use it only on a network you trust.");
  const shutdown = async () => {
    await app.close();
    process.exit(0);
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
