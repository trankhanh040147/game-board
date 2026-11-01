/**
 * People: the shape of your population — pyramid, professions, happiness and a
 * searchable roster of notable citizens.
 */
import { livingCitizens } from '../../sim/core';
import { icon } from '../icons';
import {
  citizenClassOf,
  classTone,
  esc,
  escAttr,
  fmt,
  fmtInt,
  meter,
  pct,
  pct100,
  pretty,
  professionIcon,
  professionLabel,
  scoreTone,
  selectedSettlement,
  stateOf,
  tip,
  tipText,
  toneClass,
  type Services,
} from '../util';
import { panelSection, type GamePanel, type PanelHost } from './host';

const AGE_BANDS: { label: string; min: number; max: number }[] = [
  { label: '76+', min: 76, max: 200 },
  { label: '61–75', min: 61, max: 75 },
  { label: '46–60', min: 46, max: 60 },
  { label: '31–45', min: 31, max: 45 },
  { label: '16–30', min: 16, max: 30 },
  { label: '0–15', min: 0, max: 15 },
];

export class PeoplePanel implements GamePanel {
  readonly id = 'people' as const;
  readonly subtitle = 'Who your settlement is made of';
  private search = '';
  private notableOnly = false;
  private growth = 0;

  constructor(private readonly svc: Services) {}

  eyebrow(): string {
    return 'The Ledger';
  }

  title(): string {
    return 'People';
  }

  render(): string {
    const s = stateOf(this.svc);
    const c = this.svc.app.content;
    const st = selectedSettlement(this.svc);
    const all = livingCitizens(s);
    const citizens = all.filter((x) => x.settlementId === (st?.id ?? x.settlementId));
    const pop = citizens.length + s.cohorts.filter((x) => x.settlementId === (st?.id ?? -1)).reduce((n, x) => n + x.count, 0);
    const children = citizens.filter((x) => x.age < 16).length;
    const elders = citizens.filter((x) => x.age >= 62).length;
    const adults = citizens.length - children;
    const workforce = st?.workforce ?? 0;
    const unemployed = st?.unemployed ?? 0;
    const homeless = st?.homeless ?? 0;
    const avgMorale = citizens.length ? citizens.reduce((n, x) => n + x.morale, 0) / citizens.length : 0;
    const avgHealth = citizens.length ? citizens.reduce((n, x) => n + x.health, 0) / citizens.length : 0;
    const avgEducation = citizens.length ? citizens.reduce((n, x) => n + x.education, 0) / citizens.length : 0;
    const popSeries = s.metrics.series.population ?? [];
    const prevPop = popSeries.length > 16 ? popSeries[popSeries.length - 16] : popSeries[0] ?? pop;
    this.growth = pop - prevPop;

    const professions = new Map<string, number>();
    for (const citizen of citizens) professions.set(citizen.profession as string, (professions.get(citizen.profession as string) ?? 0) + 1);
    const topProfessions = [...professions.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12);

    const buckets = [0, 20, 40, 60, 80].map((min) => {
      const max = min + 20;
      const count = citizens.filter((x) => x.morale >= min && (min === 80 ? x.morale <= 100 : x.morale < max)).length;
      return { min, max, count };
    });
    const bucketMax = Math.max(1, ...buckets.map((b) => b.count));

    const pyramid = AGE_BANDS.map((band) => {
      const males = citizens.filter((x) => x.age >= band.min && x.age <= band.max && x.sex === 'm').length;
      const females = citizens.filter((x) => x.age >= band.min && x.age <= band.max && x.sex === 'f').length;
      return { ...band, males, females };
    });
    const pyramidMax = Math.max(1, ...pyramid.map((b) => Math.max(b.males, b.females)));

    const search = this.search.trim().toLowerCase();
    const pool = citizens
      .filter((x) => !search || `${x.name} ${x.surname} ${x.profession}`.toLowerCase().includes(search))
      .filter((x) => !this.notableOnly || x.notable)
      .sort((a, b) => (b.notable ? 1 : 0) - (a.notable ? 1 : 0) || b.age - a.age);
    const shown = pool.slice(0, 160);

    return `
      <div class="fh-gp-scroll">
        <div class="fh-people-summary">
          <div class="fh-sum-card"><span class="fh-sum-label">${icon('people', 'fh-icon is-tiny')} Population</span><b>${fmtInt(pop)}</b><small class="${toneClass(this.growth)}">${this.growth >= 0 ? '+' : ''}${fmtInt(this.growth)} this season</small></div>
          <div class="fh-sum-card"><span class="fh-sum-label">${icon('hammer', 'fh-icon is-tiny')} Workforce</span><b>${fmtInt(workforce)}</b><small>${fmtInt(unemployed)} seeking work</small></div>
          <div class="fh-sum-card"><span class="fh-sum-label">${icon('heart', 'fh-icon is-tiny')} Average morale</span><b class="${scoreTone(avgMorale)}">${pct100(avgMorale)}</b><small>health ${pct100(avgHealth)}</small></div>
          <div class="fh-sum-card"><span class="fh-sum-label">${icon('book', 'fh-icon is-tiny')} Learning</span><b>${pct100(avgEducation)}</b><small>${homeless} homeless</small></div>
        </div>

        <div class="fh-people-grid">
          ${panelSection(
            'Age & sex',
            `<div class="fh-pyramid">
              ${pyramid
                .map(
                  (band) => `<div class="fh-pyramid-row" ${tipText(`${band.label} years — ${band.males} men, ${band.females} women`)}>
                    <span class="fh-pyramid-side is-m"><i style="width:${Math.round((band.males / pyramidMax) * 100)}%"></i><b>${band.males || ''}</b></span>
                    <span class="fh-pyramid-label">${band.label}</span>
                    <span class="fh-pyramid-side is-f"><i style="width:${Math.round((band.females / pyramidMax) * 100)}%"></i><b>${band.females || ''}</b></span>
                  </div>`,
                )
                .join('')}
            </div>
            <div class="fh-pyramid-legend"><span><i class="is-m"></i>men</span><span><i class="is-f"></i>women</span><span class="fh-faint">${adults} adults · ${children} children · ${elders} elders</span></div>`,
            `${citizens.length} detailed`,
          )}
          ${panelSection(
            'Happiness',
            `<div class="fh-barlist">
              ${buckets
                .map(
                  (b) => `<div class="fh-barrow fh-happy-row" ${tipText(`${b.count} people with morale ${b.min}–${b.max}`)}><span>${b.min}–${b.max}</span>${meter(b.count, bucketMax, { tone: b.min >= 60 ? 'is-good' : b.min >= 40 ? 'is-warn' : 'is-bad' })}<b>${b.count}</b></div>`,
                )
                .join('')}
            </div>
            <p class="fh-faint fh-small">Morale below 40 pushes people to leave; below 20 the hearth is in danger.</p>`,
            'morale bands',
          )}
        </div>

        ${panelSection(
          'Professions',
          `<div class="fh-profgrid">${topProfessions
            .map(
              ([prof, count]) =>
                `<div class="fh-prof" ${tipText(`${professionLabel(c, prof)} — ${count} people`)}>${icon(professionIcon(c, prof), 'fh-icon is-small')}<span><b>${esc(professionLabel(c, prof))}</b><small>${count} · ${esc(pretty(c.professions[prof]?.class ?? 'laborer'))}</small></span></div>`,
            )
            .join('')}</div>
          ${!topProfessions.length ? '<p class="fh-faint fh-small">No detailed population in this settlement.</p>' : ''}`,
          `${topProfessions.length} callings`,
        )}

        <div class="fh-gp-section">
          <div class="fh-gp-section-head">
            <h3>Citizens</h3>
            <span class="fh-gp-section-extra">${fmtInt(pool.length)} match${pool.length === 1 ? '' : 'es'}</span>
          </div>
          <div class="fh-people-toolbar">
            <label class="fh-search fh-search-inline">
              <span class="fh-search-icon">${icon('search', 'fh-icon is-small')}</span>
              <input type="search" placeholder="Search by name or calling…" data-people-search data-focus-key="people-search" value="${escAttr(this.search)}" aria-label="Search citizens" autocomplete="off" spellcheck="false" />
            </label>
            <button type="button" class="fh-toggle clickable ${this.notableOnly ? 'is-on' : ''}" data-act="notable-only" aria-pressed="${this.notableOnly}">${icon('star', 'fh-icon is-tiny')}<span>Notable only</span></button>
          </div>
          <div class="fh-people-list" role="list">
            ${
              shown.length
                ? shown
                    .map((citizen) => {
                      const cls = citizenClassOf(c, citizen);
                      const job = citizen.jobBuildingId >= 0 ? s.buildings.find((b) => b.id === citizen.jobBuildingId) : null;
                      const jobDef = job ? c.buildings[job.typeId] : null;
                      return `<button type="button" role="listitem" class="fh-person clickable" data-act="select-citizen" data-citizen="${citizen.id}" ${tip(`<div class="fh-tip-head">${icon('person', 'fh-icon is-small')} ${esc(citizen.name)} ${esc(citizen.surname)}</div><div class="fh-tip-body">${Math.floor(citizen.age)} winters · ${esc(professionLabel(c, citizen.profession))} · ${esc(pretty(cls))}</div><div class="fh-tip-grid"><span>Morale</span><b>${pct100(citizen.morale)}</b><span>Health</span><b>${pct100(citizen.health)}</b><span>Home</span><b>${citizen.homeBuildingId >= 0 ? 'housed' : 'homeless'}</b><span>Work</span><b>${jobDef ? esc(jobDef.name) : 'unemployed'}</b></div>`)}>
                        <span class="fh-person-avatar ${citizen.sex === 'f' ? 'is-f' : 'is-m'}">${esc(citizen.name.charAt(0))}</span>
                        <span class="fh-person-copy">
                          <span class="fh-person-name">${citizen.notable ? icon('star', 'fh-icon is-tiny') : ''}${esc(citizen.name)} ${esc(citizen.surname)}</span>
                          <small>${Math.floor(citizen.age)} · ${esc(professionLabel(c, citizen.profession))}${jobDef ? ` at ${esc(jobDef.name)}` : ''}</small>
                        </span>
                        <span class="fh-person-chips">
                          <span class="fh-chip ${classTone(cls)}">${esc(pretty(cls))}</span>
                          ${citizen.traits.slice(0, 1).map((t) => `<span class="fh-chip is-neutral">${esc(c.traits[t]?.name ?? pretty(t))}</span>`).join('')}
                        </span>
                        <span class="fh-person-morale">${meter(citizen.morale, 100, { tone: scoreTone(citizen.morale) })}</span>
                      </button>`;
                    })
                    .join('')
                : `<div class="fh-empty"><p class="fh-empty-title">No one matches</p><p class="fh-empty-body">Try another name or clear the search.</p></div>`
            }
          </div>
          ${pool.length > shown.length ? `<p class="fh-faint fh-small fh-list-cap">Showing ${shown.length} of ${pool.length} — refine the search to see the rest.</p>` : ''}
        </div>
      </div>`;
  }

  handleInput(input: HTMLInputElement): void {
    if (input.hasAttribute('data-people-search')) {
      this.search = input.value;
      this.hostRef?.reload();
    }
  }

  private hostRef: PanelHost | null = null;

  afterRender(_body: HTMLElement, host: PanelHost): void {
    this.hostRef = host;
  }

  handleAction(act: string, el: HTMLElement, host: PanelHost): void {
    if (act === 'select-citizen') {
      const id = Number(el.dataset.citizen);
      if (Number.isFinite(id)) {
        this.svc.app.view.selectedBuildingId = -1;
        this.svc.app.view.selectedTile = -1;
        this.svc.app.selectCitizen(id);
        host.close();
      }
    } else if (act === 'notable-only') {
      this.notableOnly = !this.notableOnly;
      host.reload();
    }
  }
}
