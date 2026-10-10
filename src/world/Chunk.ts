// A loaded chunk: the worker's base terrain plus the composed tiles after
// live objects are stamped over it.

import { CHUNK_AREA } from '../config';
import { chunkKey } from '../coords';

export class Chunk {
  cx = 0;
  cy = 0;
  key = 0;
  /** Matches a worker result to the request that made it. */
  token = 0;
  ready = false;
  /** The renderer is drawing it. */
  shown = false;
  simulated = false;
  readonly baseTiles = new Uint8Array(CHUNK_AREA);
  readonly baseDecos = new Uint8Array(CHUNK_AREA);
  readonly tiles = new Uint8Array(CHUNK_AREA);
  readonly decos = new Uint8Array(CHUNK_AREA);

  reset(cx: number, cy: number, token: number): this {
    this.cx = cx;
    this.cy = cy;
    this.key = chunkKey(cx, cy);
    this.token = token;
    this.ready = false;
    this.shown = false;
    this.simulated = false;
    return this;
  }
}

/** Reuses chunk buffers so streaming rarely wakes the garbage collector. */
export class ChunkPool {
  private readonly free: Chunk[] = [];

  acquire(cx: number, cy: number, token: number): Chunk {
    return (this.free.pop() ?? new Chunk()).reset(cx, cy, token);
  }

  release(chunk: Chunk): void {
    this.free.push(chunk);
  }
}
