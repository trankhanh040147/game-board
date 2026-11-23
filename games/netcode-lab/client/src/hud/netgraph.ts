// Net graph (B.7). Each row says where its value comes from; null renders as "—", never a placeholder number.

export type Source = "measured" | "server" | "setting" | "est." | `measured, incl. simulated ${string}`;
export interface Row { key: string; label: string; value: number | string | null; unit?: string; source: Source; digits?: number }

export class NetGraph {
  private el: HTMLElement;
  constructor(parent: HTMLElement) {
    this.el = document.createElement("div");
    this.el.id = "netgraph";
    this.el.className = "hud box";
    parent.appendChild(this.el);
  }
  render(rows: Row[]) {
    this.el.innerHTML = "<table>" + rows.map((r) => {
      const v = r.value === null ? "—" : typeof r.value === "number" ? r.value.toFixed(r.digits ?? 0) + (r.unit ? " " + r.unit : "") : r.value;
      return `<tr><td class="k">${r.label}</td><td class="v">${v}</td><td class="s">${r.source}</td></tr>`;
    }).join("") + "</table>";
  }
}
