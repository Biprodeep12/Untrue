// Seeded randomness: integer hashing, independent per-system streams, weighted picks.

/** Independent random streams, one per system, so changing one system's
 *  rolls never shifts another's. */
export const Stream = {
  Noise: 1,
  Biome: 2,
  Decoration: 3,
  Structure: 4,
  Lake: 5,
  RareEvent: 6,
  Layout: 7,
  Loot: 8,
} as const;

function mix(h: number, v: number): number {
  h = Math.imul(h ^ (v | 0), 0x9e3779b1);
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

export function hash(...values: number[]): number {
  let h = 0x811c9dc5;
  for (const v of values) h = mix(h, v);
  return h;
}

/** FNV-1a hash of a string, for ids. */
export function hashString(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193);
  return h >>> 0;
}

/** Allocation-free hash for per-tile hot loops. */
export function hash3(a: number, b: number, c: number): number {
  return mix(mix(mix(0x811c9dc5, a), b), c);
}

/** Uniform float in [0, 1) from a 32-bit hash. */
export function unit(h: number): number {
  return h / 4294967296;
}

/** Mulberry32 PRNG. */
export class Rng {
  private s: number;

  constructor(seed: number) {
    this.s = seed >>> 0;
  }

  next(): number {
    let t = (this.s = (this.s + 0x6d2b79f5) | 0);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** Integer in [min, max], inclusive. */
  int(min: number, max: number): number {
    return min + Math.floor(this.next() * (max - min + 1));
  }

  range(min: number, max: number): number {
    return min + this.next() * (max - min);
  }

  chance(p: number): boolean {
    return this.next() < p;
  }

  pick<T>(items: readonly T[]): T {
    return items[Math.floor(this.next() * items.length)];
  }

  uint(): number {
    return Math.floor(this.next() * 4294967296) >>> 0;
  }

  weighted<T>(items: readonly T[], weight: (item: T) => number): T | undefined {
    let total = 0;
    for (const item of items) total += Math.max(0, weight(item));
    if (total <= 0) return undefined;
    let roll = this.next() * total;
    for (const item of items) {
      roll -= Math.max(0, weight(item));
      if (roll < 0) return item;
    }
    return items[items.length - 1];
  }
}

export function streamRng(stream: number, ...values: number[]): Rng {
  return new Rng(hash(stream, ...values));
}
