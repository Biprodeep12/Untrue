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
        objects: Math.max(most.objects, world.objects.objects.size),
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
        (o) => new Set(o.chunks.map(keyX)).size >= 2 && cachedCount(world, o) === o.chunks.length,
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

describe('a world shared with guests', () => {
  it('keeps the union of everyone’s areas, and a region drifts only once all have left it', () => {
    const world = newWorld();
    const home = { x: 0, y: 0 };
    const far = { x: 5000, y: 0 };
    world.update(view(home.x, home.y));
    const cx = Math.floor(home.x / CHUNK_SIZE);
    const cy = Math.floor(home.y / CHUNK_SIZE);
    // A guest far off: both areas are loaded and simulated.
    world.update(view(home.x, home.y), [view(far.x, far.y)]);
    expect(world.tileAt(far.x, far.y)).not.toBeNull();
    expect(world.chunks.simRects.length).toBe(2);
    expect(world.chunks.get(Math.floor(far.x / CHUNK_SIZE), 0)!.simulated).toBe(true);
    // The host walks away; the guest walks home and stays: home does not drift.
    world.update(view(far.x + 3000, 0), [view(home.x, home.y)]);
    world.update(view(far.x + 3000, 0), [view(home.x, home.y)]);
    expect(world.regions.visit(cx, cy)).toBe(0);
    expect(world.tileAt(home.x, home.y)).not.toBeNull();
    // Now the guest leaves too: home has left everyone's area, and drifts.
    world.update(view(far.x + 3000, 0), []);
    expect(world.tileAt(home.x, home.y)).toBeNull();
    expect(world.regions.visit(cx, cy)).toBe(1);
  });

  it('a structure lives while any player’s cache holds one of its chunks', () => {
    const world = newWorld();
    let o: WorldObject | undefined;
    for (let x = 0; x < 20000 && !o; x += 64) {
      world.update(view(x, 0));
      o = [...world.objects.objects.values()].find((s) => s.chunks.length > 1);
    }
    const at = { x: o!.x + o!.w / 2, y: o!.y + o!.h / 2 };
    world.update(view(at.x, at.y));
    // The host leaves; a guest stands on it.
    world.update(view(at.x + 20000, at.y), [view(at.x, at.y)]);
    expect(world.objects.objects.get(o!.id)).toBe(o);
    world.update(view(at.x + 20000, at.y), []);
    expect(world.objects.objects.has(o!.id)).toBe(false);
  });

  it('only generates a far chunk a guest asks for once it is in the guest’s area', () => {
    const world = newWorld();
    world.update(view(0, 0));
    expect(world.chunks.demand(200, 200)).toBe(false);
    world.update(view(0, 0), [view(200 * CHUNK_SIZE, 200 * CHUNK_SIZE)]);
    expect(world.chunks.demand(200, 200)).toBe(true);
    world.update(view(0, 0), [view(200 * CHUNK_SIZE, 200 * CHUNK_SIZE)]);
    expect(world.chunks.get(200, 200)?.ready).toBe(true);
  });

  it('tells a listener every change, and costs nothing without one', () => {
    const world = newWorld();
    world.update(view(0, 0));
    const heard: string[] = [];
    world.changes = {
      harvested: (gx, gy, deco) => heard.push(`harvested ${gx},${gy} ${deco}`),
      regrown: () => heard.push('regrown'),
      objectChanged: (o) => heard.push(`changed ${o.kind}`),
      objectAdded: (o) => heard.push(`added ${o.kind}`),
      objectRemoved: (o) => heard.push(`removed ${o.kind}`),
    };
    let tree: [number, number] | null = null;
    for (let y = -9; y < 9 && !tree; y++) for (let x = -15; x < 15 && !tree; x++) if (world.tileAt(x, y)?.deco) tree = [x, y];
    const deco = world.tileAt(tree![0], tree![1])!.deco;
    world.harvest(tree![0], tree![1]);
    expect(heard).toEqual([`harvested ${tree![0]},${tree![1]} ${deco}`]);
    expect(world.harvestOf(world.chunks.get(Math.floor(tree![0] / CHUNK_SIZE), Math.floor(tree![1] / CHUNK_SIZE))!.key)).toHaveLength(3);
    // Walking away drops the structures around: each going is heard.
    const before = world.objects.objects.size;
    world.update(view(20000, 0));
    expect(heard.filter((h) => h.startsWith('removed')).length).toBeGreaterThanOrEqual(before);
  });

  it('a guest’s copy never rolls its own biomes, structures or visits', () => {
    const host = newWorld();
    host.update(view(0, 0));
    const guest = new WorldManager(1234, new SyncGenerator(), true);
    guest.update(view(0, 0));
    expect(guest.objects.objects.size).toBe(0);
    expect(guest.biomes.records.size).toBe(0);
    // What the host says is taken as is.
    const key = [...host.chunks.cached][0];
    const b = host.biomes.at(key)!;
    guest.adoptChunk(keyX(key), keyY(key), 3, b);
    expect(guest.biomes.at(key)?.id).toBe(b.id);
    expect(guest.regions.visit(keyX(key), keyY(key))).toBe(3);
    // Leaving never raises a visit here.
    guest.update(view(20000, 0));
    expect(guest.regions.visit(keyX(key), keyY(key))).toBe(3);
    expect(guest.biomes.at(key)).toBeUndefined();
  });
});
