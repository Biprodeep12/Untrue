import { afterEach, describe, expect, it, vi } from 'vitest';
import { DIMENSIONS, dimensionById, pickDimension, type DimensionLayout } from './Dimension';
import { DimTile, isSolidDim, NO_GLYPH } from './DimTile';
import { generateHollow, HOLLOW, HOLLOW_REWARDS, RIFT_SHARD_ID } from './Hollow';
import { ATLAS_H, dimCell, dimFrame } from '../rendering/Atlas';

/** Every tile the player can walk to from the arrival with every door open and
 *  the path whole (crumbling and glitching tiles count as floor). */
function reachable(L: DimensionLayout): Uint8Array {
  const seen = new Uint8Array(L.w * L.h);
  const start = Math.floor(L.arrival.y) * L.w + Math.floor(L.arrival.x);
  const stack = [start];
  seen[start] = 1;
  while (stack.length) {
    const t = stack.pop()!;
    const x = t % L.w;
    const y = Math.floor(t / L.w);
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= L.w || ny >= L.h) continue;
      const n = ny * L.w + nx;
      if (seen[n] || L.tiles[n] === DimTile.Void || isSolidDim(L.tiles[n])) continue;
      seen[n] = 1;
      stack.push(n);
    }
  }
  return seen;
}

const tileOf = (L: DimensionLayout, p: { x: number; y: number }) => Math.floor(p.y) * L.w + Math.floor(p.x);

/** A solid tile counts as reached if the player can stand beside it. */
function besideReached(L: DimensionLayout, seen: Uint8Array, t: number): boolean {
  return [1, -1, L.w, -L.w].some((d) => seen[t + d] === 1);
}

afterEach(() => vi.restoreAllMocks());

describe('dimension registry', () => {
  it('lists The Hollow and picks it for any seed', () => {
    expect(DIMENSIONS.map((d) => d.id)).toContain('hollow');
    expect(dimensionById('hollow')).toBe(HOLLOW);
    expect(dimensionById('nowhere')).toBeUndefined();
    for (const seed of [0, 1, 99, 123456789]) expect(pickDimension(seed)).toBe(HOLLOW);
  });

  it('rewards the Rift Shard', () => {
    expect(HOLLOW.rewards).toBe(HOLLOW_REWARDS);
    expect(HOLLOW_REWARDS.some((r) => r.item === RIFT_SHARD_ID && r.chance === 1)).toBe(true);
  });
});

describe('The Hollow', () => {
  it('is the same for the same seed and differs between seeds', () => {
    const a = generateHollow(42);
    const b = generateHollow(42);
    expect(b.tiles).toEqual(a.tiles);
    expect(b.glyphs).toEqual(a.glyphs);
    expect(b.phase).toEqual(a.phase);
    expect(b.chambers).toEqual(a.chambers);
    expect(generateHollow(43).tiles).not.toEqual(a.tiles);
  });

  it('never uses Math.random', () => {
    const spy = vi.spyOn(Math, 'random');
    for (let s = 0; s < 20; s++) generateHollow(s);
    expect(spy).not.toHaveBeenCalled();
  });

  it('chains the chambers in order, all reachable from the arrival', () => {
    for (let seed = 0; seed < 300; seed++) {
      const L = generateHollow(seed * 7919 + 1);
      expect(L.w).toBe(96);
      expect(L.chambers.map((c) => c.kind)).toEqual(['arrival', 'combat', 'hazard', 'puzzle', 'boss', 'vault']);
      expect(L.doors.length).toBe(5);
      const seen = reachable(L);
      for (const ch of L.chambers) {
        expect(seen[tileOf(L, ch.entry)], `seed ${seed} ${ch.kind} entry`).toBe(1);
        for (const s of ch.spawns) expect(seen[tileOf(L, s)], `seed ${seed} spawn`).toBe(1);
        for (const c of ch.checkpoints) expect(seen[tileOf(L, c)], `seed ${seed} checkpoint`).toBe(1);
        for (const t of ch.plates) if (t >= 0) expect(seen[t], `seed ${seed} plate`).toBe(1);
        for (const t of ch.mural) expect(besideReached(L, seen, t), `seed ${seed} mural`).toBe(true);
      }
      for (const door of L.doors) for (const t of door) expect(seen[t]).toBe(1);
      const boss = L.chambers[4];
      expect(seen[tileOf(L, boss.center)], `seed ${seed} boss centre`).toBe(1);
      const hazard = L.chambers[2];
      const g = hazard.goal!;
      expect(seen[g.y * L.w + g.x], `seed ${seed} goal`).toBe(1);
      expect(seen[L.portal], `seed ${seed} portal`).toBe(1);
      expect(besideReached(L, seen, L.chest), `seed ${seed} chest`).toBe(true);
      expect(L.tiles[L.rift]).toBe(DimTile.Rift);
    }
  });

  it('builds a void path of crumbling and glitching tiles with safe pads', () => {
    for (let seed = 0; seed < 50; seed++) {
      const L = generateHollow(seed);
      const hz = L.chambers[2];
      expect(hz.path.length).toBeGreaterThan(20);
      expect(hz.checkpoints.length).toBe(3);
      for (const t of hz.path) expect([DimTile.Crumble, DimTile.Glitch]).toContain(L.tiles[t]);
      let voids = 0;
      const r = hz.rect;
      for (let y = r.y + 1; y < r.y + r.h - 1; y++) for (let x = r.x + 1; x < r.x + r.w - 1; x++) if (L.tiles[y * L.w + x] === DimTile.Void) voids++;
      expect(voids).toBeGreaterThan(hz.path.length);
    }
  });

  it('shows the plate order on the mural', () => {
    for (let seed = 0; seed < 50; seed++) {
      const L = generateHollow(seed);
      const pz = L.chambers[3];
      expect(pz.order.length).toBeGreaterThanOrEqual(4);
      expect(new Set(pz.order).size).toBe(pz.order.length);
      pz.mural.forEach((t, k) => {
        expect(L.tiles[t]).toBe(DimTile.Glyph);
        expect(L.glyphs[t]).toBe(pz.order[k]);
      });
      for (const g of pz.order) {
        expect(L.tiles[pz.plates[g]]).toBe(DimTile.Plate);
        expect(L.glyphs[pz.plates[g]]).toBe(g);
      }
      expect(L.glyphs[L.portal]).toBe(NO_GLYPH);
    }
  });

  it('generates well under 20 ms', () => {
    const t0 = performance.now();
    for (let s = 0; s < 50; s++) generateHollow(s);
    expect((performance.now() - t0) / 50).toBeLessThan(20);
  });
});

describe('dimension art', () => {
  it('has a cell for every tile look and prop, inside the atlas', () => {
    for (const key of ['void', 'floor', 'wall-top', 'wall-face', 'glitch', 'crumble', 'plate-up', 'plate-down', 'checkpoint', 'rune']) {
      const [, y] = dimCell(key, 0);
      expect(y + 16).toBeLessThanOrEqual(ATLAS_H);
    }
    for (const key of ['pillar', 'crystal', 'gate:0', 'chest:0', 'chest:2', 'portal:0', 'portal:3', 'rift:1', 'glyph:5:2']) {
      const f = dimFrame(key);
      expect(f.y + f.h).toBeLessThanOrEqual(ATLAS_H);
    }
    expect(ATLAS_H).toBeLessThanOrEqual(4096);
  });
});
