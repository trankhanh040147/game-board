import { makeContent, newGame, runIdle } from '../tests/helpers';
import { capitalOf, stockOf } from '../src/sim/core';
import { placeBuilding } from '../src/sim/actions';
import { RULES } from '../src/sim/config';
import { Autoplay } from '../tools/autoplay';
const content = makeContent();
const state = newGame('reg-well');
const cap = capitalOf(state)!;
const def = content.buildings['well'];
for (const res of Object.keys(def.cost)) cap.stock[res] = Math.max(cap.stock[res] ?? 0, def.cost[res] + 40);
const ap = new Autoplay();
const pos = ap.findPlacement({ state, content, rules: RULES }, def, cap)!;
placeBuilding({ state, content, rules: RULES }, 'well', pos.x, pos.y, cap.id);
const b = state.buildings.find(x => x.typeId === 'well')!;
b.progress = 1;
let prev = stockOf(cap, 'water');
runIdle(state, 3);
for (let i = 0; i < 12; i++) {
  runIdle(state, 1);
  const now = stockOf(cap, 'water');
  console.log(`d${state.tick} water=${now.toFixed(2)} gain=${(now-prev).toFixed(2)} waterDays=${cap.waterDays.toFixed(1)} pop=${cap.population}`);
  prev = now;
}
