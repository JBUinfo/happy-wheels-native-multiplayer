import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";

function sliceBetween(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start);
  if (start < 0 || end < 0) throw new Error("Native bridge source boundaries are missing.");
  return source.slice(start, end).trim();
}

export async function readNativeBridgeScript() {
  const source = await readFile(new URL("./game-overlay-preload.js", import.meta.url), "utf8");
  const findQueue = sliceBetween(source, "function findWebpackQueue()", "function installNativeBridge(webpackRequire)");
  const factory = sliceBetween(source, "function installNativeBridge(webpackRequire)", "const nativeBridgeProbe =");
  const revision = createHash("sha256").update(findQueue + factory).digest("hex").slice(0, 12);
  return `(() => {
    const queue = (${findQueue})();
    if (!queue) throw new Error('El runtime todavía no está listo.');
    let result;
    queue.push([['hw-lan-${revision}-' + Date.now()], {}, (webpackRequire) => {
      const next = (${factory})(webpackRequire);
      window.__HW_LAN_NATIVE_BRIDGE__?.dispose?.();
      window.__HW_LAN_NATIVE_BRIDGE__ = next;
      result = { ok: true, revision: '${revision}' };
    }]);
    if (!result) throw new Error('El runtime no ejecutó la recarga del puente.');
    return result;
  })()`;
}
