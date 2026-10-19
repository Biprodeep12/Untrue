import { Container, Sprite, Texture } from 'pixi.js';
import { describe, expect, it } from 'vitest';
import { CHUNK_SIZE, TILE_SIZE } from '../config';
import { Deco, Tile } from '../generation/Tiles';
import type { Light } from '../rendering/Lighting';
import { SiteRenderer } from '../rendering/SiteRenderer';
import type { Chunk } from '../world/Chunk';
import { bakeHollow } from './bake/hollowMap';
import { DimensionRun } from './Challenges';
import { decodeDimension } from './DimensionData';
import { DimensionWorld } from './DimensionWorld';
import { HOLLOW } from './Hollow';

const L = decodeDimension(bakeHollow());

function view(px: number, py: number) {
  return { minX: px - 15, minY: py - 9, maxX: px + 15, maxY: py + 9, playerX: px, playerY: py, dirX: 0, dirY: 0 };
}

/** Counts what the chunk manager shows and hides. */
function listen(land: DimensionWorld) {
  const shown = new Set<number>();
  land.chunks.listener = {
    show: (c: Chunk) => shown.add(c.key),
    hide: (c: Chunk) => shown.delete(c.key),
    changed: () => {},
  };
  return shown;
}

describe('a dimension on the overworld engine', () => {
  it('slices its fixed map into chunks, with void off the map', () => {
    const land = new DimensionWorld(L, 7);
    const shown = listen(land);
    const a = L.arrival;
    land.update(view(a.x, a.y));
    land.chunks.showPending();
    expect(shown.size).toBeGreaterThan(0);
    for (const chunk of land.chunks.chunks.values()) {
      expect(chunk.ready).toBe(true);
      for (let i = 0; i < CHUNK_SIZE * CHUNK_SIZE; i++) {
        const gx = chunk.cx * CHUNK_SIZE + (i % CHUNK_SIZE);
        const gy = chunk.cy * CHUNK_SIZE + Math.floor(i / CHUNK_SIZE);
        const on = gx >= 0 && gy >= 0 && gx < L.w && gy < L.h;
        expect(chunk.tiles[i]).toBe(on ? L.ground[gy * L.w + gx] : Tile.Void);
        expect(chunk.decos[i]).toBe(on ? L.decos[gy * L.w + gx] : 0);
      }
    }
    // Off the map: void, and solid, so nothing walks off it.
    land.update(view(-40, -40));
    land.chunks.showPending();
    const off = land.chunks.get(-2, -2)!;
    expect(off.ready).toBe(true);
    expect(off.tiles.every((t) => t === Tile.Void)).toBe(true);
    expect(land.isSolidAt(-1, -1)).toBe(true);
    expect(land.isVoidAt(-1, -1)).toBe(true);
    expect(land.tileAt(-1, -1)).toBeNull();
  });

  it('gathers for this trip only, recomposing the chunk', () => {
    const tree = L.decos.indexOf(Deco.HollowTree);
    const gx = tree % L.w;
    const gy = Math.floor(tree / L.w);
    const land = new DimensionWorld(L, 7);
    listen(land);
    land.update(view(gx, gy));
    land.chunks.showPending();
    expect(land.isSolidAt(gx, gy)).toBe(true);
    land.harvest(gx, gy);
    expect(land.decoAt(gx, gy)).toBe(0);
    expect(land.isSolidAt(gx, gy)).toBe(false);
    const chunk = land.chunks.get(Math.floor(gx / CHUNK_SIZE), Math.floor(gy / CHUNK_SIZE))!;
    expect(chunk.decos[(gy % CHUNK_SIZE) * CHUNK_SIZE + (gx % CHUNK_SIZE)]).toBe(0);
    // The map itself is untouched: the next trip finds the tree.
    expect(L.decos[tree]).toBe(Deco.HollowTree);
    expect(new DimensionWorld(L, 7).decoAt(gx, gy)).toBe(Deco.HollowTree);
    // Gathering seeds by tile and trip.
    expect(land.seedAt(gx, gy)).toBe(new DimensionWorld(L, 7).seedAt(gx, gy));
    expect(land.seedAt(gx, gy)).not.toBe(new DimensionWorld(L, 8).seedAt(gx, gy));
  });

  it('lets go of every chunk when the trip ends', () => {
    const land = new DimensionWorld(L, 7);
    const shown = listen(land);
    land.update(view(L.arrival.x, L.arrival.y));
    land.chunks.showPending();
    expect(shown.size).toBeGreaterThan(0);
    land.dispose();
    expect(shown.size).toBe(0);
    expect(land.chunks.chunks.size).toBe(0);
    // Streaming again starts afresh.
    land.update(view(L.arrival.x, L.arrival.y));
    land.chunks.showPending();
    expect(shown.size).toBeGreaterThan(0);
  });

  it('answers collision from the map in well under a microsecond a tile', () => {
    const land = new DimensionWorld(L, 7);
    let n = 0;
    const t = performance.now();
    for (let k = 0; k < 20; k++) for (let y = 0; y < L.h; y++) for (let x = 0; x < L.w; x++) if (land.isSolidAt(x, y)) n++;
    const per = (performance.now() - t) / (20 * L.w * L.h);
    expect(n).toBeGreaterThan(0);
    expect(per).toBeLessThan(0.001);
  });
});

describe('SiteRenderer', () => {
  it('culls to the view, reuses its sprites, and frees everything on close', () => {
    const entities = new Container({ sortableChildren: true });
    const r = new SiteRenderer(Texture.WHITE, entities);
    const run = new DimensionRun(HOLLOW, L, 77);
    r.open(run);
    expect(r.opened).toBe(true);
    // Nothing stands among the entities until a view is given.
    expect(entities.children.length).toBe(0);
    const c = L.sites.find((s) => s.kind === 'puzzle')!.center;
    const at = (x: number, y: number): [number, number, number, number] => [x * TILE_SIZE - 240, y * TILE_SIZE - 135, x * TILE_SIZE + 240, y * TILE_SIZE + 135];
    r.update(...at(c.x, c.y));
    const near = entities.children.length;
    expect(near).toBeGreaterThan(0);
    expect(r.flats.children.length).toBeGreaterThan(0);

    // Frames create nothing new.
    const made = new Set(entities.children);
    for (let k = 0; k < 120; k++) {
      run.update(1 / 60, L.arrival.x, L.arrival.y);
      run.takeEvents();
      r.update(...at(c.x, c.y));
    }
    expect(entities.children.every((s) => made.has(s))).toBe(true);

    // The portal glows only when in view.
    const lights: Light[] = [];
    r.lights(lights);
    expect(lights.length).toBe(0);
    const p = L.portal;
    r.update(...at(p % L.w, Math.floor(p / L.w)));
    r.lights(lights);
    expect(lights.length).toBe(1);

    // Far away, nothing of the sites stands among the entities.
    r.update(-5000, -5000, -4500, -4700);
    expect(entities.children.length).toBe(0);

    r.close();
    expect(r.opened).toBe(false);
    expect(entities.children.length).toBe(0);
    expect(r.flats.children.length).toBe(0);
    // A second trip reuses the pooled sprites.
    const before = new Set<Sprite>();
    r.open(run);
    r.update(-1e6, -1e6, 1e6, 1e6);
    for (const s of [...entities.children, ...r.flats.children]) before.add(s as Sprite);
    r.close();
    r.open(new DimensionRun(HOLLOW, L, 78));
    r.update(-1e6, -1e6, 1e6, 1e6);
    const now = [...entities.children, ...r.flats.children];
    expect(now.every((s) => before.has(s as Sprite))).toBe(true);
    r.close();
  });
});
