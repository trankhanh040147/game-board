/**
 * FIRST HEARTH — Tutorial Content
 * ------------------------------
 * Contextual hints, not a scripted campaign. Each tip appears when its
 * condition is true, teaches one idea from the core loop, and points at the
 * UI anchor that matters:
 *
 *   gather → shelter → water → food → storage → jobs → research → roads →
 *   winter → trade → policy → automation → megaprojects
 *
 * Conditions use metric keys documented in docs/CONTENT-AUTHORING.md.
 */

import type { Condition, TutorialTipDef } from '../types';

const metric = (
  m: string,
  op: '>' | '<' | '>=' | '<=' | '==' | '!=',
  value: number,
): Condition => ({ kind: 'metric', metric: m, op, value });

const all = (...conditions: Condition[]): Condition => ({ kind: 'all', conditions });

export const TUTORIAL: TutorialTipDef[] = [
  {
    id: 'tip_first_gathering',
    title: 'First, Something in the Pot',
    body: 'Send a forager to the berry ground and a woodcutter to the trees. Food and wood are the two things every other plan is made of — a camp works the nearest source by itself, but more hands fill the pot faster.',
    condition: all(metric('foodDays', '<', 3), metric('population', '>=', 1)),
    anchor: 'hud.food',
    step: 1,
  },
  {
    id: 'tip_shelter',
    title: 'A Roof Before the Cold',
    body: 'People with no home lose heart, then health. Build a hut near the fire and the water, and keep housing capacity above your population. Night is longer than the build — start early.',
    condition: all(metric('homeless', '>', 0), metric('day', '>=', 3)),
    anchor: 'build.housing',
    step: 2,
  },
  {
    id: 'tip_water',
    title: 'Water Is the Quiet Need',
    body: 'A well supplies the settlement without anyone carrying a pail. Citizens drink every day, and buildings use water too. Dig a well near the river or a seep, and watch the water-days figure instead of the water figure.',
    condition: all(metric('waterDays', '<', 2), metric('population', '>=', 2)),
    anchor: 'hud.water',
    step: 3,
  },
  {
    id: 'tip_storage',
    title: 'Surplus Only Counts If It Keeps',
    body: 'A granary raises storage capacity and slows spoilage. Fill it in autumn; eat from it in winter. A settlement that stores food survives its own mistakes.',
    condition: all(metric('foodDays', '>=', 2), metric('food', '>', 20)),
    anchor: 'build.storage',
    step: 4,
  },
  {
    id: 'tip_jobs',
    title: 'Hands Need Work',
    body: 'An unemployed citizen still eats. Open a building\'s job slots and assign willing hands; matching a profession to its skill makes the work go further. Check the jobs panel when the settlement grows suddenly.',
    condition: metric('unemployed', '>', 0),
    anchor: 'panel.jobs',
    step: 5,
  },
  {
    id: 'tip_research',
    title: 'Ideas Come from People',
    body: 'Scholars, and quiet hours, generate insight. Insight buys discoveries — the tech tree opens buildings and better yields. Choose one discovery at a time and keep a queue going; early farms pay for themselves many times over.',
    condition: all(metric('techs', '==', 0), metric('population', '>=', 4)),
    anchor: 'panel.research',
    step: 6,
  },
  {
    id: 'tip_roads',
    title: 'Roads Shrink the World',
    body: 'Buildings far from a road work slower and move goods less. Lay roads between your production and your stores, and between the settlement and the boundary. Distance is a cost you can pave away.',
    condition: all(metric('era', '>=', 1), metric('roads', '<', 4)),
    anchor: 'build.logistics',
    step: 7,
  },
  {
    id: 'tip_winter',
    title: 'Winter Is a Bill You Can See Coming',
    body: 'Autumn is the last chance to fill the granary and the woodpile, and to repair roofs. Food and water days are your runway; if they are not enough to cross the cold months, reduce waste and import what you can.',
    condition: all(metric('season', '==', 2), metric('foodDays', '<', 8)),
    anchor: 'hud.season',
    step: 8,
  },
  {
    id: 'tip_trade',
    title: 'The Road Is Also a Market',
    body: 'A neighbour has been met: offer a trade route at the market or trade post. Buying what you lack can be cheaper than producing it badly, and selling a true surplus fills the treasury without another field.',
    condition: metric('neighborsMet', '>=', 1),
    anchor: 'panel.trade',
    step: 9,
  },
  {
    id: 'tip_policy',
    title: 'Laws Are Levers',
    body: 'Policies turn influence into lasting modifiers, and each class feels them differently. A well-chosen pair doubles down on your strength; watch approval and stability — hungry artisans forgive less than you think.',
    condition: all(metric('era', '>=', 1), metric('policies', '==', 0)),
    anchor: 'panel.society',
    step: 10,
  },
  {
    id: 'tip_automation',
    title: 'Let the Machine Eat the Repetition',
    body: 'Automation replaces drudgery with throughput: fewer hands needed per output, more goods per day. Keep an eye on upkeep and morale — a town of machines still needs a town of people who want to live in it.',
    condition: all(metric('era', '>=', 4), metric('buildings.industrial', '>=', 5)),
    anchor: 'panel.research',
    step: 11,
  },
  {
    id: 'tip_megaproject',
    title: 'Some Things Take a Generation',
    body: 'Megaprojects are era 4 and beyond: years of materials and insight for a permanent transformation. Start one when your stores are deep, because a half-finished project is a hole in both the ground and the treasury.',
    condition: all(metric('era', '>=', 4), metric('megaprojects', '==', 0)),
    anchor: 'panel.objectives',
    step: 12,
  },
];
