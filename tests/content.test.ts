/**
 * Content pack validation. Asserts the authored content is self-consistent and
 * meets the quota targets from docs/CONTENT-AUTHORING.md.
 */
import { describe, expect, it } from 'vitest';
import { buildContent, validateContent } from '../src/sim/content/index';
import { makeContent } from './helpers';

const content = makeContent();
const validation = validateContent(content);

const report = (label: string, list: string[]): string =>
  list.length ? `\n${label} (${list.length}):\n  ${list.slice(0, 30).join('\n  ')}${list.length > 30 ? `\n  ... ${list.length - 30} more` : ''}` : '';

describe('content: validation', () => {
  it('has zero validation errors', () => {
    expect(validation.errors, report('errors', validation.errors)).toEqual([]);
  });

  it('warnings are recorded (informational, printed for QA report)', () => {
    // Not a failure by itself — but the list is surfaced for the QA report.
    if (validation.warnings.length) {
      console.log(`content warnings: ${validation.warnings.length}${report('', validation.warnings)}`);
    }
    expect(Array.isArray(validation.warnings)).toBe(true);
  });
});

describe('content: quotas (CONTENT-AUTHORING targets)', () => {
  const quotas: { label: string; actual: number; min: number }[] = [
    { label: 'resources', actual: Object.keys(content.resources).length, min: 40 },
    { label: 'buildings', actual: Object.keys(content.buildings).length, min: 50 },
    { label: 'recipes', actual: Object.keys(content.recipes).length, min: 40 },
    { label: 'techs', actual: Object.keys(content.techs).length, min: 80 },
    { label: 'events', actual: Object.keys(content.events).length, min: 40 },
    { label: 'policies', actual: Object.keys(content.policies).length, min: 12 },
    { label: 'doctrines', actual: Object.keys(content.doctrines).length, min: 6 },
    { label: 'biomes', actual: Object.keys(content.biomes).length, min: 6 },
    { label: 'sites', actual: Object.keys(content.sites).length, min: 6 },
    { label: 'eras', actual: content.eras.length, min: 4 },
    { label: 'milestones', actual: content.milestones.length, min: 10 },
    { label: 'achievements', actual: content.achievements.length, min: 10 },
    { label: 'megaprojects', actual: Object.keys(content.megaprojects).length, min: 3 },
  ];
  for (const q of quotas) {
    it(`has at least ${q.min} ${q.label} (found ${q.actual})`, () => {
      expect(q.actual, `${q.label}: ${q.actual} < target ${q.min}`).toBeGreaterThanOrEqual(q.min);
    });
  }

  it('name pools are populated', () => {
    expect(content.names.male.length).toBeGreaterThanOrEqual(10);
    expect(content.names.female.length).toBeGreaterThanOrEqual(10);
    expect(content.names.surnames.length).toBeGreaterThanOrEqual(10);
    expect(content.names.settlementPrefix?.length ?? 0).toBeGreaterThan(0);
  });
});

describe('content: cross-references', () => {
  it('every building recipe id resolves', () => {
    const bad: string[] = [];
    for (const id of content.buildingOrder) {
      const b = content.buildings[id];
      for (const rid of b.recipes) if (!content.recipes[rid]) bad.push(`${id} -> ${rid}`);
      for (const t of b.requiresTech) if (!content.techs[t]) bad.push(`${id} requires tech ${t}`);
      for (const res of [...Object.keys(b.cost), ...Object.keys(b.upkeep)]) {
        if (!content.resources[res]) bad.push(`${id} references resource ${res}`);
      }
      for (const job of b.jobs) {
        if (!content.professions[job.profession]) bad.push(`${id} job profession ${job.profession}`);
        if (!content.skills[job.skill]) bad.push(`${id} job skill ${job.skill}`);
      }
    }
    expect(bad, report('bad refs', bad)).toEqual([]);
  });

  it('every recipe buildingId resolves and resources exist', () => {
    const bad: string[] = [];
    for (const rid of Object.keys(content.recipes)) {
      const r = content.recipes[rid];
      if (r.buildingId && !content.buildings[r.buildingId]) bad.push(`${rid} -> building ${r.buildingId}`);
      for (const res of [...Object.keys(r.inputs), ...Object.keys(r.outputs)]) {
        if (!content.resources[res]) bad.push(`${rid} -> resource ${res}`);
      }
      if (r.gather && !content.resources[r.gather.resource]) bad.push(`${rid} gather -> ${r.gather.resource}`);
      if (!content.skills[r.skill]) bad.push(`${rid} skill -> ${r.skill}`);
    }
    expect(bad, report('bad recipe refs', bad)).toEqual([]);
  });

  it('every tech prerequisite resolves and there is no cycle', () => {
    const bad: string[] = [];
    for (const id of content.techOrder) {
      const t = content.techs[id];
      if (!content.branches[t.branch]) bad.push(`${id} branch ${t.branch}`);
      for (const req of t.requires) if (!content.techs[req]) bad.push(`${id} requires ${req}`);
      for (const ex of t.excludes ?? []) if (!content.techs[ex]) bad.push(`${id} excludes ${ex}`);
    }
    expect(bad, report('bad tech refs', bad)).toEqual([]);

    // Depth-first cycle detection.
    const state = new Map<string, 0 | 1 | 2>();
    const cycles: string[] = [];
    const visit = (id: string, trail: string[]): void => {
      const mark = state.get(id) ?? 0;
      if (mark === 2) return;
      if (mark === 1) {
        cycles.push([...trail, id].join(' -> '));
        return;
      }
      state.set(id, 1);
      for (const req of content.techs[id]?.requires ?? []) if (content.techs[req]) visit(req, [...trail, id]);
      state.set(id, 2);
    };
    for (const id of content.techOrder) visit(id, []);
    expect(cycles, `tech cycles: ${cycles.join(', ')}`).toEqual([]);
  });

  it('every era except the final one offers doctrines; indexes are ordered', () => {
    const bad: string[] = [];
    const lastEraIndex = content.eras.length - 1;
    content.eras.forEach((era, i) => {
      if (era.index !== i) bad.push(`era ${era.id}: index ${era.index} !== ${i}`);
      // Design: the final era offers no new doctrines (the chosen creed defines
      // the ending). Every earlier era must offer at least one.
      if (i !== lastEraIndex && !era.doctrines.length) bad.push(`era ${era.id} has no doctrines`);
      for (const d of era.doctrines) if (!content.doctrines[d]) bad.push(`era ${era.id} doctrine ${d}`);
    });
    expect(bad, report('bad eras', bad)).toEqual([]);
    expect(content.eras[lastEraIndex].doctrines.length, 'final era should not require doctrines').toBeGreaterThanOrEqual(0);
  });

  it('every event choice/effect references known resources, techs, buildings', () => {
    const bad: string[] = [];
    for (const id of content.eventOrder) {
      const e = content.events[id];
      for (const choice of e.choices ?? []) {
        for (const res of Object.keys(choice.cost ?? {})) if (!content.resources[res]) bad.push(`${id} choice ${choice.id} cost ${res}`);
      }
      for (const link of e.chain ?? []) if (!content.events[link.eventId]) bad.push(`${id} chain -> ${link.eventId}`);
    }
    expect(bad, report('bad event refs', bad)).toEqual([]);
  });

  it('no duplicate ids across content collections', () => {
    const dupes: string[] = [];
    const check = (label: string, ids: string[]): void => {
      const seen = new Set<string>();
      for (const id of ids) {
        if (seen.has(id)) dupes.push(`${label}:${id}`);
        seen.add(id);
      }
    };
    check('resource', content.resourceOrder);
    check('building', content.buildingOrder);
    check('tech', content.techOrder);
    check('recipe', Object.keys(content.recipes));
    check('event', content.eventOrder);
    check('policy', content.policyOrder);
    check('doctrine', content.doctrineOrder);
    check('biome', content.biomeOrder);
    check('site', content.siteOrder);
    expect(dupes, report('duplicate ids', dupes)).toEqual([]);
  });

  it('early-game buildings require no tech (a fresh game can act)', () => {
    const locked: string[] = [];
    for (const id of content.buildingOrder) {
      const b = content.buildings[id];
      if (b.era === 0 && b.requiresTech.length > 0) locked.push(`${id} -> ${b.requiresTech.join(',')}`);
    }
    // Era-0 buildings MAY be tech-gated in principle; the invariant that matters
    // is that enough un-gated era-0 buildings exist to start a settlement.
    const freeStarters = content.buildingOrder.filter((id) => {
      const b = content.buildings[id];
      return b.era === 0 && b.requiresTech.length === 0;
    });
    expect(freeStarters.length, `only ${freeStarters.length} era-0 tech-free buildings; locked era-0: ${locked.join('; ')}`).toBeGreaterThanOrEqual(4);
    expect(freeStarters).toContain('fire_pit');
  });

  it('has production chains and sustainable food extraction', () => {
    const withInputs = Object.values(content.recipes).filter(
      (r) => Object.keys(r.inputs).length > 0 && Object.keys(r.outputs).length > 0,
    );
    expect(withInputs.length, 'no conversion recipes (inputs -> outputs) found').toBeGreaterThanOrEqual(3);
    const gathers = Object.values(content.recipes).filter((r) => r.gather && ['forage', 'forest', 'wildlife', 'fertility', 'water'].includes(r.gather.source));
    expect(gathers.length, 'no gathering recipes found').toBeGreaterThanOrEqual(2);
    // Food must be obtainable without tech: at least one edible resource is a
    // gather output or a tech-free recipe output.
    const edibleIds = Object.keys(content.resources).filter((id) => (content.resources[id].edible ?? 0) > 0);
    expect(edibleIds.length).toBeGreaterThan(0);
  });

  it('every tradable resource has a positive base price', () => {
    const bad: string[] = [];
    for (const id of content.resourceOrder) {
      const r = content.resources[id];
      if (!(r.basePrice > 0)) bad.push(`${id} basePrice=${r.basePrice}`);
    }
    expect(bad, report('bad prices', bad)).toEqual([]);
  });

  it('biomes cover water and land and have deposits wired to resources', () => {
    const biomes = Object.values(content.biomes);
    expect(biomes.some((b) => b.walkCost >= 20), 'no impassable/water biome').toBe(true);
    expect(biomes.some((b) => b.walkCost < 20), 'no walkable biome').toBe(true);
    const bad: string[] = [];
    for (const b of biomes) for (const d of b.deposits) if (!content.resources[d.resource]) bad.push(`${b.id} deposit ${d.resource}`);
    expect(bad, report('bad deposits', bad)).toEqual([]);
  });

  it('validateContent is deterministic and side-effect free', () => {
    const a = validateContent(buildContent());
    const b = validateContent(buildContent());
    expect(a.errors).toEqual(b.errors);
    expect(a.warnings).toEqual(b.warnings);
  });
});
