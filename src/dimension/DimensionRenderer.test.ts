import { Container, Sprite, Texture } from 'pixi.js';
import { describe, expect, it } from 'vitest';
import { TILE_SIZE } from '../config';
import { DimensionRenderer } from '../rendering/DimensionRenderer';
import type { Light } from '../rendering/Lighting';
import { DimensionRun } from './Challenges';
import { HOLLOW } from './Hollow';

describe('DimensionRenderer', () => {
  it('culls to the view, reuses its sprites, and frees everything on close', () => {
    const ground = new Container();
    const entities = new Container({ sortableChildren: true });
    const r = new DimensionRenderer(Texture.WHITE, ground, entities);
    const run = new DimensionRun(HOLLOW, 77);
    r.open(run);
    expect(r.opened).toBe(true);
    // Nothing stands among the entities until a view is given.
    expect(entities.children.length).toBe(0);
    const c = run.layout.chambers[0].center;
    const view = (x: number, y: number): [number, number, number, number] => [x * TILE_SIZE - 240, y * TILE_SIZE - 135, x * TILE_SIZE + 240, y * TILE_SIZE + 135];
    r.update(...view(c.x, c.y));
    const near = entities.children.length;
    expect(near).toBeGreaterThan(0);
    const lights: Light[] = [];
    r.lights(lights);
    expect(lights.length).toBeGreaterThan(0);

    // Frames create nothing new.
    const made = new Set(entities.children);
    for (let k = 0; k < 120; k++) {
      run.update(1 / 60, run.layout.arrival.x, run.layout.arrival.y);
      run.takeEvents();
      r.update(...view(c.x, c.y));
    }
    expect(entities.children.every((s) => made.has(s))).toBe(true);

    // Far away, nothing of the arrival stands among the entities.
    r.update(-5000, -5000, -4500, -4700);
    expect(entities.children.length).toBe(0);

    r.close();
    expect(r.opened).toBe(false);
    expect(entities.children.length).toBe(0);
    // A second run reuses the pooled sprites.
    const before = new Set<Sprite>();
    r.open(run);
    r.update(-1e6, -1e6, 1e6, 1e6);
    for (const s of entities.children) before.add(s as Sprite);
    r.close();
    r.open(new DimensionRun(HOLLOW, 78));
    r.update(-1e6, -1e6, 1e6, 1e6);
    const reused = entities.children.filter((s) => before.has(s as Sprite)).length;
    expect(reused).toBeGreaterThan(0);
    r.close();
  });
});
