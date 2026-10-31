/**
 * Procedural name pools for world generation and neighbour civilisations.
 *
 * These are cosmetic flavour pools (not game content/ids). Content-lore owns the canonical
 * name pools for citizens and settlements; these exist only for features that have no content
 * defs of their own (regions of the map, fallback neighbour civ names).
 */

export const REGION_ADJECTIVES: string[] = [
  'Ashen', 'Amber', 'Whispering', 'Grey', 'Thorn', 'Silver', 'Moss', 'Hollow',
  'Bright', 'Old', 'Wind', 'Rain', 'Stone', 'Green', 'Raven', 'Frost',
  'Sun', 'Mist', 'Elder', 'Iron', 'Quiet', 'Long', 'Broken', 'Golden',
  'Pale', 'Wild', 'Stony', 'Distant', 'Low', 'High',
];

export const REGION_NOUNS: string[] = [
  'Reach', 'Vale', 'Wood', 'Downs', 'Fen', 'Ridge', 'March', 'Holt',
  'Wold', 'Dell', 'Moor', 'Heath', 'Haven', 'Falls', 'Barrow', 'Expanse',
  'Crossing', 'Hollow', 'Stead', 'Shore',
];

export const REGION_NAMES_SECOND: string[] = [
  'of the Long Grass', 'of the Two Rivers', 'of the Old Stones', 'of the Grey Rain',
  'of the Hundred Pines', 'of the Quiet Years',
];

/** Fallback neighbour civilisation names, used when content name pools are unavailable. */
export const NEIGHBOR_FALLBACK_NAMES: string[] = [
  'The Amber Folk', 'Kethram', 'The Valeborn', 'Saltmere', 'The Thorn Pact',
  'Orenmark', 'The Reed Courts', 'Stonehelm', 'The Dust Riders', 'Larkhollow',
  'The Iron Choir', 'Fernwatch',
];

/** Fallback styles/colors for neighbours when generated from scratch. */
export const NEIGHBOR_COLORS: string[] = [
  '#c98b5a', '#7fa86b', '#9d7ab8', '#c47f7f', '#6f9bb5', '#b5a25e',
  '#8ab7a4', '#a2796b', '#7b8fc4', '#bfa06a', '#8f7fa8', '#a8bf6f',
];
