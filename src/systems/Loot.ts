// Loot tables (spec 3.4). Chest contents are seeded by the chest itself, so the
// same chest always holds the same loot.

import { ItemRarity, Items, type ItemDef } from '../items/Items';
import type { Rng } from '../generation/Random';

/** The spec's chest table. */
export const CHEST_TABLE: ReadonlyArray<[ItemRarity, number]> = [
  [ItemRarity.Common, 60],
  [ItemRarity.Uncommon, 25],
  [ItemRarity.Rare, 10],
  [ItemRarity.Epic, 4],
  [ItemRarity.Legendary, 1],
];

type Pool = ReadonlyArray<[ItemDef, number, number]>;

const POOLS: Record<ItemRarity, Pool> = {
  [ItemRarity.Common]: [[Items.wood, 2, 5], [Items.stone, 2, 5], [Items.berries, 2, 4], [Items.herb, 1, 3], [Items.coal, 1, 3], [Items.mushroom, 1, 3], [Items.arrow, 3, 8]],
  [ItemRarity.Uncommon]: [[Items.ironOre, 1, 3], [Items.bandage, 1, 2], [Items.roastMushroom, 1, 2], [Items.ironIngot, 1, 2], [Items.stoneAxe, 1, 1], [Items.woodenSword, 1, 1], [Items.antidote, 1, 2], [Items.leatherArmor, 1, 1], [Items.leatherCap, 1, 1], [Items.leatherBoots, 1, 1], [Items.woodenShield, 1, 1]],
  [ItemRarity.Rare]: [[Items.goldOre, 1, 2], [Items.potion, 1, 1], [Items.stew, 1, 2], [Items.stonePickaxe, 1, 1], [Items.bow, 1, 1], [Items.leatherPants, 1, 1], [Items.ironHelmet, 1, 1], [Items.ironBoots, 1, 1]],
  [ItemRarity.Epic]: [[Items.crystal, 1, 1], [Items.gem, 1, 1], [Items.ironPickaxe, 1, 1], [Items.ironAxe, 1, 1], [Items.ironSword, 1, 1], [Items.ironArmor, 1, 1], [Items.ironGreaves, 1, 1], [Items.ironShield, 1, 1]],
  [ItemRarity.Legendary]: [[Items.idol, 1, 1]],
};

export type Drops = Array<[ItemDef, number]>;

function fromPool(rng: Rng, rarity: ItemRarity): [ItemDef, number] {
  const [item, min, max] = rng.pick(POOLS[rarity]);
  return [item, rng.int(min, max)];
}

/** Two to four rolls on the chest table, plus one per two difficulty bands. */
export function rollChest(rng: Rng, band: number): Drops {
  const drops: Drops = [];
  const rolls = rng.int(2, 4) + Math.floor(band / 2);
  for (let i = 0; i < rolls; i++) drops.push(fromPool(rng, rng.weighted(CHEST_TABLE, ([, w]) => w)![0]));
  return drops;
}

/** Barrels hold a little everyday loot. */
export function rollBarrel(rng: Rng): Drops {
  if (rng.chance(0.35)) return [];
  return [fromPool(rng, rng.chance(0.85) ? ItemRarity.Common : ItemRarity.Uncommon)];
}
