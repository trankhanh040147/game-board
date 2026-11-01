/**
 * Objectives: current goals, era progress, milestones and tutorial hints.
 */
import { computeMetric } from '../../sim/metrics';
import { icon } from '../icons';
import {
  chip,
  conditionText,
  esc,
  fmt,
  fmtInt,
  meter,
  pct,
  pretty,
  roman,
  scoreTone,
  stateOf,
  tip,
  tipText,
  type Services,
} from '../util';
import { panelSection, type GamePanel, type PanelHost } from './host';

export class ObjectivesPanel implements GamePanel {
  readonly id = 'objectives' as const;
  readonly subtitle = 'What the hearth asks of you next';

  constructor(private readonly svc: Services) {}

  eyebrow(): string {
    return 'The Path';
  }

  title(): string {
    return 'Objectives';
  }

  render(): string {
    const s = stateOf(this.svc);
    const c = this.svc.app.content;
    const era = s.research.era;
    const eraDef = c.eras[era];
    const nextEra = c.eras[era + 1];
    const requirement = nextEra?.requirement ?? eraDef?.requirement;
    const reqRows = requirement
      ? [
          { label: 'Discoveries', current: Object.keys(s.research.completed).length, target: requirement.techs, icon: 'book', suffix: '' },
          { label: 'Population', current: s.settlements.reduce((n, x) => n + x.population, 0), target: requirement.population, icon: 'people', suffix: '' },
          ...(requirement.buildings ? [{ label: 'Buildings', current: s.buildings.filter((b) => b.progress >= 1).length, target: requirement.buildings, icon: 'hammer', suffix: '' }] : []),
          ...(requirement.insight ? [{ label: 'Insight', current: Math.round(s.research.insight), target: requirement.insight, icon: 'star', suffix: '' }] : []),
          ...(requirement.culture ? [{ label: 'Culture', current: Math.round(s.society.culturePoints), target: requirement.culture, icon: 'culture', suffix: '' }] : []),
        ]
      : [];
    const milestones = (c.milestones ?? []).filter((m) => m.kind !== 'achievement');
    const currentId = s.objectives.current;
    const tutorial = s.tutorial ?? { step: 0, active: true, completed: false, milestonesSeen: [], hintsDismissed: {} };
    const tips = (c.tutorial ?? [])
      .slice()
      .sort((a, b) => a.step - b.step)
      .filter((tip) => tip.step <= tutorial.step + 2)
      .slice(-5);

    return `<div class="fh-gp-scroll">
      ${
        nextEra
          ? `<section class="fh-objective-hero">
              <span class="fh-objective-eyebrow">${icon('era', 'fh-icon is-tiny')} The next age</span>
              <h2 class="display">${esc(nextEra.name)}</h2>
              <p class="serif">${esc(nextEra.desc)}</p>
              <div class="fh-era-requirements">
                ${reqRows
                  .map(
                    (row) => `<div class="fh-era-req ${row.current >= row.target ? 'is-complete' : ''}" ${tipText(`${row.label}: ${fmtInt(row.current)} of ${fmtInt(row.target)}`)}>
                      <span class="fh-era-req-icon">${icon(row.icon, 'fh-icon is-tiny')}</span>
                      <span class="fh-era-req-label">${esc(row.label)}</span>
                      ${meter(row.current, Math.max(1, row.target), { tone: row.current >= row.target ? 'is-good' : 'is-brass' })}
                      <b>${fmtInt(row.current)}<small>/${fmtInt(row.target)}</small></b>
                    </div>`,
                  )
                  .join('')}
              </div>
              <div class="fh-era-unlocks">${icon('spark', 'fh-icon is-tiny')} ${esc(nextEra.unlocksText)}</div>
            </section>`
          : `<section class="fh-objective-hero is-final">
              <span class="fh-objective-eyebrow">${icon('megaproject', 'fh-icon is-tiny')} The last age</span>
              <h2 class="display">${esc(eraDef?.name ?? 'The summit')}</h2>
              <p class="serif">Your people have climbed as far as the authored ages go. What remains is to make it last — great works, a stable society, a valley that remembers you kindly.</p>
            </section>`
      }

      <div class="fh-objectives-grid">
        ${panelSection(
          'Milestones',
          `<div class="fh-milestones">${milestones
            .slice(0, 24)
            .map((m) => {
              const doneTick = s.milestones.completed[m.id];
              const isCurrent = m.id === currentId;
              return `<div class="fh-milestone ${doneTick !== undefined ? 'is-done' : ''} ${isCurrent ? 'is-current' : ''}" ${tip(`<div class="fh-tip-head">${icon(m.icon, 'fh-icon is-small')} ${esc(m.name)}</div><div class="fh-tip-body">${esc(m.desc)}</div><div class="fh-tip-grid"><span>Requires</span><b>${esc(conditionText(m.condition, c))}</b>${doneTick !== undefined ? `<span>Completed</span><b>day ${fmtInt(doneTick)}</b>` : ''}</div>`)}>
                <span class="fh-milestone-icon">${icon(doneTick !== undefined ? 'check' : m.icon, 'fh-icon is-small')}</span>
                <span class="fh-milestone-copy"><b>${esc(m.name)}</b><small>${doneTick !== undefined ? `achieved day ${fmtInt(doneTick)}` : esc(conditionText(m.condition, c))}</small></span>
                ${isCurrent ? `<span class="fh-milestone-tag">now</span>` : ''}
              </div>`;
            })
            .join('')}</div>`,
          `${Object.keys(s.milestones.completed).length} achieved`,
        )}
        ${panelSection(
          'Guidance',
          `<div class="fh-tutorial">
            <div class="fh-tutorial-progress">${meter(Math.min(1, tutorial.step / Math.max(1, (c.tutorial?.length ?? 1))), 1, { tone: 'is-brass' })}<small>step ${tutorial.step + 1}${tutorial.completed ? ' · complete' : ''}</small></div>
            ${
              tips.length
                ? tips
                    .map(
                      (tip) => `<article class="fh-tip-card ${tip.step <= tutorial.step ? 'is-done' : 'is-next'}">
                        <span class="fh-tip-card-num">${roman(tip.step + 1)}</span>
                        <span><b>${esc(tip.title)}</b><p>${esc(tip.body)}</p></span>
                      </article>`,
                    )
                    .join('')
                : `<p class="fh-faint fh-small">No further guidance — your people know the work now.</p>`
            }
          </div>
          <div class="fh-tutorial-actions">
            <button type="button" class="fh-btn is-quiet clickable" data-act="show-firststeps">${icon('objective', 'fh-icon is-tiny')} First steps</button>
            <button type="button" class="fh-btn is-ghost clickable" data-act="replay-tour">${icon('compass', 'fh-icon is-tiny')} Replay tour</button>
            <button type="button" class="fh-btn is-quiet clickable" data-act="open-codex">${icon('book', 'fh-icon is-tiny')} Discoveries</button>
            <button type="button" class="fh-btn is-quiet clickable" data-act="open-society">${icon('scale', 'fh-icon is-tiny')} Society</button>
            <button type="button" class="fh-btn is-quiet clickable" data-act="open-expeditions">${icon('compass', 'fh-icon is-tiny')} Explore</button>
          </div>`,
          tutorial.completed ? 'complete' : `step ${tutorial.step + 1}`,
        )}
      </div>

      <div class="fh-objectives-foot">
        <span ${tipText('The era your people have reached')}>${icon('era', 'fh-icon is-tiny')} Era ${roman(era + 1)} · ${esc(eraDef?.name ?? '—')}</span>
        <span ${tipText('Milestones achieved so far')}>${icon('objective', 'fh-icon is-tiny')} ${Object.keys(s.milestones.completed).length} milestones</span>
        <span ${tipText('Population across all settlements')}>${icon('people', 'fh-icon is-tiny')} ${fmtInt(s.settlements.reduce((n, x) => n + x.population, 0))} people</span>
        <span ${tipText('Achievements earned')}>${icon('star', 'fh-icon is-tiny')} ${(c.achievements ?? []).filter((a) => s.milestones.completed[a.id] !== undefined).length}/${(c.achievements ?? []).length} achievements</span>
      </div>
    </div>`;
  }

  handleAction(act: string): void {
    if (act === 'show-firststeps') this.svc.showFirstSteps();
    else if (act === 'replay-tour') this.svc.startTour(true);
    else if (act === 'open-codex') this.svc.openPanel('codex');
    else if (act === 'open-society') this.svc.openPanel('society');
    else if (act === 'open-expeditions') this.svc.openPanel('expeditions');
  }
}

void chip;
void computeMetric;
void pct;
void scoreTone;
void pretty;
