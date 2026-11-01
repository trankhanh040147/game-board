/**
 * Content registry: merges the authored content packs into a single, validated
 * `Content` object. Content is pure data; this module only indexes and checks it.
 */
import type {
  AchievementDef,
  BiomeDef,
  BranchDef,
  BuildingDef,
  Content,
  Condition,
  DoctrineDef,
  EraDef,
  EventDef,
  EventEffect,
  MegaprojectDef,
  MilestoneDef,
  NamePools,
  PolicyDef,
  ProfessionId,
  RecipeDef,
  ResourceDef,
  SiteDef,
  SkillId,
  TechDef,
  TraitDef,
  TutorialTipDef,
} from '../types';
import { RESOURCES } from './resources';
import { BIOMES } from './biomes';
import { BUILDINGS, RECIPES } from './buildings';
import { SITES } from './sites';
import { BRANCHES, TECHS } from './techs';
import { POLICIES, DOCTRINES, ERAS, MEGAPROJECTS } from './society';
import { EVENTS } from './events';
import { MILESTONES, ACHIEVEMENTS } from './milestones';
import { NAMES, TRAITS, SKILLS, PROFESSIONS } from './people';
import { TUTORIAL } from './tutorial';

export interface ContentValidation {
  errors: string[];
  warnings: string[];
}

function indexById<T extends { id: string }>(items: T[]): Record<string, T> {
  const out: Record<string, T> = {};
  for (const item of items) out[item.id] = item;
  return out;
}

function sortResources(list: ResourceDef[]): ResourceDef[] {
  return [...list].sort((a, b) => a.tier - b.tier || a.category.localeCompare(b.category) || a.name.localeCompare(b.name));
}

function sortBuildings(list: BuildingDef[]): BuildingDef[] {
  return [...list].sort((a, b) => a.era - b.era || a.category.localeCompare(b.category) || a.name.localeCompare(b.name));
}

/** Build the merged content object. */
export function buildContent(): Content {
  const resources = indexById(RESOURCES);
  const buildings = indexById(BUILDINGS);
  const recipes = indexById(RECIPES);
  const techs = indexById(TECHS);
  const branches = indexById(BRANCHES);
  const biomes = indexById(BIOMES);
  const sites = indexById(SITES);
  const events = indexById(EVENTS);
  const policies = indexById(POLICIES);
  const doctrines = indexById(DOCTRINES);
  const megaprojects = indexById(MEGAPROJECTS);
  const traits = indexById(TRAITS);

  const content: Content = {
    version: '1.0.0',
    resources,
    resourceOrder: sortResources(RESOURCES).map((r) => r.id),
    buildings,
    buildingOrder: sortBuildings(BUILDINGS).map((b) => b.id),
    recipes,
    techs,
    techOrder: [...TECHS].sort((a, b) => a.era - b.era || a.cost - b.cost).map((t) => t.id),
    branches,
    biomes,
    biomeOrder: BIOMES.map((b) => b.id),
    sites,
    siteOrder: SITES.map((s) => s.id),
    events,
    eventOrder: EVENTS.map((e) => e.id),
    policies,
    policyOrder: [...POLICIES].sort((a, b) => a.era - b.era).map((p) => p.id),
    doctrines,
    doctrineOrder: [...DOCTRINES].sort((a, b) => a.era - b.era).map((d) => d.id),
    eras: [...ERAS].sort((a, b) => a.index - b.index),
    achievements: ACHIEVEMENTS,
    milestones: MILESTONES,
    megaprojects,
    megaprojectOrder: [...MEGAPROJECTS].sort((a, b) => a.era - b.era).map((m) => m.id),
    names: NAMES as NamePools,
    traits,
    tutorial: TUTORIAL,
    skills: SKILLS as Content['skills'],
    professions: PROFESSIONS as Content['professions'],
  };
  return content;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const METRIC_KEYS = new Set<string>([
  'population', 'adults', 'children', 'elders', 'workforce', 'unemployed', 'homeless', 'housingCapacity', 'housingQuality',
  'food', 'foodDays', 'water', 'waterDays', 'morale', 'health', 'hunger', 'thirst', 'approval', 'stability', 'crime',
  'treasury', 'insight', 'culture', 'influence', 'era', 'techs', 'buildings', 'buildings.industrial', 'pollution',
  'biodiversity', 'forest', 'fertility', 'wildlife', 'beauty', 'drought', 'temperature', 'rain', 'tradeBalance',
  'neighborsMet', 'explored', 'sitesFound', 'settlements', 'taxRate', 'rations', 'workHours', 'policies',
  'births', 'deaths', 'immigrants', 'foodProduced', 'year', 'day', 'season', 'megaprojects', 'roads',
  'capital.population', 'capital.workforce', 'capital.unemployed', 'capital.homeless', 'capital.foodDays',
  'capital.waterDays', 'capital.food', 'capital.water', 'capital.morale', 'capital.stability',
  'capital.housingCapacity', 'capital.treasury', 'capital.insight', 'capital.culture', 'capital.beauty',
  'capital.pollution', 'capital.buildings',
]);

function metricKeyKnown(metric: string): boolean {
  if (METRIC_KEYS.has(metric)) return true;
  if (metric.startsWith('capital.')) return METRIC_KEYS.has(metric) || true; // tolerate capital-scoped aliases
  return false;
}

function validateCondition(cond: Condition, where: string, errors: string[], warnings: string[]): void {
  switch (cond.kind) {
    case 'metric':
      if (!metricKeyKnown(cond.metric)) warnings.push(`${where}: unknown metric "${cond.metric}"`);
      break;
    case 'all':
    case 'any':
      for (const c of cond.conditions) validateCondition(c, where, errors, warnings);
      break;
    case 'not':
      validateCondition(cond.condition, where, errors, warnings);
      break;
    default:
      break;
  }
}

function validateEffects(effects: EventEffect[] | undefined, content: Content, where: string, errors: string[], warnings: string[]): void {
  for (const fx of effects ?? []) {
    switch (fx.kind) {
      case 'stock':
      case 'stockFraction':
        if (!content.resources[fx.resource]) errors.push(`${where}: unknown resource "${fx.resource}"`);
        break;
      case 'tempoModifier':
      case 'settlementModifier':
        if (!(fx.key in content.resources) && !MODIFIER_KEYS_CHECK.has(fx.key)) {
          warnings.push(`${where}: modifier key "${fx.key}" may be unknown`);
        }
        break;
      case 'tileDeposit':
        if (!content.resources[fx.resource]) errors.push(`${where}: unknown deposit resource "${fx.resource}"`);
        break;
      case 'grantTech':
        if (!content.techs[fx.tech]) errors.push(`${where}: unknown tech "${fx.tech}"`);
        break;
      case 'unlockBuilding':
        if (!content.buildings[fx.buildingId]) errors.push(`${where}: unknown building "${fx.buildingId}"`);
        break;
      case 'unlockPolicy':
        if (!content.policies[fx.policy]) errors.push(`${where}: unknown policy "${fx.policy}"`);
        break;
      case 'discoverSite':
        if (fx.siteId && !content.sites[fx.siteId]) warnings.push(`${where}: unknown site "${fx.siteId}"`);
        break;
      case 'scheduleEvent':
        if (!content.events[fx.eventId]) errors.push(`${where}: unknown chained event "${fx.eventId}"`);
        break;
      default:
        break;
    }
  }
}

const MODIFIER_KEYS_CHECK = new Set<string>([
  'workSpeed', 'buildSpeed', 'craftSpeed', 'farmYield', 'orchardYield', 'pastureYield', 'forageYield', 'huntYield',
  'fishYield', 'lumberYield', 'mineYield', 'quarryYield', 'inputEfficiency', 'byproductYield', 'soilRegen',
  'forestRegrow', 'wildlifeRegen', 'pollutionRate', 'pollutionDecay', 'beauty', 'waterAvailability',
  'disasterResist', 'disasterChance', 'foodConsumption', 'waterConsumption', 'healthRate', 'moraleRate', 'moraleFlat',
  'birthRate', 'deathRate', 'migrationRate', 'educationRate', 'housingQuality', 'crimeRate', 'researchRate',
  'insightFlat', 'cultureRate', 'stability', 'taxEfficiency', 'upkeepCost', 'constructionCost', 'storageCap',
  'spoilageRate', 'tradeBuyPrice', 'tradeSellPrice', 'transportCapacity', 'diplomacy', 'combatStrength', 'roadSpeed',
  'expeditionSpeed', 'gatherRadius', 'storageTransferRate',
]);

export function validateContent(content: Content): ContentValidation {
  const errors: string[] = [];
  const warnings: string[] = [];

  const req = (cond: boolean, msg: string) => {
    if (!cond) errors.push(msg);
  };

  req(content.resourceOrder.length >= 20, 'Expected at least 20 resources');
  req(content.buildingOrder.length >= 20, 'Expected at least 20 buildings');
  req(Object.keys(content.recipes).length >= 20, 'Expected at least 20 recipes');
  req(content.biomeOrder.length >= 4, 'Expected at least 4 biomes');
  req(content.techOrder.length >= 20, 'Expected at least 20 techs');
  req(content.policyOrder.length >= 4, 'Expected at least 4 policies');
  req(content.doctrineOrder.length >= 3, 'Expected at least 3 doctrines');
  req(content.eras.length >= 3, 'Expected at least 3 eras');
  req(content.eventOrder.length >= 10, 'Expected at least 10 events');
  req(content.names?.male?.length >= 10 && content.names?.female?.length >= 10, 'Name pools too small');
  req(Object.keys(content.professions).length >= 8, 'Expected at least 8 professions');

  // Resources --- buildings
  for (const id of content.buildingOrder) {
    const b = content.buildings[id];
    if (!b) continue;
    for (const res in b.cost) if (!content.resources[res]) errors.push(`building ${id}: unknown cost resource ${res}`);
    for (const res in b.upkeep) if (!content.resources[res]) errors.push(`building ${id}: unknown upkeep resource ${res}`);
    for (const rid of b.recipes) if (!content.recipes[rid]) errors.push(`building ${id}: unknown recipe ${rid}`);
    for (const job of b.jobs) {
      if (!content.professions[job.profession]) errors.push(`building ${id}: unknown profession ${job.profession}`);
      if (!content.skills[job.skill]) errors.push(`building ${id}: unknown skill ${job.skill}`);
    }
    for (const tech of b.requiresTech) if (!content.techs[tech]) errors.push(`building ${id}: unknown tech ${tech}`);
  }

  // Recipes
  for (const rid in content.recipes) {
    const r: RecipeDef = content.recipes[rid];
    for (const res in r.inputs) if (!content.resources[res]) errors.push(`recipe ${rid}: unknown input ${res}`);
    for (const res in r.outputs) if (!content.resources[res]) errors.push(`recipe ${rid}: unknown output ${res}`);
    if (r.gather && !content.resources[r.gather.resource]) errors.push(`recipe ${rid}: unknown gather resource`);
    if (r.buildingId && !content.buildings[r.buildingId]) errors.push(`recipe ${rid}: unknown building ${r.buildingId}`);
    if (!content.skills[r.skill]) errors.push(`recipe ${rid}: unknown skill ${r.skill}`);
  }

  // Biomes
  for (const id of content.biomeOrder) {
    const b: BiomeDef = content.biomes[id];
    for (const dep of b.deposits) if (!content.resources[dep.resource]) errors.push(`biome ${id}: unknown deposit resource ${dep.resource}`);
    if (!b.color || !b.colorAlt) warnings.push(`biome ${id}: missing colours`);
  }
  if (!Object.values(content.biomes).some((b) => b.walkCost >= 20)) warnings.push('No water/unwalkable biome defined — worldgen may have no ocean');

  // Techs
  for (const id of content.techOrder) {
    const t: TechDef = content.techs[id];
    if (!content.branches[t.branch]) errors.push(`tech ${id}: unknown branch ${t.branch}`);
    for (const r of t.requires) if (!content.techs[r]) errors.push(`tech ${id}: unknown prereq ${r}`);
    for (const r of t.excludes ?? []) if (!content.techs[r]) errors.push(`tech ${id}: unknown exclude ${r}`);
    for (const b of t.unlocksBuildings ?? []) if (!content.buildings[b]) warnings.push(`tech ${id}: unlock building ${b} not found`);
    for (const p of t.unlocksPolicies ?? []) if (!content.policies[p]) warnings.push(`tech ${id}: unlock policy ${p} not found`);
    for (const res in t.bonus?.stock ?? {}) if (!content.resources[res]) errors.push(`tech ${id}: unknown bonus resource ${res}`);
    if (t.cost <= 0) warnings.push(`tech ${id}: zero cost`);
  }
  // Tech cycle check
  const visiting = new Set<string>();
  const done = new Set<string>();
  const visit = (id: string): void => {
    if (done.has(id)) return;
    if (visiting.has(id)) {
      errors.push(`tech cycle involving ${id}`);
      return;
    }
    visiting.add(id);
    const t = content.techs[id];
    for (const r of t?.requires ?? []) if (content.techs[r]) visit(r);
    visiting.delete(id);
    done.add(id);
  };
  for (const id of content.techOrder) visit(id);

  // Policies / doctrines / eras
  for (const id of content.policyOrder) {
    const p: PolicyDef = content.policies[id];
    for (const t of p.requiresTech) if (!content.techs[t]) errors.push(`policy ${id}: unknown tech ${t}`);
    for (const c of p.conflicts ?? []) if (!content.policies[c]) errors.push(`policy ${id}: unknown conflict ${c}`);
  }
  for (const id of content.doctrineOrder) {
    const d: DoctrineDef = content.doctrines[id];
    if (d.uniqueBuilding && !content.buildings[d.uniqueBuilding]) warnings.push(`doctrine ${id}: unknown unique building ${d.uniqueBuilding}`);
  }
  content.eras.forEach((era: EraDef, i) => {
    if (era.index !== i) errors.push(`era ${era.id}: index ${era.index} should be ${i}`);
    for (const d of era.doctrines) if (!content.doctrines[d]) errors.push(`era ${era.id}: unknown doctrine ${d}`);
  });
  for (const id of content.megaprojectOrder) {
    const m: MegaprojectDef = content.megaprojects[id];
    for (const t of m.requiresTech) if (!content.techs[t]) errors.push(`megaproject ${id}: unknown tech ${t}`);
    for (const res in m.cost) if (!content.resources[res]) errors.push(`megaproject ${id}: unknown cost resource ${res}`);
    validateEffects(m.bonus, content, `megaproject ${id}`, errors, warnings);
  }

  // Events
  for (const id of content.eventOrder) {
    const e: EventDef = content.events[id];
    validateCondition(e.condition, `event ${id} condition`, errors, warnings);
    validateEffects(e.autoEffects, content, `event ${id}`, errors, warnings);
    for (const choice of e.choices ?? []) {
      validateEffects(choice.effects, content, `event ${id} choice ${choice.id}`, errors, warnings);
      if (choice.requires) validateCondition(choice.requires, `event ${id} choice ${choice.id}`, errors, warnings);
      for (const res in choice.cost ?? {}) if (!content.resources[res]) errors.push(`event ${id}: unknown choice cost resource ${res}`);
    }
    for (const link of e.chain ?? []) if (!content.events[link.eventId]) errors.push(`event ${id}: unknown chained event ${link.eventId}`);
    if (!e.choices?.length && !e.autoEffects?.length) warnings.push(`event ${id}: has no effects and no choices`);
  }

  // Sites
  for (const id of content.siteOrder) {
    const s: SiteDef = content.sites[id];
    validateEffects(s.effects, content, `site ${id}`, errors, warnings);
  }

  // Milestones / achievements
  for (const m of content.milestones as MilestoneDef[]) {
    if (!m.id) errors.push('milestone without id');
    validateCondition(m.condition, `milestone ${m.id}`, errors, warnings);
  }
  for (const a of content.achievements as AchievementDef[]) {
    if (!a.id) errors.push('achievement without id');
    validateCondition(a.condition, `achievement ${a.id}`, errors, warnings);
  }

  // Tutorial
  for (const tip of content.tutorial as TutorialTipDef[]) {
    validateCondition(tip.condition, `tutorial ${tip.id}`, errors, warnings);
  }

  // Names / metadata
  if (!content.names?.settlementPrefix?.length) warnings.push('No settlement prefixes; names will be generic');
  if (!content.names?.neighborNames?.length) warnings.push('No neighbour civ names');

  return { errors, warnings };
}

// ---------------------------------------------------------------------------
// Singleton accessor
// ---------------------------------------------------------------------------

let cached: Content | null = null;

export function getContent(): Content {
  if (cached) return cached;
  cached = buildContent();
  return cached;
}

export function getValidation(): ContentValidation {
  return validateContent(getContent());
}

export type {
  AchievementDef,
  BiomeDef,
  BranchDef,
  BuildingDef,
  Content,
  DoctrineDef,
  EraDef,
  EventDef,
  MegaprojectDef,
  MilestoneDef,
  PolicyDef,
  RecipeDef,
  ResourceDef,
  SiteDef,
  TechDef,
  TraitDef,
  TutorialTipDef,
  SkillId,
  ProfessionId,
};
