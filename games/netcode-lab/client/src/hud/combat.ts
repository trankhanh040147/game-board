import type { KillMsg, RoundMsg, ScoreRow } from "../game/events";
import { el } from "./widgets";

// Combat HUD (B.3). Everything here shows only on a server-confirmed event; the client never invents a hit.

export class CombatHud {
  private marker: HTMLElement;
  private headIcon: HTMLElement;
  private numbers: HTMLElement;
  private confirm: HTMLElement;
  private feed: HTMLElement;
  private timer: HTMLElement;
  private respawn: HTMLElement;
  private board: HTMLElement;
  private markerUntil = 0;
  private confirmUntil = 0;
  private feedRows: { at: number; html: string }[] = [];
  boardOpen = false;

  constructor(parent: HTMLElement, private iconUrl: { hit: string; head: string | null; skull: string | null }) {
    this.marker = el("img", { id: "hitmarker", class: "hud", src: iconUrl.hit, alt: "" });
    this.headIcon = iconUrl.head ? el("img", { id: "headicon", class: "hud", src: iconUrl.head, alt: "" }) : el("div", { id: "headicon", class: "hud txt" }, "HEADSHOT");
    this.numbers = el("div", { id: "dmgnums", class: "hud" });
    this.confirm = el("div", { id: "killconfirm", class: "hud" });
    this.feed = el("div", { id: "killfeed", class: "hud" });
    this.timer = el("div", { id: "roundtimer", class: "hud box" });
    this.respawn = el("div", { id: "respawn", class: "hud box" });
    this.board = el("div", { id: "scoreboard", class: "hud box" });
    for (const e of [this.marker, this.headIcon, this.confirm, this.timer, this.respawn, this.board]) e.style.display = "none";
    parent.append(this.marker, this.headIcon, this.numbers, this.confirm, this.feed, this.timer, this.respawn, this.board);
    addEventListener("keydown", (e) => { if (e.code === "Tab") { e.preventDefault(); this.boardOpen = true; this.board.style.display = ""; } });
    addEventListener("keyup", (e) => { if (e.code === "Tab") { this.boardOpen = false; this.board.style.display = "none"; } });
  }

  /** Shooter side of a confirmed hit: marker, damage number, headshot icon. */
  hit(damage: number, headshot: boolean, now: number) {
    this.markerUntil = now + (headshot ? 350 : 200);
    this.marker.style.display = "";
    this.marker.classList.toggle("head", headshot);
    this.headIcon.style.display = headshot ? "" : "none";
    const n = el("div", { class: `dmg${headshot ? " head" : ""}` }, String(damage));
    n.style.left = `${50 + (Math.random() - 0.5) * 4}%`; // spread so repeated numbers do not overlap
    this.numbers.appendChild(n);
    setTimeout(() => n.remove(), 900);
  }

  /** Victim side: a red flash and who hit you (server Damage event). */
  damaged(damage: number, by: string, now: number) {
    this.feedNote(`<span class="dmgtaken">−${damage}</span> from ${escapeHtml(by)}`, now);
    document.body.classList.add("hurt");
    setTimeout(() => document.body.classList.remove("hurt"), 180);
  }

  killConfirmed(victimName: string, headshot: boolean, now: number) {
    this.confirmUntil = now + 1600;
    this.confirm.innerHTML = `${this.skull()} ${escapeHtml(victimName)}${headshot ? ' <span class="hs">headshot</span>' : ""}`;
    this.confirm.style.display = "";
  }

  feedKill(e: KillMsg, team: (id: number) => string, youId: number, now: number) {
    const who = (id: number, name: string) => `<span class="${team(id)}">${escapeHtml(name)}${id === youId ? " (you)" : ""}</span>`;
    const tags = `${e.headshot ? '<span class="hs">HS</span>' : ""}${e.trust ? '<span class="trust">trust-mode claim</span>' : ""}`;
    this.feedRows.push({ at: now, html: `${who(e.killerId, e.killer)} ${this.skull()}${tags} ${who(e.victimId, e.victim)}` });
    if (this.feedRows.length > 6) this.feedRows.shift();
  }

  private skull() { return this.iconUrl.skull ? `<img src="${this.iconUrl.skull}" alt="killed">` : '<span class="skull" aria-label="killed">☠</span>'; }

  /** A plain line in the kill feed (e.g. a rejected claim, P03). */
  feedNote(html: string, now: number) {
    this.feedRows.push({ at: now, html });
    if (this.feedRows.length > 6) this.feedRows.shift();
  }

  /** Round timer from the server's round state (null = the server sends no rounds yet). */
  round(r: RoundMsg | null, serverNowMs: number | null) {
    if (!r || serverNowMs === null) { this.timer.style.display = "none"; return; }
    const left = Math.max(0, (r.endsAtServerMs - serverNowMs) / 1000);
    const mm = Math.floor(left / 60), ss = Math.floor(left % 60).toString().padStart(2, "0");
    this.timer.style.display = "";
    this.timer.innerHTML = `<span class="blue">${r.scores.blue}</span> · round ${r.no} · ${r.state === "playing" ? `${mm}:${ss}` : `next round in ${Math.ceil(left)} s`} · <span class="orange">${r.scores.orange}</span>`;
  }

  /** Respawn countdown after the server says you died (null = alive). */
  respawnIn(sec: number | null, killer?: string) {
    if (sec === null) { this.respawn.style.display = "none"; return; }
    this.respawn.style.display = "";
    this.respawn.innerHTML = `${killer ? `Killed by ${escapeHtml(killer)}<br>` : ""}Respawn in ${Math.max(0, sec).toFixed(1)} s`;
  }

  /** Scoreboard (Tab). Rows come from the server; values it does not send show "—" with the reason in the header. */
  scoreboard(rows: ScoreRow[], youId: number, note: string) {
    if (!this.boardOpen) return;
    const team = (t: "blue" | "orange") => {
      const rs = rows.filter((r) => r.team === t).sort((a, b) => (b.kills ?? 0) - (a.kills ?? 0) || (a.deaths ?? 0) - (b.deaths ?? 0));
      const f = (v: number | null, d = 0) => (v === null || v === undefined ? "—" : v.toFixed(d));
      return `<table><thead><tr><th class="${t}">${t === "blue" ? "Blue" : "Orange"}</th><th>K</th><th>D</th><th>ping</th><th>loss %</th><th>FPS</th></tr></thead><tbody>${
        rs.map((r) => `<tr class="${r.id === youId ? "you" : ""}"><td>${escapeHtml(r.name)}</td><td>${f(r.kills)}</td><td>${f(r.deaths)}</td><td title="${r.pingSource === "server-acks" ? "server ack RTT (client has not reported)" : "client clock sync"}">${f(r.pingMs)}${r.pingSource === "server-acks" ? "*" : ""}</td><td>${f(r.lossPct, 1)}</td><td>${f(r.fps)}</td></tr>`).join("")
      }</tbody></table>`;
    };
    this.board.innerHTML = `<div class="dim">${note}</div><div class="dim">ping: measured by each client (clock sync), * = server ack RTT · loss: client-measured downlink · values include simulated conditioner delay/loss when it is on</div><div class="teams">${team("blue")}${team("orange")}</div>`;
  }

  update(now: number) {
    if (now > this.markerUntil) { this.marker.style.display = "none"; this.headIcon.style.display = "none"; }
    if (now > this.confirmUntil) this.confirm.style.display = "none";
    this.feedRows = this.feedRows.filter((r) => now - r.at < 6000);
    const html = this.feedRows.map((r) => `<div>${r.html}</div>`).join("");
    if (this.feed.innerHTML !== html) this.feed.innerHTML = html;
  }
}

export function escapeHtml(s: string) {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
}
