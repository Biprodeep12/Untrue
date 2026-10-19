// A guest's chunk generator: it generates nothing. Each request goes to the
// host, and the answer is the host's own terrain for that chunk, exactly as
// its workers made it, so every player's chunk is the same, byte for byte.
//
// The chunk manager counts every request until it is answered, so every one
// is: when the host's answer arrives, each request still waiting for that
// chunk gets it (the manager drops answers to requests it has since let go);
// when the host says not yet (the chunk is beyond what it keeps for this
// guest so far), it is asked again a moment later.

import { chunkKey } from '../coords';
import type { ChunkRequest, ChunkResult } from '../generation/TerrainGenerator';
import type { ChunkGenerator } from '../world/ChunkManager';

/** How long before asking again for a chunk the host could not give yet, in ms. */
const RETRY_MS = 400;
/** The answer to a request let go of: never looked at. */
const NONE = new Uint8Array(0);

export class NetChunkGenerator implements ChunkGenerator {
  private handler: (res: ChunkResult) => void = () => {};
  /** Requests waiting for an answer, by chunk: their tokens. */
  private readonly waiting = new Map<number, { cx: number; cy: number; tokens: number[]; retryAt: number }>();

  /** How many chunks wait on the host. */
  get pending(): number {
    return this.waiting.size;
  }

  /** `ask`: sends a request for a chunk to the host. */
  constructor(private readonly ask: (cx: number, cy: number) => void) {}

  request(req: ChunkRequest): void {
    const key = chunkKey(req.cx, req.cy);
    const w = this.waiting.get(key);
    if (w) {
      // Already asked: this one shares the answer.
      w.tokens.push(req.token);
      return;
    }
    this.waiting.set(key, { cx: req.cx, cy: req.cy, tokens: [req.token], retryAt: 0 });
    this.ask(req.cx, req.cy);
  }

  onResult(handler: (res: ChunkResult) => void): void {
    this.handler = handler;
  }

  /** Whether a chunk is still wanted (any request for it waits). */
  wants(cx: number, cy: number): boolean {
    return this.waiting.has(chunkKey(cx, cy));
  }

  /** The host's terrain for a chunk: answers every request waiting for it. */
  answer(cx: number, cy: number, tiles: Uint8Array, decos: Uint8Array): void {
    const key = chunkKey(cx, cy);
    const w = this.waiting.get(key);
    if (!w) return;
    this.waiting.delete(key);
    for (const token of w.tokens) this.handler({ token, cx, cy, tiles, decos });
  }

  /** The host cannot give it yet: ask again soon. */
  later(cx: number, cy: number, now: number): void {
    const w = this.waiting.get(chunkKey(cx, cy));
    if (w) w.retryAt = now + RETRY_MS;
  }

  /** Asks again for what is due; call once a frame. */
  update(now: number): void {
    for (const w of this.waiting.values()) {
      if (!w.retryAt || now < w.retryAt) continue;
      w.retryAt = 0;
      this.ask(w.cx, w.cy);
    }
  }

  /** Lets go of requests the chunk manager no longer waits on (`live` is
   *  false for them: it disposed of their chunk). Each is answered as
   *  cancelled, so the manager's count of requests in flight stays right;
   *  without this, a chunk let go of before the host answered would be
   *  asked for again for ever, and hold a place in flight. */
  prune(live: (cx: number, cy: number, token: number) => boolean): void {
    for (const [key, w] of this.waiting) {
      let n = 0;
      for (const token of w.tokens) {
        if (live(w.cx, w.cy, token)) w.tokens[n++] = token;
        else this.handler({ token, cx: w.cx, cy: w.cy, tiles: NONE, decos: NONE });
      }
      w.tokens.length = n;
      if (!n) this.waiting.delete(key);
    }
  }

  /** Asks again for everything waiting (the link to the host came back). */
  askAll(): void {
    for (const w of this.waiting.values()) {
      w.retryAt = 0;
      this.ask(w.cx, w.cy);
    }
  }
}
