/**
 * DOM shell: screens, garage cards, results table, toasts and loading states.
 *
 * The renderer and simulation know nothing about this module; `main.js` is the
 * only caller. Every element is looked up once and cached, and all text nodes
 * are updated in place so the UI does not thrash the layout engine.
 */

import { CAR_ORDER, CAR_SPECS, TRACK_DEFS, TRACK_ORDER } from '../sim/config.js';

const SCREEN_IDS = {
  title: 'screen-title',
  garage: 'screen-garage',
  pause: 'screen-pause',
  results: 'screen-results',
};

/** Format seconds as `m:ss.mmm`. */
export function formatLapTime(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) return '--:--.---';
  const total = Math.max(0, seconds);
  const minutes = Math.floor(total / 60);
  const rest = total - minutes * 60;
  return `${minutes}:${rest.toFixed(3).padStart(6, '0')}`;
}

/** Format a gap as `+s.mmm` / `-s.mmm`. */
export function formatGap(seconds) {
  if (!Number.isFinite(seconds)) return '—';
  const sign = seconds >= 0 ? '+' : '-';
  const value = Math.abs(seconds);
  if (value >= 60) {
    const minutes = Math.floor(value / 60);
    return `${sign}${minutes}:${(value - minutes * 60).toFixed(1).padStart(4, '0')}`;
  }
  return `${sign}${value.toFixed(2)}`;
}

const STAT_LABELS = {
  speed: 'SPD',
  accel: 'ACC',
  grip: 'GRP',
  brakes: 'BRK',
};

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function buildCarCard(spec, index) {
  const card = el('button', 'card car-card');
  card.type = 'button';
  card.dataset.car = spec.id;
  card.setAttribute('aria-pressed', 'false');

  card.append(el('span', 'card__index', String(index + 1).padStart(2, '0')));

  const main = el('span', 'card__main');
  main.append(el('span', 'card__name', spec.name));
  main.append(el('span', 'card__blurb', spec.blurb));

  const stats = el('span', 'card__stats');
  for (const [key, label] of Object.entries(STAT_LABELS)) {
    const row = el('span', 'stat');
    row.append(el('span', 'stat__label', label));
    const bar = el('span', 'stat__bar');
    const fill = el('span', 'stat__fill');
    fill.style.width = `${Math.round(((spec.stats[key] ?? 5) / 10) * 100)}%`;
    bar.append(fill);
    row.append(bar);
    stats.append(row);
  }
  main.append(stats);
  card.append(main);
  card.append(
    el(
      'span',
      'card__tag',
      `${String(spec.drive ?? 'rwd').toUpperCase()} · ${Math.round(spec.topSpeed * 3.6)} KM/H`,
    ),
  );
  return card;
}

function buildTrackCard(def, index) {
  const card = el('button', 'card track-card');
  card.type = 'button';
  card.dataset.track = def.id;
  card.setAttribute('aria-pressed', 'false');

  card.append(el('span', 'card__index', String(index + 1).padStart(2, '0')));
  const main = el('span', 'card__main');
  main.append(el('span', 'card__name', def.name));
  main.append(el('span', 'card__blurb', def.blurb));
  card.append(main);
  card.append(el('span', 'card__tag', def.subtitle));
  return card;
}

/**
 * @param {{
 *   records: ReturnType<import('./storage.js').createRecordStore>,
 *   onEnterGarage:Function, onStart:Function, onResume:Function,
 *   onRestart:Function, onQuit:Function, onAgain:Function,
 *   onBackToGarage:Function, onQuality:Function, onCamera:Function,
 *   onMute:Function, onSelectCar:Function, onSelectTrack:Function,
 * }} options
 */
export function createUi(options) {
  const records = options.records;
  const nodes = {};
  for (const id of [
    'screen-title', 'screen-garage', 'screen-pause', 'screen-results',
    'enter-garage', 'car-list', 'track-list', 'start-race', 'resume-race',
    'restart-race', 'quit-race', 'results-title', 'results-position',
    'results-time', 'results-best', 'results-laps', 'again', 'back-to-garage',
    'quality-select', 'camera-select', 'mute-toggle', 'best-record',
    'loading', 'loading-label', 'loading-text', 'toast',
  ]) {
    nodes[id] = document.getElementById(id);
  }

  let selectedCar = records.get('car') ?? CAR_ORDER[0];
  let selectedTrack = records.get('track') ?? TRACK_ORDER[0];
  let activeScreen = 'title';
  let toastTimer = null;

  if (!CAR_SPECS[selectedCar]) selectedCar = CAR_ORDER[0];
  if (!TRACK_DEFS[selectedTrack]) selectedTrack = TRACK_ORDER[0];

  /* ---------------------------------------------------------------- cards -- */

  const carCards = new Map();
  CAR_ORDER.forEach((id, index) => {
    const card = buildCarCard(CAR_SPECS[id], index);
    nodes['car-list'].append(card);
    carCards.set(id, card);
    card.addEventListener('click', () => selectCar(id, true));
    card.addEventListener('focus', () => selectCar(id, false));
  });

  const trackCards = new Map();
  TRACK_ORDER.forEach((id, index) => {
    const card = buildTrackCard(TRACK_DEFS[id], index);
    nodes['track-list'].append(card);
    trackCards.set(id, card);
    card.addEventListener('click', () => selectTrack(id, true));
    card.addEventListener('focus', () => selectTrack(id, false));
  });

  function selectCar(id, notify = true) {
    if (!CAR_SPECS[id] || id === selectedCar) {
      if (notify) syncSelection();
      return selectedCar;
    }
    selectedCar = id;
    records.set('car', id);
    syncSelection();
    if (notify && options.onSelectCar) options.onSelectCar(id);
    return selectedCar;
  }

  function selectTrack(id, notify = true) {
    if (!TRACK_DEFS[id] || id === selectedTrack) {
      if (notify) syncSelection();
      return selectedTrack;
    }
    selectedTrack = id;
    records.set('track', id);
    syncSelection();
    if (notify && options.onSelectTrack) options.onSelectTrack(id);
    return selectedTrack;
  }

  function syncSelection() {
    for (const [id, card] of carCards) {
      const active = id === selectedCar;
      card.classList.toggle('is-selected', active);
      card.setAttribute('aria-pressed', String(active));
    }
    for (const [id, card] of trackCards) {
      const active = id === selectedTrack;
      card.classList.toggle('is-selected', active);
      card.setAttribute('aria-pressed', String(active));
    }
    if (options.onSelectCar) options.onSelectCar(selectedCar);
    if (options.onSelectTrack) options.onSelectTrack(selectedTrack);
  }

  /* -------------------------------------------------------------- screens -- */

  function showScreen(name) {
    activeScreen = name;
    for (const [screen, id] of Object.entries(SCREEN_IDS)) {
      const node = nodes[id];
      if (!node) continue;
      node.classList.toggle('is-hidden', screen !== name);
    }
    const overlayOpen = name !== null;
    if (nodes.loading && overlayOpen) nodes.loading.classList.add('is-hidden');
  }

  function hideScreens() {
    showScreen(null);
  }

  /* ---------------------------------------------------------------- toast -- */

  function toast(text, ms = 2200) {
    if (!nodes.toast) return;
    nodes.toast.textContent = text;
    nodes.toast.classList.add('is-visible');
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      nodes.toast.classList.remove('is-visible');
      toastTimer = null;
    }, ms);
  }

  /* -------------------------------------------------------------- loading -- */

  function setLoading(text) {
    if (!nodes.loading) return;
    if (text === null) {
      nodes.loading.classList.add('is-hidden');
    } else {
      nodes.loading.classList.remove('is-hidden');
      nodes['loading-label'].textContent = text;
    }
  }

  function setStatus(text) {
    if (nodes['loading-text']) nodes['loading-text'].textContent = text;
  }

  /* -------------------------------------------------------------- records -- */

  function setBestRecord(seconds, trackId = selectedTrack) {
    if (!nodes['best-record']) return;
    if (!Number.isFinite(seconds) || seconds <= 0) {
      nodes['best-record'].textContent = '—';
      return;
    }
    nodes['best-record'].textContent = `${formatLapTime(seconds)} · ${TRACK_DEFS[trackId]?.name ?? ''}`;
  }

  /* -------------------------------------------------------------- results -- */

  function showResults(results) {
    const {
      title = 'RACE COMPLETE',
      position = '—',
      totalTime = null,
      bestLap = null,
      standings = [],
    } = results ?? {};
    if (nodes['results-title']) nodes['results-title'].textContent = title;
    if (nodes['results-position']) nodes['results-position'].textContent = String(position);
    if (nodes['results-time']) {
      nodes['results-time'].textContent = formatLapTime(totalTime);
    }
    if (nodes['results-best']) {
      nodes['results-best'].textContent = formatLapTime(bestLap);
    }
    const body = nodes['results-laps'];
    if (body) {
      body.textContent = '';
      for (const row of standings) {
        const tr = document.createElement('tr');
        if (row.isPlayer) tr.className = 'is-player';
        tr.append(el('td', 'results-table__pos', String(row.position)));
        tr.append(el('td', 'results-table__name', row.name ?? '—'));
        tr.append(el('td', 'results-table__lap', formatLapTime(row.bestLap)));
        tr.append(el('td', 'results-table__total', formatLapTime(row.totalTime)));
        body.append(tr);
      }
    }
    showScreen('results');
  }

  /* --------------------------------------------------------------- wiring -- */

  const bind = (id, event, handler) => {
    const node = nodes[id];
    if (node) node.addEventListener(event, handler);
  };

  bind('enter-garage', 'click', () => {
    if (options.onEnterGarage) options.onEnterGarage();
  });
  bind('start-race', 'click', () => {
    if (options.onStart) options.onStart(selectedCar, selectedTrack);
  });
  bind('resume-race', 'click', () => {
    if (options.onResume) options.onResume();
  });
  bind('restart-race', 'click', () => {
    if (options.onRestart) options.onRestart();
  });
  bind('quit-race', 'click', () => {
    if (options.onQuit) options.onQuit();
  });
  bind('again', 'click', () => {
    if (options.onAgain) options.onAgain();
  });
  bind('back-to-garage', 'click', () => {
    if (options.onBackToGarage) options.onBackToGarage();
  });
  bind('quality-select', 'change', (event) => {
    if (options.onQuality) options.onQuality(event.target.value);
  });
  bind('camera-select', 'change', (event) => {
    if (options.onCamera) options.onCamera(event.target.value);
  });
  bind('mute-toggle', 'click', () => {
    if (options.onMute) options.onMute();
  });

  // Garage keyboard navigation (the game input layer is disabled on these screens).
  const onKeyDown = (event) => {
    if (activeScreen !== 'garage') return;
    if (event.code === 'ArrowLeft' || event.code === 'ArrowUp') {
      event.preventDefault();
      cycleTrack(-1);
    } else if (event.code === 'ArrowRight' || event.code === 'ArrowDown') {
      event.preventDefault();
      cycleTrack(1);
    } else if (event.code === 'BracketLeft' || event.code === 'KeyQ') {
      cycleCar(-1);
    } else if (event.code === 'BracketRight' || event.code === 'KeyE') {
      cycleCar(1);
    }
  };
  window.addEventListener('keydown', onKeyDown);

  function cycleTrack(delta) {
    const index = TRACK_ORDER.indexOf(selectedTrack);
    const next = TRACK_ORDER[(index + delta + TRACK_ORDER.length) % TRACK_ORDER.length];
    selectTrack(next);
    trackCards.get(next)?.focus();
  }

  function cycleCar(delta) {
    const index = CAR_ORDER.indexOf(selectedCar);
    const next = CAR_ORDER[(index + delta + CAR_ORDER.length) % CAR_ORDER.length];
    selectCar(next);
    carCards.get(next)?.focus();
  }

  function updateMuteButton(muted) {
    const node = nodes['mute-toggle'];
    if (!node) return;
    let label = node.querySelector('.btn__label');
    if (!label) {
      node.textContent = '';
      label = el('span', 'btn__label');
      node.append(label, el('span', 'key', 'M'));
    }
    label.textContent = muted ? 'SOUND: OFF' : 'SOUND: ON';
    node.setAttribute('aria-pressed', String(Boolean(muted)));
  }

  const qualitySelect = nodes['quality-select'];
  if (qualitySelect) qualitySelect.value = records.get('quality') ?? 'medium';
  const cameraSelect = nodes['camera-select'];
  if (cameraSelect) cameraSelect.value = records.get('camera') ?? 'chase';

  syncSelection();
  setBestRecord(records.bestLap(selectedTrack), selectedTrack);
  updateMuteButton(Boolean(records.get('muted')));

  return {
    nodes,
    get selectedCar() {
      return selectedCar;
    },
    get selectedTrack() {
      return selectedTrack;
    },
    get activeScreen() {
      return activeScreen;
    },
    showScreen,
    hideScreens,
    showResults,
    selectCar,
    selectTrack,
    cycleCar,
    cycleTrack,
    toast,
    setLoading,
    setStatus,
    setBestRecord,
    setMuted(muted) {
      updateMuteButton(muted);
    },
    setQuality(value) {
      if (qualitySelect) qualitySelect.value = value;
    },
    setCamera(value) {
      if (cameraSelect) cameraSelect.value = value;
    },
    showTitle() {
      setBestRecord(records.bestLap(selectedTrack), selectedTrack);
      showScreen('title');
    },
    showGarage() {
      setBestRecord(records.bestLap(selectedTrack), selectedTrack);
      showScreen('garage');
    },
    showPause() {
      showScreen('pause');
    },
    focusStart() {
      nodes['start-race']?.focus?.();
    },
    dispose() {
      window.removeEventListener('keydown', onKeyDown);
      if (toastTimer) clearTimeout(toastTimer);
    },
  };
}
