import { describe, expect, it } from 'vitest';
import { CHUNK_SIZE } from '../config';
import { Rng } from '../generation/Random';
import { STRUCTURES } from '../generation/StructureGenerator';
import { BiomeType, Deco, Tile } from '../generation/Tiles';
import { restore, snapshot } from '../save/SaveManager';
import { Interior } from './Interior';
import { SyncGenerator } from './SyncGenerator';
import { WorldManager } from './WorldManager';
import { WorldObject } from './WorldObject';

function view(px: number, py: number) {
  return { minX: px - 15, minY: py - 9, maxX: px + 15, maxY: py + 9, playerX: px, playerY: py, dirX: 0, dirY: 0 };
}

const build = (kind: string, seed = 1) =>
  STRUCTURES.find((d) => d.kind === kind)!.build({ rng: new Rng(seed), palette: 0, biome: BiomeType.Forest });

describe('buildings', () => {
  it('stand on a solid footprint with a doorstep in front of the door', () => {
    for (const kind of ['house', 'cabin', 'village', 'castle', 'giant-city']) {
      const l = build(kind, 7);
      expect(l.buildings.length, kind).toBeGreaterThan(0);
      for (const b of l.buildings) {
        for (let y = b.y; y < b.y + b.h; y++) for (let x = b.x; x < b.x + b.w; x++) expect(l.decos[y * l.w + x]).toBe(Deco.Footprint);
        expect(b.door).toBeGreaterThanOrEqual(1);
        expect(b.door).toBeLessThanOrEqual(b.w - 2);
        expect(l.tileAt(b.x + b.door, b.y + b.h)).toBe(Tile.Path);
      }
    }
  });

  it('mirror with their layout and refuse to rotate', () => {
    const l = build('house', 3);
    const m = l.mirrored();
    const [a] = l.buildings;
    const [b] = m.buildings;
    expect(b.x).toBe(l.w - a.x - a.w);
    expect(m.tileAt(b.x + b.door, b.y + b.h)).toBe(Tile.Path);
    expect(() => l.rotated(1)).toThrow();
  });
});

describe('interiors', () => {
  const house = () => {
    const layout = build('house', 11);
    return new WorldObject('house@test', 'house', 'Small House', 100, 200, layout);
  };

  it('can be walked into and out of', () => {
    const o = house();
    const room = new Interior(o, 0);
    const b = o.layout.buildings[0];
    expect(room.isSolidAt(Math.floor(room.spawn.x), Math.floor(room.spawn.y))).toBe(false);
    expect(room.isSolidAt(room.exit.x, room.exit.y)).toBe(false);
    expect(room.isSolidAt(0, 0)).toBe(true);
    expect(room.isSolidAt(-1, 5)).toBe(true);
    expect(room.door).toEqual({ x: 100 + b.x + b.door, y: 200 + b.y + b.h - 1 });
    expect(room.outside).toEqual({ x: room.door.x + 0.5, y: room.door.y + 1.9 });
    const decos = [...room.decos];
    expect(decos).toContain(Deco.Bed);
    expect(decos).toContain(Deco.Table);
  });

  it('are the same every visit, and their chests stay looted', () => {
    const o = house();
    const a = new Interior(o, 0);
    const b = new Interior(o, 0);
    expect([...a.decos]).toEqual([...b.decos]);
    a.decos[a.w + 1] = Deco.Chest;
    o.opened.add(a.chestId(1, 1));
    expect(a.tileAt(1, 1)!.deco).toBe(Deco.ChestOpen);
  });
});

describe('saves keep the world as it was', () => {
  it('restores region visits and gathered plants', () => {
    const world = new WorldManager(1234, new SyncGenerator());
    world.update(view(0, 0));
    let bush: [number, number] | null = null;
    for (const c of world.chunks.chunks.values()) {
      const i = c.ready ? c.decos.indexOf(Deco.Bush) : -1;
      if (i >= 0) {
        bush = [c.cx * CHUNK_SIZE + (i % CHUNK_SIZE), c.cy * CHUNK_SIZE + Math.floor(i / CHUNK_SIZE)];
        break;
      }
    }
    world.harvest(...bush!);
    // Leave and come back once, so some regions have a visit count.
    world.update(view(30000, 0));
    world.update(view(0, 0));
    world.harvest(...bush!);
    const data = snapshot(world, { x: 0, y: 0, inventory: [], vitals: null, progression: null });
    expect(data.regions.length).toBeGreaterThan(0);

    const fresh = new WorldManager(1234, new SyncGenerator());
    restore(fresh, data);
    fresh.update(view(0, 0));
    expect(fresh.regions.visit(Math.floor(bush![0] / CHUNK_SIZE), Math.floor(bush![1] / CHUNK_SIZE))).toBe(
      world.regions.visit(Math.floor(bush![0] / CHUNK_SIZE), Math.floor(bush![1] / CHUNK_SIZE)),
    );
    expect(fresh.tileAt(...bush!)!.deco).toBe(0);
  });
});

describe('castles', () => {
  const keepOf = (seed: number) => {
    const layout = build('castle', seed);
    const o = new WorldObject(`castle@${seed}`, 'castle', 'Castle', 0, 0, layout);
    return { o, layout, index: layout.buildings.findIndex((b) => b.style === 'keep') };
  };

  it('have a moat, a drawbridge, walls and a keep', () => {
    const { layout, index } = keepOf(3);
    expect(index).toBeGreaterThanOrEqual(0);
    expect(layout.tileAt(0, 0)).toBe(Tile.Water);
    const m = Math.floor(layout.w / 2);
    expect(layout.tileAt(m - 1, layout.h - 1)).toBe(Tile.BridgeV);
    expect(layout.tileAt(4, 10)).toBe(Tile.StoneWall);
    expect(layout.buildings.filter((b) => b.style === 'stone')).toHaveLength(2);
  });

  it('have a keep with a cellar, a great hall and an upper floor joined by stairs', () => {
    for (const seed of [3, 8, 21]) {
      const { o, index } = keepOf(seed);
      const hall = new Interior(o, index, 0);
      expect(hall.floorName).toBe('Great Hall');
      expect(hall.stairs.map((s) => s.to).sort()).toEqual([-1, 1]);
      expect([...hall.decos]).toContain(Deco.Throne);
      for (const to of [-1, 1]) {
        const floor = new Interior(o, index, to);
        // Arriving puts the player on open floor by the stairs back down or up.
        const at = floor.arrival(0);
        expect(floor.isSolidAt(Math.floor(at.x), Math.floor(at.y))).toBe(false);
        expect(floor.stairs.some((s) => s.to === 0)).toBe(true);
        // Only the great hall has a way out.
        expect(floor.exit.x).toBeLessThan(0);
      }
      const cellar = new Interior(o, index, -1);
      const chest = cellar.decos.indexOf(Deco.Chest);
      expect(chest).toBeGreaterThan(0);
      const x = chest % cellar.w;
      const y = Math.floor(chest / cellar.w);
      // Chests on different floors never share an id.
      expect(cellar.chestId(x, y)).not.toBe(hall.chestId(x, y));
      expect(cellar.cave).toBe(true);
    }
  });
});

describe('discovered places', () => {
  it('are announced once while loaded, and forgotten with their chunks', () => {
    const world = new WorldManager(1234, new SyncGenerator());
    let x = 0;
    let found: WorldObject | undefined;
    for (; x < 3000 && !found; x += 32) {
      world.update(view(x, 0));
      found = [...world.objects.objects.values()].find((o) => !o.discovered);
    }
    expect(found).toBeDefined();
    const o = found!;
    let announced = 0;
    world.onDiscover = () => announced++;
    const inside = view(o.x + o.w / 2, o.y + o.h / 2);
    world.update(inside);
    world.update(inside);
    expect(o.discovered).toBe(true);
    expect(announced).toBe(1);
    // Every structure forgets: once its chunks unload, it is gone, and nothing of it is saved.
    world.update(view(o.x + 30000, 0));
    expect(world.objects.objects.has(o.id)).toBe(false);
    expect(snapshot(world, { x, y: 0, inventory: [], vitals: null, progression: null })).not.toHaveProperty('objects');
  });
});
