// Items lying on the ground: dropped from the bag, picked up by walking over
// them. They stay where they were dropped, and are saved with the world.

import { itemById } from '../items/Items';
import type { Inventory, Stack } from '../systems/InventorySystem';

/** Picked up within this many tiles of the player's feet. */
const PICKUP_RANGE = 0.7;
/** A dropped item waits until the player has stepped this far away, so it is
 *  not picked straight back up. */
const ARM_RANGE = 1.4;
/** The oldest are lost past this many. */
const MAX_ITEMS = 300;

export interface GroundItem {
  readonly id: number;
  stack: Stack;
  x: number;
  y: number;
  /** Can be picked up. */
  armed: boolean;
}

export interface SavedGroundItem {
  id: string;
  count: number;
  durability?: number;
  x: number;
  y: number;
}

let nextId = 1;

export class GroundItems {
  readonly items: GroundItem[] = [];

  drop(stack: Stack, x: number, y: number, armed = false): GroundItem {
    const g = { id: nextId++, stack, x, y, armed };
    this.items.push(g);
    if (this.items.length > MAX_ITEMS) this.items.shift();
    return g;
  }

  /** Picks up what the player walks over; returns what was taken. */
  update(px: number, py: number, inv: Inventory): Stack[] {
    const taken: Stack[] = [];
    for (let i = this.items.length - 1; i >= 0; i--) {
      const g = this.items[i];
      const d = Math.hypot(g.x - px, g.y - py);
      if (!g.armed) {
        g.armed = d > ARM_RANGE;
        continue;
      }
      if (d > PICKUP_RANGE) continue;
      const left = inv.addStack(g.stack);
      const got = g.stack.count - left;
      if (got > 0) taken.push({ ...g.stack, count: got });
      if (left > 0) {
        g.stack = { ...g.stack, count: left };
        // Try again once the player steps away and back.
        g.armed = false;
      } else this.items.splice(i, 1);
    }
    return taken;
  }

  save(): SavedGroundItem[] {
    return this.items.map((g) => ({ id: g.stack.item.id, count: g.stack.count, durability: g.stack.durability, x: g.x, y: g.y }));
  }

  load(saved: readonly SavedGroundItem[]): void {
    this.items.length = 0;
    for (const s of saved) {
      const item = itemById(s.id);
      if (item) this.drop({ item, count: s.count, durability: s.durability }, s.x, s.y, true);
    }
  }
}
