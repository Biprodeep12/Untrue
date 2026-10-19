// Chunk streaming (spec 2): works out the render, cache and simulation areas,
// predicts and queues generation, and runs the chunk lifecycle.
//
// A host sharing its world streams for its guests too: each guest's view adds
// its own cache and simulation areas (`update(view, others)`). The cache is
// the union of everyone's, so a region drifts only once it has left every
// player's area, and objects live while anyone's cache holds them. Only this
// machine's own render area is drawn. Without guests it is the same as alone.

import { CACHE_MARGIN, MAX_IN_FLIGHT, RENDER_MARGIN, SIM_RADIUS } from '../config';
import { chunkKey, inRect, keyX, keyY, sameRect, tileToChunk, type ChunkRect } from '../coords';
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

/** Another player's areas, worked out from their view. */
interface OtherAreas {
  render: ChunkRect;
  cache: ChunkRect;
  sim: ChunkRect;
}

const NO_VIEWS: readonly View[] = [];
const emptyRect = (): ChunkRect => ({ x0: 0, y0: 0, x1: -1, y1: -1 });

/** Copies `src` into `dst` (made if null): stored areas are kept, not remade each frame. */
function copyRect(dst: ChunkRect | null, src: ChunkRect): ChunkRect {
  const r = dst ?? emptyRect();
  r.x0 = src.x0;
  r.y0 = src.y0;
  r.x1 = src.x1;
  r.y1 = src.y1;
  return r;
}

/** A chunk that could be generated next, and how much it is wanted (lower first). */
interface Candidate {
  cx: number;
  cy: number;
  score: number;
}

/** `out` = the areas around `view`, as for this player's own (no allocation). */
function areasOf(view: View, out: OtherAreas): void {
  const r = out.render;
  r.x0 = tileToChunk(view.minX) - RENDER_MARGIN;
  r.y0 = tileToChunk(view.minY) - RENDER_MARGIN;
  r.x1 = tileToChunk(Math.ceil(view.maxX) - 1) + RENDER_MARGIN;
  r.y1 = tileToChunk(Math.ceil(view.maxY) - 1) + RENDER_MARGIN;
  const c = out.cache;
  c.x0 = r.x0 - CACHE_MARGIN;
  c.y0 = r.y0 - CACHE_MARGIN;
  c.x1 = r.x1 + CACHE_MARGIN;
  c.y1 = r.y1 + CACHE_MARGIN;
  const px = tileToChunk(view.playerX);
  const py = tileToChunk(view.playerY);
  const m = out.sim;
  m.x0 = px - SIM_RADIUS;
  m.y0 = py - SIM_RADIUS;
  m.x1 = px + SIM_RADIUS;
  m.y1 = py + SIM_RADIUS;
}

export class ChunkManager {
  renderRect: ChunkRect | null = null;
  cacheRect: ChunkRect | null = null;
  simRect: ChunkRect | null = null;
  /** Every chunk inside the cache radius, generated or not. */
  readonly cached = new Set<number>();
  /** Generated or generating chunks. */
  readonly chunks = new Map<number, Chunk>();
  /** Every simulated area: this player's first, then each other player's. */
  readonly simRects: ChunkRect[] = [];
  listener?: ChunkListener;
  /** A chunk's terrain arrived and was composed (a host serves it on). */
  onReady?: (chunk: Chunk) => void;
  /** Ready chunks waiting to be drawn. Drawing a chunk is costly (meshes,
   *  hundreds of sprites, lights), so a few go per frame, nearest first,
   *  instead of every result that lands in the same frame. */
  private readonly pendingShow = new Set<Chunk>();
  inFlight = 0;

  private tokenSeq = 1;
  private dirX = 0;
  private dirY = 0;
  private playerCX = 0;
  private playerCY = 0;
  /** Other players' areas (a host streaming for guests), reused frame to frame. */
  private readonly others: OtherAreas[] = [];
  private otherCount = 0;
  /** Chunks other players asked for, generated after this player's own. */
  private readonly demanded = new Set<number>();
  // Worked out in place every frame: nothing here is allocated per frame.
  private readonly nextRender = emptyRect();
  private readonly nextCache = emptyRect();
  private readonly ownSim = emptyRect();
  private readonly ahead = emptyRect();
  private readonly candidates: Candidate[] = [];
  private candidateCount = 0;

  constructor(
    private readonly generator: ChunkGenerator,
    private readonly hooks: ChunkHooks,
    /** Chunk buffers to reuse; a dimension's trips share one. */
    private readonly pool = new ChunkPool(),
  ) {
    generator.onResult((res) => this.receive(res));
  }

  /** `others`: other players' views, streamed and simulated too (a host's guests). */
  update(view: View, others: readonly View[] = NO_VIEWS): void {
    const render = this.nextRender;
    render.x0 = tileToChunk(view.minX) - RENDER_MARGIN;
    render.y0 = tileToChunk(view.minY) - RENDER_MARGIN;
    render.x1 = tileToChunk(Math.ceil(view.maxX) - 1) + RENDER_MARGIN;
    render.y1 = tileToChunk(Math.ceil(view.maxY) - 1) + RENDER_MARGIN;
    const cache = this.nextCache;
    cache.x0 = render.x0 - CACHE_MARGIN;
    cache.y0 = render.y0 - CACHE_MARGIN;
    cache.x1 = render.x1 + CACHE_MARGIN;
    cache.y1 = render.y1 + CACHE_MARGIN;
    this.playerCX = tileToChunk(view.playerX);
    this.playerCY = tileToChunk(view.playerY);
    this.dirX = Math.sign(Math.round(view.dirX * 4));
    this.dirY = Math.sign(Math.round(view.dirY * 4));
    const sim = (this.simRect = this.ownSim);
    sim.x0 = this.playerCX - SIM_RADIUS;
    sim.y0 = this.playerCY - SIM_RADIUS;
    sim.x1 = this.playerCX + SIM_RADIUS;
    sim.y1 = this.playerCY + SIM_RADIUS;

    let moved = !sameRect(this.cacheRect, cache);
    if (others.length || this.otherCount) moved = this.updateOthers(others) || moved;
    if (moved) this.setCache(cache);
    if (!sameRect(this.renderRect, render)) {
      this.renderRect = copyRect(this.renderRect, render);
      for (const c of this.chunks.values()) this.syncShown(c);
    }
    const sims = this.simRects;
    sims.length = 0;
    sims.push(this.simRect);
    for (let i = 0; i < this.otherCount; i++) sims.push(this.others[i].sim);
    for (const c of this.chunks.values()) c.simulated = this.inSim(c.cx, c.cy);
    this.schedule();
    this.flushShows();
  }

  /** Takes in other players' views; true if their cache areas changed. */
  private updateOthers(views: readonly View[]): boolean {
    let changed = views.length !== this.otherCount;
    for (let i = 0; i < views.length; i++) {
      let a = this.others[i];
      if (!a) this.others.push((a = { render: emptyRect(), cache: emptyRect(), sim: emptyRect() }));
      const { x0, y0, x1, y1 } = a.cache;
      areasOf(views[i], a);
      const c = a.cache;
      if (c.x0 !== x0 || c.y0 !== y0 || c.x1 !== x1 || c.y1 !== y1) changed = true;
    }
    this.otherCount = views.length;
    return changed;
  }

  /** In any player's simulated area. */
  private inSim(cx: number, cy: number): boolean {
    if (this.simRect && inRect(this.simRect, cx, cy)) return true;
    for (let i = 0; i < this.otherCount; i++) if (inRect(this.others[i].sim, cx, cy)) return true;
    return false;
  }

  /** In any player's cache area. */
  private inCache(cx: number, cy: number): boolean {
    if (this.cacheRect && inRect(this.cacheRect, cx, cy)) return true;
    for (let i = 0; i < this.otherCount; i++) if (inRect(this.others[i].cache, cx, cy)) return true;
    return false;
  }

  /** Another player wants this chunk: it is generated soon if it is in the
   *  cache; false if it is not (their view has not arrived, or moved on). */
  demand(cx: number, cy: number): boolean {
    const key = chunkKey(cx, cy);
    if (!this.cached.has(key)) return false;
    if (!this.chunks.has(key)) this.demanded.add(key);
    return true;
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
    this.cacheRect = copyRect(this.cacheRect, rect);
    // Dispose: chunks that left every cache area go back to the pool.
    const leaving: number[] = [];
    for (const key of this.cached) {
      if (this.inCache(keyX(key), keyY(key))) continue;
      leaving.push(key);
      const chunk = this.chunks.get(key);
      if (chunk) {
        this.pendingShow.delete(chunk);
        if (chunk.shown) this.listener?.hide(chunk);
        this.chunks.delete(key);
        this.pool.release(chunk);
      }
    }
    for (const key of leaving) {
      this.cached.delete(key);
      this.demanded.delete(key);
    }
    if (leaving.length) this.hooks.cacheLeave(leaving);

    const entering: number[] = [];
    this.enter(rect, entering);
    for (let i = 0; i < this.otherCount; i++) this.enter(this.others[i].cache, entering);
    if (entering.length) this.hooks.cacheEnter(entering);
  }

  private enter(rect: ChunkRect, entering: number[]): void {
    for (let cy = rect.y0; cy <= rect.y1; cy++) {
      for (let cx = rect.x0; cx <= rect.x1; cx++) {
        const key = chunkKey(cx, cy);
        if (this.cached.has(key)) continue;
        this.cached.add(key);
        entering.push(key);
      }
    }
  }

  /** Predict and generate: the render area plus one chunk further in the
   *  direction of travel, nearest and most likely first. */
  /** A chunk that could be generated next (into reused slots). */
  private candidate(cx: number, cy: number, score: number): void {
    let c = this.candidates[this.candidateCount];
    if (!c) this.candidates.push((c = { cx: 0, cy: 0, score: 0 }));
    c.cx = cx;
    c.cy = cy;
    c.score = score;
    this.candidateCount++;
  }

  private schedule(): void {
    const render = this.renderRect;
    if (!render || this.inFlight >= MAX_IN_FLIGHT) return;
    const ahead = this.ahead;
    ahead.x0 = render.x0 + Math.min(0, this.dirX);
    ahead.y0 = render.y0 + Math.min(0, this.dirY);
    ahead.x1 = render.x1 + Math.max(0, this.dirX);
    ahead.y1 = render.y1 + Math.max(0, this.dirY);
    this.candidateCount = 0;
    for (let cy = ahead.y0; cy <= ahead.y1; cy++) {
      for (let cx = ahead.x0; cx <= ahead.x1; cx++) {
        if (this.chunks.has(chunkKey(cx, cy))) continue;
        const dx = cx - this.playerCX;
        const dy = cy - this.playerCY;
        const facing = dx * this.dirX + dy * this.dirY;
        this.candidate(cx, cy, Math.hypot(dx, dy) - facing * 0.5 + (inRect(render, cx, cy) ? 0 : 100));
      }
    }
    // Then what other players see, and what they asked for.
    for (let i = 0; i < this.otherCount; i++) {
      const r = this.others[i].render;
      const mx = (r.x0 + r.x1) / 2;
      const my = (r.y0 + r.y1) / 2;
      for (let cy = r.y0; cy <= r.y1; cy++) {
        for (let cx = r.x0; cx <= r.x1; cx++) {
          if (!this.chunks.has(chunkKey(cx, cy))) this.candidate(cx, cy, 200 + Math.hypot(cx - mx, cy - my));
        }
      }
    }
    for (const key of this.demanded) {
      if (this.chunks.has(key)) this.demanded.delete(key);
      else this.candidate(keyX(key), keyY(key), 300);
    }
    // The best few, picked in turn (no sort: only a handful go each frame).
    const list = this.candidates;
    const n = this.candidateCount;
    while (this.inFlight < MAX_IN_FLIGHT) {
      let best = -1;
      for (let i = 0; i < n; i++) if (list[i].score !== Infinity && (best < 0 || list[i].score < list[best].score)) best = i;
      if (best < 0) break;
      const { cx, cy } = list[best];
      list[best].score = Infinity;
      const key = chunkKey(cx, cy);
      // Others' areas overlap: a chunk may be listed twice.
      if (this.chunks.has(key)) continue;
      const chunk = this.pool.acquire(cx, cy, this.tokenSeq++);
      this.chunks.set(chunk.key, chunk);
      this.demanded.delete(key);
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
    chunk.simulated = this.inSim(chunk.cx, chunk.cy);
    this.syncShown(chunk);
    this.onReady?.(chunk);
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

  /** Draws every ready chunk waiting to be drawn now, not a few per frame:
   *  for a moment the screen is covered anyway (a passage through a rift). */
  showPending(): void {
    while (this.pendingShow.size) this.flushShows();
  }

  /** Lets go of every chunk (hiding what is drawn), as when a dimension is
   *  left; results still on their way are ignored when they land. */
  clear(): void {
    for (const chunk of this.chunks.values()) {
      if (chunk.shown) this.listener?.hide(chunk);
      this.pool.release(chunk);
    }
    this.chunks.clear();
    this.cached.clear();
    this.pendingShow.clear();
    this.demanded.clear();
    this.otherCount = 0;
    this.simRects.length = 0;
    this.renderRect = this.cacheRect = this.simRect = null;
  }

  /** Re-composes a chunk after an object was stamped onto it. */
  refresh(chunk: Chunk): void {
    if (!chunk.ready) return;
    this.hooks.compose(chunk);
    if (chunk.shown) this.listener?.changed(chunk);
  }
}
