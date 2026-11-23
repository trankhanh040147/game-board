import { PRESETS, PRESET_DOCS, conceptUrl } from "./presets";
import { el } from "./widgets";

/** What the Lab panel needs from the network layer. Filled by the server connection once core's protocol lands. */
export interface LabBackend {
  connected: boolean;
  /** Preset ids the server says it implements; anything else is shown as "not built yet". */
  builtPresets: Set<string>;
  /** Server-wide settings as broadcast by the server. Keys it does not send do not exist yet. */
  settings: Record<string, unknown> | null;
  activePreset: string | null;
  /** Server descriptors: kind, allowed values, built flag. */
  supported?: { key: string; kind: string; allowed?: unknown[]; min?: number; max?: number; built: boolean; note?: string }[];
  presets?: { id: string; banner?: string; built: boolean }[];
  cond?: { up: { delayMs: number; jitterMs: number; lossPct: number }; down: { delayMs: number; jitterMs: number; lossPct: number } } | null;
  setCond?(up: { delayMs: number; jitterMs: number; lossPct: number }, down: { delayMs: number; jitterMs: number; lossPct: number }): void;
  lastError?: string;
  /** P03: send one forged result claim as a "modded client" (admin only). */
  sendForgedClaim?(token: string): string;
  applyPreset(id: string, token: string): void;
  setSetting(key: string, value: unknown, token: string): void;
}

const TOKEN_KEY = "netlab.adminToken";

function loadToken(): string {
  try {
    const fromUrl = new URLSearchParams(location.search).get("admin");
    if (fromUrl) { sessionStorage.setItem(TOKEN_KEY, fromUrl); return fromUrl; }
    return sessionStorage.getItem(TOKEN_KEY) ?? "";
  } catch { return ""; }
}

export class LabPanel {
  readonly root: HTMLElement;
  private body: HTMLElement;
  private status: HTMLElement;
  private tokenNote: HTMLElement;
  private token = loadToken();
  open = false;
  onToggle?: (open: boolean) => void;
  /** Local-only controls (FPS cap) that also work without a server. */
  local: { fpsCap: number; setFpsCap(v: number): void } | null = null;

  constructor(parent: HTMLElement, private backend: LabBackend) {
    this.root = el("div", { id: "lab", role: "dialog", "aria-label": "Lab panel" });
    const header = el("header", {}, `<b>Lab panel</b> <span class="dim">(F1)</span>`);
    const tokenRow = el("div", { class: "setting" });
    const tokenInput = el("input", { type: "password", placeholder: "admin token (or ?admin= in the URL)", "aria-label": "admin token" });
    tokenInput.value = this.token;
    tokenInput.addEventListener("input", () => {
      this.token = tokenInput.value;
      try { sessionStorage.setItem(TOKEN_KEY, this.token); } catch { /* per-tab convenience only */ }
      this.refresh();
    });
    tokenRow.appendChild(tokenInput);
    this.tokenNote = el("div", { class: "tokennote" });
    header.append(tokenRow, this.tokenNote);
    this.body = el("div", { class: "scroll" });
    this.status = el("footer", { class: "dim" });
    this.root.append(header, this.body, this.status);
    parent.appendChild(this.root);
    addEventListener("keydown", (e) => {
      if (e.code === "F1") { e.preventDefault(); this.toggle(); }
    });
  }

  toggle(force?: boolean) {
    this.open = force ?? !this.open;
    this.root.classList.toggle("open", this.open);
    if (this.open) this.refresh();
    this.onToggle?.(this.open);
  }

  setStatus(text: string, isError = false) {
    this.status.innerHTML = isError ? `<span class="err">${text}</span>` : text;
  }

  refresh() {
    if (!this.open) return;
    const b = this.backend;
    const canAdmin = b.connected && this.token.length > 0;
    const frag = document.createDocumentFragment();
    this.tokenNote.innerHTML = this.token
      ? '<span class="dim">Admin token set. The server checks it on each change; a wrong token is reported below.</span>'
      : '<span class="needtoken">Presenter only: enter the admin token.</span> <span class="dim">Presets and server settings stay disabled until then. Your own network conditioner works without it.</span>';
    if (b.lastError) {
      // Server refusals (e.g. "preset: bad admin token") go at the top of the panel, where the click happened.
      frag.appendChild(el("div", { class: "refusal", role: "alert" }, `Server refused: ${b.lastError.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)}`));
    }

    if (this.local) {
      frag.appendChild(el("h3", {}, "This client"));
      const row = el("div", { class: "setting" }, `<span>FPS cap</span>`);
      const sel = el("select", { "aria-label": "FPS cap" });
      for (const v of [30, 60, 144, 0]) sel.appendChild(el("option", { value: String(v) }, v === 0 ? "uncapped" : String(v)));
      sel.value = String(this.local.fpsCap);
      const serverCap = b.settings && "fpsCap" in b.settings;
      sel.disabled = !!serverCap;
      sel.title = serverCap ? "set server-wide by the Lab" : "";
      sel.addEventListener("change", () => this.local!.setFpsCap(Number(sel.value)));
      row.appendChild(sel);
      frag.appendChild(row);
    }

    frag.appendChild(el("h3", {}, "Server settings"));
    if (!b.connected) frag.appendChild(el("div", { class: "dim" }, "Server not connected."));
    else if (!b.settings || !Object.keys(b.settings).length) frag.appendChild(el("div", { class: "dim" }, "The server has not sent any settings."));
    else for (const [k, v] of Object.entries(b.settings)) {
      const d = b.supported?.find((x) => x.key === k);
      frag.appendChild(this.settingRow(k, v, canAdmin && (d?.built ?? false), d));
    }

    if (b.connected && b.setCond) {
      frag.appendChild(el("h3", {}, "My network conditioner (simulated)"));
      const c = b.cond;
      frag.appendChild(el("div", { class: "dim" }, c
        ? `up ${c.up.delayMs}±${c.up.jitterMs} ms, loss ${c.up.lossPct}% · down ${c.down.delayMs}±${c.down.jitterMs} ms, loss ${c.down.lossPct}%`
        : "server has not reported the conditioner"));
      const row = el("div", { class: "preset" });
      const profiles: [string, number, number, number][] = [["LAN", 0, 0, 0], ["Default (40 ms)", 20, 0, 0], ["Bad route (80 ms, jitter 15, loss 1%)", 40, 15, 1]];
      for (const [name, delay, jitter, loss] of profiles) {
        const btn = el("button", {}, name);
        const dir = { delayMs: delay, jitterMs: jitter, lossPct: loss };
        btn.addEventListener("click", () => b.setCond!(dir, dir));
        row.appendChild(btn);
      }
      row.style.flexWrap = "wrap";
      frag.appendChild(row);
    }

    {
      const built = b.connected && b.builtPresets.has("P03") && !!b.sendForgedClaim; // P03 built = server handles Claim (type 7)
      const box = el("div", { class: "unsafe" });
      box.innerHTML = `<b>⚠ Modded client (unsafe)</b><br><span class="dim">Sends a forged "I hit them in the head" claim, as a cheat would, to show what P03 trust mode accepts and what server authority rejects.</span>`;
      const btn = el("button", { id: "forged-claim" }, "Send forged headshot claim");
      btn.disabled = !built || !canAdmin;
      const why = !b.connected ? "server not connected" : !built ? "not built yet (server side of P03)" : !this.token ? "needs admin token" : "";
      btn.addEventListener("click", () => this.setStatus(b.sendForgedClaim?.(this.token) ?? ""));
      box.append(btn);
      if (why) box.append(el("span", { class: "dim" }, ` · ${why}`));
      frag.appendChild(box);
    }

    let group = "";
    for (const p of PRESETS) {
      if (p.group !== group) { group = p.group; frag.appendChild(el("h3", {}, group)); }
      const built = b.connected && b.builtPresets.has(p.id);
      const row = el("div", { class: "preset" });
      const btn = el("button", { "data-preset": p.id }, p.id);
      btn.disabled = !built || !canAdmin;
      if (b.activePreset === p.id) btn.style.outline = "2px solid #4ade80";
      btn.addEventListener("click", () => b.applyPreset(p.id, this.token));
      const reason = !b.connected ? "server not connected" : !built ? "not built yet" : !this.token ? "needs admin token" : "";
      const sp = b.presets?.find((x) => x.id === p.id);
      if (sp?.banner && !PRESET_DOCS.has(p.id)) row.title = sp.banner;
      const doc = PRESET_DOCS.get(p.id);
      const sec = doc ? `<a href="${conceptUrl(doc.concept)}" target="_blank" rel="noopener">${p.section}</a>` : p.section;
      row.append(btn, el("span", {}, `${p.idea} <span class="dim">(${sec})</span>${reason ? ` <span class="why dim">· ${reason}</span>` : ""}`));
      if (doc) row.title = `${doc.banner}\nObserve: ${doc.observe}`;
      frag.appendChild(row);
    }
    this.body.replaceChildren(frag);
    this.setStatus(b.activePreset ? `active preset ${b.activePreset}` : "no preset active");
  }

  private settingRow(key: string, value: unknown, canAdmin: boolean, d?: { kind: string; allowed?: unknown[]; built: boolean; note?: string }): HTMLElement {
    const row = el("div", { class: "setting" }, `<span>${key}${d && !d.built ? ' <span class="dim">· not built yet</span>' : ""}</span>`);
    if (d?.note) row.title = d.note;
    let input: HTMLInputElement | HTMLSelectElement;
    if (d?.kind === "enum" && d.allowed) {
      const sel = el("select", { "aria-label": key });
      for (const a of d.allowed) sel.appendChild(el("option", { value: String(a) }, key === "fpsCap" && a === 0 ? "uncapped" : String(a)));
      sel.value = String(value);
      sel.addEventListener("change", () => this.backend.setSetting(key, typeof value === "number" ? Number(sel.value) : sel.value, this.token));
      input = sel;
    } else if (typeof value === "boolean") {
      const cb = el("input", { type: "checkbox", "aria-label": key });
      cb.checked = value;
      cb.addEventListener("change", () => this.backend.setSetting(key, cb.checked, this.token));
      input = cb;
    } else if (typeof value === "number") {
      input = el("input", { type: "text", inputmode: "decimal", "aria-label": key, style: "width:90px" });
      input.value = String(value);
      input.addEventListener("change", () => this.backend.setSetting(key, Number(input.value), this.token));
    } else {
      input = el("input", { type: "text", "aria-label": key, style: "width:120px" });
      input.value = String(value);
      input.addEventListener("change", () => this.backend.setSetting(key, input.value, this.token));
    }
    input.disabled = !canAdmin;
    row.appendChild(input);
    return row;
  }
}
