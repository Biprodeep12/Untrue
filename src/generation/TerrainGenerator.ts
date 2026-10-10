// Terrain: layered noise fields shared by the worker (tile generation) and the
// main thread (climate for biome types, ground checks for structure placement).

import { CHUNK_AREA, CHUNK_SIZE } from '../config';
import { SimplexNoise } from './Noise';
import { hash, hash3, Rng, Stream, unit } from './Random';
import { BiomeType, Deco, Ground, groundTile, isWater, paletteOf, Tile } from './Tiles';

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

/** Rivers get at most one bridge per cell of this many tiles. */
const BRIDGE_CELL = 80;
const BRIDGE_CHANCE = 0.85;
/** Longest a bridge may be, in tiles. */
const BRIDGE_MAX = 22;

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
  readonly warp: SimplexNoise;
  readonly detail: SimplexNoise;
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
  }

  heightAt(gx: number, gy: number): number {
    const e = this.erosion.noise2(gx / 600, gy / 600);
    const spawn = 1 - smooth((Math.hypot(gx, gy) - FLAT_SPAWN) / 40);
    return this.height.fbm(gx / 200, gy / 200, 4) - Math.max(0, e) * 0.35 - spawn * 0.6;
  }

  /** Distance in tiles from the nearest river centreline, and that river's
   *  half-width in tiles (0 where there is no river). */
  riverAt(gx: number, gy: number): { dist: number; width: number } {
    const gate = this.riverGate.noise2(gx / 900, gy / 900);
    // Rivers narrow away to nothing at their ends instead of stopping square,
    // and fade out around the spawn.
    const fade = smooth((gate + 0.15) / 0.3) * smooth((Math.hypot(gx, gy) - DRY_SPAWN) / 40);
    if (fade <= 0) return { dist: 1e9, width: 0 };
    // The river follows the zero line of a noise field; dividing by the field's
    // slope turns its value into a distance, so the river keeps an even width.
    const n = this.riverField(gx, gy);
    const dx = this.riverField(gx + 1, gy) - n;
    const dy = this.riverField(gx, gy + 1) - n;
    const dist = Math.abs(n) / Math.max(1e-4, Math.hypot(dx, dy));
    const width = (2.6 + 1.2 * this.riverGate.noise2(gx / 260, gy / 260)) * fade;
    return { dist, width: width < 0.8 ? 0 : width };
  }

  /** Warped, so rivers meander rather than follow the noise grid. */
  riverField(gx: number, gy: number): number {
    const wx = gx + this.warp.noise2(gx / 170 + 41, gy / 170 - 23) * 46 + this.warp.noise2(gx / 50, gy / 50 + 77) * 6;
    const wy = gy + this.warp.noise2(gx / 170 - 67, gy / 170 + 13) * 46 + this.warp.noise2(gx / 50 + 31, gy / 50) * 6;
    return this.river.fbm(wx / 450, wy / 450, 2);
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
    let site: BridgeSite | null = null;
    const rng = new Rng(hash(Stream.Lake, this.worldSeed, cx, cy, 0xb41d));
    if (rng.chance(BRIDGE_CHANCE)) {
      let best: { x: number; y: number; h: boolean } | null = null;
      let bestScore = 0.85;
      for (let y = cy * BRIDGE_CELL + 8; y < (cy + 1) * BRIDGE_CELL - 8; y += 3) {
        for (let x = cx * BRIDGE_CELL + 8; x < (cx + 1) * BRIDGE_CELL - 8; x += 3) {
          const r = this.riverAt(x, y);
          if (r.width < 1.5 || r.dist > 1.2 || this.heightAt(x, y) > MOUNTAIN - 0.05) continue;
          const n = this.riverField(x, y);
          const nx = this.riverField(x + 1, y) - n;
          const ny = this.riverField(x, y + 1) - n;
          const score = Math.max(Math.abs(nx), Math.abs(ny)) / Math.hypot(nx, ny) - r.dist * 0.02;
          if (score > bestScore) {
            bestScore = score;
            best = { x, y, h: Math.abs(nx) >= Math.abs(ny) };
          }
        }
      }
      if (best) site = this.span(best.x, best.y, best.h);
    }
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

export function generateChunk(fields: TerrainFields, req: ChunkRequest): ChunkResult {
  const { cx, cy, biomes } = req;
  const tiles = new Uint8Array(CHUNK_AREA);
  const decos = new Uint8Array(CHUNK_AREA);
  const decoSeed = hash(Stream.Decoration, req.worldSeed, cx, cy, req.visit);
  const warp = fields.warp;
  const detail = fields.detail;

  for (let ly = 0; ly < CHUNK_SIZE; ly++) {
    for (let lx = 0; lx < CHUNK_SIZE; lx++) {
      const i = ly * CHUNK_SIZE + lx;
      const gx = cx * CHUNK_SIZE + lx;
      const gy = cy * CHUNK_SIZE + ly;

      // Biome borders blend: look the biome up at a noise-warped position.
      const wx = gx + warp.noise2(gx / 28, gy / 28) * 11 + warp.noise2(gx / 7, gy / 7) * 3;
      const wy = gy + warp.noise2(gx / 28 + 91, gy / 28 + 37) * 11 + warp.noise2(gx / 7 + 13, gy / 7 + 71) * 3;
      const ox = Math.max(-1, Math.min(1, Math.floor(wx / CHUNK_SIZE) - cx));
      const oy = Math.max(-1, Math.min(1, Math.floor(wy / CHUNK_SIZE) - cy));
      let b = ((oy + 1) * 3 + (ox + 1)) * 3;
      if (biomes[b] < 0) b = 4 * 3;
      const type = biomes[b];
      const variant = biomes[b + 1];
      const bseed = biomes[b + 2];
      const palette = paletteOf(type, variant);
      const offX = (bseed & 0xffff) * 0.37;
      const offY = (bseed >>> 16) * 0.41;

      const h = fields.heightAt(gx, gy);
      const river = fields.riverAt(gx, gy);
      let tile: number;
      if (river.dist < river.width && h < MOUNTAIN_HIGH) {
        if (type === BiomeType.Snow) tile = Tile.Ice;
        else tile = river.dist < river.width * 0.45 ? Tile.WaterDeep : Tile.Water;
      } else if (h > MOUNTAIN) {
        tile = h > MOUNTAIN_HIGH ? Tile.RockDark : Tile.Rock;
      } else if (river.width > 0 && river.dist < river.width + 1.2) {
        tile = groundTile(palette, Ground.Shore);
      } else {
        const d = detail.noise2(gx / 11 + offX, gy / 11 + offY);
        let kind: number = Ground.Base;
        if (type === BiomeType.Desert) {
          if (Math.sin(gx * 0.11 + gy * 0.04 + d * 3) > 0.8) kind = Ground.Alt;
          else if (d < -0.6) kind = Ground.Detail;
        } else if (d > 0.38) kind = Ground.Alt;
        else if (d < -0.64) kind = Ground.Detail;
        tile = groundTile(palette, kind);
      }
      // Bridges cross rivers here and there.
      if ((isWater(tile) || tile === Tile.Ice || (tile < Tile.Water && tile % 4 === Ground.Shore)) && river.width > 0) {
        const bridge = fields.bridgeAt(gx, gy);
        if (bridge) tile = bridge;
      }
      tiles[i] = tile;

      if (tile >= Tile.Water || tile % 4 === Ground.Shore) continue;
      const density = Math.max(0, detail.noise2(gx / 45 + offY, gy / 45 + offX));
      const r = unit(hash3(decoSeed, lx, ly));
      let deco: number = Deco.None;
      if (type === BiomeType.Forest) {
        const trees = 0.01 + density * 0.17;
        if (r < trees) {
          const pine = unit(hash3(decoSeed ^ 0x5bd1, lx, ly)) < 0.18;
          deco = pine ? Deco.Pine : variant ? Deco.OakAutumn : Deco.Oak;
        } else if (r < trees + 0.02) deco = Deco.Bush;
        else if (r < trees + 0.035) deco = Deco.Flowers;
        else if (r < trees + 0.042) deco = Deco.Mushroom;
        else if (r < trees + 0.046) deco = Deco.Stone;
        else if (r < trees + 0.0475) deco = Deco.Ore;
      } else if (type === BiomeType.Desert) {
        const cactus = 0.008 + density * 0.03;
        if (r < cactus) deco = Deco.Cactus;
        else if (r < cactus + 0.012) deco = Deco.DeadBush;
        else if (r < cactus + 0.018) deco = variant ? Deco.RedRock : Deco.Stone;
        else if (r < cactus + 0.0195) deco = Deco.Ore;
      } else {
        const pines = 0.01 + density * 0.11;
        const crystals = variant ? 0.012 : 0.0015;
        if (r < pines) deco = Deco.PineSnow;
        else if (r < pines + 0.008) deco = Deco.SnowRock;
        else if (r < pines + 0.008 + crystals) deco = Deco.Crystal;
        else if (r < pines + 0.0095 + crystals) deco = Deco.Ore;
      }
      // Trees are wider than a tile: keep them off all eight neighbours.
      if (TALL.has(deco) && tallNear(decos, lx, ly)) deco = Deco.None;
      decos[i] = deco;
    }
  }
  return { token: req.token, cx, cy, tiles, decos };
}
