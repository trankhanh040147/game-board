import { score, type ModeState, type Cell } from "./scorecard";

export function el<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, string> = {}, html = ""): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  if (html) e.innerHTML = html;
  return e;
}

export class Scorecard {
  private root: HTMLElement;
  constructor(parent: HTMLElement) {
    this.root = el("div", { id: "scorecard", class: "hud box" });
    parent.appendChild(this.root);
    this.render(null);
  }
  render(m: ModeState | null) {
    const label: Record<Cell | "unknown", string> = { yes: "✓", partial: "~", no: "✗", unknown: "?" };
    const cells: [string, Cell | "unknown", string][] = m
      ? (() => { const s = score(m); return [["Instant", s.instant, s.why.instant], ["Smooth", s.smooth, s.why.smooth], ["Fair", s.fair, s.why.fair], ["Cheat-proof", s.cheatProof, s.why.cheatProof]]; })()
      : [["Instant", "unknown", "no server modes yet"], ["Smooth", "unknown", ""], ["Fair", "unknown", ""], ["Cheat-proof", "unknown", ""]];
    this.root.innerHTML = `<div class="title">Scorecard (A.2) · from active modes</div>` +
      cells.map(([n, c, w]) => `<div class="cell ${c}">${label[c]} ${n}<small>${w}</small></div>`).join("");
  }
}

export class Banner {
  private root: HTMLElement;
  constructor(parent: HTMLElement) {
    this.root = el("div", { id: "banner", class: "hud box" });
    this.root.style.display = "none";
    parent.appendChild(this.root);
  }
  set(lines: string[]) {
    this.root.style.display = lines.length ? "" : "none";
    this.root.innerHTML = lines.join("<br>");
  }
}
