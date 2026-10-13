// Terrain: layered noise fields shared by the worker (tile generation) and the
// main thread (climate for biome types, ground checks for structure placement).

import { CHUNK_AREA, CHUNK_SIZE } from '../config';
import { SimplexNoise } from './Noise';
import { hash, hash3, Rng, Stream, unit } from './Random';
import { BiomeType, Deco, Ground, groundTile, isWater, paletteOf, Tile } from './Tiles';

/** Marshes keep at least this far (tiles) from the start. */
const MARSH_MIN_DISTANCE = 200;
/** Chunks around the origin that are always Forest: the cozy safe zone. */
const SAFE_ZONE_CHUNKS = 6;
const MOUNTAIN = 0.52;
const MOUNTAIN_HIGH = 0.62;
/** Rivers stay this far (tiles) from the origin, so the player wakes on dry land. */
const DRY_SPAWN = 36;
/** Mountains stay this far (tiles) from the origin, flattening over the next 40,
 *  so the player never wakes boxed in by rock. */
const FLAT_SPAWN = 48;

const smooth = (t: number) => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t));

/** Distance from the origin. Math.hypot is slow, and this runs per tile. */
const radius = (x: number, y: number) => Math.sqrt(x * x + y * y);

/** Distance in tiles to a field's zero line, from its value here (`n`) and one
 *  tile east and south: dividing by the slope keeps lines an even width. */
function lineDistance(n: number, east: number, south: number): number {
  return Math.abs(n) / Math.max(1e-4, Math.sqrt((east - n) ** 2 + (south - n) ** 2));
}

/** Rivers get at most one bridge per cell of this many tiles. */
const BRIDGE_CELL = 80;
const BRIDGE_CHANCE = 0.85;
/** Bridge site score bonus where a trail crosses the river. */
const TRAIL_BRIDGE = 0.6;
/** Longest a bridge may be, in tiles. */
const BRIDGE_MAX = 22;

/** Two trail networks, each the zero line of its own noise field: wide main
 *  trails and narrow footpaths. `gate` sets how far apart the stretches where
 *  a network exists are; below `cut` it fades out. Past `near`, the field's
 *  value says the trail is more than a tile beyond its edge (its slope stays
 *  under 0.056 and 0.11 per tile), so the distance need not be worked out. */
const TRAILS = [
  { scale: 260, gate: 700, cut: -0.3, width: 1.05, near: 0.14 },
  { scale: 140, gate: 420, cut: 0.2, width: 0.55, near: 0.2 },
] as const;
/** The main trail network always reaches this close (tiles) to the spawn. */
const TRAIL_SPAWN = 150;

/** A two-tile-wide bridge: along x over rows y and y + 1 (`h`), or along y
 *  over columns x and x + 1 (`v`), from `from` to `to` inclusive. */
interface BridgeSite {
  axis: 'h' | 'v';
  x: number;
  y: number;
  from: number;
  to: number;
}

export class TerrainFields {
  private readonly height: SimplexNoise;
  private readonly erosion: SimplexNoise;
  private readonly river: SimplexNoise;
  private readonly riverGate: SimplexNoise;
  private readonly temperature: SimplexNoise;
  private readonly moisture: SimplexNoise;
  private readonly trail: SimplexNoise;
  private readonly trailGate: SimplexNoise;
  readonly warp: SimplexNoise;
  readonly detail: SimplexNoise;
  /** Low-frequency field for meadows, deep woods, dunes and rock fields. */
  readonly zone: SimplexNoise;
  /** The main trail field's value at the origin, subtracted near the spawn so
   *  a trail always runs through it. */
  private trailSpawn = 0;
  private readonly bridges = new Map<number, BridgeSite | null>();

  constructor(readonly worldSeed: number) {
    const s = (n: number) => new SimplexNoise(hash(Stream.Noise, worldSeed, n));
    this.height = s(1);
    this.erosion = s(2);
    this.river = s(3);
    this.riverGate = s(4);
    this.temperature = s(5);
    this.moisture = s(6);
    this.warp = s(7);
    this.detail = s(8);
    this.trail = s(9);
    this.trailGate = s(10);
    this.zone = s(11);
    this.trailSpawn = this.trailField(0, 0, 0);
  }

  heightAt(gx: number, gy: number): number {
    const e = this.erosion.noise2(gx / 600, gy / 600);
    const spawn = 1 - smooth((radius(gx, gy) - FLAT_SPAWN) / 40);
    return this.height.fbm(gx / 200, gy / 200, 4) - Math.max(0, e) * 0.35 - spawn * 0.6;
  }

  /** Distance in tiles from the nearest river centreline, and that river's
   *  half-width in tiles (0 where there is no river). */
  riverAt(gx: number, gy: number): { dist: number; width: number } {
    const fade = this.riverFade(gx, gy);
    if (fade <= 0) return { dist: 1e9, width: 0 };
    const n = this.riverField(gx, gy);
    return {
      dist: lineDistance(n, this.riverField(gx + 1, gy), this.riverField(gx, gy + 1)),
      width: this.riverWidth(gx, gy, fade),
    };
  }

  /** Rivers narrow away to nothing at their ends instead of stopping square,
   *  and fade out around the spawn. 0 where there is no river. */
  riverFade(gx: number, gy: number): number {
    const gate = this.riverGate.noise2(gx / 900, gy / 900);
    return smooth((gate + 0.15) / 0.3) * smooth((radius(gx, gy) - DRY_SPAWN) / 40);
  }

  riverWidth(gx: number, gy: number, fade: number): number {
    const width = (2.6 + 1.2 * this.riverGate.noise2(gx / 260, gy / 260)) * fade;
    return width < 0.8 ? 0 : width;
  }

  /** Warped, so rivers meander rather than follow the noise grid. */
  riverField(gx: number, gy: number): number {
    const wx = gx + this.warp.noise2(gx / 170 + 41, gy / 170 - 23) * 46 + this.warp.noise2(gx / 50, gy / 50 + 77) * 6;
    const wy = gy + this.warp.noise2(gx / 170 - 67, gy / 170 + 13) * 46 + this.warp.noise2(gx / 50 + 31, gy / 50) * 6;
    return this.river.fbm(wx / 450, wy / 450, 2);
  }

  /** Trail network `k`'s field; trails follow its zero line. Warped less than
   *  rivers, so they wander in shorter bends. */
  trailField(k: number, gx: number, gy: number): number {
    const t = TRAILS[k];
    const o = 300 + k * 211;
    const wx = gx + this.warp.noise2(gx / 90 + o, gy / 90 - 17) * 14;
    const wy = gy + this.warp.noise2(gx / 90 - 53, gy / 90 + o) * 14;
    const n = this.trail.noise2(wx / t.scale + o, wy / t.scale - o);
    if (k !== 0) return n;
    return n - this.trailSpawn * (1 - smooth((radius(gx, gy) - TRAIL_SPAWN) / 250));
  }

  /** Half-width in tiles of trail network `k` here, 0 where it has faded out. */
  trailWidth(k: number, gx: number, gy: number): number {
    const t = TRAILS[k];
    let g = this.trailGate.noise2(gx / t.gate + k * 71, gy / t.gate - k * 71);
    if (k === 0) g = Math.max(g, 1 - radius(gx, gy) / (TRAIL_SPAWN * 2));
    return t.width * smooth((g - t.cut) / 0.15);
  }

  /** True if a trail runs within a tile or so of (gx, gy). */
  private trailNear(gx: number, gy: number): boolean {
    for (let k = 0; k < TRAILS.length; k++) {
      const w = this.trailWidth(k, gx, gy);
      if (w < 0.3) continue;
      const n = this.trailField(k, gx, gy);
      if (Math.abs(n) > TRAILS[k].near * 2) continue;
      if (lineDistance(n, this.trailField(k, gx + 1, gy), this.trailField(k, gx, gy + 1)) < w + 1.5) return true;
    }
    return false;
  }

  /** River water or its shore. */
  private wet(gx: number, gy: number): boolean {
    const r = this.riverAt(gx, gy);
    return r.width > 0 && r.dist < r.width + 1.2 && this.heightAt(gx, gy) <= MOUNTAIN;
  }

  /** The bridge tile on a river or shore cell, or 0. */
  bridgeAt(gx: number, gy: number): number {
    const cx = Math.floor(gx / BRIDGE_CELL);
    const cy = Math.floor(gy / BRIDGE_CELL);
    // A bridge can reach past its own cell.
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const b = this.bridgeSite(cx + dx, cy + dy);
        if (!b) continue;
        if (b.axis === 'h' && (gy === b.y || gy === b.y + 1) && gx >= b.from && gx <= b.to) {
          return gy === b.y ? Tile.BridgeH : Tile.BridgeH2;
        }
        if (b.axis === 'v' && (gx === b.x || gx === b.x + 1) && gy >= b.from && gy <= b.to) {
          return gx === b.x ? Tile.BridgeV : Tile.BridgeV2;
        }
      }
    }
    return 0;
  }

  /** Where a cell's bridge crosses its river: the stretch of river that runs
   *  closest to north–south or east–west, so the bridge can cross it square. */
  private bridgeSite(cx: number, cy: number): BridgeSite | null {
    const key = (cx + 0x8000) * 0x10000 + (cy + 0x8000);
    const known = this.bridges.get(key);
    if (known !== undefined) return known;
    if (this.bridges.size > 4096) this.bridges.clear();
    const rng = new Rng(hash(Stream.Lake, this.worldSeed, cx, cy, 0xb41d));
    // Most cells get a bridge somewhere; a trail meeting the river always gets
    // one, and those spots win out, so the bridge carries the trail across.
    let bestScore = rng.chance(BRIDGE_CHANCE) ? 0.85 : 0.85 + TRAIL_BRIDGE;
    let best: { x: number; y: number; h: boolean } | null = null;
    for (let y = cy * BRIDGE_CELL + 8; y < (cy + 1) * BRIDGE_CELL - 8; y += 3) {
      for (let x = cx * BRIDGE_CELL + 8; x < (cx + 1) * BRIDGE_CELL - 8; x += 3) {
        const r = this.riverAt(x, y);
        if (r.width < 1.5 || r.dist > 1.2 || this.heightAt(x, y) > MOUNTAIN - 0.05) continue;
        const n = this.riverField(x, y);
        const nx = this.riverField(x + 1, y) - n;
        const ny = this.riverField(x, y + 1) - n;
        let score = Math.max(Math.abs(nx), Math.abs(ny)) / Math.hypot(nx, ny) - r.dist * 0.02;
        if (score > 0.72 && this.trailNear(x, y)) score += TRAIL_BRIDGE;
        if (score > bestScore) {
          bestScore = score;
          best = { x, y, h: Math.abs(nx) >= Math.abs(ny) };
        }
      }
    }
    const site = best ? this.span(best.x, best.y, best.h) : null;
    this.bridges.set(key, site);
    return site;
  }

  /** Walks out from a river point to dry land on both rows of the bridge. */
  private span(x: number, y: number, h: boolean): BridgeSite | null {
    let from = h ? x : y;
    let to = from;
    for (let row = 0; row < 2; row++) {
      const at = (a: number) => (h ? this.wet(a, y + row) : this.wet(x + row, a));
      let a = h ? x : y;
      let n = 0;
      while (at(a - 1) && n++ < BRIDGE_MAX) a--;
      from = Math.min(from, a);
      a = h ? x : y;
      while (at(a + 1) && n++ < BRIDGE_MAX) a++;
      to = Math.max(to, a);
      if (n >= BRIDGE_MAX) return null;
    }
    return { axis: h ? 'h' : 'v', x, y, from, to };
  }

  /** Flat, dry ground: no mountain and no river. */
  isBuildable(gx: number, gy: number): boolean {
    if (this.heightAt(gx, gy) > MOUNTAIN - 0.08) return false;
    const r = this.riverAt(gx, gy);
    return r.dist > r.width + 3;
  }

  /** Biome type a chunk's climate asks for. Fixed per world seed, so an area
   *  keeps its type across regenerations. */
  climateAt(cx: number, cy: number): BiomeType {
    if (Math.abs(cx) <= SAFE_ZONE_CHUNKS && Math.abs(cy) <= SAFE_ZONE_CHUNKS) return BiomeType.Forest;
    const gx = cx * CHUNK_SIZE + CHUNK_SIZE / 2;
    const gy = cy * CHUNK_SIZE + CHUNK_SIZE / 2;
    const latitude = Math.max(-0.4, Math.min(0.4, cy * 0.002));
    let temp = this.temperature.fbm(cx / 26, cy / 26, 2) + latitude;
    temp -= Math.max(0, this.heightAt(gx, gy)) * 0.35;
    temp += (unit(hash3(this.worldSeed, cx, cy)) - 0.5) * 0.08;
    const moist = this.moisture.fbm(cx / 22, cy / 22, 2) + this.erosion.noise2(gx / 600, gy / 600) * 0.2;
    if (temp < -0.28) return BiomeType.Snow;
    if (temp > 0.15 && moist < 0.05) return BiomeType.Desert;
    return BiomeType.Forest;
  }
}

/** A worker job. `biomes` holds [type, variant, seed] for the 3 × 3 chunk
 *  neighbourhood, row-major from the top-left; type -1 means unknown. */
export interface ChunkRequest {
  token: number;
  cx: number;
  cy: number;
  worldSeed: number;
  visit: number;
  biomes: number[];
}

export interface ChunkResult {
  token: number;
  cx: number;
  cy: number;
  tiles: Uint8Array;
  decos: Uint8Array;
}

const TALL = new Set<number>([Deco.Oak, Deco.OakAutumn, Deco.Pine, Deco.PineSnow, Deco.Palm, Deco.Cactus]);

/** True if a tall decoration sits left of or above (lx, ly), diagonals included. */
function tallNear(decos: Uint8Array, lx: number, ly: number): boolean {
  const i = ly * CHUNK_SIZE + lx;
  if (lx > 0 && TALL.has(decos[i - 1])) return true;
  if (ly === 0) return false;
  const up = i - CHUNK_SIZE;
  return TALL.has(decos[up]) || (lx > 0 && TALL.has(decos[up - 1])) || (lx < CHUNK_SIZE - 1 && TALL.has(decos[up + 1]));
}

const GRID = CHUNK_SIZE + 1;
/** Furthest the biome-border warp moves a lookup, in tiles (11 + 3, rounded up). */
const WARP_REACH = 15;

/** A noise field over a chunk's tile corners, filled on first use. Neighbouring
 *  tiles share corners, so a line's distance costs one field sample per tile
 *  instead of three. */
function cornerGrid(x0: number, y0: number, f: (gx: number, gy: number) => number): (lx: number, ly: number) => number {
  const g = new Float64Array(GRID * GRID).fill(NaN);
  return (lx, ly) => {
    const i = ly * GRID + lx;
    let v = g[i];
    if (v !== v) v = g[i] = f(x0 + lx, y0 + ly);
    return v;
  };
}

const COARSE = 4;
const COARSE_GRID = CHUNK_SIZE / COARSE + 1;
/** Most a smooth field's blend across a coarse cell can differ from it. */
const COARSE_SLACK = 0.03;

/** A noise field sampled every few tiles and blended between: a cheap first
 *  look, good to within COARSE_SLACK. */
function coarseGrid(x0: number, y0: number, f: (gx: number, gy: number) => number): (lx: number, ly: number) => number {
  const g = new Float64Array(COARSE_GRID * COARSE_GRID).fill(NaN);
  const at = (i: number, j: number) => {
    const k = j * COARSE_GRID + i;
    let v = g[k];
    if (v !== v) v = g[k] = f(x0 + i * COARSE, y0 + j * COARSE);
    return v;
  };
  return (lx, ly) => {
    const i = Math.floor(lx / COARSE);
    const j = Math.floor(ly / COARSE);
    const u = (lx - i * COARSE) / COARSE;
    const v = (ly - j * COARSE) / COARSE;
    return (at(i, j) * (1 - u) + at(i + 1, j) * u) * (1 - v) + (at(i, j + 1) * (1 - u) + at(i + 1, j + 1) * u) * v;
  };
}

export function generateChunk(fields: TerrainFields, req: ChunkRequest): ChunkResult {
  const { cx, cy, biomes } = req;
  const tiles = new Uint8Array(CHUNK_AREA);
  const decos = new Uint8Array(CHUNK_AREA);
  const decoSeed = hash(Stream.Decoration, req.worldSeed, cx, cy, req.visit);
  const warp = fields.warp;
  const detail = fields.detail;
  const zone = fields.zone;
  const x0 = cx * CHUNK_SIZE;
  const y0 = cy * CHUNK_SIZE;
  const riverF = cornerGrid(x0, y0, (x, y) => fields.riverField(x, y));
  const trailF = TRAILS.map((_, k) => cornerGrid(x0, y0, (x, y) => fields.trailField(k, x, y)));
  const coarse = TRAILS.map((_, k) => coarseGrid(x0, y0, (x, y) => fields.trailField(k, x, y)));
  // Trail widths change slowly: blend them from the chunk's corners.
  const corner = (k: number, x: number, y: number) => fields.trailWidth(k, x0 + x, y0 + y);
  const trailW = TRAILS.map((_, k) => [corner(k, 0, 0), corner(k, CHUNK_SIZE, 0), corner(k, 0, CHUNK_SIZE), corner(k, CHUNK_SIZE, CHUNK_SIZE)]);
  // Neighbours with this chunk's own biome (or unknown, which falls back to it).
  const same = Array.from({ length: 9 }, (_, n) => {
    const b = n * 3;
    return biomes[b] < 0 || (biomes[b] === biomes[12] && biomes[b + 1] === biomes[13] && biomes[b + 2] === biomes[14]);
  });
  /** False where the warp could reach a neighbour with another biome. */
  const settled = (lx: number, ly: number) => {
    const x1 = lx >= CHUNK_SIZE - WARP_REACH ? 2 : 1;
    const y1 = ly >= CHUNK_SIZE - WARP_REACH ? 2 : 1;
    for (let y = ly < WARP_REACH ? 0 : 1; y <= y1; y++) for (let x = lx < WARP_REACH ? 0 : 1; x <= x1; x++) if (!same[y * 3 + x]) return false;
    return true;
  };
  const lineAt = (f: (lx: number, ly: number) => number, lx: number, ly: number) => lineDistance(f(lx, ly), f(lx + 1, ly), f(lx, ly + 1));

  for (let ly = 0; ly < CHUNK_SIZE; ly++) {
    for (let lx = 0; lx < CHUNK_SIZE; lx++) {
      const i = ly * CHUNK_SIZE + lx;
      const gx = x0 + lx;
      const gy = y0 + ly;

      // Biome borders blend: look the biome up at a noise-warped position.
      let b = 4 * 3;
      if (!settled(lx, ly)) {
        const wx = gx + warp.noise2(gx / 28, gy / 28) * 11 + warp.noise2(gx / 7, gy / 7) * 3;
        const wy = gy + warp.noise2(gx / 28 + 91, gy / 28 + 37) * 11 + warp.noise2(gx / 7 + 13, gy / 7 + 71) * 3;
        const ox = Math.max(-1, Math.min(1, Math.floor(wx / CHUNK_SIZE) - cx));
        const oy = Math.max(-1, Math.min(1, Math.floor(wy / CHUNK_SIZE) - cy));
        b = ((oy + 1) * 3 + (ox + 1)) * 3;
        if (biomes[b] < 0) b = 4 * 3;
      }
      const type = biomes[b];
      const variant = biomes[b + 1];
      const bseed = biomes[b + 2];
      const palette = paletteOf(type, variant);
      const offX = (bseed & 0xffff) * 0.37;
      const offY = (bseed >>> 16) * 0.41;

      const h = fields.heightAt(gx, gy);
      // Same values as fields.riverAt, from the shared corner grid.
      const fade = fields.riverFade(gx, gy);
      const riverW = fade > 0 ? fields.riverWidth(gx, gy, fade) : 0;
      const riverD = riverW > 0 ? lineAt(riverF, lx, ly) : 1e9;
      const inRiver = riverD < riverW && h < MOUNTAIN_HIGH;

      // Trails: distance from the nearest trail's edge, negative on it.
      let trail = 1e9;
      if (!inRiver && h <= MOUNTAIN_HIGH) {
        const u = lx / CHUNK_SIZE;
        const v = ly / CHUNK_SIZE;
        for (let k = 0; k < TRAILS.length; k++) {
          const c = trailW[k];
          const w = (c[0] * (1 - u) + c[1] * u) * (1 - v) + (c[2] * (1 - u) + c[3] * u) * v;
          if (w < 0.3 || Math.abs(coarse[k](lx, ly)) > TRAILS[k].near + COARSE_SLACK) continue;
          if (Math.abs(trailF[k](lx, ly)) > TRAILS[k].near) continue;
          trail = Math.min(trail, lineAt(trailF[k], lx, ly) - w);
        }
      }
      // Worn edges: the trail spills a little onto the ground beside it.
      const onTrail = trail < 0 || (trail < 0.6 && unit(hash3(req.worldSeed ^ 0x7a11, gx, gy)) < 0.3);
      // Landscape zones on open ground: meadows and deep woods, marshes, dunes, snowfields.
      let open = 0;
      let deep = 0;
      let marsh = 0;

      let tile: number;
      if (inRiver) {
        if (type === BiomeType.Snow) tile = Tile.Ice;
        else tile = riverD < riverW * 0.45 ? Tile.WaterDeep : Tile.Water;
      } else if (onTrail) {
        // Trails cross low rock as passes, but go round the high peaks.
        tile = Tile.Path;
      } else if (h > MOUNTAIN) {
        tile = h > MOUNTAIN_HIGH ? Tile.RockDark : Tile.Rock;
      } else if (riverW > 0 && riverD < riverW + 1.2) {
        tile = groundTile(palette, Ground.Shore);
      } else {
        const z = zone.noise2(gx / 80, gy / 80);
        open = smooth((-z - 0.25) / 0.25);
        deep = smooth((z - 0.3) / 0.25);
        const d = detail.noise2(gx / 11 + offX, gy / 11 + offY);
        let kind: number = Ground.Base;
        if (type === BiomeType.Desert) {
          // Ripples, stronger across the dune seas.
          if (Math.sin(gx * 0.11 + gy * 0.04 + d * 3) > 0.8 - deep * 0.35) kind = Ground.Alt;
          else if (d < -0.6) kind = Ground.Detail;
        } else if (d > 0.38 - open * 0.3) kind = Ground.Alt;
        else if (d < -0.64) kind = Ground.Detail;
        tile = groundTile(palette, kind);
        // Marshes: low forest dotted with shallow pools, away from the start.
        if (type === BiomeType.Forest && gx * gx + gy * gy > MARSH_MIN_DISTANCE ** 2) {
          marsh = smooth((zone.noise2(gx / 150 - 511, gy / 150 + 263) - 0.4) / 0.15);
          if (marsh > 0) {
            // No pools by rivers: bridges must land on dry ground.
            const byRiver = riverW > 0 && riverD < riverW + 8;
            if (!byRiver && detail.noise2(gx / 6 + 71, gy / 6 - 29) > 0.8 - marsh * 0.55) tile = Tile.Water;
            else if (d < -0.3 + marsh * 0.4) tile = groundTile(palette, Ground.Detail);
          }
        }
      }
      // Bridges cross rivers here and there.
      if ((isWater(tile) || tile === Tile.Ice || tile === Tile.Path || (tile < Tile.Water && tile % 4 === Ground.Shore)) && riverW > 0) {
        const bridge = fields.bridgeAt(gx, gy);
        if (bridge) tile = bridge;
      }
      tiles[i] = tile;

      if (tile >= Tile.Water || tile % 4 === Ground.Shore) continue;
      const density = Math.max(0, detail.noise2(gx / 45 + offY, gy / 45 + offX));
      const rocky = zone.noise2(gx / 22 + 913, gy / 22 - 377) > 0.5;
      const nearWater = riverW > 0 && riverD < riverW + 5;
      const r = unit(hash3(decoSeed, lx, ly));
      // Cumulative chances: each kind takes the next slice of r.
      let deco: number = Deco.None;
      let acc: number;
      if (type === BiomeType.Forest) {
        // Meadows are open and flowery, deep woods dark with pines and mushrooms.
        // Marshes: few trees, thick with bushes, reeds (dead brush) and mushrooms.
        acc = ((0.01 + density * 0.17) * (1 - open * 0.95) + deep * 0.22) * (1 - marsh * 0.75);
        if (rocky) acc *= 0.4;
        if (r < acc) {
          const pine = !marsh && unit(hash3(decoSeed ^ 0x5bd1, lx, ly)) < 0.18 + deep * 0.3;
          deco = pine ? Deco.Pine : variant ? Deco.OakAutumn : Deco.Oak;
        } else if (r < (acc += (nearWater ? 0.05 : 0.02) + marsh * 0.06)) deco = Deco.Bush;
        else if (r < (acc += marsh * 0.05)) deco = Deco.DeadBush;
        else if (r < (acc += 0.015 + open * 0.07 + (nearWater ? 0.02 : 0))) deco = Deco.Flowers;
        else if (r < (acc += 0.007 + deep * 0.025 + marsh * 0.03)) deco = Deco.Mushroom;
        else if (r < (acc += rocky ? 0.05 : 0.004)) deco = Deco.Stone;
        else if (r < acc + (rocky ? 0.006 : 0.0015)) deco = Deco.Ore;
      } else if (type === BiomeType.Desert) {
        // Palms gather along rivers as oases; cactus stands, bare dunes, rocky flats.
        acc = nearWater ? 0.09 : 0;
        if (r < acc) deco = Deco.Palm;
        else if (r < (acc += (0.008 + density * 0.03) * (1 + open * 3) * (1 - deep * 0.8))) deco = Deco.Cactus;
        else if (r < (acc += 0.012)) deco = Deco.DeadBush;
        else if (r < (acc += rocky ? 0.06 : 0.006)) {
          deco = variant || (rocky && unit(hash3(decoSeed ^ 0x2e7, lx, ly)) < 0.5) ? Deco.RedRock : Deco.Stone;
        } else if (r < acc + (rocky ? 0.005 : 0.0015)) deco = Deco.Ore;
      } else {
        // Open snowfields between stands of taiga.
        acc = (0.01 + density * 0.11) * (1 - open * 0.9) + deep * 0.14;
        if (r < acc) deco = Deco.PineSnow;
        else if (r < (acc += rocky ? 0.05 : 0.008)) deco = Deco.SnowRock;
        else if (r < (acc += variant ? 0.012 : 0.0015)) deco = Deco.Crystal;
        else if (r < acc + (rocky ? 0.005 : 0.0015)) deco = Deco.Ore;
      }
      // Trees are wider than a tile: keep them off all eight neighbours, and
      // clear of trails.
      if (TALL.has(deco) && (trail < 1 || tallNear(decos, lx, ly))) deco = Deco.None;
      decos[i] = deco;
    }
  }
  return { token: req.token, cx, cy, tiles, decos };
}
