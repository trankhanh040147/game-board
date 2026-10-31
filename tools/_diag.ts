import { makeContent, newGame } from '../tests/helpers';
import { Autoplay } from '../tools/autoplay';
import { tick } from '../src/sim/tick';
import { RULES } from '../src/sim/config';
import { totalPopulation, capitalOf } from '../src/sim/core';
const content = makeContent();
const state = newGame('longrun-seed');
const ap = new Autoplay();
let prev = 0;
for (let i = 0; i < 400; i++) {
  ap.run(state, content);
  tick(state, content, RULES);
  const pop = totalPopulation(state);
  const cap = capitalOf(state)!;
  if (state.tick % 25 === 0 || (prev > 2 && pop <= prev * 0.6)) {
    console.log(`d${state.tick} pop=${pop} peak=${state.stats.populationPeak} foodD=${cap.foodDays.toFixed(1)} watD=${cap.waterDays.toFixed(1)} starving=${state.stats.citizensStarved} died=${state.stats.citizensDied} era=${state.research.era} bld=${state.buildings.length}`);
    if (prev > 2 && pop <= prev * 0.6) console.log('  bad:', state.notifications.slice(-6).map(n=>n.text.slice(0,70)).join(' | '));
    prev = pop;
  }
  if (pop === 0) break;
}
console.log('buildings:', JSON.stringify(state.buildings.reduce((a: any, b) => { a[b.typeId]=(a[b.typeId]??0)+1; return a; }, {})));
console.log('death causes:', JSON.stringify(state.citizens.filter(c=>!c.alive).reduce((a: any, c) => { a[c.deathCause]=(a[c.deathCause]??0)+1; return a; }, {})));
