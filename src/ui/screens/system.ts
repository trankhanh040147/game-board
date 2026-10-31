/** Pause, settings and controls overlays. */

import type { HudState, Settings } from '../../core/types';
import type { UIEnv } from '../shared';
import { button, divider, keycap, screenShell, sectionTitle } from '../shared';
import { append, div, el, span } from '../util';

/* ------------------------------------------------------------------ */
/* Pause                                                               */
/* ------------------------------------------------------------------ */

export interface PauseContext {
  roundLabel?: string;
  objective?: string;
  mode?: HudState['mode'];
  denars?: number;
  bet?: number;
}

export function renderPause(env: UIEnv, context: PauseContext | null): HTMLElement {
  const tr = env.tr;
  const shell = screenShell('pause', {
    className: 'bm-frame--pause',
    kicker: tr('pauseKicker'),
    title: tr('pauseTitle'),
    subtitle: tr('pauseSub'),
    heroIcon: 'clock',
  });

  const grid = div('bm-pause-grid');

  const actions = div('bm-pause-actions');
  actions.appendChild(button(env, tr('resume'), {
    kind: 'primary', icon: 'sword', onClick: () => env.handlers.onResume(),
  }));
  actions.appendChild(button(env, tr('menuControls'), {
    kind: 'secondary', icon: 'key', onClick: () => env.handlers.onOpenControls(),
  }));
  actions.appendChild(button(env, tr('menuSettings'), {
    kind: 'secondary', icon: 'gear', onClick: () => env.handlers.onOpenSettings(),
  }));
  actions.appendChild(button(env, tr('abandon'), {
    kind: 'danger', icon: 'close', onClick: () => env.handlers.onQuitToMenu(),
  }));
  grid.appendChild(actions);

  const quick = div('bm-pause-quick');
  quick.appendChild(sectionTitle(tr('pauseQuickKeys')));
  const rows: [string[], string][] = [
    [['W', 'A', 'S', 'D'], env.tr('ctrlMove')],
    [['Shift'], env.tr('ctrlSprint')],
    [['LMB'], env.tr('ctrlAttack')],
    [['RMB'], env.tr('ctrlBlock')],
    [['Space'], env.tr('ctrlDodge')],
    [['F'], env.tr('ctrlKick')],
    [['Q'], env.tr('ctrlLock')],
  ];
  for (const [keys, label] of rows) {
    const row = div('bm-keyrow');
    const keysWrap = span('bm-keyrow-keys');
    for (const key of keys) keysWrap.appendChild(keycap(key, key.length > 1));
    append(row, keysWrap, span('bm-keyrow-label', label));
    quick.appendChild(row);
  }
  grid.appendChild(quick);

  shell.body.appendChild(grid);

  if (context) {
    const status = div('bm-pause-status');
    if (context.roundLabel) {
      const item = div('bm-pause-stat');
      append(item, span('bm-pause-stat-label', tr('hudRound')), span('bm-pause-stat-value', context.roundLabel));
      status.appendChild(item);
    }
    if (context.objective) {
      const item = div('bm-pause-stat');
      append(item, span('bm-pause-stat-label', tr('hudObjective')), span('bm-pause-stat-value', context.objective));
      status.appendChild(item);
    }
    if (typeof context.denars === 'number') {
      const item = div('bm-pause-stat');
      append(item, span('bm-pause-stat-label', tr('profileDenars')), span('bm-pause-stat-value', String(context.denars)));
      status.appendChild(item);
    }
    if (typeof context.bet === 'number' && context.bet > 0) {
      const item = div('bm-pause-stat');
      append(item, span('bm-pause-stat-label', tr('hudBet')), span('bm-pause-stat-value', String(context.bet)));
      status.appendChild(item);
    }
    if (status.childElementCount > 0) {
      shell.body.appendChild(divider('bm-divider--tight'));
      shell.body.appendChild(status);
    }
  }

  const foot = div('bm-foot-note');
  append(foot, keycap('Esc'), span('', ' ' + tr('resume')));
  shell.foot.appendChild(foot);
  return shell.root;
}

/* ------------------------------------------------------------------ */
/* Settings                                                            */
/* ------------------------------------------------------------------ */

function sliderRow(
  env: UIEnv,
  label: string,
  value: number,
  min: number,
  max: number,
  step: number,
  format: (v: number) => string,
  onChange: (value: number) => void,
): HTMLDivElement {
  const row = div('bm-setrow');
  const head = div('bm-setrow-head');
  const val = span('bm-setrow-value', format(value));
  append(head, el('label', 'bm-setrow-label', label), val);
  row.appendChild(head);

  const wrap = div('bm-slider');
  const input = el('input', 'bm-slider-input');
  input.type = 'range';
  input.min = String(min);
  input.max = String(max);
  input.step = String(step);
  input.value = String(value);
  input.setAttribute('aria-label', label);
  input.addEventListener('input', () => {
    const next = Number(input.value);
    val.textContent = format(next);
    const pct = ((next - min) / (max - min)) * 100;
    input.style.setProperty('--fill', `${Math.max(0, Math.min(100, pct))}%`);
    onChange(next);
  });
  const pct0 = ((value - min) / (max - min)) * 100;
  input.style.setProperty('--fill', `${Math.max(0, Math.min(100, pct0))}%`);
  wrap.appendChild(input);
  row.appendChild(wrap);
  void env;
  return row;
}

function toggleRow(label: string, value: boolean, onChange: (v: boolean) => void): HTMLDivElement {
  const row = div('bm-setrow bm-setrow--toggle');
  const head = div('bm-setrow-head');
  append(head, el('label', 'bm-setrow-label', label));
  row.appendChild(head);
  const btn = el('button', `bm-switch${value ? ' is-on' : ''}`);
  btn.type = 'button';
  btn.setAttribute('role', 'switch');
  btn.setAttribute('aria-checked', value ? 'true' : 'false');
  btn.setAttribute('aria-label', label);
  btn.appendChild(span('bm-switch-knob'));
  btn.addEventListener('click', () => {
    const next = !btn.classList.contains('is-on');
    btn.classList.toggle('is-on', next);
    btn.setAttribute('aria-checked', next ? 'true' : 'false');
    onChange(next);
  });
  row.appendChild(btn);
  return row;
}

function segmentedRow(
  label: string,
  options: { value: string; label: string }[],
  current: string,
  onPick: (value: string) => void,
): HTMLDivElement {
  const row = div('bm-setrow bm-setrow--seg');
  const head = div('bm-setrow-head');
  append(head, el('label', 'bm-setrow-label', label));
  row.appendChild(head);
  const group = div('bm-seg');
  for (const option of options) {
    const btn = el('button', `bm-seg-btn${option.value === current ? ' is-on' : ''}`, option.label);
    btn.type = 'button';
    btn.setAttribute('aria-pressed', option.value === current ? 'true' : 'false');
    btn.addEventListener('click', () => {
      group.querySelectorAll('.bm-seg-btn').forEach((n) => n.classList.remove('is-on'));
      btn.classList.add('is-on');
      onPick(option.value);
    });
    group.appendChild(btn);
  }
  row.appendChild(group);
  return row;
}

export function renderSettings(env: UIEnv): HTMLElement {
  const tr = env.tr;
  const current: Settings = { ...env.settings };
  const shell = screenShell('settings', {
    className: 'bm-frame--settings',
    kicker: tr('menuSettingsMeta'),
    title: tr('settingsTitle'),
    subtitle: tr('settingsSub'),
    heroIcon: 'gear',
  });

  const update = (patch: Partial<Settings>) => {
    Object.assign(current, patch);
    env.applySettings({ ...current });
  };

  const grid = div('bm-settings-grid');

  const sound = div('bm-settings-col');
  sound.appendChild(sectionTitle(tr('settingsAudio')));
  sound.appendChild(sliderRow(env, tr('setMasterVolume'), current.masterVolume, 0, 1, 0.05,
    (v) => `${Math.round(v * 100)}%`, (v) => update({ masterVolume: v })));
  sound.appendChild(sliderRow(env, tr('setMusicVolume'), current.musicVolume, 0, 1, 0.05,
    (v) => `${Math.round(v * 100)}%`, (v) => update({ musicVolume: v })));
  sound.appendChild(sliderRow(env, tr('setSfxVolume'), current.sfxVolume, 0, 1, 0.05,
    (v) => `${Math.round(v * 100)}%`, (v) => update({ sfxVolume: v })));
  grid.appendChild(sound);

  const picture = div('bm-settings-col');
  picture.appendChild(sectionTitle(tr('settingsVideo')));
  picture.appendChild(segmentedRow(tr('setQuality'), [
    { value: 'low', label: tr('setLow') },
    { value: 'medium', label: tr('setMedium') },
    { value: 'high', label: tr('setHigh') },
  ], current.quality, (value) => update({ quality: value as Settings['quality'] })));
  picture.appendChild(sliderRow(env, tr('setFov'), current.fov, 50, 85, 1,
    (v) => `${Math.round(v)}°`, (v) => update({ fov: v })));
  picture.appendChild(sliderRow(env, tr('setShake'), current.cameraShake, 0, 1.5, 0.05,
    (v) => `${Math.round(v * 100)}%`, (v) => update({ cameraShake: v })));
  grid.appendChild(picture);

  const combat = div('bm-settings-col');
  combat.appendChild(sectionTitle(tr('settingsControls')));
  combat.appendChild(sliderRow(env, tr('setSensitivity'), current.sensitivity, 0.2, 3, 0.05,
    (v) => `${v.toFixed(2)}×`, (v) => update({ sensitivity: v })));
  combat.appendChild(toggleRow(tr('setInvertY'), current.invertY, (v) => update({ invertY: v })));
  grid.appendChild(combat);

  const iface = div('bm-settings-col');
  iface.appendChild(sectionTitle(tr('settingsInterface')));
  iface.appendChild(toggleRow(tr('setHints'), current.showHints, (v) => update({ showHints: v })));
  iface.appendChild(segmentedRow(tr('setLanguage'), [
    { value: 'en', label: 'English' },
    { value: 'vi', label: 'Tiếng Việt' },
  ], current.language, (value) => update({ language: value as Settings['language'] })));
  grid.appendChild(iface);

  shell.body.appendChild(grid);

  const foot = div('bm-settings-note');
  append(foot, span('bm-settings-note-mark'), span('', tr('settingsSaved')));
  shell.foot.appendChild(foot);
  shell.foot.appendChild(button(env, tr('back'), {
    kind: 'secondary', icon: 'chevron', onClick: () => env.handlers.onCloseOverlay(),
  }));
  return shell.root;
}

/* ------------------------------------------------------------------ */
/* Controls                                                            */
/* ------------------------------------------------------------------ */

interface ControlRow {
  keys: string[];
  label: string;
  desc: string;
}

interface ControlGroup {
  title: string;
  rows: ControlRow[];
}

export function renderControls(env: UIEnv): HTMLElement {
  const tr = env.tr;
  const shell = screenShell('controls', {
    className: 'bm-frame--controls',
    kicker: tr('menuControlsMeta'),
    title: tr('controlsTitle'),
    subtitle: tr('controlsSub'),
    heroIcon: 'key',
  });

  const groups: ControlGroup[] = [
    {
      title: tr('groupMovement'),
      rows: [
        { keys: ['W', 'A', 'S', 'D'], label: tr('ctrlMove'), desc: tr('ctrlMoveDesc') },
        { keys: ['Shift'], label: tr('ctrlSprint'), desc: tr('ctrlSprintDesc') },
        { keys: ['Space'], label: tr('ctrlDodge'), desc: tr('ctrlDodgeDesc') },
      ],
    },
    {
      title: tr('groupCombat'),
      rows: [
        { keys: ['LMB'], label: tr('ctrlAttack'), desc: tr('ctrlAttackDesc') },
        { keys: ['RMB'], label: tr('ctrlBlock'), desc: tr('ctrlBlockDesc') },
        { keys: ['F'], label: tr('ctrlKick'), desc: tr('ctrlKickDesc') },
        { keys: ['Q', 'MMB'], label: tr('ctrlLock'), desc: tr('ctrlLockDesc') },
      ],
    },
    {
      title: tr('groupCamera'),
      rows: [
        { keys: ['Mouse'], label: tr('ctrlLook'), desc: tr('ctrlLookDesc') },
        { keys: ['Wheel'], label: tr('ctrlZoom'), desc: tr('ctrlZoomDesc') },
      ],
    },
    {
      title: tr('groupInterface'),
      rows: [
        { keys: ['Esc'], label: tr('ctrlPause'), desc: tr('ctrlPauseDesc') },
        { keys: ['Tab'], label: tr('ctrlBoard'), desc: tr('ctrlBoardDesc') },
        { keys: ['H'], label: tr('ctrlHints'), desc: tr('ctrlHintsDesc') },
      ],
    },
  ];

  const grid = div('bm-controls-grid');
  for (const group of groups) {
    const col = div('bm-controls-col');
    col.appendChild(sectionTitle(group.title));
    for (const row of group.rows) {
      const node = div('bm-ctrlrow');
      const keysWrap = span('bm-ctrlrow-keys');
      for (const key of row.keys) keysWrap.appendChild(keycap(key, key.length > 2));
      const text = div('bm-ctrlrow-text');
      append(text, span('bm-ctrlrow-label', row.label), span('bm-ctrlrow-desc', row.desc));
      append(node, keysWrap, text);
      col.appendChild(node);
    }
    grid.appendChild(col);
  }
  shell.body.appendChild(grid);

  shell.foot.appendChild(button(env, tr('back'), {
    kind: 'secondary', icon: 'chevron', onClick: () => env.handlers.onCloseOverlay(),
  }));
  return shell.root;
}
