// Spreads chunk generation across a small pool of web workers. If workers
// cannot start, or one fails, generation falls back to the main thread so the
// world always keeps loading.

import type { ChunkRequest, ChunkResult } from '../generation/TerrainGenerator';
import type { ChunkGenerator } from '../world/ChunkManager';
import { SyncGenerator } from '../world/SyncGenerator';

export class WorkerGenerator implements ChunkGenerator {
  private readonly workers: Worker[] = [];
  /** Requests each worker has not answered yet, by token. */
  private readonly pending: Array<Map<number, ChunkRequest>> = [];
  private fallback: SyncGenerator | null = null;
  private next = 0;
  private handler: (res: ChunkResult) => void = () => {};

  constructor(count = Math.max(1, Math.min(3, (navigator.hardwareConcurrency || 2) - 1))) {
    try {
      for (let i = 0; i < count; i++) {
        const w = new Worker(new URL('./worldGenerator.worker.ts', import.meta.url), { type: 'module' });
        const pending = new Map<number, ChunkRequest>();
        w.onmessage = (e: MessageEvent<ChunkResult>) => {
          pending.delete(e.data.token);
          this.handler(e.data);
        };
        w.onerror = (e) => {
          e.preventDefault();
          this.fail();
        };
        w.onmessageerror = () => this.fail();
        this.workers.push(w);
        this.pending.push(pending);
      }
    } catch {
      this.fail();
    }
  }

  request(req: ChunkRequest): void {
    if (this.fallback) {
      this.fallback.request(req);
      return;
    }
    this.pending[this.next].set(req.token, req);
    this.workers[this.next].postMessage(req);
    this.next = (this.next + 1) % this.workers.length;
  }

  onResult(handler: (res: ChunkResult) => void): void {
    this.handler = handler;
  }

  /** Workers are unavailable: generate on the main thread from now on, and
   *  redo whatever was still waiting. */
  private fail(): void {
    if (this.fallback) return;
    console.warn('Chunk workers unavailable; generating on the main thread.');
    this.fallback = new SyncGenerator();
    this.fallback.onResult((res) => this.handler(res));
    const waiting = this.pending.flatMap((m) => [...m.values()]);
    for (const w of this.workers) w.terminate();
    this.workers.length = 0;
    this.pending.length = 0;
    for (const req of waiting) this.fallback.request(req);
  }
}
