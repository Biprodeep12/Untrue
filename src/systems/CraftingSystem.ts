// Crafting (spec 5). The adventurer never builds, so stations are found in the
// world: campfires in camps, anvils in villages and castles.

import { Deco } from '../generation/Tiles';
import { Items, type ItemDef } from '../items/Items';
import type { Inventory } from './InventorySystem';

export type Station = 'hand' | 'campfire' | 'anvil';

export const STATION_DECO: Record<Exclude<Station, 'hand'>, number> = {
  campfire: Deco.Campfire,
  anvil: Deco.Anvil,
};
export const STATION_NAMES: Record<Station, string> = { hand: 'By hand', campfire: 'Campfire', anvil: 'Anvil' };
/** How close a station must be, in tiles. */
export const STATION_RANGE = 3;

export interface Recipe {
  output: ItemDef;
  count: number;
  station: Station;
  inputs: Array<[ItemDef, number]>;
}

export const RECIPES: readonly Recipe[] = [
  { output: Items.stoneAxe, count: 1, station: 'hand', inputs: [[Items.wood, 3], [Items.stone, 2]] },
  { output: Items.stonePickaxe, count: 1, station: 'hand', inputs: [[Items.wood, 3], [Items.stone, 3]] },
  { output: Items.bandage, count: 1, station: 'hand', inputs: [[Items.herb, 2]] },
  { output: Items.roastMushroom, count: 1, station: 'campfire', inputs: [[Items.mushroom, 2]] },
  { output: Items.stew, count: 1, station: 'campfire', inputs: [[Items.mushroom, 2], [Items.herb, 1], [Items.berries, 1]] },
  { output: Items.ironIngot, count: 1, station: 'anvil', inputs: [[Items.ironOre, 2], [Items.coal, 1]] },
  { output: Items.ironAxe, count: 1, station: 'anvil', inputs: [[Items.ironIngot, 2], [Items.wood, 2]] },
  { output: Items.ironPickaxe, count: 1, station: 'anvil', inputs: [[Items.ironIngot, 3], [Items.wood, 2]] },
  { output: Items.woodenSword, count: 1, station: 'hand', inputs: [[Items.wood, 5]] },
  { output: Items.bow, count: 1, station: 'hand', inputs: [[Items.wood, 3], [Items.silk, 2]] },
  { output: Items.arrow, count: 6, station: 'hand', inputs: [[Items.wood, 1], [Items.stone, 1]] },
  { output: Items.leatherArmor, count: 1, station: 'hand', inputs: [[Items.hide, 5]] },
  { output: Items.leatherCap, count: 1, station: 'hand', inputs: [[Items.hide, 2]] },
  { output: Items.leatherPants, count: 1, station: 'hand', inputs: [[Items.hide, 3]] },
  { output: Items.leatherBoots, count: 1, station: 'hand', inputs: [[Items.hide, 2]] },
  { output: Items.woodenShield, count: 1, station: 'hand', inputs: [[Items.wood, 6]] },
  { output: Items.antidote, count: 1, station: 'hand', inputs: [[Items.herb, 2], [Items.berries, 1]] },
  { output: Items.cookedMeat, count: 1, station: 'campfire', inputs: [[Items.rawMeat, 1]] },
  { output: Items.ironSword, count: 1, station: 'anvil', inputs: [[Items.ironIngot, 3], [Items.wood, 1]] },
  { output: Items.ironArmor, count: 1, station: 'anvil', inputs: [[Items.ironIngot, 5], [Items.hide, 2]] },
  { output: Items.ironHelmet, count: 1, station: 'anvil', inputs: [[Items.ironIngot, 2]] },
  { output: Items.ironGreaves, count: 1, station: 'anvil', inputs: [[Items.ironIngot, 3], [Items.hide, 1]] },
  { output: Items.ironBoots, count: 1, station: 'anvil', inputs: [[Items.ironIngot, 2]] },
  { output: Items.ironShield, count: 1, station: 'anvil', inputs: [[Items.ironIngot, 3], [Items.wood, 2]] },
  { output: Items.torch, count: 3, station: 'hand', inputs: [[Items.wood, 1], [Items.coal, 1]] },
  { output: Items.lantern, count: 1, station: 'anvil', inputs: [[Items.ironIngot, 1], [Items.spiritEssence, 2]] },
];

export function hasInputs(inv: Inventory, r: Recipe): boolean {
  return r.inputs.every(([item, n]) => inv.count(item) >= n);
}

export type CraftResult = 'ok' | 'missing' | 'station' | 'full';

/** Crafts one batch. `stations` lists the stations within range. */
export function craft(inv: Inventory, r: Recipe, stations: ReadonlySet<Station>): CraftResult {
  if (!stations.has(r.station)) return 'station';
  if (!hasInputs(inv, r)) return 'missing';
  for (const [item, n] of r.inputs) inv.remove(item, n);
  const left = inv.add(r.output, r.count);
  if (left > 0) {
    // No room: undo so nothing is lost.
    inv.remove(r.output, r.count - left);
    for (const [item, n] of r.inputs) inv.add(item, n);
    return 'full';
  }
  return 'ok';
}
