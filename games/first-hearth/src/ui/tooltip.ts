/**
 * Reusable hover/focus tooltip. Rich HTML tips are authored by the UI modules
 * via data attributes; the manager only positions and reveals them.
 *
 * Behaviour: 240ms hover delay, instant swap between adjacent tips, flips to
 * stay inside the viewport, follows the pointer, dismissed on click/scroll.
 */
export class Tooltip {
  private readonly el: HTMLElement;
  private timer = 0;
  private target: HTMLElement | null = null;
  private visible = false;
  private raf = 0;
  private px = 0;
  private py = 0;
  private enabled = true;
  private readonly isCoarse: boolean;

  constructor(private readonly host: HTMLElement) {
    this.el = document.createElement('div');
    this.el.className = 'fh-tooltip';
    this.el.setAttribute('role', 'tooltip');
    this.el.setAttribute('aria-hidden', 'true');
    host.appendChild(this.el);
    this.isCoarse = window.matchMedia?.('(pointer: coarse)')?.matches ?? false;

    document.addEventListener('pointerover', this.onPointerOver, true);
    document.addEventListener('pointerout', this.onPointerOut, true);
    document.addEventListener('pointermove', this.onPointerMove, true);
    document.addEventListener('pointerdown', this.onDismiss, true);
    document.addEventListener('focusin', this.onFocusIn, true);
    document.addEventListener('focusout', this.onFocusOut, true);
    document.addEventListener('keydown', this.onKeyDown, true);
    window.addEventListener('blur', this.hide);
    document.addEventListener('scroll', this.onScroll, true);
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    if (!enabled) this.hide();
  }

  destroy(): void {
    document.removeEventListener('pointerover', this.onPointerOver, true);
    document.removeEventListener('pointerout', this.onPointerOut, true);
    document.removeEventListener('pointermove', this.onPointerMove, true);
    document.removeEventListener('pointerdown', this.onDismiss, true);
    document.removeEventListener('focusin', this.onFocusIn, true);
    document.removeEventListener('focusout', this.onFocusOut, true);
    document.removeEventListener('keydown', this.onKeyDown, true);
    window.removeEventListener('blur', this.hide);
    document.removeEventListener('scroll', this.onScroll, true);
    this.el.remove();
  }

  private findTarget(from: EventTarget | null): HTMLElement | null {
    if (!(from instanceof Element)) return null;
    const node = from.closest<HTMLElement>('[data-tip-html], [data-tip]');
    if (!node) return null;
    if (node.getAttribute('data-tip-disabled') === '1') return null;
    return node;
  }

  private contentFor(target: HTMLElement): string {
    const rich = target.getAttribute('data-tip-html');
    if (rich) return rich;
    const plain = target.getAttribute('data-tip');
    return plain ? `<div class="fh-tip-body">${plain}</div>` : '';
  }

  private onPointerOver = (ev: PointerEvent): void => {
    if (!this.enabled || this.isCoarse) return;
    const target = this.findTarget(ev.target);
    if (!target || target === this.target) return;
    this.px = ev.clientX;
    this.py = ev.clientY;
    this.setTarget(target, false);
  };

  private onPointerOut = (ev: PointerEvent): void => {
    const target = this.findTarget(ev.target);
    if (!target || target !== this.target) return;
    const related = ev.relatedTarget instanceof Element ? ev.relatedTarget.closest('[data-tip-html], [data-tip]') : null;
    if (related === target) return;
    this.hide();
  };

  private onPointerMove = (ev: PointerEvent): void => {
    if (!this.visible && !this.timer) return;
    this.px = ev.clientX;
    this.py = ev.clientY;
    if (this.visible && !this.raf) this.raf = requestAnimationFrame(this.position);
  };

  private onFocusIn = (ev: FocusEvent): void => {
    if (!this.enabled) return;
    const target = this.findTarget(ev.target);
    if (!target) return;
    const rect = target.getBoundingClientRect();
    this.px = rect.left + rect.width / 2;
    this.py = rect.bottom;
    this.setTarget(target, false);
  };

  private onFocusOut = (ev: FocusEvent): void => {
    const target = this.findTarget(ev.target);
    if (target && target === this.target) this.hide();
  };

  private onDismiss = (): void => this.hide();

  private onKeyDown = (ev: KeyboardEvent): void => {
    if (ev.key === 'Escape') this.hide();
  };

  private onScroll = (ev: Event): void => {
    if (!this.visible) return;
    if (ev.target instanceof Node && this.el.contains(ev.target)) return;
    this.hide();
  };

  private setTarget(target: HTMLElement, instant: boolean): void {
    if (this.target === target && this.visible) return;
    this.target = target;
    if (this.timer) {
      window.clearTimeout(this.timer);
      this.timer = 0;
    }
    this.hideEl();
    const run = (): void => {
      this.timer = 0;
      if (!this.target || !this.target.isConnected) return;
      const html = this.contentFor(this.target);
      if (!html) return;
      this.el.innerHTML = html;
      this.el.classList.add('is-visible');
      this.el.setAttribute('aria-hidden', 'false');
      this.visible = true;
      this.position();
    };
    if (instant) run();
    else this.timer = window.setTimeout(run, 220);
  }

  private hideEl(): void {
    if (this.raf) {
      cancelAnimationFrame(this.raf);
      this.raf = 0;
    }
    this.visible = false;
    this.el.classList.remove('is-visible');
    this.el.setAttribute('aria-hidden', 'true');
  }

  hide = (): void => {
    if (this.timer) {
      window.clearTimeout(this.timer);
      this.timer = 0;
    }
    this.target = null;
    this.hideEl();
  };

  private position = (): void => {
    this.raf = 0;
    if (!this.visible) return;
    const pad = 12;
    const rect = this.el.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let x = this.px + 16;
    let y = this.py + 18;
    if (x + rect.width > vw - pad) x = this.px - rect.width - 16;
    if (y + rect.height > vh - pad) y = this.py - rect.height - 14;
    x = Math.max(pad, Math.min(x, vw - rect.width - pad));
    y = Math.max(pad, Math.min(y, vh - rect.height - pad));
    this.el.style.transform = `translate3d(${Math.round(x)}px, ${Math.round(y)}px, 0)`;
  };
}
