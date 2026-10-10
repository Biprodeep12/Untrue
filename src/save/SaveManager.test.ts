import { describe, expect, it } from 'vitest';
import { SyncGenerator } from '../world/SyncGenerator';
import { WorldManager } from '../world/WorldManager';
import type { WorldObject } from '../world/WorldObject';
import { restore, snapshot } from './SaveManager';

function view(px: number, py: number) {
  return { minX: px - 15, minY: py - 9, maxX: px + 15, maxY: py + 9, playerX: px, playerY: py, dirX: 0, dirY: 0 };
}

/** Walks east until a persistent rare find is loaded. */
function findPersistent(world: WorldManager): WorldObject {
  for (let x = 0; x < 40000; x += 32) {
    world.update(view(x, 0));
    const o = [...world.objects.objects.values()].find((o) => o.persistence === 'persistent');
    if (o) return o;
  }
  throw new Error('no persistent object found');
}

describe('save', () => {
  it('keeps rare persistent finds through a full unload', () => {
    const world = new WorldManager(1234, new SyncGenerator());
    const found = findPersistent(world);
    world.update(view(found.x + 30000, 0));
    expect(world.objects.objects.get(found.id)).toBe(found);
  });

  it('round-trips the seed, the player and persistent objects only', () => {
    const world = new WorldManager(1234, new SyncGenerator());
    const found = findPersistent(world);
    found.discovered = true;
    const data = snapshot(world, { x: 12.5, y: -3.1, inventory: [], vitals: null, progression: null });
    expect(data.seed).toBe(1234);
    expect(data.player).toMatchObject({ x: 12.5, y: -3.1 });
    expect(data.objects.every((o) => o.persistence === 'persistent')).toBe(true);

    const fresh = new WorldManager(data.seed, new SyncGenerator());
    restore(fresh, data);
    const back = fresh.objects.objects.get(found.id)!;
    expect(back.discovered).toBe(true);
    expect(back.layout.tiles).toEqual(found.layout.tiles);
    // Its own anchor rolls the same id on load, which must not duplicate it.
    fresh.update(view(found.x + found.w / 2, found.y + found.h / 2));
    expect([...fresh.objects.objects.values()].filter((o) => o.kind === found.kind && o.x === found.x)).toHaveLength(1);
  });
});
