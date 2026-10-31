import { describe, expect, it } from 'vitest';
import {
  AI_PROFILES,
  ARMORS,
  HELMETS,
  SHIELDS,
  TOURNAMENT,
  WEAPONS,
  attackStaminaCost,
  attackTiming,
  makeLoadout,
  maxHpForLevel,
  meleeReward,
  rankForLevel,
  xpForLevel,
} from '../src/core/config';
import { mulberry32 } from '../src/core/utils';

describe('combat data', () => {
  it('has sane weapon timings', () => {
    for (const weapon of Object.values(WEAPONS)) {
      const t = attackTiming(weapon);
      expect(t.windup).toBeGreaterThan(0.15);
      expect(t.active).toBeGreaterThan(0.05);
      expect(t.recover).toBeGreaterThan(0.15);
      expect(t.total).toBeCloseTo(t.windup + t.active + t.recover);
      expect(attackStaminaCost(weapon)).toBeGreaterThan(10);
    }
  });

  it('makes valid loadouts from every tier', () => {
    const rng = mulberry32(1234);
    for (let tier = 1; tier <= 4; tier++) {
      for (let i = 0; i < 30; i++) {
        const loadout = makeLoadout({ tier, color1: 0x9d2f2b, color2: 0xd9c9a3, title: `T${tier}`, rng });
        expect(loadout.weapon.damage).toBeGreaterThan(15);
        expect(loadout.armor.body).toBeGreaterThan(0);
        expect(loadout.helmet).toBeDefined();
        expect(loadout.shield === null || loadout.shield.armor > 0).toBe(true);
        if (loadout.weapon.twoHanded) expect(loadout.shield).toBeNull();
      }
    }
  });

  it('uses the documented armour / shield / helmet datasets', () => {
    expect(Object.keys(ARMORS)).toContain('plate');
    expect(Object.keys(SHIELDS)).toContain('kite');
    expect(Object.keys(HELMETS)).toContain('great');
    expect(Object.keys(AI_PROFILES)).toEqual(expect.arrayContaining(['recruit', 'veteran', 'champion']));
  });
});

describe('progression', () => {
  it('increases xp requirements monotonically', () => {
    let prev = 0;
    for (let level = 1; level < 12; level++) {
      const need = xpForLevel(level);
      expect(need).toBeGreaterThan(prev);
      prev = need;
    }
  });

  it('grants hp per level with a cap', () => {
    expect(maxHpForLevel(1)).toBe(120);
    expect(maxHpForLevel(2)).toBe(122);
    expect(maxHpForLevel(99)).toBeLessThanOrEqual(150);
    expect(maxHpForLevel(99)).toBeGreaterThan(maxHpForLevel(2));
  });

  it('returns sensible rank names', () => {
    expect(rankForLevel(1)).toBe('Serf');
    expect(rankForLevel(6)).toBe('Knight');
    expect(rankForLevel(999)).toBe('Legend of the Sand');
  });

  it('uses the Warband melee reward table', () => {
    expect(meleeReward(0, false).denars).toBe(0);
    expect(meleeReward(2, false).denars).toBe(0);
    expect(meleeReward(3, false).denars).toBe(5);
    expect(meleeReward(5, false).denars).toBe(5);
    expect(meleeReward(6, false).denars).toBe(10);
    expect(meleeReward(9, false).denars).toBe(10);
    expect(meleeReward(10, false).denars).toBe(25);
    expect(meleeReward(19, false).denars).toBe(25);
    expect(meleeReward(20, false).denars).toBe(60);
    expect(meleeReward(35, true).denars).toBe(310);
    expect(meleeReward(35, true).xp).toBe(210);
    expect(meleeReward(35, true).renown).toBe(2);
  });
});

describe('tournament structure', () => {
  it('escalates 16 -> 8 -> 4 -> 2 -> 1', () => {
    expect(TOURNAMENT.contestants).toBe(16);
    expect(TOURNAMENT.rounds.map((r) => r.teams * r.teamSize)).toEqual([16, 8, 4, 2]);
    expect(TOURNAMENT.rounds.map((r) => r.survivors)).toEqual([8, 4, 2, 1]);
    expect(TOURNAMENT.rounds.map((r) => r.advanceTeams)).toEqual([2, 1, 1, 1]);
    for (let i = 1; i < TOURNAMENT.rounds.length; i++) {
      expect(TOURNAMENT.rounds[i].purse).toBeGreaterThan(TOURNAMENT.rounds[i - 1].purse);
    }
  });
});
