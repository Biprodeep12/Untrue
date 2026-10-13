// Chunk streaming (spec 2): works out the render, cache and simulation areas,
// predicts and queues generation, and runs the chunk lifecycle.

import { CACHE_MARGIN, MAX_IN_FLIGHT, RENDER_MARGIN, SIM_RADIUS } from '../config';
import { chunkKey, expandRect, inRect, keyX, keyY, sameRect, tileToChunk, type ChunkRect } from '../coords';
import type { ChunkRequest, ChunkResult } from '../generation/TerrainGenerator';
import { Chunk, ChunkPool } from './Chunk';

/** Chunks drawn per frame at most; see `pendingShow`. */
const SHOW_PER_FRAME = 2;

/** Produces chunk terrain, usually off the main thread. */
export interface ChunkGenerator {
  request(req: ChunkRequest): void;
  onResult(handler: (res: ChunkResult) => void): void;
}

/** What the camera sees, in tile coordinates, plus where the player is heading. */
export interface View {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  playerX: number;
  playerY: number;
  dirX: number;
  dirY: number;
}

export interface ChunkHooks {
  cacheEnter(keys: number[]): void;
  cacheLeave(keys: number[]): void;
  buildRequest(cx: number, cy: number, token: number): ChunkRequest;
  /** Base terrain arrived; compose the final tiles. */
  compose(chunk: Chunk): void;
}

export interface ChunkListener {
  show(chunk: Chunk): void;
  hide(chunk: Chunk): void;
  changed(chunk: Chunk): void;
}

export class ChunkManager {
  renderRect: ChunkRect | null = null;
  cacheRect: ChunkRect | null = null;
  simRect: ChunkRect | null = null;
  /** Every chunk inside the cache radius, generated or not. */
  readonly cached = new Set<number>();
  /** Generated or generating chunks. */
  readonly chunks = new Map<number, Chunk>();
  listener?: ChunkListener;
  /** Ready chunks waiting to be drawn. Drawing a chunk is costly (meshes,
   *  hundreds of sprites, lights), so a few go per frame, nearest first,
   *  instead of every result that lands in the same frame. */
  private readonly pendingShow = new Set<Chunk>();
  inFlight = 0;

  private readonly pool = new ChunkPool();
  private tokenSeq = 1;
  private dirX = 0;
  private dirY = 0;
  private playerCX = 0;
  private playerCY = 0;

  constructor(
    private readonly generator: ChunkGenerator,
    private readonly hooks: ChunkHooks,
  ) {
    generator.onResult((res) => this.receive(res));
  }

  update(view: View): void {
    const visible: ChunkRect = {
      x0: tileToChunk(view.minX),
      y0: tileToChunk(view.minY),
      x1: tileToChunk(Math.ceil(view.maxX) - 1),
      y1: tileToChunk(Math.ceil(view.maxY) - 1),
    };
    const render = expandRect(visible, RENDER_MARGIN);
    const cache = expandRect(render, CACHE_MARGIN);
    this.playerCX = tileToChunk(view.playerX);
    this.playerCY = tileToChunk(view.playerY);
    this.dirX = Math.sign(Math.round(view.dirX * 4));
    this.dirY = Math.sign(Math.round(view.dirY * 4));
    this.simRect = expandRect({ x0: this.playerCX, y0: this.playerCY, x1: this.playerCX, y1: this.playerCY }, SIM_RADIUS);

    if (!sameRect(this.cacheRect, cache)) this.setCache(cache);
    if (!sameRect(this.renderRect, render)) {
      this.renderRect = render;
      for (const c of this.chunks.values()) this.syncShown(c);
    }
    for (const c of this.chunks.values()) c.simulated = inRect(this.simRect, c.cx, c.cy);
    this.schedule();
    this.flushShows();
  }

  /** Draws up to SHOW_PER_FRAME waiting chunks, nearest to the player first. */
  private flushShows(): void {
    for (let n = 0; n < SHOW_PER_FRAME && this.pendingShow.size; n++) {
      let best: Chunk | null = null;
      let bestD = Infinity;
      for (const c of this.pendingShow) {
        const d = Math.abs(c.cx - this.playerCX) + Math.abs(c.cy - this.playerCY);
        if (d < bestD) {
          bestD = d;
          best = c;
        }
      }
      this.pendingShow.delete(best!);
      best!.shown = true;
      this.listener?.show(best!);
    }
  }

  get(cx: number, cy: number): Chunk | undefined {
    return this.chunks.get(chunkKey(cx, cy));
  }

  isCached = (key: number): boolean => this.cached.has(key);

  private setCache(rect: ChunkRect): void {
    this.cacheRect = rect;
    // Dispose: chunks that left the cache radius go back to the pool.
    const leaving: number[] = [];
    for (const key of this.cached) {
      if (inRect(rect, keyX(key), keyY(key))) continue;
      leaving.push(key);
      const chunk = this.chunks.get(key);
      if (chunk) {
        this.pendingShow.delete(chunk);
        if (chunk.shown) this.listener?.hide(chunk);
        this.chunks.delete(key);
        this.pool.release(chunk);
      }
    }
    for (const key of leaving) this.cached.delete(key);
    if (leaving.length) this.hooks.cacheLeave(leaving);

    const entering: number[] = [];
    for (let cy = rect.y0; cy <= rect.y1; cy++) {
      for (let cx = rect.x0; cx <= rect.x1; cx++) {
        const key = chunkKey(cx, cy);
        if (this.cached.has(key)) continue;
        this.cached.add(key);
        entering.push(key);
      }
    }
    if (entering.length) this.hooks.cacheEnter(entering);
  }

  /** Predict and generate: the render area plus one chunk further in the
   *  direction of travel, nearest and most likely first. */
  private schedule(): void {
    const render = this.renderRect;
    if (!render || this.inFlight >= MAX_IN_FLIGHT) return;
    const ahead: ChunkRect = {
      x0: render.x0 + Math.min(0, this.dirX),
      y0: render.y0 + Math.min(0, this.dirY),
      x1: render.x1 + Math.max(0, this.dirX),
      y1: render.y1 + Math.max(0, this.dirY),
    };
    const queue: Array<{ cx: number; cy: number; score: number }> = [];
    for (let cy = ahead.y0; cy <= ahead.y1; cy++) {
      for (let cx = ahead.x0; cx <= ahead.x1; cx++) {
        if (this.chunks.has(chunkKey(cx, cy))) continue;
        const dx = cx - this.playerCX;
        const dy = cy - this.playerCY;
        const facing = dx * this.dirX + dy * this.dirY;
        const score = Math.hypot(dx, dy) - facing * 0.5 + (inRect(render, cx, cy) ? 0 : 100);
        queue.push({ cx, cy, score });
      }
    }
    queue.sort((a, b) => a.score - b.score);
    for (const { cx, cy } of queue) {
      if (this.inFlight >= MAX_IN_FLIGHT) break;
      const chunk = this.pool.acquire(cx, cy, this.tokenSeq++);
      this.chunks.set(chunk.key, chunk);
      this.inFlight++;
      this.generator.request(this.hooks.buildRequest(cx, cy, chunk.token));
    }
  }

  private receive(res: ChunkResult): void {
    this.inFlight--;
    const chunk = this.chunks.get(chunkKey(res.cx, res.cy));
    if (!chunk || chunk.token !== res.token) return; // disposed while generating
    chunk.baseTiles.set(res.tiles);
    chunk.baseDecos.set(res.decos);
    this.hooks.compose(chunk);
    chunk.ready = true;
    chunk.simulated = !!this.simRect && inRect(this.simRect, chunk.cx, chunk.cy);
    this.syncShown(chunk);
  }

  /** Activate or deactivate rendering for a chunk. */
  private syncShown(chunk: Chunk): void {
    const want = chunk.ready && !!this.renderRect && inRect(this.renderRect, chunk.cx, chunk.cy);
    if (!want) this.pendingShow.delete(chunk);
    if (want === chunk.shown) return;
    if (want) {
      // Without a renderer (tests, tools) there is nothing to spread out.
      if (this.listener) this.pendingShow.add(chunk);
      else chunk.shown = true;
      return;
    }
    chunk.shown = false;
    this.listener?.hide(chunk);
  }

  /** Re-composes a chunk after an object was stamped onto it. */
  refresh(chunk: Chunk): void {
    if (!chunk.ready) return;
    this.hooks.compose(chunk);
    if (chunk.shown) this.listener?.changed(chunk);
  }
}
