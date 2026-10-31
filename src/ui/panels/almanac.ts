/**
 * Almanac: canvas charts of the tracked metrics, the chronicle grouped by year,
 * and the achievement board.
 */
import { dateLabel, yearOf } from '../../sim/core';
import { drawLineChart, type ChartTone } from '../charts';
import { icon } from '../icons';
import {
  esc,
  fmt,
  fmtInt,
  pct,
  pretty,
  seriesLast,
  seriesSlope,
  signed,
  stateOf,
  tip,
  tipText,
  toneClass,
  type Services,
} from '../util';
import { panelSection, type GamePanel, type PanelHost } from './host';

interface ChartSpec {
  key: string;
  label: string;
  tone: ChartTone;
  icon: string;
  hint: string;
  format?: (v: number) => string;
  scale?: number;
}

const CHARTS: ChartSpec[] = [
  { key: 'population', label: 'Population', tone: 'ember', icon: 'people', hint: 'Total souls alive across every settlement.' },
  { key: 'foodDays', label: 'Food reserves', tone: 'good', icon: 'wheat', hint: 'Days of food in the granary at current consumption.', format: (v) => `${fmt(v)}d` },
  { key: 'morale', label: 'Morale', tone: 'brass', icon: 'heart', hint: 'Average spirits of your people.' },
  { key: 'health', label: 'Health', tone: 'info', icon: 'hospital', hint: 'Average physical condition.' },
  { key: 'treasury', label: 'Treasury', tone: 'brass', icon: 'coin', hint: 'Coin held across settlements.' },
  { key: 'pollution', label: 'Pollution', tone: 'bad', icon: 'cloud', hint: 'Average pollution over claimed land.', scale: 100, format: (v) => fmt(v * 100, 0) + '%' },
  { key: 'insight', label: 'Insight', tone: 'violet', icon: 'star', hint: 'Unspent insight, the fuel of discovery.' },
  { key: 'biodiversity', label: 'Biodiversity', tone: 'good', icon: 'leaf', hint: 'The living richness of the valley.', scale: 100, format: (v) => fmt(v * 100, 0) + '%' },
];

export class AlmanacPanel implements GamePanel {
  readonly id = 'almanac' as const;
  readonly subtitle = 'Charts and chronicle of the years';
  private range = 120;

  constructor(private readonly svc: Services) {}

  eyebrow(): string {
    return 'The Almanac';
  }

  title(): string {
    return 'The Long Record';
  }

  render(): string {
    const s = stateOf(this.svc);
    const c = this.svc.app.content;
    const chartCards = CHARTS.map((spec) => {
      const series = s.metrics.series[spec.key] ?? [];
      const last = series.length ? series[series.length - 1] : 0;
      const slope = seriesSlope(s, spec.key, 12);
      return `<figure class="fh-chart-card" ${tipText(spec.hint)}>
        <figcaption>
          <span class="fh-chart-title">${icon(spec.icon, 'fh-icon is-tiny')}${esc(spec.label)}</span>
          <span class="fh-chart-value">${esc(spec.format ? spec.format(last) : fmt(last))}<small class="${toneClass(slope)}">${signed(spec.format ? slope * (spec.scale ? 100 : 1) : slope, 1)}/d</small></span>
        </figcaption>
        <canvas class="fh-chart-canvas" data-chart="${spec.key}" height="118" aria-label="${esc(spec.label)} chart"></canvas>
      </figure>`;
    }).join('');

    const chronicle = [...s.chronicle].sort((a, b) => b.tick - a.tick).slice(0, 70);
    const byYear = new Map<number, typeof chronicle>();
    for (const entry of chronicle) {
      const list = byYear.get(entry.year) ?? [];
      list.push(entry);
      byYear.set(entry.year, list);
    }
    const years = [...byYear.keys()].sort((a, b) => b - a);

    const achievements = c.achievements ?? [];
    const completed = achievements.filter((a) => s.milestones.completed[a.id] !== undefined);
    const achCards = achievements
      .map((a) => {
        const done = s.milestones.completed[a.id] !== undefined;
        const hidden = a.hidden && !done;
        return `<article class="fh-achievement ${done ? 'is-done' : ''}" ${tipText(hidden ? 'A hidden achievement.' : a.desc)}>
          <span class="fh-ach-icon">${icon(done || !hidden ? a.icon : 'help', 'fh-icon is-small')}</span>
          <span><b>${esc(hidden ? '???' : a.name)}</b><small>${esc(hidden ? 'not yet discovered' : a.desc)}</small></span>
          ${done ? `<span class="fh-ach-check">${icon('check', 'fh-icon is-tiny')}</span>` : ''}
        </article>`;
      })
      .join('');

    return `
      <div class="fh-gp-scroll">
        <div class="fh-almanac-toolbar">
          <span class="fh-almanac-note">${icon('chart', 'fh-icon is-tiny')} ${fmtInt(s.metrics.series.population?.length ?? 0)} days on record · ${fmtInt(s.chronicle.length)} chronicle entries · ${completed.length}/${achievements.length} achievements</span>
          <div class="fh-seg" role="group" aria-label="Chart range">
            ${[
              [60, 'Season'],
              [120, 'Year'],
              [260, 'Long span'],
              [420, 'All'],
            ]
              .map(([value, label]) => `<button type="button" class="fh-seg-btn clickable ${this.range === value ? 'is-active' : ''}" data-act="range" data-range="${value}" aria-pressed="${this.range === value}">${label}</button>`)
              .join('')}
          </div>
        </div>
        <div class="fh-charts-grid">${chartCards}</div>

        ${panelSection(
          'The chronicle',
          `<div class="fh-chronicle">${
            years.length
              ? years
                  .map(
                    (year) => `<div class="fh-chron-year"><span class="fh-chron-year-tag">Year ${year}</span>
                      ${(byYear.get(year) ?? [])
                        .map(
                          (entry) =>
                            `<article class="fh-chron-entry is-${entry.kind} is-importance-${entry.importance}">
                              <span class="fh-chron-dot" aria-hidden="true"></span>
                              <span class="fh-chron-copy">
                                <span class="fh-chron-head"><b>${esc(entry.title)}</b><small>${esc(dateLabel(entry.tick))} · ${esc(pretty(entry.kind))}</small></span>
                                <p class="serif">${esc(entry.body)}</p>
                              </span>
                            </article>`,
                        )
                        .join('')}
                    </div>`,
                  )
                  .join('')
              : '<p class="fh-faint">The chronicle is empty. History begins when something happens.</p>'
          }</div>`,
          `${fmtInt(s.chronicle.length)} entries`,
          'Every year is kept: discoveries, disasters, festivals and foundings.',
        )}

        ${panelSection(
          'Achievements',
          `<div class="fh-ach-grid">${achCards || '<p class="fh-faint">No achievements authored yet.</p>'}</div>`,
          `${completed.length} earned`,
        )}

        <div class="fh-almanac-foot">
          <span ${tipText('Days survived since the first hearth was lit')}>${icon('hourglass', 'fh-icon is-tiny')} ${fmtInt(s.tick)} days endured</span>
          <span ${tipText('Total people born into your civilisation')}>${icon('seed', 'fh-icon is-tiny')} ${fmtInt(s.stats.citizensBorn)} born</span>
          <span ${tipText('Total deaths recorded')}>${icon('skull', 'fh-icon is-tiny')} ${fmtInt(s.stats.citizensDied)} lost</span>
          <span ${tipText('Trees planted by your people')}>${icon('tree', 'fh-icon is-tiny')} ${fmtInt(s.stats.treesPlanted)} planted</span>
          <span ${tipText('Sites discovered in the valley')}>${icon('eye', 'fh-icon is-tiny')} ${pct(s.exploration.mapReveal)} charted</span>
        </div>
      </div>`;
  }

  afterRender(body: HTMLElement): void {
    const s = stateOf(this.svc);
    const range = this.range;
    for (const canvas of body.querySelectorAll<HTMLCanvasElement>('[data-chart]')) {
      const key = canvas.dataset.chart ?? '';
      const spec = CHARTS.find((x) => x.key === key);
      if (!spec) continue;
      const series = s.metrics.series[key] ?? [];
      const values = series.slice(Math.max(0, series.length - range)).map((v) => (spec.scale ? v * spec.scale : v));
      if (!values.length) {
        drawLineChart(canvas, [], { tone: spec.tone, emptyLabel: 'No days recorded yet' });
        continue;
      }
      drawLineChart(canvas, values, { tone: spec.tone, format: spec.format ?? ((v: number) => fmt(v)), max: spec.scale });
    }
  }

  handleAction(act: string, el: HTMLElement, host: PanelHost): void {
    if (act === 'range') {
      this.range = Number(el.dataset.range) || 120;
      host.reload();
    }
  }
}

// Helpers kept for future panels.
void seriesLast;
void yearOf;
