// Pointer lock + raw mouse. Produces the player's intent each fixed tick; the WASM codec turns it into bytes.
// When the browser refuses pointer lock (embedded views, some headless runs), the game falls back to "drag to look":
// hold a mouse button on the view and move the mouse. Left button still fires.

export interface InputIntent {
  forward: boolean; back: boolean; left: boolean; right: boolean;
  jump: boolean; fire: boolean;
  yaw: number;   // radians, 0 faces -Z, positive turns left (counter-clockwise seen from above)
  pitch: number; // radians, clamped to ±89°
}

const PITCH_LIMIT = (89 * Math.PI) / 180;

export class InputCapture {
  yaw = 0;
  pitch = 0;
  sensitivity = 0.0022; // radians per mouse count
  locked = false;
  /** Pointer lock was refused: playing with drag-to-look. */
  dragMode = false;
  rawMouse = false;
  private keys = new Set<string>();
  private fireHeld = false;
  private dragging = false;
  private skipMove = false;
  /** Fire presses since the last tick, so a click shorter than a tick is not lost. */
  private firePresses = 0;
  /** performance.now() of the last movement-key press, for the input → motion probe. */
  lastMoveKeyAt = -1;
  /** Called when play starts or stops (lock gained/lost, drag mode entered/left). */
  onActiveChange?: (active: boolean) => void;
  onLockError?: (msg: string) => void;
  onFirePress?: () => void;

  get active() { return this.locked || this.dragMode; }

  constructor(private canvas: HTMLElement) {
    document.addEventListener("pointerlockchange", () => {
      this.locked = document.pointerLockElement === canvas;
      if (this.locked) this.dragMode = false;
      if (!this.locked) this.release();
      this.onActiveChange?.(this.active);
    });
    document.addEventListener("mousemove", (e) => {
      if (!(this.locked || (this.dragMode && this.dragging))) return;
      // Drag mode: the first move after a press can carry the whole distance since the last delivered move (seen in
      // Chromium as a ~200 px jump), which would snap the aim. Drop it, and drop single-event spikes.
      if (this.dragMode && (this.skipMove || Math.abs(e.movementX) > 250 || Math.abs(e.movementY) > 250)) { this.skipMove = false; return; }
      this.yaw -= e.movementX * this.sensitivity;
      this.pitch = Math.max(-PITCH_LIMIT, Math.min(PITCH_LIMIT, this.pitch - e.movementY * this.sensitivity));
    });
    const down = (e: MouseEvent) => {
      if (!this.active) return;
      if (this.dragMode) {
        if (e.target !== canvas) return; // the Lab panel and other UI keep their clicks
        this.dragging = true;
        this.skipMove = true;
      }
      if (e.button !== 0) return;
      this.fireHeld = true;
      this.firePresses++;
      this.onFirePress?.();
    };
    document.addEventListener("mousedown", down);
    document.addEventListener("mouseup", (e) => {
      if (e.button === 0) this.fireHeld = false;
      if (e.buttons === 0) this.dragging = false;
    });
    canvas.addEventListener("contextmenu", (e) => { if (this.dragMode) e.preventDefault(); });
    document.addEventListener("keydown", (e) => {
      if (this.dragMode && e.code === "Escape") { this.stopDrag(); return; }
      if (!this.active) return;
      if (["KeyW", "KeyA", "KeyS", "KeyD"].includes(e.code) && !this.keys.has(e.code)) this.lastMoveKeyAt = performance.now();
      this.keys.add(e.code);
      if (e.code === "Space") e.preventDefault();
    });
    document.addEventListener("keyup", (e) => this.keys.delete(e.code));
    addEventListener("blur", () => this.release());
  }

  private release() { this.keys.clear(); this.fireHeld = false; this.dragging = false; }

  stopDrag() {
    if (!this.dragMode) return;
    this.dragMode = false;
    this.release();
    this.onActiveChange?.(false);
  }

  /** Leaves play: exits pointer lock or drag mode. */
  deactivate() {
    if (this.locked) document.exitPointerLock();
    this.stopDrag();
  }

  async lock() {
    // unadjustedMovement = raw mouse without OS acceleration, where the browser supports it. requestPointerLock may
    // throw synchronously (older browsers) or return a rejected promise; both land in the catch blocks.
    try {
      await (this.canvas as any).requestPointerLock({ unadjustedMovement: true });
      this.rawMouse = true;
      return;
    } catch { this.rawMouse = false; }
    try {
      await (this.canvas as any).requestPointerLock();
      return;
    } catch (e) {
      const err = e as Error;
      this.onLockError?.(`Pointer lock refused by the browser (${err.name}: ${err.message}). Playing without it: drag with the mouse to look.`);
    }
    this.dragMode = true;
    this.onActiveChange?.(true);
  }

  sample(): InputIntent {
    const fire = this.fireHeld || this.firePresses > 0;
    this.firePresses = 0;
    return {
      forward: this.keys.has("KeyW"), back: this.keys.has("KeyS"),
      left: this.keys.has("KeyA"), right: this.keys.has("KeyD"),
      jump: this.keys.has("Space"), fire,
      yaw: this.yaw, pitch: this.pitch,
    };
  }
}
