import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  CAR_ORDER,
  CAR_SPECS,
  NITRO,
  OPPONENT_NAMES,
  OPPONENT_SKILLS,
  TRACK_DEFS,
} from '../src/sim/config.js';
import {
  carForward,
  carKph,
  carRight,
  createCarState,
  gearForSpeed,
  resetCar,
  stepCar,
} from '../src/sim/car.js';
import { computeStandings, createRace, raceProgress, stepRace } from '../src/sim/race.js';
import { mulberry32 } from '../src/core/rng.js';
import { buildTrack } from '../src/sim/track.js';

const FIXED = 1 / 120;

/** A flat, endless road so longitudinal tests are not affected by corners. */
const FLAT_TRACK = {
  query(x, z) {
    return {
      index: 0,
      t: 0,
      s: 0,
      lateral: 0,
      x,
      y: 0,
      z,
      tx: 0,
      ty: 0,
      tz: 1,
      rx: 1,
      rz: 0,
      curvature: 0,
      surface: 'road',
      onTrack: true,
      onShoulder: true,
      distance: 0,
    };
  },
};

const track = buildTrack(TRACK_DEFS['neon-bay']);

function makeCar(id, overrides = {}) {
  return createCarState({
    id,
    spec: CAR_SPECS[id],
    position: { x: 0, y: 0, z: 0 },
    heading: 0,
    ...overrides,
  });
}

function run(car, input, seconds, step = FIXED, trackObject = FLAT_TRACK) {
  const events = [];
  const steps = Math.round(seconds / step);
  for (let i = 0; i < steps; i += 1) {
    events.push(...stepCar(car, input, step, trackObject));
  }
  return events;
}

/* ------------------------------------------------------------ car state -- */

test('createCarState applies documented defaults', () => {
  const car = createCarState({ id: 'vanko', spec: CAR_SPECS.vanko, position: { x: 3, y: 1, z: -4 }, heading: 0.5 });

  assert.equal(car.id, 'vanko', 'id');
  assert.equal(car.spec, CAR_SPECS.vanko, 'spec is kept by reference');
  assert.equal(car.palette, CAR_SPECS.vanko.palette, 'palette defaults to the spec palette');
  assert.equal(car.isPlayer, false, 'cars are AI by default');
  assert.equal(car.x, 3, 'x');
  assert.equal(car.y, 1, 'y');
  assert.equal(car.z, -4, 'z');
  assert.equal(car.heading, 0.5, 'heading');
  assert.equal(car.vx, 0, 'vx starts at rest');
  assert.equal(car.vz, 0, 'vz starts at rest');
  assert.equal(car.yawRate, 0, 'yawRate starts at rest');
  assert.equal(car.speed, 0, 'speed starts at rest');
  assert.equal(car.slip, 0, 'slip starts at zero');
  assert.equal(car.nitro, NITRO.capacity, 'nitro starts full');
  assert.equal(car.boosting, false, 'not boosting');
  assert.equal(car.onTrack, true, 'assumed on track until the first query');
  assert.equal(car.surface, 'road', 'assumed on the road until the first query');
  assert.equal(car.humpIndex, -1, 'no query hint yet');
  assert.equal(car.gear, 1, 'starts in first gear');
  assert.equal(car.isPlayer, false, 'isPlayer default');
});

test('createCarState resolves string specs and sanitises garbage input', () => {
  const byString = createCarState({ spec: 'kira', position: { x: 0, y: 0, z: 0 } });
  assert.equal(byString.spec, CAR_SPECS.kira, 'string spec resolves through CAR_SPECS');
  assert.equal(byString.id, 'kira', 'id falls back to the spec id');

  const unknown = createCarState({ spec: 'nope', position: { x: 0, y: 0, z: 0 } });
  assert.equal(unknown.spec, CAR_SPECS[CAR_ORDER[0]], 'unknown spec falls back to the first car');

  const garbage = createCarState({
    spec: CAR_SPECS.vanko,
    position: { x: NaN, y: Infinity, z: undefined },
    heading: NaN,
    isPlayer: true,
  });
  assert.equal(garbage.x, 0, 'NaN x is sanitised');
  assert.equal(garbage.y, 0, 'infinite y is sanitised');
  assert.equal(garbage.z, 0, 'undefined z is sanitised');
  assert.equal(garbage.heading, 0, 'NaN heading is sanitised');
  assert.equal(garbage.isPlayer, true, 'isPlayer is honoured');
});

test('resetCar zeroes momentum and teleports the car', () => {
  const car = makeCar('rhino');
  run(car, { throttle: 1, steer: 0.4 }, 2);
  car.yawRate = 2;
  car.nitro = 3;
  car.boosting = true;

  resetCar(car, { x: 10, y: 2, z: -20 }, Math.PI * 2 + 0.3);

  assert.equal(car.x, 10, 'x');
  assert.equal(car.y, 2, 'y');
  assert.equal(car.z, -20, 'z');
  assert.ok(Math.abs(car.heading - 0.3) < 1e-9, `heading should wrap, got ${car.heading}`);
  assert.equal(car.vx, 0, 'vx zeroed');
  assert.equal(car.vz, 0, 'vz zeroed');
  assert.equal(car.yawRate, 0, 'yawRate zeroed');
  assert.equal(car.speed, 0, 'speed zeroed');
  assert.equal(car.slip, 0, 'slip zeroed');
  assert.equal(car.boosting, false, 'boosting cleared');
  assert.equal(car.humpIndex, -1, 'track hint reset');
});

test('carForward / carRight / carKph follow the heading convention', () => {
  const car = makeCar('vanko');
  car.heading = 0;
  assert.deepEqual(carForward(car), [0, 0, 1], 'heading 0 faces +Z');
  const rightAtZero = carRight(car);
  assert.ok(
    Math.abs(rightAtZero[0] - 1) < 1e-12 && Math.abs(rightAtZero[2]) < 1e-12,
    `heading 0 should have right = +X, got ${JSON.stringify(rightAtZero)}`,
  );

  car.heading = Math.PI / 2;
  const forward = carForward(car);
  const right = carRight(car);
  assert.ok(Math.abs(forward[0] - 1) < 1e-9 && Math.abs(forward[2]) < 1e-9, `heading PI/2 forward ${forward}`);
  assert.ok(Math.abs(right[0]) < 1e-9 && Math.abs(right[2] + 1) < 1e-9, `heading PI/2 right ${right}`);

  car.speed = 27;
  assert.equal(carKph(car), 97.2, 'carKph converts m/s to km/h');
});

/* ----------------------------------------------------------- longitudinal -- */

test('stepCar rejects degenerate dt and missing state', () => {
  const car = makeCar('vanko');
  assert.deepEqual(stepCar(null, { throttle: 1 }, FIXED, FLAT_TRACK), [], 'no car = no events');
  assert.deepEqual(stepCar(car, { throttle: 1 }, 0, FLAT_TRACK), [], 'dt 0 = no step');
  assert.deepEqual(stepCar(car, { throttle: 1 }, -1, FLAT_TRACK), [], 'negative dt = no step');
  assert.deepEqual(stepCar(car, { throttle: 1 }, NaN, FLAT_TRACK), [], 'NaN dt = no step');
});

test('every car accelerates 0-100 km/h in 2.5-6 s', () => {
  for (const id of CAR_ORDER) {
    const car = makeCar(id);
    let time = 0;
    let reached = null;
    while (time < 8) {
      stepCar(car, { throttle: 1, steer: 0 }, FIXED, FLAT_TRACK);
      time += FIXED;
      if (reached === null && carKph(car) >= 100) reached = time;
    }
    assert.ok(reached !== null, `${id}: never reached 100 km/h`);
    assert.ok(
      reached >= 2.5 && reached <= 6,
      `${id}: 0-100 km/h took ${reached.toFixed(2)} s, expected 2.5-6 s`,
    );
  }
});

test('each car settles within 12% of its advertised top speed', () => {
  for (const id of CAR_ORDER) {
    const spec = CAR_SPECS[id];
    const car = makeCar(id);
    let topSpeed = 0;
    for (let i = 0; i < 60 * 120; i += 1) {
      stepCar(car, { throttle: 1, steer: 0 }, FIXED, FLAT_TRACK);
      topSpeed = Math.max(topSpeed, car.speed);
      if (car.speed < topSpeed - 2 && i > 240) {
        // Once aerodynamics dominate the acceleration the speed plateaus.
        topSpeed = Math.max(topSpeed, car.speed);
      }
    }
    const expected = spec.topSpeed;
    assert.ok(
      topSpeed > expected * 0.88 && topSpeed < expected * 1.12,
      `${id}: top speed ${(topSpeed * 3.6).toFixed(0)} km/h (${topSpeed.toFixed(2)} m/s) outside 12% of ${(expected * 3.6).toFixed(0)} km/h (${expected.toFixed(2)} m/s)`,
    );
  }
});

test('throttle -1 brakes through zero and then reverses at a capped speed', () => {
  // The contract defines throttle < 0 as "brake/reverse" on the same control.
  const car = makeCar('vanko');
  run(car, { throttle: 1 }, 3);
  assert.ok(car.speed > 20, `expected speed > 20 m/s before braking, got ${car.speed}`);

  let closestToStop = Infinity;
  let minSpeed = 0;
  for (let i = 0; i < 6 * 120; i += 1) {
    stepCar(car, { throttle: -1 }, FIXED, FLAT_TRACK);
    closestToStop = Math.min(closestToStop, Math.abs(car.speed));
    minSpeed = Math.min(minSpeed, car.speed);
    for (const key of ['x', 'z', 'speed', 'vx', 'vz']) {
      assert.ok(Number.isFinite(car[key]), `car.${key} became ${car[key]} while braking/reversing`);
    }
  }
  assert.ok(closestToStop < 0.5, `the car should pass through a stop, closest was ${closestToStop.toFixed(2)} m/s`);
  assert.ok(minSpeed >= -10.5, `reverse speed ${minSpeed.toFixed(2)} m/s exceeded the reverse cap`);
  assert.ok(car.speed < 0, `holding throttle -1 should end up reversing, got ${car.speed.toFixed(2)} m/s`);
});

test('the car stays pinned to the road height returned by the track query', () => {
  const hillside = {
    query: (x, z) => ({ ...FLAT_TRACK.query(x, z), y: 4.5 }),
  };
  const car = makeCar('kira');
  stepCar(car, { throttle: 1 }, FIXED, hillside);
  assert.equal(car.y, 4.5, 'car y follows the track surface');
});

/* -------------------------------------------------------------- handling -- */

test('handbrake plus throttle breaks traction into a drift (slip > 0.25)', () => {
  for (const id of CAR_ORDER) {
    const car = makeCar(id);
    run(car, { throttle: 1, steer: 0 }, 2.5);
    let maxSlip = 0;
    for (let i = 0; i < 2 * 120; i += 1) {
      stepCar(car, { throttle: 1, steer: 1, handbrake: true }, FIXED, FLAT_TRACK);
      maxSlip = Math.max(maxSlip, car.slip);
    }
    assert.ok(
      maxSlip > 0.25,
      `${id}: handbrake drift only reached slip ${maxSlip.toFixed(3)} (needs > 0.25)`,
    );
    assert.ok(car.slip >= 0 && car.slip <= 1, `${id}: slip ${car.slip} outside 0..1`);
  }
});

test('steering is clamped to the spec steer lock', () => {
  for (const id of CAR_ORDER) {
    const spec = CAR_SPECS[id];
    const car = makeCar(id);
    run(car, { throttle: 0.6, steer: 1 }, 1);
    assert.ok(
      Math.abs(car.steerAngle) <= spec.steerLock + 1e-6,
      `${id}: steerAngle ${car.steerAngle} exceeds steerLock ${spec.steerLock}`,
    );
    assert.ok(Math.abs(car.steer) <= 1, `${id}: steer ${car.steer} outside -1..1`);
  }
});

test('nitro boosts top speed and drains the tank', () => {
  const car = makeCar('vanko');
  run(car, { throttle: 1 }, 6);
  const withoutBoost = car.speed;

  const boosted = makeCar('vanko');
  run(boosted, { throttle: 1, nitro: true }, 6);
  assert.ok(boosted.nitro < NITRO.capacity, `nitro should drain, got ${boosted.nitro}`);
  assert.ok(
    boosted.speed > withoutBoost,
    `nitro should add speed: ${boosted.speed.toFixed(2)} vs ${withoutBoost.toFixed(2)} m/s`,
  );

  const events = [];
  const fresh = makeCar('vanko');
  run(fresh, { throttle: 1 }, 1);
  events.push(...run(fresh, { throttle: 1, nitro: true }, 0.5));
  assert.ok(events.some((event) => event.type === 'nitro'), 'firing nitro should emit a nitro event');
});

/* ------------------------------------------------------------ robustness -- */

test('60 s of hostile seeded input keeps every car finite and inside sane bounds', () => {
  for (const id of CAR_ORDER) {
    const spec = CAR_SPECS[id];
    const car = makeCar(id);
    const random = mulberry32(0xc0ffee + CAR_ORDER.indexOf(id));
    let events = 0;
    for (let i = 0; i < 60 * 120; i += 1) {
      const input = {
        throttle: random() * 2 - 1,
        steer: random() * 2 - 1,
        handbrake: random() < 0.12,
        nitro: random() < 0.2,
      };
      events += stepCar(car, input, FIXED, track).length;
      for (const key of ['x', 'y', 'z', 'heading', 'speed', 'vx', 'vz', 'yawRate', 'slip', 'nitro']) {
        assert.ok(Number.isFinite(car[key]), `${id} step ${i}: car.${key} became ${car[key]}`);
      }
    }
    assert.ok(car.nitro >= 0 && car.nitro <= NITRO.capacity, `${id}: nitro ${car.nitro} outside 0..capacity`);
    assert.ok(car.slip >= 0 && car.slip <= 1, `${id}: slip ${car.slip} outside 0..1`);
    assert.ok(
      car.speed <= spec.topSpeed * 1.5,
      `${id}: speed ${car.speed} exceeded the hard speed cap`,
    );
    assert.ok(Number.isInteger(events), 'events should be counted');
  }
});

test('the same input sequence produces identical state (determinism)', () => {
  const a = makeCar('rhino');
  const b = makeCar('rhino');
  const random = mulberry32(99);
  for (let i = 0; i < 1200; i += 1) {
    const input = {
      throttle: random() * 2 - 1,
      steer: random() * 2 - 1,
      handbrake: random() < 0.1,
      nitro: random() < 0.2,
    };
    stepCar(a, input, FIXED, track);
    stepCar(b, input, FIXED, track);
  }
  for (const key of ['x', 'y', 'z', 'heading', 'speed', 'vx', 'vz', 'yawRate', 'slip', 'nitro']) {
    assert.equal(a[key], b[key], `deterministic step diverged on ${key}`);
  }
});

test('off-track driving emits an offtrack event', () => {
  const car = makeCar('vanko');
  const events = [];
  // Point the car straight across the road and drive off the edge.
  const slot = track.gridTransform(4, 0);
  car.x = slot.x;
  car.z = slot.z;
  car.heading = slot.heading + Math.PI / 2;
  for (let i = 0; i < 240; i += 1) {
    events.push(...stepCar(car, { throttle: 1, steer: 0 }, FIXED, track));
  }
  assert.ok(car.onTrack === false || events.some((event) => event.type === 'offtrack'), 'driving off the road should report offtrack');
});

/* ----------------------------------------------------------------- gears -- */

test('gearForSpeed returns valid gears and an rpm needle while accelerating', () => {
  for (const id of CAR_ORDER) {
    const spec = CAR_SPECS[id];
    const car = makeCar(id);
    const gearsSeen = new Set();
    for (let i = 0; i < 25 * 120; i += 1) {
      stepCar(car, { throttle: 1, steer: 0 }, FIXED, FLAT_TRACK);
      const { gear, rpm01 } = gearForSpeed(car);
      assert.ok(Number.isInteger(gear) && gear >= 1 && gear <= spec.gearCount, `${id}: invalid gear ${gear} (count ${spec.gearCount})`);
      assert.ok(rpm01 >= 0 && rpm01 <= 1, `${id}: rpm01 ${rpm01} outside 0..1`);
      gearsSeen.add(gear);
    }
    assert.ok(gearsSeen.has(1), `${id}: should use first gear from rest`);
    assert.ok(gearsSeen.size >= Math.min(4, spec.gearCount - 1), `${id}: only used gears ${[...gearsSeen].join(',')}`);
    assert.ok(Math.max(...gearsSeen) > 1, `${id}: should upshift while accelerating`);
  }
});

test('gearForSpeed at rest is first gear, idle rpm', () => {
  for (const id of CAR_ORDER) {
    const car = makeCar(id);
    const { gear, rpm01 } = gearForSpeed(car);
    assert.equal(gear, 1, `${id}: parked car sits in first gear`);
    assert.ok(rpm01 >= 0 && rpm01 <= 0.3, `${id}: parked rpm01 ${rpm01} should be near idle`);
  }
});

/* ------------------------------------------------------------------ race -- */

function raceEntrants({ allAi = false, playerCar = 'vanko' } = {}) {
  const entrants = [];
  for (let i = 0; i < 5; i += 1) {
    entrants.push({
      id: `rival-${i}`,
      name: OPPONENT_NAMES[i],
      spec: CAR_SPECS[CAR_ORDER[(i + 1) % CAR_ORDER.length]],
      isPlayer: false,
      skill: OPPONENT_SKILLS[i],
    });
  }
  entrants.push({
    id: allAi ? 'ai-player' : 'player',
    name: allAi ? 'AI' : 'YOU',
    spec: CAR_SPECS[playerCar],
    isPlayer: !allAi,
    skill: 1,
  });
  return entrants;
}

function makeRace(options = {}) {
  return createRace({
    track: options.track ?? track,
    entrants: options.entrants ?? raceEntrants(),
    laps: options.laps ?? 3,
    seed: options.seed ?? 7,
    countdown: options.countdown ?? 0,
  });
}

function simulate(race, seconds, playerInput = { throttle: 0.8, steer: 0 }) {
  const events = [];
  const steps = Math.round(seconds / FIXED);
  for (let i = 0; i < steps; i += 1) events.push(...stepRace(race, FIXED, playerInput));
  return events;
}

test('createRace builds a six-car grid with distinct positions', () => {
  const race = makeRace({ countdown: 3 });
  assert.equal(race.cars.length, 6, 'a full field is 6 cars');
  assert.equal(race.ais.length, 5, 'five AI drivers plus the player');
  assert.ok(race.player, 'the player car exists');

  const positions = race.cars.map((car) => [car.x, car.z]);
  for (let i = 0; i < positions.length; i += 1) {
    for (let j = i + 1; j < positions.length; j += 1) {
      const distance = Math.hypot(positions[i][0] - positions[j][0], positions[i][1] - positions[j][1]);
      assert.ok(distance > 2, `grid slots ${i} and ${j} overlap (${distance.toFixed(2)} m apart)`);
    }
  }
  for (const car of race.cars) {
    assert.ok(Number.isFinite(car.x) && Number.isFinite(car.z), `${car.id}: non-finite grid position`);
    assert.equal(car.speed, 0, `${car.id}: cars should start stationary`);
  }
  assert.equal(race.state, 'countdown', 'race starts in the countdown');
  assert.equal(race.countdown, 3, 'countdown starts at 3');
  assert.equal(race.results, null, 'no results before the finish');
  assert.equal(race.standings.length, 6, 'standings include the whole field');
  for (const standing of race.standings) {
    assert.ok(standing.position >= 1 && standing.position <= 6, `standing position ${standing.position} out of range`);
    assert.ok(standing.progress >= 0 && standing.progress <= race.laps, `standing progress ${standing.progress} out of range`);
  }
});

test('stepRace countdown emits 3, 2, 1 then go and starts the race', () => {
  const race = makeRace({ countdown: 3 });
  const values = [];
  let goIndex = -1;
  const events = [];
  for (let i = 0; i < 5 * 120; i += 1) {
    const stepEvents = stepRace(race, FIXED, null);
    for (const event of stepEvents) {
      events.push(event);
      if (event.type === 'countdown') values.push(event.value);
      if (event.type === 'go') goIndex = values.length;
    }
    if (race.state === 'running' && goIndex >= 0) break;
  }
  assert.deepEqual(values, [3, 2, 1], `expected countdown 3,2,1, got ${values.join(',')}`);
  assert.ok(goIndex >= 0, 'a go event must fire after 1');
  assert.equal(goIndex, values.length, 'go must come after the last countdown event');
  assert.equal(race.state, 'running', 'the race switches to running after the countdown');
  assert.equal(race.countdown, 0, 'countdown reaches zero');
  assert.ok(race.time < 4, `the countdown should take ~3 s, took ${race.time.toFixed(2)} s`);
  assert.deepEqual(stepRace(race, 0, null), [], 'dt 0 is ignored');
});

test('a 3-lap AI-only race finishes in under 400 s with ordered results', () => {
  for (const [id, def] of Object.entries(TRACK_DEFS)) {
    const raceTrack = buildTrack(def);
    const race = createRace({
      track: raceTrack,
      entrants: raceEntrants({ allAi: true }),
      laps: 3,
      seed: 123,
      countdown: 0,
    });

    let worstLateral = 0;
    const steps = Math.round(400 / FIXED);
    for (let i = 0; i < steps && race.state !== 'finished'; i += 1) {
      stepRace(race, FIXED, null);
      if (i % 30 === 0) {
        for (const car of race.cars) {
          const query = raceTrack.query(car.x, car.z, car.humpIndex);
          worstLateral = Math.max(worstLateral, Math.abs(query.lateral));
        }
      }
    }

    assert.equal(race.state, 'finished', `${id}: the AI race did not finish within 400 s of sim time`);
    assert.ok(race.time < 400, `${id}: race finished after ${race.time.toFixed(1)} s (limit 400 s)`);
    assert.ok(Array.isArray(race.results) && race.results.length === 6, `${id}: expected 6 result rows`);
    assert.deepEqual(
      race.results.map((row) => row.position),
      [1, 2, 3, 4, 5, 6],
      `${id}: result positions must be ordered 1..6`,
    );
    for (const [index, row] of race.results.entries()) {
      assert.ok(Number.isFinite(row.totalTime) && row.totalTime > 0, `${id}: result ${index} has a bad total time ${row.totalTime}`);
      assert.ok(row.laps.length === 3, `${id}: result ${index} should list 3 laps, got ${row.laps.length}`);
      for (const lap of row.laps) {
        assert.ok(Number.isFinite(lap.time) && lap.time > 0, `${id}: result ${index} lap ${lap.lap} time ${lap.time}`);
        assert.ok(lap.time < 400, `${id}: result ${index} lap ${lap.lap} took ${lap.time.toFixed(1)} s`);
      }
      assert.ok(
        Math.abs(row.bestLap - Math.min(...row.laps.map((lap) => lap.time))) < 1e-6,
        `${id}: result ${index} bestLap does not match its lap list`,
      );
      if (index > 0) {
        assert.ok(
          row.totalTime >= race.results[index - 1].totalTime,
          `${id}: result ${index} finished faster than the row ahead`,
        );
      }
    }
    assert.ok(
      worstLateral <= raceTrack.boundary,
      `${id}: a car reached lateral ${worstLateral.toFixed(2)} m, outside the ${raceTrack.boundary} m track boundary`,
    );
  }
});

test('race progress and standings are monotonic and consistent', () => {
  const race = makeRace({ countdown: 0 });
  simulate(race, 3);
  const before = race.standings.map((standing) => ({ ...standing }));
  simulate(race, 3);
  const after = race.standings.map((standing) => ({ ...standing }));

  for (const row of after) {
    assert.ok(row.position >= 1 && row.position <= 6, `position ${row.position} out of range`);
    assert.ok(row.lap >= 1 && row.lap <= race.laps, `lap ${row.lap} out of range`);
    assert.ok(row.gap >= 0, `gap ${row.gap} should be non-negative`);
    const previous = before.find((candidate) => candidate.carId === row.carId);
    assert.ok(
      row.progress >= previous.progress - 1e-9,
      `${row.carId}: progress went backwards (${previous.progress} -> ${row.progress})`,
    );
  }
  assert.equal(new Set(after.map((row) => row.carId)).size, 6, 'every car appears exactly once in the standings');
  assert.ok(after.some((row) => row.isPlayer), 'the player is flagged in the standings');
});

test('the player car responds to playerInput', () => {
  const race = makeRace({ countdown: 0 });
  const player = race.player;
  const start = { x: player.x, z: player.z };
  simulate(race, 3, { throttle: 1, steer: 0 });
  const moved = Math.hypot(player.x - start.x, player.z - start.z);
  assert.ok(moved > 10, `player moved only ${moved.toFixed(1)} m in 3 s of throttle`);
  assert.ok(player.speed > 5, `player speed ${player.speed.toFixed(2)} m/s should be climbing`);
  assert.ok(Number.isFinite(player._totalDistance), 'player race progress must stay finite');
});

test('two races with the same seed stay bit-identical (determinism)', () => {
  const a = makeRace({ seed: 0xabc, countdown: 0 });
  const b = makeRace({ seed: 0xabc, countdown: 0 });
  for (let i = 0; i < 20 * 120; i += 1) {
    stepRace(a, FIXED, null);
    stepRace(b, FIXED, null);
  }
  assert.equal(a.time, b.time, 'races advanced by different amounts of time');
  for (let i = 0; i < a.cars.length; i += 1) {
    const ca = a.cars[i];
    const cb = b.cars[i];
    for (const key of ['x', 'z', 'heading', 'speed', '_totalDistance']) {
      assert.equal(ca[key], cb[key], `car ${i} (${ca.id}) diverged on ${key}`);
    }
  }
  assert.deepEqual(a.standings, b.standings, 'standings differ between identical seeds');
});

test('raceProgress is monotonic and clamps to the race distance', () => {
  const race = makeRace({ countdown: 0 });
  const input = { throttle: 0.85, steer: 0 };
  let lastProgress = -Infinity;
  for (let i = 0; i < 10 * 120; i += 1) {
    stepRace(race, FIXED, input);
    const progress = raceProgress(race.player, race.track);
    assert.ok(progress.progress >= lastProgress - 1e-9, `progress went backwards: ${lastProgress} -> ${progress.progress}`);
    assert.ok(progress.progress >= 0 && progress.progress <= race.laps, `progress ${progress.progress} outside 0..${race.laps}`);
    lastProgress = progress.progress;
  }
  assert.ok(lastProgress > 0.01, `expected the player to make progress, got ${lastProgress}`);
  assert.deepEqual(raceProgress(null, race.track), { lap: 1, progress: 0 }, 'raceProgress tolerates a missing car');
});

test('stepRace ignores a finished race and hostile dt', () => {
  const race = makeRace({ countdown: 0 });
  race.state = 'finished';
  assert.deepEqual(stepRace(race, FIXED, null), [], 'a finished race must not keep simulating');
  assert.deepEqual(stepRace(race, 0, null), [], 'dt 0 is ignored');
  assert.deepEqual(stepRace(race, NaN, null), [], 'NaN dt is ignored');
});
