/**
 * Keyboard + gamepad input.
 *
 * `sample()` returns the analogue struct the car physics wants; discrete actions
 * (pause, camera, mute, restart, confirm) are pushed through `onCommand` so the
 * shell can react on key-down instead of polling.
 *
 * The module is DOM-optional: `createInput()` with a stub target works in Node.
 */

const KEY_MAP = {
  KeyW: 'throttle+',
  ArrowUp: 'throttle+',
  KeyS: 'throttle-',
  ArrowDown: 'throttle-',
  KeyA: 'steer-',
  ArrowLeft: 'steer-',
  KeyD: 'steer+',
  ArrowRight: 'steer+',
  Space: 'handbrake',
  ShiftLeft: 'nitro',
  ShiftRight: 'nitro',
};

const COMMAND_MAP = {
  KeyC: 'camera',
  KeyM: 'mute',
  KeyP: 'pause',
  Escape: 'pause',
  KeyR: 'restart',
  KeyQ: 'quit',
  Enter: 'confirm',
  NumpadEnter: 'confirm',
  KeyF: 'fullscreen',
  Backquote: 'debug',
};

/** Human-readable control reference, shared by the title screen and README. */
export const CONTROL_REFERENCE = [
  ['W / ↑', 'throttle'],
  ['S / ↓', 'brake & reverse'],
  ['A D / ← →', 'steer'],
  ['SPACE', 'handbrake'],
  ['SHIFT', 'nitro'],
  ['C', 'camera'],
  ['P / ESC', 'pause'],
  ['R', 'restart'],
  ['M', 'mute'],
];

/**
 * @param {{target?:EventTarget, onCommand?:(command:string)=>void, gamepad?:boolean}} [options]
 */
export function createInput(options = {}) {
  const target = options.target ?? (typeof window !== 'undefined' ? window : null);
  const gamepadEnabled = options.gamepad ?? true;
  const pressed = new Set();
  const state = {
    throttle: 0,
    steer: 0,
    handbrake: false,
    nitro: false,
    enabled: true,
    gamepadConnected: false,
    lastCommand: null,
  };

  function emit(command) {
    if (!command) return;
    state.lastCommand = command;
    if (options.onCommand) options.onCommand(command);
  }

  function onKeyDown(event) {
    if (!state.enabled) {
      // Still allow the pause/confirm keys to wake the shell up.
      const command = COMMAND_MAP[event.code];
      if (command) {
        event.preventDefault?.();
        emit(command);
      }
      return;
    }
    const mapped = KEY_MAP[event.code];
    if (mapped) {
      event.preventDefault?.();
      pressed.add(mapped);
      if (event.repeat) return;
      if (mapped === 'handbrake') state.handbrake = true;
      if (mapped === 'nitro') state.nitro = true;
      return;
    }
    const command = COMMAND_MAP[event.code];
    if (command) {
      event.preventDefault?.();
      if (event.repeat) return;
      emit(command);
    }
  }

  function onKeyUp(event) {
    const mapped = KEY_MAP[event.code];
    if (!mapped) return;
    event.preventDefault?.();
    pressed.delete(mapped);
    if (mapped === 'handbrake') state.handbrake = false;
    if (mapped === 'nitro') state.nitro = false;
  }

  function clear() {
    pressed.clear();
    state.handbrake = false;
    state.nitro = false;
    state.throttle = 0;
    state.steer = 0;
  }

  function onBlur() {
    clear();
  }

  function readGamepad() {
    if (!gamepadEnabled || typeof navigator === 'undefined' || !navigator.getGamepads) {
      return null;
    }
    const pads = navigator.getGamepads();
    for (const pad of pads) {
      if (!pad || !pad.connected) continue;
      state.gamepadConnected = true;
      const axes = pad.axes;
      const buttons = pad.buttons;
      const steerAxis = axes[0] ?? 0;
      const throttleAxis = -(axes[1] ?? 0);
      const steerDeadzone = Math.abs(steerAxis) > 0.12 ? steerAxis : 0;
      return {
        throttle: throttleAxis,
        steer: Math.max(-1, Math.min(1, steerDeadzone * 1.4)),
        handbrake: Boolean(buttons[0]?.pressed),
        nitro: Boolean(buttons[2]?.pressed || buttons[1]?.pressed),
        start: Boolean(buttons[9]?.pressed),
      };
    }
    return null;
  }

  /** Poll the current analogue input. Safe to call at simulation rate. */
  function sample() {
    if (!state.enabled) {
      return { throttle: 0, steer: 0, handbrake: false, nitro: false };
    }
    const pad = readGamepad();
    let throttle = 0;
    let steer = 0;
    if (pressed.has('throttle+')) throttle += 1;
    if (pressed.has('throttle-')) throttle -= 1;
    if (pressed.has('steer+')) steer += 1;
    if (pressed.has('steer-')) steer -= 1;
    if (pad) {
      if (Math.abs(pad.throttle) > Math.abs(throttle)) throttle = pad.throttle;
      if (Math.abs(pad.steer) > Math.abs(steer)) steer = pad.steer;
    }
    state.throttle = Math.max(-1, Math.min(1, throttle));
    state.steer = Math.max(-1, Math.min(1, steer));
    return {
      throttle: state.throttle,
      steer: state.steer,
      handbrake: state.handbrake || Boolean(pad?.handbrake),
      nitro: state.nitro || Boolean(pad?.nitro),
    };
  }

  /** Attach listeners; returns a disposer. */
  function attach() {
    if (!target || typeof target.addEventListener !== 'function') return () => {};
    target.addEventListener('keydown', onKeyDown);
    target.addEventListener('keyup', onKeyUp);
    target.addEventListener('blur', onBlur);
    return () => {
      target.removeEventListener('keydown', onKeyDown);
      target.removeEventListener('keyup', onKeyUp);
      target.removeEventListener('blur', onBlur);
    };
  }

  const detach = attach();

  return {
    state,
    sample,
    clear,
    emit,
    setEnabled(enabled) {
      state.enabled = Boolean(enabled);
      if (!state.enabled) clear();
    },
    get enabled() {
      return state.enabled;
    },
    dispose() {
      detach();
      clear();
    },
  };
}
