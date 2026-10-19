// Per-region visit counters. A region's counter rises when its last chunk
// leaves the cache radius, so the next visit seeds every roll differently
// while chunks that stay loaded keep regenerating identically. This is the
// Drift: what the world remembers of a place (looted chests, cleared lairs,
// closed rifts, items on the ground) is kept per visit, and goes with it.

import { regionKey } from '../coords';

interface Region {
  active: number;
  visit: number;
}

export class RegionTracker {
  private readonly regions = new Map<number, Region>();
  /** A guest's copy: visits are the host's, set as its chunks arrive, never
   *  counted here (the host counts over every player's area). */
  replica = false;

  /** A guest takes the host's visit for a region (`regionKey`). */
  setVisit(key: number, visit: number): void {
    const r = this.regions.get(key);
    if (r) r.visit = visit;
    else this.regions.set(key, { active: 0, visit });
  }

  visit(cx: number, cy: number): number {
    return this.regions.get(regionKey(cx, cy))?.visit ?? 0;
  }

  /** A region's visit by its key (`regionKey`). */
  visitOf(key: number): number {
    return this.regions.get(key)?.visit ?? 0;
  }

  enter(cx: number, cy: number): void {
    const key = regionKey(cx, cy);
    const r = this.regions.get(key);
    if (r) r.active++;
    else this.regions.set(key, { active: 1, visit: 0 });
  }

  /** A region that fully unloads regenerates next time; true if this was its
   *  last chunk (it has drifted). */
  leave(cx: number, cy: number): boolean {
    const r = this.regions.get(regionKey(cx, cy));
    if (!r) return false;
    r.active--;
    if (r.active !== 0 || this.replica) return false;
    r.visit++;
    return true;
  }

  get size(): number {
    return this.regions.size;
  }

  /** Visit counters worth keeping, as flat pairs: region key, visit. */
  save(): number[] {
    const out: number[] = [];
    for (const [key, r] of this.regions) if (r.visit > 0) out.push(key, r.visit);
    return out;
  }

  load(pairs: number[]): void {
    for (let i = 0; i + 1 < pairs.length; i += 2) {
      const r = this.regions.get(pairs[i]);
      if (r) r.visit = pairs[i + 1];
      else this.regions.set(pairs[i], { active: 0, visit: pairs[i + 1] });
    }
  }
}

/** A memory of something at a chunk, kept for one visit of its region:
 *  `${what}#${visit}`. `what` names the chunk as `cx,cy` (an anchor, a lair). */
export function driftKey(what: string, visit: number): string {
  return `${what}#${visit}`;
}

/** The chunk and visit of a key made by `driftKey` (or an object id, which
 *  holds them too), or null for keys tied to no region (events). */
export function parseDriftKey(key: string): { cx: number; cy: number; visit: number } | null {
  const m = DRIFT_KEY.exec(key);
  return m ? { cx: Number(m[1]), cy: Number(m[2]), visit: Number(m[3]) } : null;
}

/** `cx,cy`, an optional `/slot`, then `#visit`: anchors (`cx,cy/slot#v`),
 *  lairs (`legend@cx,cy#v`) and object ids (`kind@cx,cy#v/slot`). Slots are
 *  names (`structure`, `rare`). */
const DRIFT_KEY = /(-?\d+),(-?\d+)(?:\/[\w-]+)?#(\d+)/;
