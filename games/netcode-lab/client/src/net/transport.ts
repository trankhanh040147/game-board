// Game transport: binary hot path + JSON control. WebTransport (datagrams + first bidi stream, NDJSON) when the page
// is a secure context and the server offers it; otherwise WebSocket (binary frames + text frames).

export interface Transport {
  readonly kind: "wt" | "ws";
  sendBinary(b: Uint8Array): void;
  sendControl(msg: object): void;
  onBinary: (b: Uint8Array) => void;
  onControl: (msg: any) => void;
  onClose: (reason: string) => void;
  close(): void;
  bytesUp: number;
  bytesDown: number;
}

export interface ServerInfo { protocolVersion: number; ws: string; wt: { path: string; port: number; certHashBase64: string } | null; secure: boolean; serverTimeMs: number }

export async function fetchInfo(): Promise<ServerInfo> {
  const r = await fetch("./api/info", { cache: "no-store" });
  if (!r.ok) throw new Error(`/api/info: HTTP ${r.status}`);
  return r.json();
}

const noop = () => {};

export class WsTransport implements Transport {
  readonly kind = "ws" as const;
  onBinary: (b: Uint8Array) => void = noop;
  onControl: (msg: any) => void = noop;
  onClose: (reason: string) => void = noop;
  bytesUp = 0;
  bytesDown = 0;
  private constructor(private ws: WebSocket) {
    ws.binaryType = "arraybuffer";
    ws.onmessage = (ev) => {
      if (typeof ev.data === "string") { this.bytesDown += ev.data.length; this.onControl(JSON.parse(ev.data)); }
      else { this.bytesDown += ev.data.byteLength; this.onBinary(new Uint8Array(ev.data)); }
    };
    ws.onclose = (ev) => this.onClose(`WebSocket closed (code ${ev.code}${ev.reason ? ", " + ev.reason : ""})`);
  }
  static connect(path: string): Promise<WsTransport> {
    const proto = location.protocol === "https:" ? "wss" : "ws";
    const ws = new WebSocket(`${proto}://${location.host}${path}`);
    return new Promise((resolve, reject) => {
      ws.onopen = () => resolve(new WsTransport(ws));
      ws.onerror = () => reject(new Error("WebSocket connection failed"));
    });
  }
  sendBinary(b: Uint8Array) { if (this.ws.readyState === 1) { this.ws.send(b); this.bytesUp += b.byteLength; } }
  sendControl(msg: object) { if (this.ws.readyState === 1) { const s = JSON.stringify(msg); this.ws.send(s); this.bytesUp += s.length; } }
  close() { this.ws.close(); }
}

function b64ToBytes(b64: string): Uint8Array {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

export class WtTransport implements Transport {
  readonly kind = "wt" as const;
  onBinary: (b: Uint8Array) => void = noop;
  onControl: (msg: any) => void = noop;
  onClose: (reason: string) => void = noop;
  bytesUp = 0;
  bytesDown = 0;
  private dgWriter: WritableStreamDefaultWriter<Uint8Array>;
  private ctlWriter: WritableStreamDefaultWriter<Uint8Array>;
  private enc = new TextEncoder();
  private closed = false;

  private constructor(private wt: any, stream: any) {
    this.dgWriter = wt.datagrams.writable.getWriter();
    this.ctlWriter = stream.writable.getWriter();
    this.readDatagrams(wt.datagrams.readable.getReader());
    this.readControl(stream.readable.getReader());
    wt.closed.then(() => this.finish("WebTransport closed"), (e: Error) => this.finish(`WebTransport failed: ${e.message}`));
  }

  static async connect(info: ServerInfo): Promise<WtTransport> {
    if (!info.wt) throw new Error("server offers no WebTransport");
    const url = `https://${location.hostname}:${info.wt.port}${info.wt.path}`;
    const WT = (globalThis as any).WebTransport;
    const wt = new WT(url, { serverCertificateHashes: [{ algorithm: "sha-256", value: b64ToBytes(info.wt.certHashBase64) }] });
    await wt.ready;
    const stream = await wt.createBidirectionalStream();
    return new WtTransport(wt, stream);
  }

  private finish(reason: string) { if (!this.closed) { this.closed = true; this.onClose(reason); } }

  private async readDatagrams(r: ReadableStreamDefaultReader<Uint8Array>) {
    try {
      for (;;) {
        const { value, done } = await r.read();
        if (done) break;
        this.bytesDown += value.byteLength;
        this.onBinary(value);
      }
    } catch (e) { this.finish(`datagram read failed: ${(e as Error).message}`); }
  }

  private async readControl(r: ReadableStreamDefaultReader<Uint8Array>) {
    const dec = new TextDecoder();
    let buf = "";
    try {
      for (;;) {
        const { value, done } = await r.read();
        if (done) break;
        this.bytesDown += value.byteLength;
        buf += dec.decode(value, { stream: true });
        let nl: number;
        while ((nl = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, nl);
          buf = buf.slice(nl + 1);
          if (line.trim()) this.onControl(JSON.parse(line));
        }
      }
      this.finish("control stream ended");
    } catch (e) { this.finish(`control read failed: ${(e as Error).message}`); }
  }

  sendBinary(b: Uint8Array) {
    if (this.closed) return;
    this.bytesUp += b.byteLength;
    this.dgWriter.write(b).catch((e) => this.finish(`datagram write failed: ${e.message}`));
  }
  sendControl(msg: object) {
    if (this.closed) return;
    const bytes = this.enc.encode(JSON.stringify(msg) + "\n");
    this.bytesUp += bytes.byteLength;
    this.ctlWriter.write(bytes).catch((e) => this.finish(`control write failed: ${e.message}`));
  }
  close() { this.wt.close(); }
}

export function webTransportPossible(): boolean {
  return window.isSecureContext && typeof (globalThis as any).WebTransport === "function";
}
