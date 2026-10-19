// The data format of a dimension's map, as it travels: today a file shipped
// with the game (public/dimensions/<id>.json), later a server's answer. One
// JSON document per dimension, `format: 2`:
//
//   id, name, width, height (tiles, whole chunks), mood {darkness, tint, music}
//   tiles, decos     the land: one byte per tile each, run-length encoded
//                    ([count 1-255, value] pairs), then base64
//   regions          region names; regionMap: one byte per chunk, encoded alike
//   rift, portal, chest   [x, y] tiles: the rift home (its tile carries the
//                    tear, `Deco.Rift`), the way out, the vault's chest
//   sites            the challenges' landmarks (see `SiteFile`)
//   clues            lore stones (`Deco.LoreStone` on their tile) and their text
//   spawns           where creatures roam: rect, species ids, cap
//   plot             the world's own story (optional): its resident, the relics
//                    (`Deco.Relic` on their tiles), what they say, the visions
//                    and the reward (see `PlotFile`)
//
// Everything is checked as untrusted input before use (`decodeDimension`):
// sizes, lengths, bounds, ids and that the pieces fit together. A bad file is
// refused whole, with a reason, and the game stays in the overworld.

import { CHUNK_SIZE } from '../config';
import { Deco, DECO_COUNT, isSolid, isVoid, TILE_COUNT } from '../generation/Tiles';
import { OUTFITS } from '../rendering/Atlas';
import { dimensionById, type Clue, type DimensionLayout, type Plot, type PlotVision, type Point, type Rect, type Site, type SiteKind, type SpawnZone } from './Dimension';
import { DimTile, NO_GLYPH } from './DimTile';
import { GLYPH_COUNT } from './Hollow';

export const DIMENSION_FORMAT = 2;
/** Largest map side, in tiles. */
export const MAX_SIDE = 512;
/** Sites at most: a shared instance packs each site's gate in a 16-bit mask. */
const MAX_SITES = 16;
/** Hazard path slabs at most, all sites together: their timers travel in
 *  every shared run state, which must stay small. */
const MAX_PATH_TILES = 600;
const MAX_CLUES = 64;
const MAX_ZONES = 32;
const MAX_REGIONS = 32;
const MAX_LIST = 4096;
const MAX_TEXT = 1200;
const MAX_RELICS = 16;
const MAX_REWARD_ITEMS = 8;
const MUSIC = new Set(['rift', 'archive']);
const SITE_KINDS = new Set<SiteKind>(['combat', 'hazard', 'puzzle', 'boss', 'vault', 'tide']);

type XY = [number, number];
type XYWH = [number, number, number, number];

export interface SiteFile {
  kind: SiteKind;
  name: string;
  rect: XYWH;
  entry: XY;
  center: XY;
  gates?: XY[];
  spawns?: XY[];
  checkpoints?: XY[];
  /** Hazard: the path in walking order: x, y, 1 for a glitching slab (0 crumbling), its phase. */
  path?: Array<[number, number, number, number]>;
  goal?: XYWH;
  /** Puzzle: plates, x, y, glyph. */
  plates?: Array<[number, number, number]>;
  /** Puzzle: mural stones in reading order, x, y, glyph; their glyphs are the order. */
  mural?: Array<[number, number, number]>;
  /** Puzzle: 'text' when the order is written down (a lore stone), not lit on the mural. */
  hint?: 'mural' | 'text';
  /** Tide: the valves in turning order, x, y. */
  valves?: XY[];
  /** Tide: the floor the water covers, x, y, depth (1 to the number of valves). */
  flood?: Array<[number, number, number]>;
}

export interface PlotFile {
  resident: { name: string; x: number; y: number; look: string };
  goal: string;
  relics: Array<{ id: string; x: number; y: number; name: string }>;
  talk: { first: string[]; waiting: string; ready: string[]; after: string; cleared: string };
  restored: PlotVision;
  closing: PlotVision;
  reward: { xp: number; items: Array<{ item: string; count: number }> };
}

export interface DimensionFile {
  format: typeof DIMENSION_FORMAT;
  id: string;
  name: string;
  width: number;
  height: number;
  mood: { darkness: number; tint: number; music: string };
  tiles: string;
  decos: string;
  regions: string[];
  regionMap: string;
  rift: XY;
  portal: XY;
  chest: XY;
  sites: SiteFile[];
  clues: Array<{ id: string; x: number; y: number; title: string; pages: string[] }>;
  spawns: Array<{ rect: XYWH; species: string[]; cap: number }>;
  plot?: PlotFile;
}

/** A dimension's data could not be used; says why. */
export class DimensionDataError extends Error {}

function fail(why: string): never {
  throw new DimensionDataError(why);
}

// Encoding ------------------------------------------------------------------------

/** Run-length encodes bytes as [count 1-255, value] pairs. */
export function rle(bytes: Uint8Array): Uint8Array {
  const out: number[] = [];
  for (let i = 0; i < bytes.length; ) {
    const v = bytes[i];
    let n = 1;
    while (n < 255 && i + n < bytes.length && bytes[i + n] === v) n++;
    out.push(n, v);
    i += n;
  }
  return Uint8Array.from(out);
}

/** Undoes `rle`, into exactly `length` bytes; anything else is refused. */
export function unrle(pairs: Uint8Array, length: number): Uint8Array {
  if (pairs.length % 2) fail('run-length data has an odd length');
  const out = new Uint8Array(length);
  let o = 0;
  for (let i = 0; i < pairs.length; i += 2) {
    const n = pairs[i];
    if (n === 0) fail('run-length data has an empty run');
    if (o + n > length) fail('run-length data is longer than the map');
    out.fill(pairs[i + 1], o, o + n);
    o += n;
  }
  if (o !== length) fail('run-length data is shorter than the map');
  return out;
}

export function toBase64(bytes: Uint8Array): string {
  let s = '';
  // In slices: one call per byte would be slow, one call for all can overflow the stack.
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

export function fromBase64(text: string): Uint8Array {
  let s: string;
  try {
    s = atob(text);
  } catch {
    fail('not base64');
  }
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

// Checking ------------------------------------------------------------------------

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function str(v: unknown, what: string, max = 80): string {
  if (typeof v !== 'string' || !v.length || v.length > max) fail(`${what} is not a string of 1-${max} characters`);
  return v;
}

function int(v: unknown, what: string, min: number, max: number): number {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max) fail(`${what} is not a whole number from ${min} to ${max}`);
  return v;
}

function num(v: unknown, what: string, min: number, max: number): number {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max) fail(`${what} is not a number from ${min} to ${max}`);
  return v;
}

function list(v: unknown, what: string, max = MAX_LIST): unknown[] {
  if (!Array.isArray(v) || v.length > max) fail(`${what} is not a list of at most ${max}`);
  return v;
}

/** Decodes and checks a dimension's data. Throws `DimensionDataError`. */
export function decodeDimension(data: unknown): DimensionLayout {
  if (!isObject(data)) fail('not an object');
  if (data.format !== DIMENSION_FORMAT) fail(`format ${String(data.format)} is not ${DIMENSION_FORMAT}`);
  const id = str(data.id, 'id', 32);
  if (!/^[a-z0-9-]+$/.test(id)) fail('id has characters other than a-z, 0-9 and -');
  if (!dimensionById(id)) fail(`no dimension "${id}" is known to this version of the game`);
  const name = str(data.name, 'name', 64);
  const w = int(data.width, 'width', CHUNK_SIZE, MAX_SIDE);
  const h = int(data.height, 'height', CHUNK_SIZE, MAX_SIDE);
  if (w % CHUNK_SIZE || h % CHUNK_SIZE) fail('the map is not whole chunks');
  const n = w * h;
  const tileXY = (v: unknown, what: string): number => {
    const p = list(v, what, 2);
    if (p.length !== 2) fail(`${what} is not [x, y]`);
    return int(p[1], `${what} y`, 0, h - 1) * w + int(p[0], `${what} x`, 0, w - 1);
  };
  const feet = (v: unknown, what: string): Point => {
    const p = list(v, what, 2);
    if (p.length !== 2) fail(`${what} is not [x, y]`);
    return { x: num(p[0], `${what} x`, 0, w), y: num(p[1], `${what} y`, 0, h) };
  };
  const rect = (v: unknown, what: string): Rect => {
    const r = list(v, what, 4);
    if (r.length !== 4) fail(`${what} is not [x, y, w, h]`);
    const out = { x: int(r[0], `${what} x`, 0, w - 1), y: int(r[1], `${what} y`, 0, h - 1), w: int(r[2], `${what} w`, 1, w), h: int(r[3], `${what} h`, 1, h) };
    if (out.x + out.w > w || out.y + out.h > h) fail(`${what} runs off the map`);
    return out;
  };

  // Mood.
  const m = isObject(data.mood) ? data.mood : fail('mood is missing');
  const music = typeof m.music === 'string' && MUSIC.has(m.music) ? m.music : 'rift';
  const mood = { darkness: num(m.darkness, 'mood darkness', 0, 1), tint: int(m.tint, 'mood tint', 0, 0xffffff), music };

  // The land.
  const ground = unrle(fromBase64(str(data.tiles, 'tiles', 8 * n)), n);
  const decos = unrle(fromBase64(str(data.decos, 'decos', 8 * n)), n);
  for (let i = 0; i < n; i++) {
    if (ground[i] >= TILE_COUNT) fail(`unknown tile ${ground[i]}`);
    if (decos[i] >= DECO_COUNT) fail(`unknown decoration ${decos[i]}`);
  }
  const walkable = (i: number) => !isVoid(ground[i]) && !isSolid(ground[i], decos[i]);
  /** Feet stand on open ground. */
  const standsOn = (p: Point, what: string) => {
    const i = Math.min(h - 1, Math.floor(p.y - 0.15)) * w + Math.min(w - 1, Math.floor(p.x));
    if (!walkable(i)) fail(`${what} is not on open ground`);
  };

  // Regions.
  const regions = list(data.regions, 'regions', MAX_REGIONS).map((r, k) => str(r, `region ${k}`, 40));
  if (!regions.length) fail('no regions');
  const chunks = (w / CHUNK_SIZE) * (h / CHUNK_SIZE);
  const regionOf = unrle(fromBase64(str(data.regionMap, 'regionMap', 8 * chunks + 8)), chunks);
  for (let i = 0; i < chunks; i++) if (regionOf[i] >= regions.length) fail(`chunk ${i} names region ${regionOf[i]}, which is not listed`);

  // Site tiles: each tile is given to one thing at most.
  const tiles = new Uint8Array(n);
  const glyphs = new Uint8Array(n).fill(NO_GLYPH);
  const phase = new Uint8Array(n);
  const claim = (i: number, t: number, what: string) => {
    if (tiles[i] !== DimTile.None) fail(`${what} overlaps another site tile`);
    tiles[i] = t;
  };
  const rift = tileXY(data.rift, 'rift');
  if (decos[rift] !== Deco.Rift) fail('the rift home has no tear on its tile');
  const below = rift + w;
  if (below >= n || !walkable(below)) fail('there is no ground below the rift home to arrive on');
  const portal = tileXY(data.portal, 'portal');
  if (!walkable(portal)) fail('the portal is not on open ground');
  claim(portal, DimTile.Portal, 'the portal');
  const chest = tileXY(data.chest, 'chest');
  if (!walkable(chest)) fail('the chest is not on open ground');
  claim(chest, DimTile.Chest, 'the chest');

  const sites: Site[] = list(data.sites, 'sites', MAX_SITES).map((v, k): Site => {
    const what = `site ${k}`;
    if (!isObject(v)) fail(`${what} is not an object`);
    const kind = v.kind as SiteKind;
    if (!SITE_KINDS.has(kind)) fail(`${what} has an unknown kind`);
    const tilesOf = (key: string) => list(v[key] ?? [], `${what} ${key}`).map((p, j) => tileXY(p, `${what} ${key} ${j}`));
    const feetOf = (key: string) => list(v[key] ?? [], `${what} ${key}`).map((p, j) => feet(p, `${what} ${key} ${j}`));
    const site: Site = {
      kind,
      name: str(v.name, `${what} name`, 40),
      rect: rect(v.rect, `${what} rect`),
      entry: feet(v.entry, `${what} entry`),
      center: feet(v.center, `${what} center`),
      gates: tilesOf('gates'),
      spawns: feetOf('spawns'),
      checkpoints: feetOf('checkpoints'),
      path: [],
      goal: v.goal === undefined ? null : rect(v.goal, `${what} goal`),
      plates: new Array<number>(GLYPH_COUNT).fill(-1),
      order: [],
      mural: [],
      hint: v.hint === 'text' ? 'text' : 'mural',
      valves: [],
      flood: [],
    };
    for (const g of site.gates) {
      if (!walkable(g)) fail(`${what} has a gate on solid ground or the void`);
      claim(g, DimTile.Gate, `${what} gate`);
    }
    standsOn(site.entry, `${what} entry`);
    site.spawns.forEach((p, j) => standsOn(p, `${what} spawn ${j}`));
    site.checkpoints.forEach((p, j) => standsOn(p, `${what} checkpoint ${j}`));
    if (kind === 'boss') standsOn(site.center, `${what} centre`);
    if (kind === 'combat' && !site.spawns.length) fail(`${what} has nowhere for its waves to appear`);
    if (kind === 'hazard') {
      if (!site.goal) fail(`${what} has no far side`);
      if (!site.checkpoints.length) fail(`${what} has no ledge to return to`);
      list(v.path, `${what} path`).forEach((p, j) => {
        const step = list(p, `${what} path ${j}`, 4);
        if (step.length !== 4) fail(`${what} path ${j} is not [x, y, glitch, phase]`);
        const i = tileXY(step.slice(0, 2), `${what} path ${j}`);
        const glitch = int(step[2], `${what} path ${j} glitch`, 0, 1);
        phase[i] = int(step[3], `${what} path ${j} phase`, 0, 255);
        claim(i, glitch ? DimTile.Glitch : DimTile.Crumble, `${what} path ${j}`);
        site.path.push(i);
      });
      if (!site.path.length) fail(`${what} has no path`);
    }
    if (kind === 'tide') {
      if (!site.goal) fail(`${what} has no far side`);
      if (!site.checkpoints.length) fail(`${what} has no ledge to return to`);
      const valves = list(v.valves, `${what} valves`, 8);
      if (!valves.length) fail(`${what} has no valves`);
      valves.forEach((p, j) => {
        const i = tileXY(p, `${what} valve ${j}`);
        if (!walkable(i)) fail(`${what} valve ${j} is not on open ground`);
        claim(i, DimTile.Valve, `${what} valve ${j}`);
        // The first valve is on the ledge, dry always; each later one stands
        // in the band of water before it, and goes under with it.
        phase[i] = j === 0 ? 0 : valves.length - j + 1;
        site.valves.push(i);
      });
      list(v.flood, `${what} flood`).forEach((p, j) => {
        const f = list(p, `${what} flood ${j}`, 3);
        if (f.length !== 3) fail(`${what} flood ${j} is not [x, y, depth]`);
        const i = tileXY(f.slice(0, 2), `${what} flood ${j}`);
        if (!walkable(i)) fail(`${what} flood ${j} is not on open ground`);
        phase[i] = int(f[2], `${what} flood ${j} depth`, 1, valves.length);
        claim(i, DimTile.Flood, `${what} flood ${j}`);
        site.flood.push(i);
      });
      if (!site.flood.length) fail(`${what} has no water`);
    }
    if (kind === 'puzzle') {
      const plates = list(v.plates, `${what} plates`, GLYPH_COUNT);
      plates.forEach((p, j) => {
        const pl = list(p, `${what} plate ${j}`, 3);
        if (pl.length !== 3) fail(`${what} plate ${j} is not [x, y, glyph]`);
        const i = tileXY(pl.slice(0, 2), `${what} plate ${j}`);
        const g = int(pl[2], `${what} plate ${j} glyph`, 0, GLYPH_COUNT - 1);
        if (site.plates[g] >= 0) fail(`${what} has two plates of glyph ${g}`);
        if (!walkable(i)) fail(`${what} plate ${j} is not on open ground`);
        claim(i, DimTile.Plate, `${what} plate ${j}`);
        glyphs[i] = g;
        site.plates[g] = i;
      });
      const mural = list(v.mural, `${what} mural`, GLYPH_COUNT);
      if (!mural.length) fail(`${what} has no mural`);
      mural.forEach((p, j) => {
        const st = list(p, `${what} mural ${j}`, 3);
        if (st.length !== 3) fail(`${what} mural ${j} is not [x, y, glyph]`);
        const i = tileXY(st.slice(0, 2), `${what} mural ${j}`);
        const g = int(st[2], `${what} mural ${j} glyph`, 0, GLYPH_COUNT - 1);
        if (site.plates[g] < 0) fail(`${what} mural shows glyph ${g}, which no plate has`);
        if (site.order.includes(g)) fail(`${what} mural shows glyph ${g} twice`);
        claim(i, DimTile.Glyph, `${what} mural ${j}`);
        glyphs[i] = g;
        site.order.push(g);
        site.mural.push(i);
      });
    }
    return site;
  });
  if (sites.filter((s) => s.kind === 'boss').length !== 1) fail('there is not exactly one boss');
  let pathTiles = 0;
  for (const s of sites) pathTiles += s.path.length;
  if (pathTiles > MAX_PATH_TILES) fail(`the hazard paths have more than ${MAX_PATH_TILES} slabs`);
  // The way home and the vault's chest are inside the vault.
  const vaults = sites.filter((s) => s.kind === 'vault');
  const within = (i: number, r: Rect) => {
    const x = i % w;
    const y = Math.floor(i / w);
    return x >= r.x && y >= r.y && x < r.x + r.w && y < r.y + r.h;
  };
  if (!vaults.some((v) => within(portal, v.rect) && within(chest, v.rect))) fail('the portal and the chest are not inside a vault');

  const clueIds = new Set<string>();
  const clues: Clue[] = list(data.clues, 'clues', MAX_CLUES).map((v, k): Clue => {
    const what = `clue ${k}`;
    if (!isObject(v)) fail(`${what} is not an object`);
    const cid = str(v.id, `${what} id`, 40);
    if (clueIds.has(cid)) fail(`${what} repeats id ${cid}`);
    clueIds.add(cid);
    const x = int(v.x, `${what} x`, 0, w - 1);
    const y = int(v.y, `${what} y`, 0, h - 1);
    if (decos[y * w + x] !== Deco.LoreStone) fail(`${what} has no lore stone on its tile`);
    const pages = list(v.pages, `${what} pages`, 8).map((p, j) => str(p, `${what} page ${j}`, MAX_TEXT));
    if (!pages.length) fail(`${what} has no text`);
    return { id: cid, x, y, title: str(v.title, `${what} title`, 60), pages };
  });

  const def = dimensionById(id)!;
  const zones: SpawnZone[] = list(data.spawns, 'spawns', MAX_ZONES).map((v, k): SpawnZone => {
    const what = `spawn zone ${k}`;
    if (!isObject(v)) fail(`${what} is not an object`);
    const species = list(v.species, `${what} species`, 8).map((s) => {
      const sp = def.roster.find((r) => r.id === s && !r.boss);
      if (!sp) fail(`${what} names a creature not met in ${def.name}`);
      return sp;
    });
    if (!species.length) fail(`${what} has no creatures`);
    return { rect: rect(v.rect, `${what} rect`), species, cap: int(v.cap, `${what} cap`, 1, 8) };
  });

  const plot = data.plot === undefined ? null : decodePlot(data.plot, w, h, decos, walkable);

  const rx = rift % w;
  const ry = Math.floor(rift / w);
  return {
    id, name, w, h, mood, ground, decos, tiles, glyphs, phase, sites, clues, zones, regions, regionOf, plot,
    arrival: { x: rx + 0.5, y: ry + 1.9 },
    rift, portal, chest,
  };
}

/** A plot, checked: its resident on open ground in a look the game has, every
 *  relic on its own `Deco.Relic`, every line of text a sensible length. */
function decodePlot(v: unknown, w: number, h: number, decos: Uint8Array, walkable: (i: number) => boolean): Plot {
  if (!isObject(v)) fail('plot is not an object');
  const text = (t: unknown, what: string) => str(t, what, MAX_TEXT);
  const pages = (t: unknown, what: string) => {
    const out = list(t, what, 8).map((p, j) => text(p, `${what} ${j}`));
    if (!out.length) fail(`${what} is empty`);
    return out;
  };
  const vision = (t: unknown, what: string): PlotVision => {
    if (!isObject(t)) fail(`${what} is not an object`);
    return { title: str(t.title, `${what} title`, 60), pages: pages(t.pages, `${what} pages`) };
  };
  const r = isObject(v.resident) ? v.resident : fail('plot resident is missing');
  const look = str(r.look, 'plot resident look', 32);
  if (!Object.prototype.hasOwnProperty.call(OUTFITS, look)) fail(`plot resident look "${look}" is not known to this version of the game`);
  const resident = { name: str(r.name, 'plot resident name', 40), x: int(r.x, 'plot resident x', 0, w - 1), y: int(r.y, 'plot resident y', 0, h - 1), look };
  if (!walkable(resident.y * w + resident.x)) fail('the plot resident does not stand on open ground');
  const ids = new Set<string>();
  const relics = list(v.relics, 'plot relics', MAX_RELICS).map((p, k) => {
    const what = `plot relic ${k}`;
    if (!isObject(p)) fail(`${what} is not an object`);
    const id = str(p.id, `${what} id`, 40);
    if (ids.has(id)) fail(`${what} repeats id ${id}`);
    ids.add(id);
    const x = int(p.x, `${what} x`, 0, w - 1);
    const y = int(p.y, `${what} y`, 0, h - 1);
    if (decos[y * w + x] !== Deco.Relic) fail(`${what} has no relic on its tile`);
    return { id, x, y, name: str(p.name, `${what} name`, 60) };
  });
  if (!relics.length) fail('plot has no relics');
  const t = isObject(v.talk) ? v.talk : fail('plot talk is missing');
  const talk = {
    first: pages(t.first, 'plot talk first'),
    waiting: text(t.waiting, 'plot talk waiting'),
    ready: pages(t.ready, 'plot talk ready'),
    after: text(t.after, 'plot talk after'),
    cleared: text(t.cleared, 'plot talk cleared'),
  };
  const rw = isObject(v.reward) ? v.reward : fail('plot reward is missing');
  const items = list(rw.items, 'plot reward items', MAX_REWARD_ITEMS).map((it, k) => {
    if (!isObject(it)) fail(`plot reward item ${k} is not an object`);
    return { item: str(it.item, `plot reward item ${k} id`, 40), count: int(it.count, `plot reward item ${k} count`, 1, 99) };
  });
  return {
    resident,
    goal: str(v.goal, 'plot goal', 60),
    relics,
    talk,
    restored: vision(v.restored, 'plot restored'),
    closing: vision(v.closing, 'plot closing'),
    reward: { xp: int(rw.xp, 'plot reward xp', 0, 5000), items },
  };
}
