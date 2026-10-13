// Trading with village traders and travelling merchants, for coins.

import { hashString, Rng } from '../generation/Random';
import { Items, type ItemDef } from '../items/Items';
import type { Inventory } from './InventorySystem';

export interface Offer {
  item: ItemDef;
  count: number;
  price: number;
}

/** What traders pay per item. Anything not listed they will not buy. */
export const SELL_PRICES = new Map<ItemDef, number>([
  [Items.vegetables, 2],
  [Items.idol, 250],
  [Items.starIngot, 120],
  [Items.gem, 60],
  [Items.starMetal, 45],
  [Items.crystal, 35],
  [Items.goldOre, 12],
  [Items.ironIngot, 8],
  [Items.spiritEssence, 8],
  [Items.venom, 6],
  [Items.iceShard, 6],
  [Items.ironOre, 4],
  [Items.hide, 3],
  [Items.silk, 3],
  [Items.chitin, 3],
  [Items.cookedMeat, 3],
  [Items.rawMeat, 1],
  [Items.bone, 1],
]);

const VILLAGE_STOCK: Offer[] = [
  { item: Items.arrow, count: 10, price: 12 },
  { item: Items.torch, count: 3, price: 6 },
  { item: Items.bandage, count: 1, price: 8 },
  { item: Items.antidote, count: 1, price: 12 },
  { item: Items.cookedMeat, count: 2, price: 10 },
  { item: Items.stew, count: 1, price: 14 },
  { item: Items.woodenSword, count: 1, price: 20 },
  { item: Items.bow, count: 1, price: 55 },
  { item: Items.leatherArmor, count: 1, price: 60 },
  { item: Items.leatherCap, count: 1, price: 22 },
  { item: Items.leatherBoots, count: 1, price: 22 },
  { item: Items.woodenShield, count: 1, price: 30 },
  { item: Items.stonePickaxe, count: 1, price: 18 },
];

const RARE_STOCK: Offer[] = [
  { item: Items.potion, count: 1, price: 35 },
  { item: Items.ironSword, count: 1, price: 140 },
  { item: Items.ironArmor, count: 1, price: 220 },
  { item: Items.ironHelmet, count: 1, price: 110 },
  { item: Items.ironShield, count: 1, price: 130 },
  { item: Items.ironPickaxe, count: 1, price: 120 },
  { item: Items.lantern, count: 1, price: 90 },
  { item: Items.ironIngot, count: 3, price: 30 },
];

/** A trader's goods, seeded by who they are so the shop is stable. */
export function stockFor(id: string, rare: boolean): Offer[] {
  const rng = new Rng(hashString(id));
  const pool = rare ? [...RARE_STOCK, ...VILLAGE_STOCK.slice(0, 4)] : VILLAGE_STOCK;
  const picks = new Set<Offer>();
  while (picks.size < Math.min(6, pool.length)) picks.add(rng.pick(pool));
  return [...picks];
}

export type TradeResult = 'ok' | 'coins' | 'full' | 'none';

export function buy(inv: Inventory, offer: Offer): TradeResult {
  if (inv.count(Items.coin) < offer.price) return 'coins';
  inv.remove(Items.coin, offer.price);
  const left = inv.add(offer.item, offer.count);
  if (left > 0) {
    // No room: put everything back.
    inv.remove(offer.item, offer.count - left);
    inv.add(Items.coin, offer.price);
    return 'full';
  }
  return 'ok';
}

/** Sells up to `count` of an item, one price each. */
export function sell(inv: Inventory, item: ItemDef, count = 1): TradeResult {
  const price = SELL_PRICES.get(item);
  const n = Math.min(count, inv.count(item));
  if (!price || n <= 0 || !inv.remove(item, n)) return 'none';
  inv.add(Items.coin, price * n);
  return 'ok';
}
