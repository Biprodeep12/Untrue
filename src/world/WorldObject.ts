// A world object that may span many chunks and lives as one record (spec 4.1).

import { CHUNK_SIZE } from '../config';
import { chunkKey, tileToChunk } from '../coords';
import type { Layout } from '../generation/StructureGenerator';
import { Deco } from '../generation/Tiles';
import type { Chunk } from './Chunk';

export class WorldObject {
  /** Keys of every chunk the footprint touches. */
  readonly chunks: number[] = [];
  /** Footprint chunks currently inside the cache radius. */
  activeChunks = 0;
  discovered = false;
  /** Anchor chunk and roll slot, stable across visits. Chests from an anchor
   *  the player has looted regenerate empty. */
  anchor = '';
  /** Layout indices of chests opened while this object lives. */
  readonly opened = new Set<number>();
  /** Every chest starts looted, because this anchor was looted before. */
  emptyChests = false;
  /** A rift the player closed: its tear shows as a scar while the object lives. */
  closed = false;
  /** A rift: the id of the outer dimension it opens onto. */
  dimension = '';

  constructor(
    readonly id: string,
    readonly kind: string,
    readonly name: string,
    readonly x: number,
    readonly y: number,
    readonly layout: Layout,
  ) {
    for (let cy = tileToChunk(y); cy <= tileToChunk(y + layout.h - 1); cy++) {
      for (let cx = tileToChunk(x); cx <= tileToChunk(x + layout.w - 1); cx++) this.chunks.push(chunkKey(cx, cy));
    }
  }

  get w(): number {
    return this.layout.w;
  }

  get h(): number {
    return this.layout.h;
  }

  contains(gx: number, gy: number): boolean {
    return gx >= this.x && gy >= this.y && gx < this.x + this.w && gy < this.y + this.h;
  }

  overlaps(x: number, y: number, w: number, h: number, pad: number): boolean {
    return x < this.x + this.w + pad && x + w + pad > this.x && y < this.y + this.h + pad && y + h + pad > this.y;
  }

  /** Writes this object's part of the layout over a chunk's composed tiles. */
  stamp(chunk: Chunk): void {
    const ox = chunk.cx * CHUNK_SIZE;
    const oy = chunk.cy * CHUNK_SIZE;
    const x0 = Math.max(this.x, ox);
    const y0 = Math.max(this.y, oy);
    const x1 = Math.min(this.x + this.w, ox + CHUNK_SIZE);
    const y1 = Math.min(this.y + this.h, oy + CHUNK_SIZE);
    const { tiles, decos, w } = this.layout;
    for (let gy = y0; gy < y1; gy++) {
      for (let gx = x0; gx < x1; gx++) {
        const li = (gy - this.y) * w + (gx - this.x);
        const ci = (gy - oy) * CHUNK_SIZE + (gx - ox);
        const t = tiles[li];
        let d = decos[li];
        if (d === Deco.Chest && (this.emptyChests || this.opened.has(li))) d = Deco.ChestOpen;
        else if (d === Deco.Rift && this.closed) d = Deco.RiftScar;
        if (t) {
          chunk.tiles[ci] = t - 1;
          chunk.decos[ci] = d === Deco.Clear ? 0 : d;
        } else if (d) {
          chunk.decos[ci] = d === Deco.Clear ? 0 : d;
        }
      }
    }
  }
}
