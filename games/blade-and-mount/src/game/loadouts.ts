import {
  ARMORS,
  HELMETS,
  SHIELDS,
  WEAPONS,
  playerLoadoutForRound,
} from '../core/config';
import type { Loadout } from '../core/types';

export type WeaponIcon = 'sword' | 'greatsword' | 'spear' | 'axe';

export interface LoadoutChoice {
  id: string;
  name: string;
  subtitle: string;
  icon: WeaponIcon;
  loadout: Loadout;
  /** Short flavour line shown under the stats. */
  note: string;
}

function withShield(base: Loadout, shieldId: keyof typeof SHIELDS | null, color1: number, color2: number): Loadout['shield'] {
  if (!shieldId) return null;
  return { ...SHIELDS[shieldId], color: color1, color2 };
}

/** Four curated, meaningfully different player loadouts for a tournament round. */
export function tournamentLoadoutChoices(
  round: number,
  color1: number,
  color2: number,
): LoadoutChoice[] {
  const base = playerLoadoutForRound(round, color1, color2, () => 0.5);
  const r = Math.max(0, Math.min(3, round));
  const make = (id: string, name: string, subtitle: string, icon: WeaponIcon, weaponId: keyof typeof WEAPONS, shieldId: keyof typeof SHIELDS | null, note: string): LoadoutChoice => ({
    id,
    name,
    subtitle,
    icon,
    note,
    loadout: {
      ...base,
      weapon: { ...WEAPONS[weaponId] },
      shield: withShield(base, shieldId, color1, color2),
      title: base.title,
    },
  });
  const choices = [
    make('sword', 'Sword & Kite', 'Balanced · reliable', 'sword', 'arming_sword', 'kite', 'The old faithful: quick cuts, a wall of linden board.'),
    make('axe', 'War Axe', 'Heavy · armour-breaker', 'axe', 'war_axe', 'heater', 'Slow, cruel and excellent at splitting mail.'),
    make('spear', 'War Spear', 'Long · controlling', 'spear', 'spear', 'heater', 'Keep them at the point of the spear — if you can.'),
    make('greatsword', 'Greatsword', 'Two-handed · reach', 'greatsword', 'greatsword', null, 'No shield. No excuses. A sweeping two-handed blade.'),
  ];
  if (r >= 2) {
    choices[1] = make('mace', 'Flanged Mace', 'Heavy · crushes plate', 'axe', 'mace', 'heater', 'A knight-killer: heavy, short and armour-piercing.');
  }
  return choices;
}

/** Four curated loadouts for the arena melee. */
export function meleeLoadoutChoices(): LoadoutChoice[] {
  const color1 = 0x7c2f2c;
  const color2 = 0xd9c9a3;
  const make = (id: string, name: string, subtitle: string, icon: WeaponIcon, weaponId: keyof typeof WEAPONS, shieldId: keyof typeof SHIELDS | null, note: string): LoadoutChoice => ({
    id,
    name,
    subtitle,
    icon,
    note,
    loadout: {
      weapon: { ...WEAPONS[weaponId] },
      shield: withShield({
        weapon: WEAPONS.arming_sword,
        shield: SHIELDS.kite,
        armor: ARMORS.hauberk,
        helmet: HELMETS.nasal,
        color1,
        color2,
        title: 'Arena Arms',
      }, shieldId, color1, color2),
      armor: { ...ARMORS.hauberk },
      helmet: { ...HELMETS.nasal },
      color1,
      color2,
      title: 'Arena Arms',
    },
  });
  return [
    make('sword', 'Sword & Kite', 'Balanced · reliable', 'sword', 'arming_sword', 'kite', 'Quick cuts, a stout shield, and a fighting chance.'),
    make('axe', 'War Axe', 'Heavy · armour-breaker', 'axe', 'war_axe', 'heater', 'Trade speed for brutal, armour-splitting blows.'),
    make('spear', 'Boar Spear', 'Long · two-handed', 'spear', 'boar_spear', null, 'Hold the crowd at bay with a wall of ash and steel.'),
    make('greatsword', 'Greatsword', 'Two-handed · reach', 'greatsword', 'greatsword', null, 'A sweeping two-handed blade for the bold and the doomed.'),
  ];
}

export function weaponStats(loadout: Loadout): { damage: number; speed: number; reach: number } {
  return {
    damage: loadout.weapon.damage,
    speed: loadout.weapon.speed,
    reach: loadout.weapon.reach,
  };
}
