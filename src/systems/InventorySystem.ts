// Slot inventory (spec 5): stacking, quantities, a hotbar row and moving items.

import { EQUIP_SLOTS, itemById, ItemRarity, weightOf, type EquipSlot, type ItemDef, type ToolKind } from '../items/Items';

export const INVENTORY_SIZE = 24;
/** The first row doubles as the hotbar. */
export const HOTBAR_SIZE = 8;

export interface Stack {
  item: ItemDef;
  count: number;
  /** Uses left, for weapons. */
  durability?: number;
}

export type SavedSlot = { id: string; count: number; durability?: number } | null;

/** Worn armour and the off-hand item, by slot. */
export type Equipment = Record<EquipSlot, Stack | null>;
/** Armour never stops more than this share of a blow. */
const MAX_ARMOR = 0.6;

export class Inventory {
  readonly slots: Array<Stack | null> = new Array(INVENTORY_SIZE).fill(null);
  readonly equipment: Equipment = { head: null, chest: null, legs: null, feet: null, offhand: null };
  /** Bumped on every change, so views redraw only when needed. */
  version = 0;

  /** How many the player has, in the bag or equipped. */
  count(item: ItemDef): number {
    let n = 0;
    for (const s of this.slots) if (s?.item === item) n += s.count;
    for (const s of Object.values(this.equipment)) if (s?.item === item) n += s.count;
    return n;
  }

  /** Adds as much as fits; returns how many did not. */
  add(item: ItemDef, count: number): number {
    // Nothing to add (and a NaN count would poison every stack it touched).
    if (!(count > 0)) return 0;
    this.version++;
    for (const s of this.slots) {
      if (count <= 0) break;
      if (s?.item !== item || s.count >= item.stack) continue;
      const n = Math.min(count, item.stack - s.count);
      s.count += n;
      count -= n;
    }
    for (let i = 0; i < this.slots.length && count > 0; i++) {
      if (this.slots[i]) continue;
      const n = Math.min(count, item.stack);
      this.slots[i] = { item, count: n, durability: item.weapon?.durability };
      count -= n;
    }
    return count;
  }

  /** Tidies the bag below the hotbar: like items merged, then weapons,
   *  tools, armour, food, materials and treasure, rarest first. */
  sort(): void {
    const kind = (i: ItemDef) =>
      i.weapon ? 0 : i.tool ? 1 : i.equip ? 2 : i.food ? 3 : i.rarity >= ItemRarity.Epic ? 5 : 4;
    const loose: Stack[] = [];
    for (let i = HOTBAR_SIZE; i < this.slots.length; i++) {
      const s = this.slots[i];
      this.slots[i] = null;
      if (!s) continue;
      // Merge into an open stack of the same item (worn weapons never stack).
      const same = s.item.stack > 1 ? loose.find((o) => o.item === s.item && o.count < s.item.stack) : undefined;
      if (same) {
        const n = Math.min(s.count, s.item.stack - same.count);
        same.count += n;
        s.count -= n;
      }
      if (s.count > 0) loose.push(s);
    }
    loose.sort((a, b) => kind(a.item) - kind(b.item) || b.item.rarity - a.item.rarity || a.item.name.localeCompare(b.item.name));
    loose.forEach((s, k) => (this.slots[HOTBAR_SIZE + k] = s));
    this.version++;
  }

  /** Removes `count` if all of it is there, from the bag first and then
   *  from what is equipped; returns whether it did. */
  remove(item: ItemDef, count: number): boolean {
    if (this.count(item) < count) return false;
    this.version++;
    for (let i = this.slots.length - 1; i >= 0 && count > 0; i--) {
      const s = this.slots[i];
      if (s?.item !== item) continue;
      const n = Math.min(count, s.count);
      s.count -= n;
      count -= n;
      if (s.count === 0) this.slots[i] = null;
    }
    for (const slot of EQUIP_SLOTS) {
      const s = this.equipment[slot];
      if (count <= 0 || s?.item !== item) continue;
      const n = Math.min(count, s.count);
      s.count -= n;
      count -= n;
      if (s.count === 0) this.equipment[slot] = null;
    }
    return true;
  }

  /** Wears or holds the item in a bag slot, swapping out what was there. A
   *  stack of torches goes into the off hand whole. Returns whether it did. */
  equip(slot: number): boolean {
    const s = this.slots[slot];
    const to = s?.item.equip;
    if (!s || !to) return false;
    this.version++;
    this.slots[slot] = this.equipment[to];
    this.equipment[to] = s;
    return true;
  }

  /** Runs a change and, if it returns false, puts the bag and equipment back
   *  exactly as they were (counts and durability), e.g. when what it gave
   *  did not fit. */
  tryChange(change: () => boolean): boolean {
    const slots = this.slots.map((s) => s && { ...s });
    const equipment = EQUIP_SLOTS.map((k) => this.equipment[k] && { ...this.equipment[k] });
    if (change()) return true;
    slots.forEach((s, i) => (this.slots[i] = s));
    EQUIP_SLOTS.forEach((k, i) => (this.equipment[k] = equipment[i]));
    this.version++;
    return false;
  }

  /** Takes off an equipped item and puts it in the bag, if there is room. */
  unequip(to: EquipSlot): boolean {
    const s = this.equipment[to];
    if (!s) return false;
    const free = this.slots.indexOf(null);
    if (free < 0) return false;
    this.version++;
    this.slots[free] = s;
    this.equipment[to] = null;
    return true;
  }

  /** Puts on the best armour piece for each empty slot from the bag. */
  autoEquip(): void {
    for (const to of EQUIP_SLOTS) {
      if (to === 'offhand' || this.equipment[to]) continue;
      let best = -1;
      this.slots.forEach((s, i) => {
        if (s?.item.equip === to && (best < 0 || (s.item.armor ?? 0) > (this.slots[best]!.item.armor ?? 0))) best = i;
      });
      if (best >= 0) this.equip(best);
    }
  }

  /** Takes one from a specific slot. */
  takeOne(slot: number): ItemDef | null {
    const s = this.slots[slot];
    if (!s) return null;
    this.version++;
    if (--s.count === 0) this.slots[slot] = null;
    return s.item;
  }

  /** Moves a slot onto another: merges equal stacks, otherwise swaps. */
  move(from: number, to: number): void {
    if (from === to) return;
    this.version++;
    const a = this.slots[from];
    const b = this.slots[to];
    if (a && b && a.item === b.item && b.count < b.item.stack) {
      const n = Math.min(a.count, b.item.stack - b.count);
      b.count += n;
      a.count -= n;
      if (a.count === 0) this.slots[from] = null;
      return;
    }
    this.slots[from] = b;
    this.slots[to] = a;
  }

  /** Wears a weapon down by one use; returns true if it broke. */
  wear(slot: number): boolean {
    const s = this.slots[slot];
    if (s?.durability === undefined) return false;
    this.version++;
    s.durability--;
    if (s.durability > 0) return false;
    this.slots[slot] = null;
    return true;
  }

  private weighed = { version: -1, weight: 0 };

  /** Total carry weight, equipment included; cached until the bag changes. */
  weight(): number {
    if (this.weighed.version === this.version) return this.weighed.weight;
    let w = 0;
    for (const s of this.slots) if (s) w += weightOf(s.item) * s.count;
    for (const s of Object.values(this.equipment)) if (s) w += weightOf(s.item) * s.count;
    this.weighed = { version: this.version, weight: w };
    return w;
  }

  /** Takes a whole slot out of the bag, e.g. to drop it. */
  takeSlot(slot: number): Stack | null {
    const s = this.slots[slot];
    if (!s) return null;
    this.version++;
    this.slots[slot] = null;
    return s;
  }

  /** Puts a stack back, keeping its durability; returns how many did not fit. */
  addStack(stack: Stack): number {
    if (stack.durability === undefined || stack.item.stack > 1) return this.add(stack.item, stack.count);
    const i = this.slots.indexOf(null);
    if (i < 0) return stack.count;
    this.version++;
    this.slots[i] = { ...stack };
    return 0;
  }

  /** Share of damage the worn armour absorbs: every piece adds up. */
  armor(): number {
    let total = 0;
    for (const s of Object.values(this.equipment)) total += s?.item.armor ?? 0;
    return Math.min(MAX_ARMOR, total);
  }

  /** The shield in the off hand, if any. */
  shield(): ItemDef['shield'] {
    return this.equipment.offhand?.item.shield;
  }

  saveEquipment(): Partial<Record<EquipSlot, SavedSlot>> {
    const out: Partial<Record<EquipSlot, SavedSlot>> = {};
    for (const slot of EQUIP_SLOTS) {
      const s = this.equipment[slot];
      if (s) out[slot] = { id: s.item.id, count: s.count, durability: s.durability };
    }
    return out;
  }

  loadEquipment(saved: Partial<Record<EquipSlot, SavedSlot>>): void {
    this.version++;
    for (const slot of EQUIP_SLOTS) {
      const s = saved[slot];
      const item = s && itemById(s.id);
      this.equipment[slot] = item && item.equip === slot ? loadStack(item, s) : null;
    }
  }

  /** The best tool of a kind carried, if any. */
  bestTool(kind: ToolKind): ItemDef | null {
    let best: ItemDef | null = null;
    for (const s of this.slots) if (s?.item.tool?.kind === kind && (!best || s.item.tool.tier > best.tool!.tier)) best = s.item;
    return best;
  }

  /** Highest tier of a tool kind carried, 0 for bare hands. */
  toolTier(kind: ToolKind): number {
    let tier = 0;
    for (const s of this.slots) if (s?.item.tool?.kind === kind) tier = Math.max(tier, s.item.tool.tier);
    return tier;
  }

  save(): SavedSlot[] {
    return this.slots.map((s) => (s ? { id: s.item.id, count: s.count, durability: s.durability } : null));
  }

  load(saved: SavedSlot[]): void {
    this.version++;
    this.slots.fill(null);
    saved.forEach((s, i) => {
      const item = s && itemById(s.id);
      if (item && i < this.slots.length) this.slots[i] = loadStack(item, s);
    });
  }
}

/** A saved stack, checked: a count that is not a positive number drops it,
 *  and a weapon's durability falls back to new if it is missing or broken. */
export function loadStack(item: ItemDef, s: NonNullable<SavedSlot>): Stack | null {
  const count = Math.floor(s.count);
  if (!(count >= 1)) return null;
  const max = item.weapon?.durability;
  const durability = max === undefined ? undefined : s.durability !== undefined && s.durability > 0 ? Math.min(max, s.durability) : max;
  return { item, count, durability };
}
