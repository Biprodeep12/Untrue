import { describe, expect, it } from 'vitest';
import { SyncGenerator } from '../world/SyncGenerator';
import { WorldManager } from '../world/WorldManager';
import { EXPLORE_STEP, ExplorationSystem } from './ExplorationSystem';

function view(px: number, py: number) {
  return { minX: px - 15, minY: py - 9, maxX: px + 15, maxY: py + 9, playerX: px, playerY: py, dirX: 0, dirY: 0 };
}

describe('exploration', () => {
  it('records what the player has seen and rewards milestones', () => {
    const world = new WorldManager(1234, new SyncGenerator());
    const ex = new ExplorationSystem();
    const milestones: number[] = [];
    ex.onMilestone = (n) => milestones.push(n);
    for (let x = 0; x < 3000; x += 16) {
      world.update(view(x, 0));
      ex.update(world);
    }
    expect(ex.explored.size).toBeGreaterThan(EXPLORE_STEP);
    expect(milestones[0]).toBe(EXPLORE_STEP);
    // Seen chunks stay seen after the world unloads them.
    world.update(view(50000, 0));
    expect(ex.explored.size).toBeGreaterThan(EXPLORE_STEP);
  });

  it('keeps markers and the tracked one through a save', () => {
    const ex = new ExplorationSystem();
    const a = ex.addMarker(10, 20, 'Camp');
    ex.addMarker(-5, 7);
    ex.tracked = a.id;
    ex.explored.set(123456, 3);
    const copy = new ExplorationSystem();
    copy.load(ex.save());
    expect(copy.trackedMarker?.label).toBe('Camp');
    expect(copy.explored.get(123456)).toBe(3);
    copy.removeMarker(a.id);
    expect(copy.tracked).toBeNull();
    expect(copy.addMarker(0, 0).id).toBe(3);
  });
});
