import { describe, expect, it } from 'vitest';
import { CHUNK_SIZE } from '../config';
import { Rng } from '../generation/Random';
import { STRUCTURES } from '../generation/StructureGenerator';
import { generateChunk, TerrainFields } from '../generation/TerrainGenerator';
import { BiomeType, Deco, isSolid, isWater, Tile } from '../generation/Tiles';
import { Items } from '../items/Items';
import { GatheringSystem, interactionAt } from '../systems/GatheringSystem';
import { Inventory } from '../systems/InventorySystem';
import { Vitals } from '../systems/Vitals';
import { Interior } from './Interior';
import { WorldObject } from './WorldObject';

const SEED = 1234;
const fields = new TerrainFields(SEED);
const chunks = new Map<string, Uint8Array>();

function tileAt(gx: number, gy: number): number {
  const cx = Math.floor(gx / CHUNK_SIZE);
  const cy = Math.floor(gy / CHUNK_SIZE);
  const key = `${cx},${cy}`;
  let tiles = chunks.get(key);
  if (!tiles) {
    const biomes = Array.from({ length: 9 }, () => [BiomeType.Forest, 0, 1]).flat();
    tiles = generateChunk(fields, { token: 0, cx, cy, worldSeed: SEED, visit: 0, biomes }).tiles;
    chunks.set(key, tiles);
  }
  return tiles[(gy - cy * CHUNK_SIZE) * CHUNK_SIZE + (gx - cx * CHUNK_SIZE)];
}

const BRIDGES: number[] = [Tile.BridgeH, Tile.BridgeH2, Tile.BridgeV, Tile.BridgeV2];

describe('rivers', () => {
  it('never run through the spawn', () => {
    for (let y = -20; y <= 20; y++) for (let x = -20; x <= 20; x++) expect(isWater(tileAt(x, y))).toBe(false);
  });

  it('have bridges that reach dry land at both ends', () => {
    let found = 0;
    for (let gy = -600; gy < 600 && found < 6; gy += 2) {
      for (let gx = -600; gx < 600 && found < 6; gx += 2) {
        if (!fields.riverAt(gx, gy).width || !BRIDGES.includes(fields.bridgeAt(gx, gy))) continue;
        const t = tileAt(gx, gy);
        if (!BRIDGES.includes(t)) continue;
        const along = t === Tile.BridgeH || t === Tile.BridgeH2 ? [1, 0] : [0, 1];
        for (const dir of [1, -1]) {
          let x = gx;
          let y = gy;
          let steps = 0;
          while (BRIDGES.includes(tileAt(x, y)) && steps++ < 40) {
            x += along[0] * dir;
            y += along[1] * dir;
          }
          // Off the end of the bridge is ground you can stand on.
          expect(isWater(tileAt(x, y))).toBe(false);
          expect(isSolid(tileAt(x, y), 0)).toBe(false);
        }
        found++;
        gx += 120;
      }
    }
    expect(found).toBeGreaterThan(0);
  });

  it('keep their bridges far from the origin, whatever was looked at first', () => {
    const site = (f: TerrainFields, cx: number, cy: number) => (f as unknown as { bridgeSite(cx: number, cy: number): unknown }).bridgeSite(cx, cy);
    for (let cx = 0; cx < 200; cx++) {
      const fresh = site(new TerrainFields(SEED), cx, 32768);
      if (!fresh) continue;
      // A 16-bit key packing gave this far-off cell the same cache slot.
      const warmed = new TerrainFields(SEED);
      site(warmed, cx + 1, -32768);
      expect(site(warmed, cx, 32768)).toEqual(fresh);
      return;
    }
    throw new Error('no bridge found');
  });
});

describe('the spawn', () => {
  it('has no mountains nearby, on any seed', () => {
    for (let seed = 1; seed <= 200; seed++) {
      const f = new TerrainFields(seed * 104729);
      for (let y = -48; y <= 48; y += 4) {
        for (let x = -48; x <= 48; x += 4) {
          if (Math.hypot(x, y) <= 48) expect(f.heightAt(x, y), `seed ${seed * 104729}`).toBeLessThan(0.52);
        }
      }
    }
  });

  it('always has a way out, on any seed', () => {
    for (let seed = 1; seed <= 12; seed++) {
      const f = new TerrainFields(seed * 7919);
      const cache = new Map<string, { tiles: Uint8Array; decos: Uint8Array }>();
      const at = (gx: number, gy: number) => {
        const cx = Math.floor(gx / CHUNK_SIZE);
        const cy = Math.floor(gy / CHUNK_SIZE);
        let c = cache.get(`${cx},${cy}`);
        if (!c) {
          const biomes = Array.from({ length: 9 }, () => [BiomeType.Forest, 0, 1]).flat();
          c = generateChunk(f, { token: 0, cx, cy, worldSeed: seed * 7919, visit: 0, biomes });
          cache.set(`${cx},${cy}`, c);
        }
        const i = (gy - cy * CHUNK_SIZE) * CHUNK_SIZE + (gx - cx * CHUNK_SIZE);
        return isSolid(c.tiles[i], c.decos[i]);
      };
      // Walk from the spawn until 100 tiles out.
      const R = 100;
      const seen = new Set<number>([0]);
      const queue: Array<[number, number]> = [[0, 0]];
      let escaped = false;
      while (queue.length && !escaped) {
        const [x, y] = queue.shift()!;
        for (const [nx, ny] of [[x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]]) {
          const k = (nx + 512) * 1024 + ny + 512;
          if (seen.has(k) || at(nx, ny)) continue;
          seen.add(k);
          if (Math.hypot(nx, ny) > R) escaped = true;
          queue.push([nx, ny]);
        }
      }
      expect(escaped, `seed ${seed * 7919}`).toBe(true);
    }
  });
});

describe('mines', () => {
  const mine = () => {
    const layout = STRUCTURES.find((d) => d.kind === 'mine')!.build({ rng: new Rng(5), palette: 0, biome: BiomeType.Forest });
    return new WorldObject('mine@test', 'mine', 'Mine', 40, 80, layout);
  };

  it('have an entrance into a cave of ore', () => {
    const o = mine();
    expect(o.layout.buildings).toHaveLength(1);
    expect(o.layout.buildings[0].style).toBe('mine');
    const cave = new Interior(o, 0);
    expect(cave.cave).toBe(true);
    expect(cave.isSolidAt(Math.floor(cave.spawn.x), Math.floor(cave.spawn.y))).toBe(false);
    expect([...cave.decos].filter((d) => d === Deco.Ore).length).toBeGreaterThanOrEqual(3);
    expect([...cave.decos]).toContain(Deco.SupportBeam);
  });

  it('can be mined, and what is mined stays gone', () => {
    const o = mine();
    const cave = new Interior(o, 0);
    const i = cave.decos.indexOf(Deco.Ore);
    const x = i % cave.w;
    const y = Math.floor(i / cave.w);
    const inv = new Inventory();
    const vitals = new Vitals();
    expect(interactionAt(cave, inv, vitals, x, y)?.kind).toBe('locked');
    inv.add(Items.stonePickaxe, 1);
    const action = interactionAt(cave, inv, vitals, x, y)!;
    expect(action.kind).toBe('harvest');
    const gathering = new GatheringSystem(null as never, inv, vitals, () => {});
    gathering.ground = cave;
    gathering.begin(action);
    gathering.update(10);
    expect(inv.count(Items.coal) + inv.count(Items.ironOre)).toBeGreaterThan(0);
    expect(cave.tileAt(x, y)!.deco).toBe(0);
    expect(new Interior(o, 0).tileAt(x, y)!.deco).toBe(0);
  });
});
