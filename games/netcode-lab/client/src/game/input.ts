// Pointer lock + raw mouse. Produces the player's intent each fixed tick; the WASM codec turns it into bytes.

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
  rawMouse = false;
  private keys = new Set<string>();
  private fireHeld = false;
  /** Fire presses since the last tick, so a click shorter than a tick is not lost. */
  private firePresses = 0;
  /** performance.now() of the last movement-key press, for the input → motion probe. */
  lastMoveKeyAt = -1;
  onLockChange?: (locked: boolean) => void;
  onFirePress?: () => void;

  constructor(private canvas: HTMLElement) {
    document.addEventListener("pointerlockchange", () => {
      this.locked = document.pointerLockElement === canvas;
      if (!this.locked) { this.keys.clear(); this.fireHeld = false; }
      this.onLockChange?.(this.locked);
    });
    document.addEventListener("mousemove", (e) => {
      if (!this.locked) return;
      this.yaw -= e.movementX * this.sensitivity;
      this.pitch = Math.max(-PITCH_LIMIT, Math.min(PITCH_LIMIT, this.pitch - e.movementY * this.sensitivity));
    });
    document.addEventListener("mousedown", (e) => {
      if (!this.locked || e.button !== 0) return;
      this.fireHeld = true;
      this.firePresses++;
      this.onFirePress?.();
    });
    document.addEventListener("mouseup", (e) => { if (e.button === 0) this.fireHeld = false; });
    document.addEventListener("keydown", (e) => {
      if (!this.locked) return;
      if (["KeyW", "KeyA", "KeyS", "KeyD"].includes(e.code) && !this.keys.has(e.code)) this.lastMoveKeyAt = performance.now();
      this.keys.add(e.code);
      if (e.code === "Space") e.preventDefault();
    });
    document.addEventListener("keyup", (e) => this.keys.delete(e.code));
  }

  onLockError?: (msg: string) => void;

  async lock() {
    // unadjustedMovement = raw mouse without OS acceleration, where the browser supports it.
    try {
      await (this.canvas as any).requestPointerLock({ unadjustedMovement: true });
      this.rawMouse = true;
      return;
    } catch { this.rawMouse = false; }
    try { await (this.canvas as any).requestPointerLock(); }
    catch (e) { this.onLockError?.(`The browser refused pointer lock: ${(e as Error).message}`); }
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
