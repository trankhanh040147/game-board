/**
 * FIRST STEPS — a persistent opening checklist docked above the minimap.
 *
 * Evaluated live from game state so it can never go stale, clickable so it
 * teaches by doing, and collapsible/dismissible once the player has their feet.
 */
import { hasTech, totalPopulation } from '../sim/core';
import { icon } from './icons';
import { esc, escAttr, fmtInt, meter, stateOf, tipText, type Services } from './util';

const KEY = 'fh-firststeps-v1';

type Pref = 'open' | 'collapsed' | 'hidden';

interface StepDef {
  id: string;
  label: string;
  hint: string;
  icon: string;
  hintFor?: (svc: Services) => string;
  done: () => boolean;
  act: () => void;
  locked?: () => boolean;
}

function anyBuilding(svc: Services, ids: string[]): boolean {
  const s = stateOf(svc);
  return s.buildings.some((b) => ids.includes(b.typeId));
}

export class FirstSteps {
  readonly root: HTMLElement;
  private pref: Pref;
  private forceOpen = false;
  private signature = '';
  private steps: StepDef[];
  private layoutQueued = false;

  constructor(
    private readonly svc: Services,
    private readonly onLayout: (height: number | null) => void,
  ) {
    this.pref = readPref();
    this.steps = this.buildSteps();
    this.root = document.createElement('aside');
    this.root.className = 'fh-firststeps';
    this.root.setAttribute('aria-label', 'First steps');
    this.root.hidden = true;
    this.root.addEventListener('click', this.onClick);
    this.refresh();
  }

  destroy(): void {
    this.root.removeEventListener('click', this.onClick);
    this.root.remove();
  }

  /** Re-open the checklist (called from Help and Objectives). */
  show(): void {
    this.forceOpen = true;
    this.pref = 'open';
    savePref(this.pref);
    this.signature = '';
    this.refresh();
    window.requestAnimationFrame(() => this.root.scrollIntoView({ block: 'nearest' }));
  }

  refresh(): void {
    const s = stateOf(this.svc);
    const doneFlags = this.steps.map((step) => step.done());
    const doneCount = doneFlags.filter(Boolean).length;
    const allDone = doneCount === this.steps.length;
    const currentIndex = doneFlags.findIndex((d) => !d);
    const state: Pref = this.pref === 'hidden' ? 'hidden' : this.pref === 'collapsed' || (allDone && !this.forceOpen) ? 'collapsed' : 'open';
    const farmLocked = !hasTech(s, 'cultivation');
    const signature = `${state}|${doneCount}|${allDone ? 1 : 0}|${currentIndex}|${farmLocked ? 1 : 0}|${s.buildings.length}|${fmtInt(totalPopulation(s))}|${Object.keys(s.research.completed).length}`;
    if (signature === this.signature) {
      this.queueLayout();
      return;
    }
    this.signature = signature;
    this.root.hidden = state === 'hidden';
    this.root.dataset.state = state;
    if (state === 'hidden') {
      this.queueLayout();
      return;
    }
    if (state === 'collapsed') {
      this.root.innerHTML = `<button type="button" class="fh-fs-chip clickable" data-act="expand" ${tipText('Open the First Steps checklist')}>
        <span class="fh-fs-chip-mark ${allDone ? 'is-done' : ''}">${icon(allDone ? 'check' : 'objective', 'fh-icon is-tiny')}</span>
        <span>${allDone ? 'First steps complete' : `First steps ${doneCount}/${this.steps.length}`}</span>
        <span class="fh-fs-chip-caret">${icon('chevron_down', 'fh-icon is-tiny')}</span>
      </button>`;
      this.queueLayout();
      return;
    }
    this.root.innerHTML = `
      <div class="fh-fs-head">
        <div class="fh-fs-title">
          <span class="fh-eyebrow">${icon('objective', 'fh-icon is-tiny')} The opening moves</span>
          <span class="fh-fs-progress">${doneCount} / ${this.steps.length}</span>
        </div>
        <div class="fh-fs-head-actions">
          <button type="button" class="fh-fs-icon clickable" data-act="collapse" aria-label="Collapse first steps" ${tipText('Collapse')}>${icon('minus', 'fh-icon is-tiny')}</button>
          <button type="button" class="fh-fs-icon clickable" data-act="dismiss" aria-label="Hide first steps" ${tipText('Hide — restore it from Help')}>${icon('close', 'fh-icon is-tiny')}</button>
        </div>
      </div>
      <div class="fh-fs-meter">${meter(doneCount, this.steps.length, { tone: allDone ? 'is-good' : 'is-brass' })}</div>
      <div class="fh-fs-list" role="list">
        ${this.steps
          .map((step, i) => {
            const done = doneFlags[i];
            const current = i === currentIndex;
            const locked = !done && step.locked?.();
            const hint = locked && step.hintFor ? step.hintFor(this.svc) : step.hint;
            return `<button type="button" role="listitem" class="fh-fs-row clickable ${done ? 'is-done' : ''} ${current ? 'is-current' : ''} ${locked ? 'is-locked' : ''}" data-step="${escAttr(step.id)}" ${tipText(`${step.label}${locked ? ' — locked' : ''}`)}>
              <span class="fh-fs-mark">${done ? icon('check', 'fh-icon is-tiny') : locked ? icon('lock', 'fh-icon is-tiny') : `<i>${i + 1}</i>`}</span>
              <span class="fh-fs-copy">
                <span class="fh-fs-label">${esc(step.label)}</span>
                ${current || locked ? `<span class="fh-fs-hint">${esc(hint)}</span>` : ''}
              </span>
              <span class="fh-fs-go">${icon('chevron_right', 'fh-icon is-tiny')}</span>
            </button>`;
          })
          .join('')}
      </div>
    `;
    this.queueLayout();
  }

  private queueLayout(): void {
    if (this.layoutQueued) return;
    this.layoutQueued = true;
    window.requestAnimationFrame(() => {
      this.layoutQueued = false;
      if (this.root.hidden) {
        this.onLayout(null);
        return;
      }
      this.onLayout(this.root.offsetHeight || null);
    });
  }

  private buildSteps(): StepDef[] {
    return [
      {
        id: 'gather',
        label: 'Gather food',
        hint: 'Build a Forager’s Camp, Hunting Blind or Fishing Dock.',
        icon: 'camp',
        done: () => anyBuilding(this.svc, ['foragers_camp', 'hunting_blind', 'fishing_dock']),
        act: () => this.svc.focusBuild('gathering'),
      },
      {
        id: 'shelter',
        label: 'Raise shelter',
        hint: 'Build a Lean-to or a Hut so people can sleep warm.',
        icon: 'shelter',
        done: () => anyBuilding(this.svc, ['lean_to', 'hut', 'cottage', 'house', 'apartment']),
        act: () => this.svc.focusBuild('housing'),
      },
      {
        id: 'water',
        label: 'Dig a well',
        hint: 'Water is the faster clock — dig a Well near water.',
        icon: 'well',
        done: () => anyBuilding(this.svc, ['well', 'water_tower', 'aqueduct']),
        act: () => this.svc.focusBuild('water'),
      },
      {
        id: 'discovery',
        label: 'Make a discovery',
        hint: 'Spend Insight in the Codex.',
        icon: 'star',
        done: () => Object.keys(stateOf(this.svc).research.completed).length > 0,
        act: () => this.svc.openPanel('codex'),
      },
      {
        id: 'farm',
        label: 'Sow a farm',
        hint: 'A Farm turns land into a steady surplus.',
        hintFor: () => 'Discover Cultivation first, then build a Farm.',
        icon: 'farm',
        done: () => anyBuilding(this.svc, ['farm']),
        act: () => (hasTech(stateOf(this.svc), 'cultivation') ? this.svc.focusBuild('food') : this.svc.openPanel('codex')),
        locked: () => !hasTech(stateOf(this.svc), 'cultivation'),
      },
      {
        id: 'population',
        label: 'Reach five souls',
        hint: 'Homes, food and morale bring families — and migrants.',
        icon: 'people',
        done: () => totalPopulation(stateOf(this.svc)) >= 5,
        act: () => this.svc.openPanel('people'),
      },
      {
        id: 'granary',
        label: 'Build a granary',
        hint: 'Storage keeps the harvest from spoiling.',
        icon: 'granary',
        done: () => anyBuilding(this.svc, ['granary']),
        act: () => this.svc.focusBuild('storage'),
      },
    ];
  }

  private onClick = (ev: MouseEvent): void => {
    const target = ev.target instanceof Element ? ev.target.closest<HTMLElement>('[data-act], [data-step]') : null;
    if (!target) return;
    if (target.dataset.act === 'collapse') {
      this.pref = 'collapsed';
      savePref(this.pref);
      this.signature = '';
      this.refresh();
      return;
    }
    if (target.dataset.act === 'dismiss') {
      this.pref = 'hidden';
      savePref(this.pref);
      this.signature = '';
      this.refresh();
      return;
    }
    if (target.dataset.act === 'expand') {
      this.pref = 'open';
      this.forceOpen = true;
      savePref(this.pref);
      this.signature = '';
      this.refresh();
      return;
    }
    const stepId = target.dataset.step;
    if (stepId) {
      const step = this.steps.find((s) => s.id === stepId);
      if (!step) return;
      step.act();
      this.svc.refreshSoon();
    }
  };
}

function readPref(): Pref {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw === 'open' || raw === 'collapsed' || raw === 'hidden') return raw;
  } catch {
    /* ignore */
  }
  return 'open';
}

function savePref(pref: Pref): void {
  try {
    localStorage.setItem(KEY, pref);
  } catch {
    /* ignore */
  }
}
