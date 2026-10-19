// Biome records (spec 3.2): one record owns many chunks, is created the first
// time one of them loads, and is dropped when none of them remain loaded.

import { MIN_BIOME_CHUNKS } from '../config';
import { chunkKey } from '../coords';
import { growBiome } from '../generation/BiomeGenerator';
import { streamRng, Stream } from '../generation/Random';
import type { TerrainFields } from '../generation/TerrainGenerator';
import { BIOME_NAMES, paletteOf, type BiomeType } from '../generation/Tiles';

/** Chance that a new biome is its type's rare variant. */
const VARIANT_CHANCE = 0.08;

export interface BiomeRecord {
  id: number;
  type: BiomeType;
  variant: number;
  /** Seeds this biome's local noise, so a regenerated biome looks different. */
  seed: number;
  chunks: number[];
  /** Footprint chunks currently inside the cache radius. */
  activeChunks: number;
}

export function biomeName(b: BiomeRecord): string {
  return BIOME_NAMES[paletteOf(b.type, b.variant)];
}

export class BiomeManager {
  readonly records = new Map<number, BiomeRecord>();
  private readonly owner = new Map<number, BiomeRecord>();
  private nextId = 1;

  constructor(private readonly fields: TerrainFields) {}

  at(key: number): BiomeRecord | undefined {
    return this.owner.get(key);
  }

  /** A guest takes the host's record for a chunk (it never grows biomes
   *  itself: borders depend on what loaded first, which differs by player). */
  adopt(key: number, id: number, type: BiomeType, variant: number, seed: number): BiomeRecord {
    const had = this.owner.get(key);
    if (had?.id === id) return had;
    if (had) this.release(key);
    let record = this.records.get(id);
    if (!record) this.records.set(id, (record = { id, type, variant, seed, chunks: [], activeChunks: 0 }));
    this.owner.set(key, record);
    record.chunks.push(key);
    record.activeChunks++;
    return record;
  }

  /** A guest's chunk left: it lets go of the host's record for it. */
  release(key: number): void {
    const b = this.owner.get(key);
    if (!b) return;
    this.owner.delete(key);
    const i = b.chunks.indexOf(key);
    if (i >= 0) b.chunks.splice(i, 1);
    if (--b.activeChunks <= 0) this.records.delete(b.id);
  }

  chunkEntered(key: number): void {
    const b = this.owner.get(key);
    if (b) b.activeChunks++;
  }

  chunkLeft(key: number): void {
    const b = this.owner.get(key);
    if (!b) return;
    b.activeChunks--;
    if (b.activeChunks === 0) {
      for (const k of b.chunks) this.owner.delete(k);
      this.records.delete(b.id);
    }
  }

  /** Returns the chunk's biome, generating a new one around it if none exists. */
  ensure(cx: number, cy: number, visit: number, isCached: (key: number) => boolean): BiomeRecord {
    const existing = this.owner.get(chunkKey(cx, cy));
    if (existing) return existing;

    const { fields } = this;
    const type = fields.climateAt(cx, cy);
    const rng = streamRng(Stream.Biome, fields.worldSeed, cx, cy, visit);
    const seed = rng.uint();
    const variant = rng.chance(VARIANT_CHANCE) ? 1 : 0;
    const offX = (seed & 0xffff) * 0.013;
    const offY = (seed >>> 16) * 0.017;
    const cells = growBiome({
      startX: cx,
      startY: cy,
      rng,
      isFree: (x, y) => !this.owner.has(chunkKey(x, y)),
      matches: (x, y) => fields.climateAt(x, y) === type,
      rough: (x, y) => fields.warp.noise2(x / 5 + offX, y / 5 + offY),
    });

    // Hemmed in by loaded neighbours below the minimum: join the neighbour it
    // touches most instead of leaving a sliver.
    let record: BiomeRecord | undefined;
    if (cells.length < MIN_BIOME_CHUNKS) record = this.mostTouching(cells);
    if (!record) {
      record = { id: this.nextId++, type, variant, seed, chunks: [], activeChunks: 0 };
      this.records.set(record.id, record);
    }
    for (const [x, y] of cells) {
      const key = chunkKey(x, y);
      this.owner.set(key, record);
      record.chunks.push(key);
      if (isCached(key)) record.activeChunks++;
    }
    return record;
  }

  private mostTouching(cells: Array<[number, number]>): BiomeRecord | undefined {
    const contacts = new Map<BiomeRecord, number>();
    for (const [x, y] of cells) {
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const b = this.owner.get(chunkKey(x + dx, y + dy));
        if (b) contacts.set(b, (contacts.get(b) ?? 0) + 1);
      }
    }
    let best: BiomeRecord | undefined;
    let most = 0;
    for (const [b, n] of contacts) {
      if (n > most) {
        best = b;
        most = n;
      }
    }
    return best;
  }
}
