import { clamp } from './utils';

/**
 * Keyboard + mouse input with pointer-lock look.
 * Mouse deltas and pressed-edges are cleared by `endFrame()` at the end of each game frame.
 */
export class Input {
  readonly el: HTMLElement;
  keys = new Set<string>();
  private pressedKeys = new Set<string>();
  private releasedKeys = new Set<string>();

  mouseDX = 0;
  mouseDY = 0;
  wheel = 0;
  lmb = false;
  rmb = false;
  mmb = false;
  private lmbPressed = false;
  private rmbPressed = false;
  private lmbReleased = false;
  private rmbReleased = false;
  private mmbPressed = false;
  locked = false;
  onLockChange: ((locked: boolean) => void) | null = null;
  /** When true, pointer-lock loss is not treated as a pause by the game. */
  suppressLockCallback = false;

  private onKeyDown = (e: KeyboardEvent) => {
    if (e.repeat) {
      this.keys.add(e.code);
      return;
    }
    // Prevent page scroll / browser shortcuts while playing.
    if (['Space', 'Tab', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.code)) {
      e.preventDefault();
    }
    this.keys.add(e.code);
    this.pressedKeys.add(e.code);
  };

  private onKeyUp = (e: KeyboardEvent) => {
    this.keys.delete(e.code);
    this.releasedKeys.add(e.code);
  };

  private onMouseDown = (e: MouseEvent) => {
    if (e.button === 0) { this.lmb = true; this.lmbPressed = true; }
    else if (e.button === 2) { this.rmb = true; this.rmbPressed = true; }
    else if (e.button === 1) { this.mmb = true; this.mmbPressed = true; e.preventDefault(); }
  };

  private onMouseUp = (e: MouseEvent) => {
    if (e.button === 0) { this.lmb = false; this.lmbReleased = true; }
    else if (e.button === 2) { this.rmb = false; this.rmbReleased = true; }
    else if (e.button === 1) { this.mmb = false; }
  };

  private onMouseMove = (e: MouseEvent) => {
    if (!this.locked) return;
    this.mouseDX += e.movementX || 0;
    this.mouseDY += e.movementY || 0;
  };

  private onWheel = (e: WheelEvent) => {
    if (!this.locked) return;
    this.wheel += Math.sign(e.deltaY);
    e.preventDefault();
  };

  private onContextMenu = (e: Event) => e.preventDefault();

  private onPointerLockChange = () => {
    this.locked = document.pointerLockElement === this.el;
    if (!this.suppressLockCallback) this.onLockChange?.(this.locked);
  };

  private onBlur = () => {
    this.keys.clear();
    this.lmb = false;
    this.rmb = false;
  };

  constructor(el: HTMLElement) {
    this.el = el;
    window.addEventListener('keydown', this.onKeyDown, { passive: false });
    window.addEventListener('keyup', this.onKeyUp);
    window.addEventListener('mousedown', this.onMouseDown);
    window.addEventListener('mouseup', this.onMouseUp);
    window.addEventListener('mousemove', this.onMouseMove);
    window.addEventListener('wheel', this.onWheel, { passive: false });
    window.addEventListener('contextmenu', this.onContextMenu);
    window.addEventListener('blur', this.onBlur);
    document.addEventListener('pointerlockchange', this.onPointerLockChange);
  }

  requestLock(): void {
    if (this.locked) return;
    try {
      const result = this.el.requestPointerLock() as unknown;
      if (result && typeof (result as Promise<void>).catch === 'function') {
        (result as Promise<void>).catch(() => { /* user may need to click again */ });
      }
    } catch {
      /* ignore */
    }
  }

  exitLock(): void {
    if (document.pointerLockElement) document.exitPointerLock();
  }

  isDown(code: string): boolean {
    return this.keys.has(code);
  }

  wasPressed(code: string): boolean {
    return this.pressedKeys.has(code);
  }

  wasReleased(code: string): boolean {
    return this.releasedKeys.has(code);
  }

  get moveX(): number {
    return (this.isDown('KeyD') || this.isDown('ArrowRight') ? 1 : 0) -
      (this.isDown('KeyA') || this.isDown('ArrowLeft') ? 1 : 0);
  }

  get moveZ(): number {
    return (this.isDown('KeyW') || this.isDown('ArrowUp') ? 1 : 0) -
      (this.isDown('KeyS') || this.isDown('ArrowDown') ? 1 : 0);
  }

  get lookX(): number { return this.mouseDX; }
  get lookY(): number { return this.mouseDY; }

  get lmbClicked(): boolean { return this.lmbPressed; }
  get lmbReleasedThisFrame(): boolean { return this.lmbReleased; }
  get rmbClicked(): boolean { return this.rmbPressed; }
  get rmbReleasedThisFrame(): boolean { return this.rmbReleased; }
  get mmbClicked(): boolean { return this.mmbPressed; }

  /** Convert wheel to camera zoom delta (-1..1). */
  get zoomDelta(): number {
    return clamp(this.wheel, -2, 2);
  }

  endFrame(): void {
    this.mouseDX = 0;
    this.mouseDY = 0;
    this.wheel = 0;
    this.pressedKeys.clear();
    this.releasedKeys.clear();
    this.lmbPressed = false;
    this.lmbReleased = false;
    this.rmbPressed = false;
    this.rmbReleased = false;
    this.mmbPressed = false;
  }

  dispose(): void {
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('keyup', this.onKeyUp);
    window.removeEventListener('mousedown', this.onMouseDown);
    window.removeEventListener('mouseup', this.onMouseUp);
    window.removeEventListener('mousemove', this.onMouseMove);
    window.removeEventListener('wheel', this.onWheel);
    window.removeEventListener('contextmenu', this.onContextMenu);
    window.removeEventListener('blur', this.onBlur);
    document.removeEventListener('pointerlockchange', this.onPointerLockChange);
  }
}
