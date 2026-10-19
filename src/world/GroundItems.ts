// Items lying on the ground: dropped from the bag, picked up by walking over
// them. They stay where they were dropped, and are saved with the world, for
// as long as their region does: when it drifts (fully leaves the active area
// and regenerates), what lay on it drifts with it.

import { itemById } from '../items/Items';
import { loadStack, type Inventory, type Stack } from '../systems/InventorySystem';

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
  /** The region it lies in, and that region's visit when it was dropped. */
  region: number;
  visit: number;
}

/** Where the land's regions are and how often each has regenerated. */
export interface DriftClock {
  /** The region key of a spot, in tiles. */
  region(x: number, y: number): number;
  /** A region's visit counter. */
  visit(region: number): number;
}

export interface SavedGroundItem {
  id: string;
  count: number;
  durability?: number;
  x: number;
  y: number;
  /** Its region's visit when it was dropped; missing before saves v9. */
  visit?: number;
}

let nextId = 1;

/** Someone wants to hear of every item put down or taken away (a host
 *  telling its guests); nobody listens alone. */
export interface GroundListener {
  added(g: GroundItem): void;
  removed(g: GroundItem): void;
}

const NONE: Stack[] = [];

export class GroundItems {
  readonly items: GroundItem[] = [];
  /** Set by the world; without it nothing ever drifts (tests, rooms). */
  drift: DriftClock | null = null;
  listener: GroundListener | null = null;
  /** A guest's copy of the host's ground: nothing is picked up here; walking
   *  over an item asks for it instead (`reach`). */
  reach: ((g: GroundItem) => void) | null = null;

  drop(stack: Stack, x: number, y: number, armed = false, visit?: number, id = nextId++): GroundItem {
    const region = this.drift?.region(x, y) ?? 0;
    const g = { id, stack, x, y, armed, region, visit: visit ?? this.drift?.visit(region) ?? 0 };
    this.items.push(g);
    this.listener?.added(g);
    if (this.items.length > MAX_ITEMS) this.lose(0);
    return g;
  }

  /** The item with this id, if it is here. */
  byId(id: number): GroundItem | undefined {
    for (const g of this.items) if (g.id === id) return g;
    return undefined;
  }

  /** Takes an item away; false if it was not here. */
  remove(id: number): boolean {
    const i = this.items.findIndex((g) => g.id === id);
    if (i < 0) return false;
    this.lose(i);
    return true;
  }

  private lose(i: number): void {
    const [g] = this.items.splice(i, 1);
    this.listener?.removed(g);
  }

  /** Picks up what the player walks over; returns what was taken. */
  update(px: number, py: number, inv: Inventory): Stack[] {
    const reach = this.reach;
    let taken = NONE;
    for (let i = this.items.length - 1; i >= 0; i--) {
      const g = this.items[i];
      const d = Math.hypot(g.x - px, g.y - py);
      if (!g.armed) {
        g.armed = d > ARM_RANGE;
        continue;
      }
      if (d > PICKUP_RANGE) continue;
      if (reach) {
        // Asked for once; armed again when the player steps away and back.
        g.armed = false;
        reach(g);
        continue;
      }
      const left = inv.addStack(g.stack);
      const got = g.stack.count - left;
      if (got > 0) (taken === NONE ? (taken = []) : taken).push({ ...g.stack, count: got });
      if (left > 0) {
        g.stack = { ...g.stack, count: left };
        // Try again once the player steps away and back.
        g.armed = false;
        if (this.listener) {
          this.listener.removed(g);
          this.listener.added(g);
        }
      } else this.lose(i);
    }
    return taken;
  }

  /** Lets go of what lies on regions that have drifted since it was dropped;
   *  called when a region's visit rises, so never per frame. */
  sweep(): number {
    const drift = this.drift;
    if (!drift) return 0;
    let gone = 0;
    for (let i = this.items.length - 1; i >= 0; i--) {
      const g = this.items[i];
      if (drift.visit(g.region) === g.visit) continue;
      this.lose(i);
      gone++;
    }
    return gone;
  }

  save(): SavedGroundItem[] {
    return this.items.map((g) => ({ id: g.stack.item.id, count: g.stack.count, durability: g.stack.durability, x: g.x, y: g.y, visit: g.visit }));
  }

  /** Region visits must be loaded first: items from a visit that has since
   *  drifted are not brought back. Older saves' items count as from this visit. */
  load(saved: readonly SavedGroundItem[]): void {
    this.items.length = 0;
    for (const s of saved) {
      const item = itemById(s.id);
      if (!item || !Number.isFinite(s.x) || !Number.isFinite(s.y)) continue;
      const stack = loadStack(item, s);
      const visit = Number.isInteger(s.visit) && s.visit! >= 0 ? s.visit : undefined;
      if (stack) this.drop(stack, s.x, s.y, true, visit);
    }
    this.sweep();
  }
}
