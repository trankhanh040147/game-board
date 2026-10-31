/**
 * FIRST HEARTH — People Content
 * -----------------------------
 * Name pools, personality traits, skill metadata and profession metadata.
 *
 * PROFESSIONS must cover every profession id used in BuildingDef.jobs and
 * RecipeDef workforce definitions. The canonical set (23) is fixed with
 * content-econ; a few extra support professions are added for depth.
 *
 * Classes: laborer, artisan, scholar, merchant.
 */

import type { NamePools, ProfessionId, SkillId, TraitDef } from '../types';

// ---------------------------------------------------------------------------
// NAMES
// ---------------------------------------------------------------------------

export const NAMES: NamePools = {
  male: [
    'Alden', 'Ansel', 'Arlo', 'Bain', 'Bram', 'Cade', 'Calder', 'Callum', 'Corin', 'Coyle',
    'Dain', 'Dorn', 'Eamon', 'Edric', 'Ewan', 'Fenn', 'Garrick', 'Gil', 'Hale', 'Hew',
    'Idris', 'Ivo', 'Jory', 'Kellen', 'Kerr', 'Kestrel', 'Larkin', 'Lorcan', 'Merrick', 'Milo',
    'Nyle', 'Orin', 'Orrin', 'Osric', 'Pace', 'Pell', 'Perrin', 'Quinn', 'Rafe', 'Ren',
    'Rowan', 'Rurik', 'Soren', 'Stellan', 'Tarn', 'Teren', 'Thorne', 'Tobin', 'Tomas', 'Ulric',
    'Vane', 'Wren', 'Wystan', 'Yates', 'Zane', 'Briar', 'Colm', 'Derry', 'Emrys', 'Fitch',
  ],
  female: [
    'Ada', 'Aila', 'Alba', 'Anwen', 'Arden', 'Berta', 'Briony', 'Cass', 'Celandine', 'Clara',
    'Cora', 'Dara', 'Della', 'Elin', 'Elowen', 'Emer', 'Enid', 'Esme', 'Fara', 'Fenna',
    'Greta', 'Hana', 'Hesper', 'Ilse', 'Iona', 'Iris', 'Isolde', 'Juna', 'Katra', 'Lark',
    'Lena', 'Liora', 'Mabel', 'Maren', 'Merrit', 'Mira', 'Nessa', 'Nola', 'Oda', 'Orla',
    'Rae', 'Rhea', 'Rosalind', 'Sable', 'Sena', 'Signe', 'Sora', 'Tansy', 'Tara', 'Tessa',
    'Thea', 'Una', 'Veda', 'Vela', 'Wren', 'Yara', 'Zinnia', 'Blythe', 'Carys', 'Dove',
  ],
  surnames: [
    'Alder', 'Ashdown', 'Barrow', 'Birch', 'Blackwood', 'Bramble', 'Brook', 'Bywater', 'Carter', 'Clay',
    'Cobb', 'Cooper', 'Croft', 'Dale', 'Downing', 'Drake', 'Drift', 'Eames', 'Farrow', 'Fell',
    'Fenwick', 'Field', 'Flint', 'Ford', 'Fox', 'Frost', 'Gale', 'Gorse', 'Grant', 'Green',
    'Hallow', 'Harrow', 'Heath', 'Hedge', 'Holt', 'Ironwood', 'Kettle', 'Lane', 'Leach', 'Marrow',
    'Marsh', 'Meadow', 'Mill', 'Moss', 'Nettle', 'Oak', 'Orchard', 'Pike', 'Reed', 'Rill',
    'Rowen', 'Salt', 'Sedge', 'Slate', 'Stone', 'Thorne', 'Tiller', 'Vale', 'Willow', 'Yarrow',
  ],
  settlementPrefix: [
    'Amber', 'Ash', 'Birch', 'Bramble', 'Brook', 'Clay', 'Dawn', 'Fern', 'Frost', 'Glen',
    'Hearth', 'High', 'Iron', 'Lark', 'Mill', 'Moss', 'Oak', 'Reed', 'Salt', 'Stone',
    'Thorn', 'Willow', 'Wind', 'Ember',
  ],
  settlementSuffix: [
    'brook', 'cross', 'dale', 'fen', 'field', 'ford', 'gate', 'garth', 'haven', 'hearth',
    'hill', 'holt', 'mere', 'mill', 'moor', 'reach', 'rest', 'rise', 'stead', 'stone',
    'vale', 'watch', 'well', 'wick', 'wold', 'wood',
  ],
  neighborNames: [
    'the Vell', 'the Ostra', 'the Kelder', 'the Milbrook', 'the Corrin', 'the Sarn',
    'the Effen', 'the Tallow', 'the Vant', 'the Rill', 'the Garrow', 'the Hesper',
  ],
  neighborTitles: [
    'Chief', 'Speaker', 'Warden', 'Elder', 'Matron', 'Marshal',
    'Herald', 'Steward', 'Keeper', 'Voice', 'Councillor', 'Lord',
  ],
  traitFlavor: {
    industrious: 'First to the field, last to the fire; cannot sit still while work is visible.',
    curious: 'Asks what the stars are, and whether the clay would burn harder with sand in it.',
    frail: 'Catches every cold that passes, and has outlived three stronger neighbours by being careful.',
    charismatic: 'People agree with them before they have finished the sentence, and are not sure why.',
    stubborn: 'Will argue with a river, and has occasionally won.',
    dreamer: 'Half of them is always somewhere else, usually a place that does not exist yet.',
    stoic: 'Buries the grief first, then eats, then fixes the roof.',
    quick: 'Moves and thinks faster than the rest, and sometimes gets both wrong sooner.',
    keen_eyed: 'Sees a broken fence from the far side of the field and a lie from across the fire.',
    gentle: 'Hands that calm animals and arguments alike; brings the strays home.',
    ambitious: 'Wants a bigger roof, a longer name and a seat nearer the fire.',
    loyal: 'Would follow the settlement over a hill, and has, twice.',
    wanderer: 'Was somewhere else before here, and might be somewhere else again.',
    haunted: 'Does not talk about the year before they came; sleeps with a light.',
  },
};

// ---------------------------------------------------------------------------
// TRAITS — 14
// ---------------------------------------------------------------------------

export const TRAITS: TraitDef[] = [
  {
    id: 'industrious',
    name: 'Industrious',
    desc: 'Works through the long evenings without being asked, and expects the same of others.',
    icon: 'hammer',
    effects: { workSpeed: 0.08, morale: -2 },
  },
  {
    id: 'curious',
    name: 'Curious',
    desc: 'Learns by asking the questions nobody has written down an answer to yet.',
    icon: 'spark',
    effects: { learning: 0.12, workSpeed: -0.02 },
  },
  {
    id: 'frail',
    name: 'Frail',
    desc: 'A body that has to be negotiated with. Gets ill easily, and lives carefully.',
    icon: 'leaf',
    effects: { health: -0.08, learning: 0.04 },
  },
  {
    id: 'charismatic',
    name: 'Charismatic',
    desc: 'A voice that makes the work feel worth doing, even on the bad days.',
    icon: 'heart',
    effects: { sociality: 0.15, morale: 4 },
  },
  {
    id: 'stubborn',
    name: 'Stubborn',
    desc: 'Holds a position through argument and weather alike. Sometimes the position is right.',
    icon: 'stone',
    effects: { workSpeed: 0.04, sociality: -0.08 },
  },
  {
    id: 'dreamer',
    name: 'Dreamer',
    desc: 'Sees the town that could be, and forgets the fence that needs mending today.',
    icon: 'moon',
    effects: { learning: 0.08, workSpeed: -0.04, morale: 2 },
  },
  {
    id: 'stoic',
    name: 'Stoic',
    desc: 'Carries bad news without cracking, and takes the worst duty without being asked twice.',
    icon: 'shield',
    effects: { morale: 4, sociality: -0.04 },
  },
  {
    id: 'quick',
    name: 'Quick',
    desc: 'Fast hands and fast judgement; the work comes in early, the mistakes come in early too.',
    icon: 'wind',
    effects: { workSpeed: 0.1, health: -0.02 },
  },
  {
    id: 'keen_eyed',
    name: 'Keen-Eyed',
    desc: 'Notices the cracked jar, the thin ice, the stranger at the boundary, long before anyone else.',
    icon: 'eye',
    effects: { learning: 0.06, workSpeed: 0.03 },
  },
  {
    id: 'gentle',
    name: 'Gentle',
    desc: 'Calms frightened animals and frightened people with the same low voice.',
    icon: 'heart',
    effects: { sociality: 0.12, morale: 3, workSpeed: -0.02 },
  },
  {
    id: 'ambitious',
    name: 'Ambitious',
    desc: 'Measures the year in what has been gained, not in what has been kept.',
    icon: 'crown',
    effects: { workSpeed: 0.06, fertility: 0.04, morale: -2 },
  },
  {
    id: 'loyal',
    name: 'Loyal',
    desc: 'Stays when staying is expensive, and remembers who else stayed.',
    icon: 'bell',
    effects: { morale: 3, sociality: 0.05 },
  },
  {
    id: 'wanderer',
    name: 'Wanderer',
    desc: 'Has come from somewhere and still watches the roads at dusk.',
    icon: 'compass',
    effects: { workSpeed: 0.02, sociality: -0.06, learning: 0.04 },
  },
  {
    id: 'haunted',
    name: 'Haunted',
    desc: 'The year before they came is a closed room. Some nights the door is not closed.',
    icon: 'skull',
    effects: { health: -0.04, morale: -3, learning: 0.06 },
  },
];

// ---------------------------------------------------------------------------
// SKILLS — exactly 12
// ---------------------------------------------------------------------------

export const SKILLS: Record<SkillId, { name: string; icon: string; color: string; desc: string }> = {
  farming: {
    name: 'Farming',
    icon: 'wheat',
    color: '#7fa653',
    desc: 'Soil, seed and season — the patience to make a field repeat itself.',
  },
  woodcraft: {
    name: 'Woodcraft',
    icon: 'axe',
    color: '#8a6a43',
    desc: 'Reading grain, bending with steam, and knowing which tree will hold a roof.',
  },
  mining: {
    name: 'Mining',
    icon: 'pick',
    color: '#7a7068',
    desc: 'Stone, ore, water and bad air — the craft of going down and coming back up.',
  },
  building: {
    name: 'Building',
    icon: 'hammer',
    color: '#b0752e',
    desc: 'Foundations, joints and true lines; the difference between a shelter and a ruin.',
  },
  crafting: {
    name: 'Craft',
    icon: 'anvil',
    color: '#c26b3e',
    desc: 'Turning heat and raw stock into things worth carrying home.',
  },
  scholarship: {
    name: 'Scholarship',
    icon: 'book',
    color: '#5f8fb0',
    desc: 'Watching, counting, doubting and writing it down where it can be checked.',
  },
  medicine: {
    name: 'Medicine',
    icon: 'herb',
    color: '#6f9e8f',
    desc: 'Clean water, clean hands, an honest diagnosis and the nerve to cut.',
  },
  trade: {
    name: 'Trade',
    icon: 'coin',
    color: '#c9a227',
    desc: 'Reading a market, keeping a bargain, and knowing what a thing is worth to the other man.',
  },
  leadership: {
    name: 'Leadership',
    icon: 'crown',
    color: '#9c6ba8',
    desc: 'Getting a hundred people to push the same cart in the same direction, often uphill.',
  },
  combat: {
    name: 'Combat',
    icon: 'shield',
    color: '#a05a3a',
    desc: 'Standing your ground, and knowing when the ground is not worth standing on.',
  },
  artistry: {
    name: 'Artistry',
    icon: 'quill',
    color: '#b56a8f',
    desc: 'Shape, story and song: the part of a settlement that survives having been useful.',
  },
  husbandry: {
    name: 'Husbandry',
    icon: 'sheep',
    color: '#9a8f5b',
    desc: 'Breeding, feeding and doctoring animals until they trust you at the gate.',
  },
};

// ---------------------------------------------------------------------------
// PROFESSIONS — 23 canonical ids used by buildings/recipes, plus 3 support
// ---------------------------------------------------------------------------

export const PROFESSIONS: Record<ProfessionId, { name: string; icon: string; skill: SkillId; class: 'laborer' | 'artisan' | 'scholar' | 'merchant' }> = {
  // labourers
  forager: { name: 'Forager', icon: 'leaf', skill: 'farming', class: 'laborer' },
  woodcutter: { name: 'Woodcutter', icon: 'axe', skill: 'woodcraft', class: 'laborer' },
  miner: { name: 'Miner', icon: 'pick', skill: 'mining', class: 'laborer' },
  farmer: { name: 'Farmer', icon: 'wheat', skill: 'farming', class: 'laborer' },
  fisher: { name: 'Fisher', icon: 'fish', skill: 'farming', class: 'laborer' },
  hunter: { name: 'Hunter', icon: 'bow', skill: 'combat', class: 'laborer' },
  herder: { name: 'Herder', icon: 'sheep', skill: 'husbandry', class: 'laborer' },
  builder: { name: 'Builder', icon: 'hammer', skill: 'building', class: 'laborer' },
  hauler: { name: 'Hauler', icon: 'cart', skill: 'trade', class: 'laborer' },
  guard: { name: 'Guard', icon: 'shield', skill: 'combat', class: 'laborer' },
  quarryman: { name: 'Quarryman', icon: 'stone', skill: 'mining', class: 'laborer' },
  // artisans
  smith: { name: 'Smith', icon: 'anvil', skill: 'crafting', class: 'artisan' },
  carpenter: { name: 'Carpenter', icon: 'saw', skill: 'woodcraft', class: 'artisan' },
  weaver: { name: 'Weaver', icon: 'loom', skill: 'crafting', class: 'artisan' },
  mason: { name: 'Mason', icon: 'brick', skill: 'building', class: 'artisan' },
  potter: { name: 'Potter', icon: 'pot', skill: 'crafting', class: 'artisan' },
  tanner: { name: 'Tanner', icon: 'hide', skill: 'crafting', class: 'artisan' },
  miller: { name: 'Miller', icon: 'mill', skill: 'crafting', class: 'artisan' },
  baker: { name: 'Baker', icon: 'bread', skill: 'crafting', class: 'artisan' },
  engineer: { name: 'Engineer', icon: 'gear', skill: 'building', class: 'artisan' },
  // scholars
  scholar: { name: 'Scholar', icon: 'book', skill: 'scholarship', class: 'scholar' },
  healer: { name: 'Healer', icon: 'herb', skill: 'medicine', class: 'scholar' },
  artist: { name: 'Artist', icon: 'quill', skill: 'artistry', class: 'scholar' },
  priest: { name: 'Priest', icon: 'temple', skill: 'leadership', class: 'scholar' },
  teacher: { name: 'Teacher', icon: 'scroll', skill: 'scholarship', class: 'scholar' },
  // merchants
  merchant: { name: 'Merchant', icon: 'coin', skill: 'trade', class: 'merchant' },
};
