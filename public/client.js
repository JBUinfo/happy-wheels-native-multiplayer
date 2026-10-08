const form = document.querySelector("#connect-form");
const relayInput = document.querySelector("#server");
const roomInput = document.querySelector("#room");
const nameInput = document.querySelector("#name");
const connectButton = document.querySelector("#connect");
const disconnectButton = document.querySelector("#disconnect");
const statusOutput = document.querySelector("#status");
const playersOutput = document.querySelector("#players");
const canvas = document.querySelector("#track");
const context = canvas.getContext("2d");

const groundY = 410;
const racers = new Map();
const heldKeys = new Set();
const keyMap = new Map([
  ["ArrowLeft", "left"], ["a", "left"], ["ArrowRight", "right"], ["d", "right"],
  ["ArrowUp", "accelerate"], ["w", "accelerate"], ["ArrowDown", "brake"], ["s", "brake"], [" ", "action"],
]);

let socket = null;
let localId = null;
let inputSequence = 0;
let stateSequence = 0;
let lastFrame = performance.now();
let lastStateSent = 0;
let cameraX = 0;

function setStatus(text, online = false) {
  statusOutput.value = text;
  statusOutput.dataset.online = String(online);
}

function resizeCanvas() {
  const bounds = canvas.getBoundingClientRect();
  const ratio = Math.max(1, window.devicePixelRatio || 1);
  canvas.width = Math.round(bounds.width * ratio);
  canvas.height = Math.round(bounds.height * ratio);
  context.setTransform(ratio, 0, 0, ratio, 0, 0);
}

function createRacer(player, isLocal = false) {
  return {
    id: player.id,
    name: player.name,
    color: player.color,
    isLocal,
    input: { seq: -1, keys: [] },
    state: player.state ?? { x: 80, y: 0, vx: 0, vy: 0, rotation: 0, alive: true },
    jumpWasDown: false,
  };
}

function updatePlayerList() {
  playersOutput.replaceChildren();
  for (const racer of racers.values()) {
    const badge = document.createElement("span");
    badge.className = "player";
    const swatch = document.createElement("span");
    swatch.className = "swatch";
    swatch.style.backgroundColor = racer.color;
    badge.append(swatch, document.createTextNode(`${racer.name}${racer.isLocal ? " · you" : ""}`));
    playersOutput.append(badge);
  }
}

function send(message) {
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
}

function mappedKeys() {
  return [...heldKeys];
}

function sendInput() {
  send({ type: "input", seq: inputSequence++, keys: mappedKeys() });
}

function joinSocket() {
  const room = roomInput.value.trim();
  const name = nameInput.value.trim();
  if (!/^[a-zA-Z0-9_-]{1,32}$/.test(room)) {
    setStatus("Room: use 1–32 letters, numbers, _ or -");
    return;
  }
  if (!name) {
    setStatus("Enter a player name");
    return;
  }

  const entered = relayInput.value.trim();
  const relay = entered || `${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}`;
  const url = new URL(relay);
  url.pathname = "/ws";
  url.search = "";
  url.hash = "";
  if (url.protocol !== "ws:" && url.protocol !== "wss:") {
    setStatus("Relay URL must start with ws:// or wss://");
    return;
  }

  socket?.close();
  racers.clear();
  localId = null;
  setStatus("Connecting…");
  socket = new WebSocket(url);
  socket.addEventListener("open", () => {
    socket.send(JSON.stringify({ type: "join", room, name }));
  });
  socket.addEventListener("message", ({ data }) => {
    let message;
    try { message = JSON.parse(data); } catch { return; }
    if (message.type === "welcome") {
      localId = message.self.id;
      racers.set(localId, createRacer(message.self, true));
      for (const peer of message.peers) racers.set(peer.id, createRacer(peer));
      setStatus(`Connected · room ${message.room}`, true);
      connectButton.disabled = true;
      disconnectButton.disabled = false;
      sendInput();
      updatePlayerList();
      return;
    }
    if (message.type === "joined") {
      racers.set(message.player.id, createRacer(message.player));
      updatePlayerList();
      return;
    }
    if (message.type === "left") {
      racers.delete(message.playerId);
      updatePlayerList();
      return;
    }
    if (message.type === "input") {
      const racer = racers.get(message.playerId);
      if (racer && message.input.seq > racer.input.seq) racer.input = message.input;
      return;
    }
    if (message.type === "state") {
      const racer = racers.get(message.playerId);
      if (racer) racer.state = message.state;
      return;
    }
    if (message.type === "error") setStatus(message.message);
  });
  socket.addEventListener("close", () => {
    racers.clear();
    localId = null;
    connectButton.disabled = false;
    disconnectButton.disabled = true;
    updatePlayerList();
    setStatus("Disconnected");
  });
  socket.addEventListener("error", () => setStatus("Relay connection failed"));
}

function disconnect() {
  socket?.close(1000, "player disconnected");
  socket = null;
  heldKeys.clear();
}

function updateLocalRacer(dt) {
  const racer = racers.get(localId);
  if (!racer) return;
  const state = racer.state;
  const steering = Number(heldKeys.has("right")) - Number(heldKeys.has("left"));
  const throttle = Number(heldKeys.has("accelerate")) - Number(heldKeys.has("brake")) * 0.8;
  const actionDown = heldKeys.has("action");
  const onGround = state.y >= 0;

  state.vx += throttle * 520 * dt;
  if (heldKeys.has("brake")) state.vx *= Math.pow(0.03, dt);
  else state.vx *= Math.pow(0.76, dt);
  state.vx = Math.max(-240, Math.min(700, state.vx));
  if (actionDown && !racer.jumpWasDown && onGround) state.vy = -300;
  racer.jumpWasDown = actionDown;

  state.vy += 850 * dt;
  state.x = Math.max(0, state.x + state.vx * dt);
  state.y += state.vy * dt;
  if (state.y > 0) {
    state.y = 0;
    state.vy = 0;
  }
  state.rotation = Math.max(-0.7, Math.min(0.7, steering * 0.35 + state.vx / 700 * 0.2));
  state.alive = true;
}

function drawRacer(racer, x, y, alpha = 1) {
  const state = racer.state;
  context.save();
  context.globalAlpha = alpha;
  context.translate(x, y + state.y);
  context.rotate(state.rotation);
  context.strokeStyle = racer.color;
  context.fillStyle = racer.color;
  context.lineWidth = 4;
  context.beginPath();
  context.arc(-17, -5, 10, 0, Math.PI * 2);
  context.arc(18, -5, 10, 0, Math.PI * 2);
  context.stroke();
  context.beginPath();
  context.moveTo(-17, -5);
  context.lineTo(-2, -21);
  context.lineTo(18, -5);
  context.lineTo(4, -5);
  context.lineTo(-17, -5);
  context.lineTo(-2, -21);
  context.lineTo(2, -32);
  context.stroke();
  context.beginPath();
  context.arc(2, -41, 6, 0, Math.PI * 2);
  context.fill();
  context.beginPath();
  context.moveTo(1, -34);
  context.lineTo(-3, -20);
  context.lineTo(6, -13);
  context.stroke();
  context.restore();

  context.save();
  context.globalAlpha = alpha;
  context.fillStyle = "#172033";
  context.font = "12px system-ui, sans-serif";
  context.textAlign = "center";
  context.fillText(racer.isLocal ? `${racer.name} · you` : `${racer.name} · ghost`, x, y - 57 + state.y);
  context.restore();
}

function render(now) {
  const bounds = canvas.getBoundingClientRect();
  const width = bounds.width;
  const height = bounds.height;
  const dt = Math.min(0.05, Math.max(0, (now - lastFrame) / 1000));
  lastFrame = now;
  updateLocalRacer(dt);

  const local = racers.get(localId);
  if (local) {
    cameraX = Math.max(0, local.state.x - width * 0.32);
    if (socket?.readyState === WebSocket.OPEN && now - lastStateSent >= 50) {
      send({ type: "state", seq: stateSequence++, state: { ...local.state } });
      lastStateSent = now;
    }
  }

  context.clearRect(0, 0, width, height);
  const sky = context.createLinearGradient(0, 0, 0, height);
  sky.addColorStop(0, "#b9def7");
  sky.addColorStop(1, "#eef7fd");
  context.fillStyle = sky;
  context.fillRect(0, 0, width, height);
  context.fillStyle = "#7fb46b";
  context.fillRect(0, groundY, width, height - groundY);
  context.fillStyle = "#607c52";
  context.fillRect(0, groundY, width, 8);

  const firstMark = Math.floor(cameraX / 200) * 200;
  context.strokeStyle = "rgba(31, 55, 70, .18)";
  context.fillStyle = "rgba(31, 55, 70, .65)";
  context.font = "11px system-ui, sans-serif";
  for (let mark = firstMark; mark < cameraX + width + 200; mark += 200) {
    const sx = mark - cameraX;
    context.beginPath();
    context.moveTo(sx, groundY);
    context.lineTo(sx, groundY + 13);
    context.stroke();
    context.fillText(`${mark}m`, sx + 3, groundY + 28);
  }

  for (const racer of racers.values()) {
    const screenX = racer.state.x - cameraX;
    if (screenX < -60 || screenX > width + 60) continue;
    const alpha = racer.isLocal ? 1 : 0.58;
    drawRacer(racer, screenX, groundY, alpha);
  }
  requestAnimationFrame(render);
}

form.addEventListener("submit", (event) => {
  event.preventDefault();
  joinSocket();
});
disconnectButton.addEventListener("click", disconnect);
window.addEventListener("resize", resizeCanvas);
window.addEventListener("keydown", (event) => {
  if (document.activeElement instanceof HTMLInputElement) return;
  const key = keyMap.get(event.key.length === 1 ? event.key.toLowerCase() : event.key) ?? keyMap.get(event.code);
  if (!key || heldKeys.has(key)) return;
  event.preventDefault();
  heldKeys.add(key);
  sendInput();
});
window.addEventListener("keyup", (event) => {
  const key = keyMap.get(event.key.length === 1 ? event.key.toLowerCase() : event.key) ?? keyMap.get(event.code);
  if (!key || !heldKeys.delete(key)) return;
  event.preventDefault();
  sendInput();
});
window.addEventListener("blur", () => {
  if (heldKeys.size) {
    heldKeys.clear();
    sendInput();
  }
});

relayInput.value = "";
resizeCanvas();
requestAnimationFrame(render);
