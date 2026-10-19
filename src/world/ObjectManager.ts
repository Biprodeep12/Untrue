// Live world objects, indexed by chunk and by kind. An object is discarded
// when every chunk it occupies has left the cache radius (spec 4): the world
// forgets every structure, however large or rare.

import { chunkKey, tileToChunk } from '../coords';
import type { WorldObject } from './WorldObject';

const NONE: ReadonlySet<WorldObject> = new Set();

export class ObjectManager {
  readonly objects = new Map<string, WorldObject>();
  private readonly byChunk = new Map<number, WorldObject[]>();
  /** Live objects by kind, so spacing checks only look at their own kind. */
  private readonly byKind = new Map<string, Set<WorldObject>>();

  add(o: WorldObject, isCached: (key: number) => boolean): void {
    this.objects.set(o.id, o);
    for (const key of o.chunks) {
      let list = this.byChunk.get(key);
      if (!list) this.byChunk.set(key, (list = []));
      list.push(o);
      if (isCached(key)) o.activeChunks++;
    }
    let kind = this.byKind.get(o.kind);
    if (!kind) this.byKind.set(o.kind, (kind = new Set()));
    kind.add(o);
  }

  /** Live objects of one kind; empty when there are none. */
  ofKind(kind: string): ReadonlySet<WorldObject> {
    return this.byKind.get(kind) ?? NONE;
  }

  inChunk(key: number): readonly WorldObject[] {
    return this.byChunk.get(key) ?? [];
  }

  chunkEntered(key: number): void {
    for (const o of this.inChunk(key)) o.activeChunks++;
  }

  chunkLeft(key: number): void {
    const list = this.byChunk.get(key);
    if (!list) return;
    // Backwards: discarding takes the object out of this list.
    for (let i = list.length - 1; i >= 0; i--) {
      const o = list[i];
      if (--o.activeChunks <= 0) this.remove(o);
    }
  }

  /** True if any live object sits within `pad` tiles of the rectangle. Every
   *  object is listed under each chunk it covers, so only the chunks under
   *  the padded rectangle need looking at. */
  collides(x: number, y: number, w: number, h: number, pad: number): boolean {
    const cx1 = tileToChunk(x + w + pad - 1);
    const cy1 = tileToChunk(y + h + pad - 1);
    for (let cy = tileToChunk(y - pad); cy <= cy1; cy++) {
      for (let cx = tileToChunk(x - pad); cx <= cx1; cx++) {
        for (const o of this.inChunk(chunkKey(cx, cy))) if (o.overlaps(x, y, w, h, pad)) return true;
      }
    }
    return false;
  }

  /** True if a live object of this kind has its centre within `spacing` tiles. */
  crowded(kind: string, cx: number, cy: number, spacing: number): boolean {
    const same = this.byKind.get(kind);
    if (!same) return false;
    for (const o of same) {
      if (Math.hypot(o.x + o.w / 2 - cx, o.y + o.h / 2 - cy) < spacing) return true;
    }
    return false;
  }

  remove(o: WorldObject): void {
    if (!this.objects.delete(o.id)) return;
    for (const key of o.chunks) {
      const list = this.byChunk.get(key);
      if (!list) continue;
      const i = list.indexOf(o);
      if (i >= 0) list.splice(i, 1);
      if (list.length === 0) this.byChunk.delete(key);
    }
    const kind = this.byKind.get(o.kind);
    kind?.delete(o);
    if (kind?.size === 0) this.byKind.delete(o.kind);
    this.onRemove?.(o);
  }

  /** An object went (its last chunk left, or it was taken away). */
  onRemove?: (o: WorldObject) => void;
}
