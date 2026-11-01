import { describe, expect, it } from 'vitest';
import { meleeLoadoutChoices, tournamentLoadoutChoices, weaponStats } from '../src/game/loadouts';

describe('player loadout choices', () => {
  it('offers four distinct tournament choices with valid gear', () => {
    for (let round = 0; round < 4; round++) {
      const choices = tournamentLoadoutChoices(round, 0x8e2f2b, 0xd9c9a3);
      expect(choices).toHaveLength(4);
      expect(new Set(choices.map((c) => c.id)).size).toBe(4);
      expect(new Set(choices.map((c) => c.loadout.weapon.id)).size).toBe(4);
      for (const c of choices) {
        expect(c.loadout.armor.body).toBeGreaterThan(0);
        expect(c.loadout.helmet.armor).toBeGreaterThanOrEqual(0);
        if (c.loadout.weapon.twoHanded) expect(c.loadout.shield).toBeNull();
        const s = weaponStats(c.loadout);
        expect(s.damage).toBeGreaterThan(15);
        expect(s.reach).toBeGreaterThan(1.5);
      }
    }
  });

  it('offers four melee choices including two-handed options', () => {
    const choices = meleeLoadoutChoices();
    expect(choices).toHaveLength(4);
    expect(choices.filter((c) => c.loadout.weapon.twoHanded).length).toBeGreaterThanOrEqual(2);
    for (const c of choices) {
      expect(c.loadout.armor.id).toBe('hauberk');
      expect(c.loadout.helmet.id).toBe('nasal');
    }
  });
});
