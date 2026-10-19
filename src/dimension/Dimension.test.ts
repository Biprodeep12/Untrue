import { describe, expect, it } from 'vitest';
import shipped from '../../public/dimensions/hollow.json?raw';
import { CHUNK_SIZE } from '../config';
import { Deco, Ground, groundTile, isSolid, isVoid, Tile } from '../generation/Tiles';
import { ATLAS_H, dimCell, dimFrame } from '../rendering/Atlas';
import { bakeHollow } from './bake/hollowMap';
import { DIMENSIONS, dimensionById, dimensionForRift, retuneChoices, type DimensionLayout } from './Dimension';
import { decodeDimension, DimensionDataError, fromBase64, rle, toBase64, unrle, type DimensionFile } from './DimensionData';
import { DimTile } from './DimTile';
import { HOLLOW, HOLLOW_REWARDS, RIFT_SHARD_ID } from './Hollow';

const file = (): DimensionFile => JSON.parse(shipped) as DimensionFile;

/** Every tile the player can walk to from the arrival; `bossOpen` with the Warden's gate open. */
function reachable(L: DimensionLayout, bossOpen: boolean): Uint8Array {
  const shut = new Set<number>();
  for (const s of L.sites) if (s.kind === 'boss' && !bossOpen) for (const t of s.gates) shut.add(t);
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
      if (seen[n] || shut.has(n)) continue;
      const site = L.tiles[n];
      const open = site === DimTile.Crumble || site === DimTile.Glitch || site === DimTile.Gate || site === DimTile.Plate || site === DimTile.Portal ||
        (site === DimTile.None && !isVoid(L.ground[n]) && !isSolid(L.ground[n], L.decos[n]));
      if (!open) continue;
      seen[n] = 1;
      stack.push(n);
    }
  }
  return seen;
}

const beside = (L: DimensionLayout, seen: Uint8Array, t: number) => [1, -1, L.w, -L.w].some((d) => seen[t + d] === 1);

/** Expects decoding a changed copy of the shipped file to be refused. */
function refused(change: (f: DimensionFile) => void, why: RegExp): void {
  const f = file();
  change(f);
  expect(() => decodeDimension(f)).toThrow(DimensionDataError);
  expect(() => decodeDimension(f)).toThrow(why);
}

describe('dimension registry', () => {
  it('lists The Hollow, then The Drowned Archive, in story order', () => {
    expect(DIMENSIONS.map((d) => d.id)).toEqual(['hollow', 'archive']);
    expect(dimensionById('hollow')).toBe(HOLLOW);
    expect(dimensionById('archive')?.name).toBe('The Drowned Archive');
    expect(dimensionById('nowhere')).toBeUndefined();
    // Before the Hollow is cleared, every rift leads there, and offers no choice.
    for (const seed of [0, 1, 0x7fffffff, -5]) expect(dimensionForRift(seed)).toBe('hollow');
    expect(retuneChoices('hollow', new Set())).toEqual(['hollow']);
    // Once it is, rifts lean to the Archive, and can be tuned back.
    const n = { hollow: 0, archive: 0 } as Record<string, number>;
    for (let seed = 0; seed < 2000; seed++) n[dimensionForRift(seed, new Set(['hollow']))]++;
    expect(n.archive).toBeGreaterThan(n.hollow * 3);
    expect(n.hollow).toBeGreaterThan(0);
    expect(retuneChoices('archive', new Set(['hollow']))).toEqual(['archive', 'hollow']);
  });

  it('leads rifts on in story order, sometimes back to worlds cleared, never ahead', () => {
    const registry = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
    const tally = (cleared: Set<string>) => {
      const n: Record<string, number> = { a: 0, b: 0, c: 0 };
      for (let seed = 0; seed < 4000; seed++) n[dimensionForRift(seed, cleared, registry)]++;
      return n;
    };
    // Nothing cleared: only the first.
    expect(tally(new Set())).toEqual({ a: 4000, b: 0, c: 0 });
    // The first cleared: mostly the second, sometimes the first, never the third.
    const one = tally(new Set(['a']));
    expect(one.c).toBe(0);
    expect(one.b).toBeGreaterThan(one.a * 4);
    expect(one.a).toBeGreaterThan(300);
    // All cleared: any, about evenly.
    const all = tally(new Set(['a', 'b', 'c']));
    for (const id of ['a', 'b', 'c']) expect(all[id]).toBeGreaterThan(1100);
    // The same rift always leads the same way.
    expect(dimensionForRift(42, new Set(['a']), registry)).toBe(dimensionForRift(42, new Set(['a']), registry));
    // Retuning: where it opens first, then what is cleared, in story order.
    expect(retuneChoices('b', new Set(['c', 'a']), registry)).toEqual(['b', 'a', 'c']);
    expect(retuneChoices('a', new Set(['a']), registry)).toEqual(['a']);
  });

  it('rewards the Rift Shard', () => {
    expect(HOLLOW.rewards).toBe(HOLLOW_REWARDS);
    expect(HOLLOW_REWARDS.some((r) => r.item === RIFT_SHARD_ID && r.chance === 1)).toBe(true);
  });
});

describe("The Hollow's map", () => {
  it('ships as baked: baking again gives the same file', () => {
    const t = performance.now();
    const baked = bakeHollow();
    expect(performance.now() - t).toBeLessThan(2000);
    // Line endings aside, which git may change on checkout.
    expect(JSON.stringify(baked)).toBe(shipped.trim());
    // Small enough to send: well under a tenth of a megabyte.
    expect(shipped.length).toBeLessThan(100 * 1024);
  });

  it('decodes into a 256 x 256 open land with every site, clue and creature', () => {
    const L = decodeDimension(file());
    expect([L.w, L.h]).toEqual([256, 256]);
    expect(L.sites.map((s) => s.kind).sort()).toEqual(['boss', 'combat', 'hazard', 'puzzle', 'vault']);
    expect(L.clues.length).toBeGreaterThanOrEqual(5);
    for (const c of L.clues) expect(L.decos[c.y * L.w + c.x]).toBe(Deco.LoreStone);
    expect(L.decos[L.rift]).toBe(Deco.Rift);
    expect(L.zones.length).toBeGreaterThan(0);
    expect(L.regions.length).toBe(10);
    // Mostly open land and void, with trees and crystals.
    let land = 0;
    let trees = 0;
    for (let i = 0; i < L.w * L.h; i++) {
      if (!isVoid(L.ground[i])) land++;
      if (L.decos[i] === Deco.HollowTree) trees++;
    }
    expect(land).toBeGreaterThan(L.w * L.h * 0.25);
    expect(trees).toBeGreaterThan(100);
  });

  it('holds drifted fragments of the overworld, reachable, and the marks of the Null by the Warden', () => {
    const L = decodeDimension(file());
    const open = reachable(L, true);
    const region = (name: string) => L.regions.indexOf(name);
    const cw = L.w / CHUNK_SIZE;
    // Overworld grass, trees and buildings, on land of their own, reachable from the rift.
    for (const [name, needs] of [
      ['A Drifted Wood', [Deco.Oak]],
      ['The Lost Hamlet', [Deco.Well, Deco.Crop]],
    ] as const) {
      const r = region(name);
      expect(r, name).toBeGreaterThanOrEqual(0);
      let grass = 0;
      let reached = 0;
      const found = new Set<number>();
      for (let i = 0; i < L.w * L.h; i++) {
        const c = Math.floor(i / L.w / CHUNK_SIZE) * cw + Math.floor((i % L.w) / CHUNK_SIZE);
        if (L.regionOf[c] !== r) continue;
        if (L.ground[i] === groundTile(0, Ground.Base) || L.ground[i] === groundTile(0, Ground.Alt)) grass++;
        if (open[i]) reached++;
        found.add(L.decos[i]);
      }
      expect(grass, name).toBeGreaterThan(200);
      expect(reached, name).toBeGreaterThan(200);
      for (const d of needs) expect(found.has(d), `${name} has ${d}`).toBe(true);
    }
    const hamlet: number[] = [];
    for (let i = 0; i < L.w * L.h; i++) if (L.ground[i] === Tile.WoodWall || L.ground[i] === Tile.StoneWall) hamlet.push(i);
    expect(hamlet.length).toBeGreaterThan(20);
    // Round absences by the Warden's arena, and nowhere else.
    const arena = L.sites.find((s) => s.kind === 'boss')!.rect;
    let marks = 0;
    for (let i = 0; i < L.w * L.h; i++) {
      if (L.ground[i] !== Tile.NullMark) continue;
      marks++;
      const x = i % L.w;
      const y = Math.floor(i / L.w);
      expect(Math.hypot(x - (arena.x + arena.w / 2), y - (arena.y + arena.h / 2))).toBeLessThan(30);
      expect(isSolid(L.ground[i], L.decos[i]) || isVoid(L.ground[i])).toBe(false);
    }
    expect(marks).toBeGreaterThanOrEqual(8);
  });

  it('can be finished from the arrival, and the vault only past the Warden', () => {
    const L = decodeDimension(file());
    const open = reachable(L, true);
    for (const s of L.sites) expect(open[Math.floor(s.entry.y) * L.w + Math.floor(s.entry.x)], s.name).toBe(1);
    expect(open[L.portal]).toBe(1);
    expect(beside(L, open, L.chest)).toBe(true);
    for (const c of L.clues) expect(beside(L, open, c.y * L.w + c.x), c.id).toBe(true);
    for (const s of L.sites) for (const t of s.mural) expect(beside(L, open, t)).toBe(true);
    expect(reachable(L, false)[L.portal]).toBe(0);
  });

  it('hangs cliffs under the land, over the void', () => {
    const L = decodeDimension(file());
    for (let y = 1; y < L.h; y++) {
      for (let x = 0; x < L.w; x++) {
        const i = y * L.w + x;
        if (L.ground[i] === Tile.VoidCliff) expect(isVoid(L.ground[i - L.w])).toBe(false);
      }
    }
  });
});

describe('the data format', () => {
  it('run-length encodes and decodes bytes exactly', () => {
    const bytes = new Uint8Array(1000);
    for (let i = 0; i < bytes.length; i++) bytes[i] = i < 600 ? 7 : i % 3;
    const back = unrle(fromBase64(toBase64(rle(bytes))), bytes.length);
    expect(back).toEqual(bytes);
    expect(() => unrle(Uint8Array.from([5, 1]), 4)).toThrow(DimensionDataError);
    expect(() => unrle(Uint8Array.from([2, 1]), 4)).toThrow(DimensionDataError);
    expect(() => unrle(Uint8Array.from([0, 1, 4, 1]), 4)).toThrow(DimensionDataError);
    expect(() => fromBase64('###')).toThrow(DimensionDataError);
  });

  it('refuses data that does not fit together', () => {
    refused((f) => ((f as { format: number }).format = 1), /format/);
    refused((f) => (f.id = 'elsewhere'), /no dimension/);
    refused((f) => (f.id = 'Bad Id'), /characters/);
    refused((f) => (f.width = 250), /whole chunks/);
    refused((f) => (f.width = 4096), /width/);
    refused((f) => (f.tiles = toBase64(rle(new Uint8Array(100)))), /shorter/);
    refused((f) => (f.tiles = toBase64(rle(new Uint8Array(256 * 256).fill(250)))), /unknown tile/);
    refused((f) => (f.rift = [0, 0]), /no tear/);
    refused((f) => (f.rift = [9999, 0]), /rift x/);
    refused((f) => (f.portal = f.chest), /overlaps/);
    refused((f) => (f.spawns[0].species = ['wolf']), /not met/);
    refused((f) => (f.spawns[0].species = ['rift-warden']), /not met/);
    refused((f) => (f.clues[0].x += 1), /no lore stone/);
    refused((f) => (f.clues[1].id = f.clues[0].id), /repeats/);
    refused((f) => (f.clues[0].pages = []), /no text/);
    refused((f) => (f.clues[0].title = 'x'.repeat(500)), /title/);
    refused((f) => (f.regions = []), /no regions/);
    refused((f) => {
      // The mural shows a glyph no plate has.
      const puzzle = f.sites.find((s) => s.kind === 'puzzle')!;
      puzzle.mural![0][2] = [0, 1, 2, 3, 4, 5].find((g) => !puzzle.plates!.some((p) => p[2] === g))!;
    }, /no plate has/);
    refused((f) => {
      const path = f.sites.find((s) => s.kind === 'hazard')!;
      path.path![1] = path.path![0];
    }, /overlaps/);
    refused((f) => (f.sites.find((s) => s.kind === 'boss')!.rect = [250, 250, 20, 20]), /runs off/);
    expect(() => decodeDimension(null)).toThrow(DimensionDataError);
    expect(() => decodeDimension([])).toThrow(DimensionDataError);
  });

  it('keeps regions whole chunks', () => {
    const L = decodeDimension(file());
    expect(L.regionOf.length).toBe((L.w / CHUNK_SIZE) * (L.h / CHUNK_SIZE));
  });
});

describe('dimension art', () => {
  it('has a cell for every site look and prop, inside the atlas', () => {
    for (const [key, n] of [['crumble', 3], ['glitch', 3], ['plate-up', 6], ['plate-down', 6]] as const) {
      for (let v = 0; v < n; v++) {
        const [x, y] = dimCell(key, v);
        expect(x + 16).toBeLessThanOrEqual(256);
        expect(y + 16).toBeLessThanOrEqual(ATLAS_H);
      }
    }
    for (const key of ['gate:0', 'chest:2', 'portal:3', 'glyph:5:2', 'tear:0', 'rift-halo']) {
      const f = dimFrame(key);
      expect(f.y + f.h).toBeLessThanOrEqual(ATLAS_H);
    }
    expect(ATLAS_H).toBeLessThanOrEqual(4096);
  });
});
