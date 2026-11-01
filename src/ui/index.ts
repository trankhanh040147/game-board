/**
 * FIRST HEARTH — UI entry point.
 *
 * createUI(app) mounts the entire DOM interface into #ui-root, wires the app
 * event bus and keyboard shortcuts, and exposes refresh()/destroy(). The
 * simulation is never mutated from here: every change goes through GameApp.
 */
import '../styles/panels.css';
import '../styles/modals.css';
import '../styles/graph.css';
import '../styles/tour.css';
import type { GameApp } from '../app';
import { capitalOf, techAvailable } from '../sim/core';
import { icon } from './icons';
import { HUD } from './hud';
import { BuildPanel } from './build-panel';
import { Inspector } from './inspector';
import { MinimapPanel } from './minimap';
import { NotificationLog, ToastHost } from './notifications';
import {
  DecisionModal,
  EraBanner,
  GameOverOverlay,
  ModalHost,
  WelcomeOverlay,
  openNewGameModal,
  openSettingsModal,
} from './modals';
import { PanelHost } from './panels/host';
import { Tour } from './tour';
import { FirstSteps } from './first-steps';
import { createPanels } from './panels';
import { Tooltip } from './tooltip';
import { esc, stateOf, type ExpeditionKind, type PanelId, type Services, type SettingsTab } from './util';

export interface UIController {
  refresh(): void;
  destroy(): void;
}

interface RailEntry {
  id: PanelId;
  label: string;
  icon: string;
  key: string;
}

const RAIL: RailEntry[] = [
  { id: 'codex', label: 'Codex', icon: 'book', key: 'T' },
  { id: 'society', label: 'Society', icon: 'crown', key: 'S' },
  { id: 'market', label: 'Market', icon: 'market', key: 'M' },
  { id: 'people', label: 'People', icon: 'people', key: 'P' },
  { id: 'almanac', label: 'Almanac', icon: 'chart', key: 'C' },
  { id: 'diplomacy', label: 'Diplomacy', icon: 'handshake', key: 'D' },
  { id: 'expeditions', label: 'Expeditions', icon: 'compass', key: 'E' },
  { id: 'wonders', label: 'Wonders', icon: 'megaproject', key: 'W' },
  { id: 'objectives', label: 'Objectives', icon: 'objective', key: 'O' },
];

export function createUI(app: GameApp): UIController {
  const mount = document.getElementById('ui-root');
  if (!mount) throw new Error('createUI: #ui-root is missing');

  const shell = document.createElement('div');
  shell.className = 'fh-shell';
  mount.appendChild(shell);

  let expeditionTarget: ExpeditionKind | null = null;

  // ---------------------------------------------------------------- services
  const services: Services = {
    app,
    openPanel(id: PanelId): void {
      panelHost.open(id);
      shell.classList.add('is-panel-open');
      hud.closePopovers();
      notifLog.close();
    },
    closePanel(): void {
      panelHost.close();
      shell.classList.remove('is-panel-open');
    },
    activePanel(): PanelId | null {
      return panelHost.currentId();
    },
    togglePanel(id: PanelId): void {
      if (panelHost.isOpen(id)) services.closePanel();
      else services.openPanel(id);
    },
    openSettings(tab: SettingsTab = 'save'): void {
      openSettingsModal(services, modalHost, tab);
    },
    startTour(force = false): void {
      tour.start(force);
    },
    showFirstSteps(): void {
      firstSteps.show();
    },
    openNewGame(): void {
      openNewGameModal(services, modalHost);
    },
    openNotifications(): void {
      notifLog.toggle();
    },
    focusBuild(category: string | null): void {
      services.closePanel();
      notifLog.close();
      hud.closePopovers();
      buildPanel.focusCategory(category);
      refresh();
    },
    setExpeditionTarget(kind: ExpeditionKind | null): void {
      expeditionTarget = kind;
      if (kind) {
        app.setBuildMode(null);
        buildPanel.cancelTool();
        shell.classList.add('is-targeting');
        targetBanner.hidden = false;
        targetBanner.innerHTML = `
          <span class="fh-target-banner-icon">${icon('target', 'fh-icon is-small')}</span>
          <span><b>Choosing a destination</b><small>Click a tile on the map to send the ${esc(kind)} party · <kbd>Esc</kbd> cancels</small></span>
          <button type="button" class="fh-btn is-ghost clickable" data-cancel-target>Cancel</button>
        `;
      } else {
        shell.classList.remove('is-targeting');
        targetBanner.hidden = true;
      }
      refresh();
    },
    getExpeditionTarget(): ExpeditionKind | null {
      return expeditionTarget;
    },
    openDecisionModal(): void {
      decisionModal.refresh();
    },
    refreshSoon(): void {
      refresh();
    },
    toast(text: string, severity: 'info' | 'good' | 'warn' | 'bad' = 'info', iconName = 'bell'): void {
      toastHost.push(text, severity, iconName);
    },
  };

  // ---------------------------------------------------------------- modules
  const tooltipMgr = new Tooltip(shell);

  const hud = new HUD(services);
  shell.appendChild(hud.root);

  const rail = document.createElement('nav');
  rail.className = 'fh-rail';
  rail.setAttribute('aria-label', 'Panels');
  rail.innerHTML = `
    <button type="button" class="fh-rail-btn clickable" data-rail="build" aria-label="Construction panel" aria-pressed="false" data-tip="Construction (B)">
      ${icon('hammer', 'fh-icon')}<span class="fh-rail-label">Build</span><span class="fh-rail-key">B</span>
    </button>
    <span class="fh-rail-sep" aria-hidden="true"></span>
    ${RAIL.map(
      (entry) => `<button type="button" class="fh-rail-btn clickable" data-rail="${entry.id}" aria-label="${esc(entry.label)}" aria-pressed="false" data-tip="${esc(entry.label)} (${entry.key})">
        ${icon(entry.icon, 'fh-icon')}<span class="fh-rail-label">${esc(entry.label)}</span><span class="fh-rail-key">${entry.key}</span><span class="fh-rail-badge" data-rail-badge="${entry.id}" hidden></span>
      </button>`,
    ).join('')}
    <span class="fh-rail-spacer" aria-hidden="true"></span>
    <button type="button" class="fh-rail-btn clickable" data-rail="notices" aria-label="Notices" data-tip="Notices">
      ${icon('bell', 'fh-icon')}<span class="fh-rail-label">Notices</span><span class="fh-rail-badge" data-rail-badge="notices" hidden></span>
    </button>
    <button type="button" class="fh-rail-btn clickable" data-rail="help" aria-label="Help and shortcuts" data-tip="How to play (?)">
      ${icon('help', 'fh-icon')}<span class="fh-rail-label">Help</span><span class="fh-rail-key">?</span>
    </button>
  `;
  shell.appendChild(rail);

  const buildPanel = new BuildPanel(services);
  shell.appendChild(buildPanel.root);

  const inspector = new Inspector(services);
  shell.appendChild(inspector.root);

  const minimap = new MinimapPanel(services);
  shell.appendChild(minimap.root);

  const panelHost = new PanelHost(services);
  createPanels(services, panelHost);
  shell.appendChild(panelHost.root);

  const toastHost = new ToastHost(services);
  shell.appendChild(toastHost.root);

  const notifLog = new NotificationLog(services);
  shell.appendChild(notifLog.root);

  const modalHost = new ModalHost();
  shell.appendChild(modalHost.root);
  const decisionModal = new DecisionModal(services, modalHost);
  const gameOver = new GameOverOverlay(services, modalHost);
  const eraBanner = new EraBanner(services);
  shell.appendChild(eraBanner.root);
  const welcome = new WelcomeOverlay(services, {
    onBegin: () => {
      window.setTimeout(() => {
        if (!destroyed && tour.shouldStart()) tour.start();
      }, 650);
    },
  });
  shell.appendChild(welcome.root);

  // The tour and the first-steps checklist are the two onboarding surfaces.
  const tour = new Tour(services);
  shell.appendChild(tour.root);
  const firstSteps = new FirstSteps(services, (height) => {
    if (height) {
      shell.style.setProperty('--fh-firststeps-h', `${Math.round(height)}px`);
      shell.classList.add('has-firststeps');
    } else {
      shell.style.setProperty('--fh-firststeps-h', '0px');
      shell.classList.remove('has-firststeps');
    }
  });
  shell.appendChild(firstSteps.root);

  const targetBanner = document.createElement('div');
  targetBanner.className = 'fh-target-banner';
  targetBanner.hidden = true;
  shell.appendChild(targetBanner);

  // ---------------------------------------------------------------- events
  const offs: (() => void)[] = [];
  offs.push(
    app.on('notification', (...args: unknown[]) => {
      const payload = (args[0] ?? {}) as {
        text?: string;
        severity?: 'info' | 'good' | 'warn' | 'bad' | 'discovery' | 'milestone';
        icon?: string;
      };
      if (payload.text) toastHost.push(payload.text, payload.severity ?? 'info', payload.icon ?? 'bell');
    }),
  );
  offs.push(
    app.on('decision', () => {
      if (!welcome.isOpen) decisionModal.refresh();
      refresh();
    }),
  );
  offs.push(
    app.on('newgame', () => {
      services.setExpeditionTarget(null);
      services.closePanel();
      buildPanel.cancelTool();
      notifLog.close();
      modalHost.closeAll();
      refresh();
    }),
  );
  offs.push(
    app.on('loaded', () => {
      services.closePanel();
      services.setExpeditionTarget(null);
      buildPanel.cancelTool();
      modalHost.closeAll();
      refresh();
    }),
  );
  offs.push(
    app.on('selection', () => {
      onSelection();
      inspector.refresh();
      refresh();
    }),
  );
  offs.push(app.on('speed', () => refresh()));
  offs.push(app.on('paused', () => refresh()));

  // Selection side-effects: demolish and expedition targeting resolve on the
  // map click the renderer turns into a selection.
  function onSelection(): void {
    const view = app.view;
    if (view.buildMode === '__demolish__' && view.selectedBuildingId >= 0) {
      const id = view.selectedBuildingId;
      const building = app.state.buildings.find((b) => b.id === id);
      const def = building ? app.content.buildings[building.typeId] : null;
      app.setBuildMode(null);
      buildPanel.cancelTool();
      if (building && def) {
        const refund = building.progress < 1 ? 75 : 20;
        modalHost.open({
          id: 'confirm-demolish',
          eyebrow: 'Dismantle',
          title: `Dismantle ${def.name}?`,
          size: 'm',
          body: `<p class="serif">The ${esc(def.name)} will be taken apart for roughly ${refund}% of its materials. The tiles will be empty ground again.</p>
            <p class="fh-faint fh-small">Workers will be reassigned, and any stored goods it produced stay in the settlement.</p>`,
          footer: `<button type="button" class="fh-btn is-ghost clickable" data-modal-close>Keep it</button><button type="button" class="fh-btn is-bad clickable" data-act="confirm">${icon('close', 'fh-icon is-tiny')} Dismantle</button>`,
          onMount: (modal) => {
            modal.addEventListener('click', (ev) => {
              const target = ev.target;
              if (!(target instanceof Element)) return;
              if (target.closest('[data-act="confirm"]')) {
                app.demolish(id);
                modalHost.close('confirm-demolish');
              }
            });
          },
        });
      }
      return;
    }
    if (expeditionTarget && view.selectedTile >= 0) {
      const w = app.state.world.width;
      const x = view.selectedTile % w;
      const y = Math.floor(view.selectedTile / w);
      const kind = expeditionTarget;
      const result = app.startExpedition(kind, x, y);
      if (result.ok) services.setExpeditionTarget(null);
      else services.toast(result.message ?? 'Cannot send an expedition there.', 'warn', 'warning');
      refresh();
    }
  }

  // ---------------------------------------------------------------- rail
  rail.addEventListener('click', (ev) => {
    const target = ev.target instanceof Element ? ev.target.closest<HTMLElement>('[data-rail]') : null;
    if (!target) return;
    const railId = target.dataset.rail;
    if (railId === 'build') {
      services.closePanel();
      buildPanel.setCollapsed(!buildPanel.isCollapsed());
      refresh();
    } else if (railId === 'notices') {
      notifLog.toggle();
    } else if (railId === 'help') {
      services.openSettings('help');
    } else if (railId) {
      services.togglePanel(railId as PanelId);
    }
  });
  shell.addEventListener('click', (ev) => {
    const target = ev.target instanceof Element ? ev.target.closest<HTMLElement>('[data-cancel-target]') : null;
    if (target) services.setExpeditionTarget(null);
  });

  // ---------------------------------------------------------------- keyboard
  const isTyping = (): boolean => {
    const el = document.activeElement;
    if (!(el instanceof HTMLElement)) return false;
    if (el.isContentEditable) return true;
    const tag = el.tagName;
    return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
  };

  const onKeyDown = (ev: KeyboardEvent): void => {
    if (ev.defaultPrevented) return;
    if (modalHost.isOpen()) return; // modal host owns its keys
    if (tour.isActive()) return; // tour owns its keys
    if (welcome.isOpen) return;
    if (isTyping()) return;
    const key = ev.key;
    if (key === 'Escape') {
      ev.preventDefault();
      if (notifLog.isOpen()) notifLog.close();
      else if (expeditionTarget) services.setExpeditionTarget(null);
      else if (app.view.buildMode) {
        app.setBuildMode(null);
        buildPanel.cancelTool();
        refresh();
      } else if (panelHost.isOpen()) services.closePanel();
      else hud.closePopovers();
      return;
    }
    if (key === ' ' || key === 'Spacebar') {
      ev.preventDefault();
      app.togglePause();
      refresh();
      return;
    }
    if (key >= '0' && key <= '4') {
      const speed = Number(key);
      if (speed === 0) app.pause();
      else {
        app.setSpeed(speed);
        app.resume();
      }
      refresh();
      return;
    }
    if (key === '?') {
      ev.preventDefault();
      services.openSettings('help');
      return;
    }
    switch (key.toLowerCase()) {
      case 'b':
        services.closePanel();
        buildPanel.setCollapsed(!buildPanel.isCollapsed());
        break;
      case 't':
        services.togglePanel('codex');
        break;
      case 's':
        services.togglePanel('society');
        break;
      case 'm':
        services.togglePanel('market');
        break;
      case 'p':
        services.togglePanel('people');
        break;
      case 'c':
        services.togglePanel('almanac');
        break;
      case 'd':
        services.togglePanel('diplomacy');
        break;
      case 'e':
        services.togglePanel('expeditions');
        break;
      case 'w':
        services.togglePanel('wonders');
        break;
      case 'o':
        services.togglePanel('objectives');
        break;
      case 'g':
        app.view.showGrid = !app.view.showGrid;
        break;
      case 'f': {
        const cap = capitalOf(app.state);
        if (cap) app.renderer?.centerOnTile(cap.x, cap.y, 1);
        break;
      }
      default:
        return;
    }
    ev.preventDefault();
    refresh();
  };
  window.addEventListener('keydown', onKeyDown);

  // ---------------------------------------------------------------- refresh
  let lastSettingsKey = '';
  let lastRailKey = '';
  let destroyed = false;

  function applySettings(): void {
    const settings = app.state.settings;
    const key = `${settings.colorblind}|${settings.reducedMotion}|${settings.tooltips}|${settings.uiScale}`;
    if (key === lastSettingsKey) return;
    lastSettingsKey = key;
    shell.dataset.colorblind = settings.colorblind ? 'true' : 'false';
    shell.dataset.reducedMotion = settings.reducedMotion ? 'true' : 'false';
    document.documentElement.style.setProperty('--fh-ui-scale', String(settings.uiScale ?? 1));
    tooltipMgr.setEnabled(settings.tooltips !== false);
  }

  function updateRail(): void {
    const s = app.state;
    const c = app.content;
    const available = c.techOrder.filter((id) => techAvailable(s, c, id)).length;
    const affordable = c.techOrder.filter((id) => techAvailable(s, c, id) && (s.research.insight ?? 0) >= c.techs[id].cost).length;
    const doctrineOffer = (s.research.doctrineChoices?.length ?? 0) > 0 && !s.research.doctrine;
    const wondersAvailable = c.megaprojectOrder.filter((id) => s.megaprojects[id]?.status === 'available').length;
    const objectivesActive = s.objectives.current ? 1 : s.tutorial?.active ? 1 : 0;
    const unread = s.notifications.filter((n) => !n.read).length;
    const key = `${available}|${affordable}|${doctrineOffer}|${wondersAvailable}|${objectivesActive}|${unread}|${panelHost.currentId() ?? ''}|${buildPanel.isCollapsed()}|${notifLog.isOpen()}`;
    if (key === lastRailKey) return;
    lastRailKey = key;
    const badge = (id: string): HTMLElement | null => rail.querySelector<HTMLElement>(`[data-rail-badge="${id}"]`);
    const setBadge = (id: string, count: number, tone = 'muted'): void => {
      const el = badge(id);
      if (!el) return;
      el.hidden = count <= 0;
      el.textContent = count > 99 ? '99+' : String(count);
      el.dataset.tone = tone;
    };
    setBadge('codex', available, affordable > 0 ? 'ember' : 'muted');
    setBadge('society', doctrineOffer ? 1 : 0, 'ember');
    setBadge('wonders', wondersAvailable, 'brass');
    setBadge('objectives', objectivesActive, 'muted');
    setBadge('notices', unread, 'bad');
    for (const btn of rail.querySelectorAll<HTMLElement>('[data-rail]')) {
      const id = btn.dataset.rail;
      const active = id === 'build' ? !buildPanel.isCollapsed() : id === 'notices' ? notifLog.isOpen() : panelHost.isOpen(id as PanelId);
      btn.classList.toggle('is-active', active);
      btn.setAttribute('aria-pressed', String(active));
    }
  }

  function refresh(): void {
    if (destroyed) return;
    try {
      const state = app.state;
      applySettings();
      hud.refresh();
      buildPanel.refresh();
      inspector.refresh();
      minimap.refresh();
      panelHost.refresh();
      notifLog.refresh();
      if (!welcome.isOpen) {
        decisionModal.refresh();
        gameOver.refresh();
      }
      eraBanner.refresh();
      firstSteps.refresh();
      if (tour.isActive() && (state.events.pending.length > 0 || modalHost.isOpen())) tour.abort();
      updateRail();
    } catch (err) {
      console.error('[ui] refresh failed', err);
    }
  }

  // First-run welcome, then the tour.
  if (welcome.shouldShow()) {
    window.setTimeout(() => {
      if (destroyed) return;
      welcome.show();
    }, 450);
  } else if (tour.shouldStart() && app.state.tick <= 1) {
    // Returning QA/browser profile without the welcome overlay still gets the tour once.
    window.setTimeout(() => {
      if (destroyed) return;
      tour.start();
    }, 1100);
  }

  refresh();

  return {
    refresh,
    destroy(): void {
      destroyed = true;
      window.removeEventListener('keydown', onKeyDown);
      for (const off of offs) off();
      hud.destroy();
      buildPanel.destroy();
      inspector.destroy();
      minimap.destroy();
      toastHost.destroy();
      notifLog.destroy();
      eraBanner.destroy();
      welcome.destroy();
      tour.destroy();
      firstSteps.destroy();
      panelHost.destroy();
      modalHost.destroy();
      tooltipMgr.destroy();
      shell.remove();
    },
  };
}
