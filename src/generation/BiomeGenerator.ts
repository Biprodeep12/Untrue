// Grows a biome footprint outward from its trigger chunk (spec 3.2, steps 3 and 4).

import { MIN_BIOME_CHUNKS } from '../config';
import { Rng } from './Random';

export interface GrowOptions {
  startX: number;
  startY: number;
  rng: Rng;
  /** True when no loaded biome owns the chunk. */
  isFree(cx: number, cy: number): boolean;
  /** True when the chunk's climate matches the biome type. */
  matches(cx: number, cy: number): boolean;
  /** Smooth noise in [-1, 1] that roughens the border. */
  rough(cx: number, cy: number): number;
}

/** Rolls a target size and claims free chunks nearest-first. Chunks whose
 *  climate disagrees are taken only to reach the minimum size, so an area keeps
 *  its type while the borders move between visits. May return fewer than the
 *  minimum when hemmed in by loaded neighbours; the caller merges those. */
export function growBiome(o: GrowOptions): Array<[number, number]> {
  const target = MIN_BIOME_CHUNKS + o.rng.int(0, MIN_BIOME_CHUNKS * 2);
  const stretch = o.rng.range(0.6, 1.6);
  const angle = o.rng.range(0, Math.PI);
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);

  const claimed: Array<[number, number]> = [];
  const seen = new Set<string>();
  const heap = new MinHeap();

  const push = (cx: number, cy: number) => {
    const id = `${cx},${cy}`;
    if (seen.has(id)) return;
    seen.add(id);
    if (!o.isFree(cx, cy)) return;
    // Elliptical distance, rotated, with noise so the border is irregular.
    const dx = cx - o.startX;
    const dy = cy - o.startY;
    const u = (dx * cos + dy * sin) * stretch;
    const v = (-dx * sin + dy * cos) / stretch;
    let score = Math.sqrt(u * u + v * v) * (1 + 0.6 * o.rough(cx, cy));
    if (!o.matches(cx, cy)) score += 1e6;
    heap.push(score, cx, cy);
  };

  push(o.startX, o.startY);
  while (claimed.length < target && heap.size > 0) {
    const [score, cx, cy] = heap.pop();
    if (score >= 1e6 && claimed.length >= MIN_BIOME_CHUNKS) break;
    claimed.push([cx, cy]);
    push(cx + 1, cy);
    push(cx - 1, cy);
    push(cx, cy + 1);
    push(cx, cy - 1);
  }
  return claimed;
}

class MinHeap {
  private s: number[] = [];
  private x: number[] = [];
  private y: number[] = [];

  get size(): number {
    return this.s.length;
  }

  push(score: number, cx: number, cy: number): void {
    const { s, x, y } = this;
    let i = s.length;
    s.push(score);
    x.push(cx);
    y.push(cy);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (s[p] <= s[i]) break;
      this.swap(i, p);
      i = p;
    }
  }

  pop(): [number, number, number] {
    const { s, x, y } = this;
    const top: [number, number, number] = [s[0], x[0], y[0]];
    const last = s.length - 1;
    this.swap(0, last);
    s.pop();
    x.pop();
    y.pop();
    let i = 0;
    for (;;) {
      const l = i * 2 + 1;
      const r = l + 1;
      let m = i;
      if (l < s.length && s[l] < s[m]) m = l;
      if (r < s.length && s[r] < s[m]) m = r;
      if (m === i) break;
      this.swap(i, m);
      i = m;
    }
    return top;
  }

  private swap(a: number, b: number): void {
    const { s, x, y } = this;
    [s[a], s[b]] = [s[b], s[a]];
    [x[a], x[b]] = [x[b], x[a]];
    [y[a], y[b]] = [y[b], y[a]];
  }
}
