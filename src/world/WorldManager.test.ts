import { describe, expect, it } from 'vitest';
import { CHUNK_SIZE, MIN_BIOME_CHUNKS } from '../config';
import { keyX, keyY } from '../coords';
import { SyncGenerator } from './SyncGenerator';
import { WorldManager } from './WorldManager';
import type { WorldObject } from './WorldObject';

/** A 30 × 18 tile view, about what a phone in landscape shows. */
function view(px: number, py: number) {
  return { minX: px - 15, minY: py - 9, maxX: px + 15, maxY: py + 9, playerX: px, playerY: py, dirX: 1, dirY: 0 };
}

function newWorld(seed = 1234): WorldManager {
  return new WorldManager(seed, new SyncGenerator());
}

function cachedCount(world: WorldManager, o: WorldObject): number {
  return o.chunks.filter((k) => world.chunks.cached.has(k)).length;
}

function signature(world: WorldManager): Set<string> {
  return new Set([...world.objects.objects.values()].map((o) => `${o.kind}@${o.x},${o.y},${o.w}x${o.h}`));
}

describe('world streaming', () => {
  it('gives every cached chunk a biome of at least the minimum size', () => {
    const world = newWorld();
    for (let x = 0; x < 6000; x += 64) {
      world.update(view(x, x / 3));
      for (const key of world.chunks.cached) expect(world.biomes.at(key)).toBeDefined();
    }
    for (const b of world.biomes.records.values()) expect(b.chunks.length).toBeGreaterThanOrEqual(MIN_BIOME_CHUNKS);
  }, 20000);

  it('keeps memory bounded on a long walk', () => {
    const world = newWorld();
    let most = { chunks: 0, biomes: 0, objects: 0 };
    for (let x = 0; x < 40000; x += 16) {
      world.update(view(x, 0));
      most = {
        chunks: Math.max(most.chunks, world.chunks.chunks.size),
        biomes: Math.max(most.biomes, world.biomes.records.size),
        objects: Math.max(most.objects, [...world.objects.objects.values()].filter((o) => o.persistence !== 'persistent').length),
      };
    }
    expect(most.chunks).toBeLessThanOrEqual(world.chunks.cached.size);
    expect(most.biomes).toBeLessThan(12);
    expect(most.objects).toBeLessThan(40);
  }, 20000);

  it('is repeatable for the same seed and path', () => {
    const a = newWorld(99);
    const b = newWorld(99);
    for (let x = 0; x < 3000; x += 40) {
      a.update(view(x, 0));
      b.update(view(x, 0));
    }
    expect(signature(a)).toEqual(signature(b));
  });
});

describe('MVP: multi-chunk lifetime and regeneration', () => {
  it('keeps a multi-chunk object through a partial unload and discards it after a full one', () => {
    const world = newWorld();
    let target: WorldObject | undefined;
    let x = 0;
    for (; x < 20000 && !target; x += CHUNK_SIZE) {
      world.update(view(x, 0));
      target = [...world.objects.objects.values()].find(
        (o) => o.persistence !== 'persistent' && new Set(o.chunks.map(keyX)).size >= 2 && cachedCount(world, o) === o.chunks.length,
      );
    }
    expect(target, 'no multi-chunk object found').toBeDefined();
    const o = target!;

    // Walk east until part of the footprint has left the cache radius.
    let partial = false;
    for (; x < 40000; x += 4) {
      world.update(view(x, 0));
      const n = cachedCount(world, o);
      if (n > 0 && n < o.chunks.length) {
        partial = true;
        expect(world.objects.objects.get(o.id)).toBe(o);
        // Loaded chunks still show the object's stamp.
        for (const key of o.chunks) {
          const chunk = world.chunks.chunks.get(key);
          if (!chunk?.ready) continue;
          for (let ly = 0; ly < CHUNK_SIZE; ly++) {
            for (let lx = 0; lx < CHUNK_SIZE; lx++) {
              const gx = keyX(key) * CHUNK_SIZE + lx - o.x;
              const gy = keyY(key) * CHUNK_SIZE + ly - o.y;
              if (gx < 0 || gy < 0 || gx >= o.w || gy >= o.h) continue;
              const t = o.layout.tiles[gy * o.w + gx];
              if (t) expect(chunk.tiles[ly * CHUNK_SIZE + lx]).toBe(t - 1);
            }
          }
        }
      }
      if (n === 0) break;
    }
    expect(partial).toBe(true);
    expect(world.objects.objects.has(o.id)).toBe(false);
  });

  it('regenerates an area differently after a full unload, keeping biome types', () => {
    const world = newWorld();
    const home = { x: 3000, y: -2000 };
    world.update(view(home.x, home.y));
    const types = new Map([...world.chunks.cached].map((k) => [k, world.biomes.at(k)!.type]));
    const objectsBefore = signature(world);
    const chunk = world.chunks.get(Math.floor(home.x / CHUNK_SIZE), Math.floor(home.y / CHUNK_SIZE))!;
    const decosBefore = chunk.decos.slice();

    world.update(view(home.x + 20000, home.y));
    world.update(view(home.x, home.y));

    const after = world.chunks.get(Math.floor(home.x / CHUNK_SIZE), Math.floor(home.y / CHUNK_SIZE))!;
    expect(after.decos).not.toEqual(decosBefore);
    expect(signature(world)).not.toEqual(objectsBefore);
    let same = 0;
    for (const [k, t] of types) if (world.biomes.at(k)!.type === t) same++;
    expect(same / types.size).toBeGreaterThan(0.8);
  });
});
