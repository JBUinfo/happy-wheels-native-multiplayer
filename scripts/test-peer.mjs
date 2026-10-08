import { WebSocket } from "ws";

// Simulated room member for manual validation on one computer. It joins the
// room, announces a character and replays a simple key script in a loop.
// Usage: node scripts/test-peer.mjs [--name Bot] [--character 3] [--room happy-wheels]
//   [--server ws://127.0.0.1:8765/ws] [--script "up:3000,none:2000,left+up:1500"]

function option(name, fallback) {
  const args = process.argv.slice(2);
  const equals = args.find((arg) => arg.startsWith(`--${name}=`));
  if (equals) return equals.slice(name.length + 3);
  const index = args.indexOf(`--${name}`);
  return index >= 0 && args[index + 1] !== undefined ? args[index + 1] : fallback;
}

const server = option("server", "ws://127.0.0.1:8765/ws");
const room = option("room", "happy-wheels");
const name = option("name", `Bot-${process.pid}`);
const characterIndex = Number(option("character", "1"));
const steps = option("script", "up:3000,none:2000").split(",").map((step) => {
  const [keys, duration] = step.split(":");
  return { keys: keys === "none" ? [] : keys.split("+"), duration: Math.max(50, Number(duration) || 1000) };
});

const socket = new WebSocket(server);
let sequence = 0;
let timer = null;

function send(message) {
  if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
}

function play(index) {
  const step = steps[index % steps.length];
  send({ type: "input", seq: sequence++, keys: step.keys });
  console.log(`${name}: ${step.keys.join("+") || "released"} for ${step.duration} ms`);
  timer = setTimeout(() => play(index + 1), step.duration);
}

socket.on("open", () => send({ type: "join", room, name }));
socket.on("message", (bytes) => {
  const message = JSON.parse(bytes.toString("utf8"));
  if (message.type === "welcome") {
    console.log(`${name} joined ${message.room} with ${message.peers.length} other player(s).`);
    if (characterIndex !== 1) send({ type: "avatar", characterIndex });
    play(0);
  } else if (message.type === "error") {
    console.error(`${name}: ${message.message}`);
  }
});
socket.on("close", (code, reason) => {
  clearTimeout(timer);
  console.log(`${name} disconnected (${code}${reason.length ? `: ${reason}` : ""}).`);
  process.exit(0);
});
socket.on("error", (error) => console.error(`${name}: ${error.message}`));

const leave = () => {
  send({ type: "input", seq: sequence++, keys: [] });
  socket.close(1000, "test peer stopped");
};
process.once("SIGINT", leave);
process.once("SIGTERM", leave);
