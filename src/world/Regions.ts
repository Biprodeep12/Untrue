// Per-region visit counters. A region's counter rises when its last chunk
// leaves the cache radius, so the next visit seeds every roll differently
// while chunks that stay loaded keep regenerating identically.

import { regionKey } from '../coords';

interface Region {
  active: number;
  visit: number;
}

export class RegionTracker {
  private readonly regions = new Map<number, Region>();

  visit(cx: number, cy: number): number {
    return this.regions.get(regionKey(cx, cy))?.visit ?? 0;
  }

  enter(cx: number, cy: number): void {
    const key = regionKey(cx, cy);
    const r = this.regions.get(key);
    if (r) r.active++;
    else this.regions.set(key, { active: 1, visit: 0 });
  }

  /** `renew` decides whether a region that fully unloads regenerates next time. */
  leave(cx: number, cy: number, renew: (region: number, visit: number) => boolean = () => true): void {
    const key = regionKey(cx, cy);
    const r = this.regions.get(key);
    if (!r) return;
    r.active--;
    if (r.active === 0 && renew(key, r.visit)) r.visit++;
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
