const maps = import.meta.glob("../../shared/map.json", { eager: true });
const el = document.getElementById("status")!;

async function probe(url: string): Promise<boolean> {
  try { return (await fetch(url, { method: "HEAD" })).ok; } catch { return false; }
}

function wsProbe(): Promise<boolean> {
  return new Promise((resolve) => {
    const proto = location.protocol === "https:" ? "wss" : "ws";
    let ws: WebSocket;
    try { ws = new WebSocket(`${proto}://${location.host}/ws`); } catch { resolve(false); return; }
    ws.onopen = () => { ws.close(); resolve(true); };
    ws.onerror = () => resolve(false);
  });
}

async function boot() {
  const [wasm, server] = await Promise.all([probe("./sim.wasm"), wsProbe()]);
  const rows = [
    ["Map (shared/map.json)", Object.keys(maps).length > 0],
    ["Sim WASM (sim.wasm)", wasm],
    ["Game server (/ws)", server],
  ] as const;
  el.innerHTML = "<h2>Netcode Lab</h2>" + rows
    .map(([n, ok]) => `<div>${ok ? "✓" : "✗"} ${n}${ok ? "" : " — not available yet"}</div>`)
    .join("");
}
boot();
