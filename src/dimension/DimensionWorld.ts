// An outer dimension's land as the game plays it: the same engine as the
// overworld (chunk streaming and culling through a `ChunkManager`, drawn by a
// `TileRenderer`), but fed from a fixed map instead of the terrain generator.
// Nothing forgets here: no regions, no rolled structures. What is gathered is
// gone for this trip; the next trip finds the map as it was made. Outside the
// map is void.
//
// Collision and gathering read the map's arrays directly, so they work
// anywhere on the map, loaded or not, in O(1) and without allocating.

import { CHUNK_AREA, CHUNK_SIZE } from '../config';
import { chunkKey, tileToChunk } from '../coords';
import { hash, Stream } from '../generation/Random';
import type { ChunkRequest, ChunkResult } from '../generation/TerrainGenerator';
import { isSolid, isVoid, Tile } from '../generation/Tiles';
import type { Ground } from '../systems/GatheringSystem';
import type { ChunkPool } from '../world/Chunk';
import { ChunkManager, type ChunkGenerator, type View } from '../world/ChunkManager';
import type { DimensionLayout } from './Dimension';

/** Slices chunks out of a fixed map, at once; off the map is void. */
export class FixedGenerator implements ChunkGenerator {
  private handler: (res: ChunkResult) => void = () => {};
  // Reused: the chunk manager copies a result as soon as it lands.
  private readonly tiles = new Uint8Array(CHUNK_AREA);
  private readonly decos = new Uint8Array(CHUNK_AREA);
  private readonly result: ChunkResult = { token: 0, cx: 0, cy: 0, tiles: this.tiles, decos: this.decos };

  constructor(private readonly layout: DimensionLayout) {}

  request(req: ChunkRequest): void {
    const { w, h, ground, decos } = this.layout;
    const ox = req.cx * CHUNK_SIZE;
    const oy = req.cy * CHUNK_SIZE;
    for (let ly = 0; ly < CHUNK_SIZE; ly++) {
      const gy = oy + ly;
      const row = ly * CHUNK_SIZE;
      for (let lx = 0; lx < CHUNK_SIZE; lx++) {
        const gx = ox + lx;
        const on = gx >= 0 && gy >= 0 && gx < w && gy < h;
        const i = gy * w + gx;
        this.tiles[row + lx] = on ? ground[i] : Tile.Void;
        this.decos[row + lx] = on ? decos[i] : 0;
      }
    }
    const r = this.result;
    r.token = req.token;
    r.cx = req.cx;
    r.cy = req.cy;
    this.handler(r);
  }

  onResult(handler: (res: ChunkResult) => void): void {
    this.handler = handler;
  }
}

export class DimensionWorld implements Ground {
  readonly chunks: ChunkManager;
  /** Tiles whose decoration was gathered this trip: 1 gone. */
  private readonly gone: Uint8Array;
  /** The same, per chunk, for composing chunks without scanning them whole. */
  private readonly goneIn = new Map<number, number[]>();

  constructor(
    readonly layout: DimensionLayout,
    /** Seeds what gathering gives; the trip's own. */
    readonly seed: number,
    /** Chunk buffers kept from trip to trip, so each trip allocates none. */
    pool?: ChunkPool,
  ) {
    this.gone = new Uint8Array(layout.w * layout.h);
    this.chunks = new ChunkManager(new FixedGenerator(layout), {
      cacheEnter: () => {},
      cacheLeave: () => {},
      buildRequest: (cx, cy, token) => ({ token, cx, cy, worldSeed: seed, visit: 0, biomes: [] }),
      compose: (chunk) => {
        chunk.tiles.set(chunk.baseTiles);
        chunk.decos.set(chunk.baseDecos);
        const cut = this.goneIn.get(chunk.key);
        if (cut) for (const i of cut) chunk.decos[i] = 0;
      },
    }, pool);
  }

  /** Streams the chunks around the camera. */
  update(view: View): void {
    this.chunks.update(view);
  }

  private index(gx: number, gy: number): number {
    const { w, h } = this.layout;
    return gx >= 0 && gy >= 0 && gx < w && gy < h ? gy * w + gx : -1;
  }

  /** The land and what stands on it, or null off the map. */
  tileAt(gx: number, gy: number): { tile: number; deco: number } | null {
    const i = this.index(gx, gy);
    if (i < 0) return null;
    return { tile: this.layout.ground[i], deco: this.gone[i] ? 0 : this.layout.decos[i] };
  }

  /** The decoration on a tile, without allocating; 0 off the map. */
  decoAt(gx: number, gy: number): number {
    const i = this.index(gx, gy);
    return i < 0 || this.gone[i] ? 0 : this.layout.decos[i];
  }

  /** Walls, rocks, trees and the like; off the map counts as solid. The void
   *  is not solid here; the trip walls it off (`isVoidAt`). */
  isSolidAt(gx: number, gy: number): boolean {
    const i = this.index(gx, gy);
    if (i < 0) return true;
    return isSolid(this.layout.ground[i], this.gone[i] ? 0 : this.layout.decos[i]);
  }

  /** Nothing to stand on, off the map included. */
  isVoidAt(gx: number, gy: number): boolean {
    const i = this.index(gx, gy);
    return i < 0 || isVoid(this.layout.ground[i]);
  }

  seedAt(gx: number, gy: number): number {
    return hash(Stream.Loot, this.seed, gx, gy);
  }

  harvest(gx: number, gy: number): void {
    const i = this.index(gx, gy);
    if (i < 0 || this.gone[i]) return;
    this.gone[i] = 1;
    const cx = tileToChunk(gx);
    const cy = tileToChunk(gy);
    const key = chunkKey(cx, cy);
    let cut = this.goneIn.get(key);
    if (!cut) this.goneIn.set(key, (cut = []));
    cut.push((gy - cy * CHUNK_SIZE) * CHUNK_SIZE + (gx - cx * CHUNK_SIZE));
    const chunk = this.chunks.get(cx, cy);
    if (chunk) this.chunks.refresh(chunk);
  }

  /** Lets go of every chunk: the trip is over. */
  dispose(): void {
    this.chunks.clear();
  }
}
