// Live world objects, indexed by chunk. An object is discarded only when every
// chunk it occupies has left the cache radius (spec 4), unless it is kept:
// persistent objects always, discovered semi-persistent ones for a while.

import type { WorldObject } from './WorldObject';

export class ObjectManager {
  readonly objects = new Map<string, WorldObject>();
  private readonly byChunk = new Map<number, WorldObject[]>();
  onDiscard?: (o: WorldObject) => void;
  /** Whether an object outlives leaving the cache radius. */
  keeps: (o: WorldObject) => boolean = (o) => o.persistence === 'persistent';
  /** World minutes, for how long kept objects have been idle. */
  clock: () => number = () => 0;

  add(o: WorldObject, isCached: (key: number) => boolean): void {
    this.objects.set(o.id, o);
    for (const key of o.chunks) {
      let list = this.byChunk.get(key);
      if (!list) this.byChunk.set(key, (list = []));
      list.push(o);
      if (isCached(key)) o.activeChunks++;
    }
  }

  inChunk(key: number): readonly WorldObject[] {
    return this.byChunk.get(key) ?? [];
  }

  chunkEntered(key: number): void {
    for (const o of this.inChunk(key)) o.activeChunks++;
  }

  chunkLeft(key: number): void {
    for (const o of [...this.inChunk(key)]) {
      o.activeChunks--;
      if (o.activeChunks > 0) continue;
      if (this.keeps(o)) o.idleSince = this.clock();
      else this.discard(o);
    }
  }

  /** Lets go of semi-persistent objects left idle for longer than `maxIdle` minutes. */
  sweep(maxIdle: number): void {
    const now = this.clock();
    for (const o of [...this.objects.values()]) {
      if (o.persistence === 'semi-persistent' && o.activeChunks === 0 && now - o.idleSince > maxIdle) this.discard(o);
    }
  }

  remove(o: WorldObject): void {
    this.discard(o);
  }

  /** True if any live object sits within `pad` tiles of the rectangle. */
  collides(x: number, y: number, w: number, h: number, pad: number): boolean {
    for (const o of this.objects.values()) if (o.overlaps(x, y, w, h, pad)) return true;
    return false;
  }

  /** True if a live object of this kind has its centre within `spacing` tiles. */
  crowded(kind: string, cx: number, cy: number, spacing: number): boolean {
    for (const o of this.objects.values()) {
      if (o.kind === kind && Math.hypot(o.x + o.w / 2 - cx, o.y + o.h / 2 - cy) < spacing) return true;
    }
    return false;
  }

  private discard(o: WorldObject): void {
    this.objects.delete(o.id);
    for (const key of o.chunks) {
      const list = this.byChunk.get(key);
      if (!list) continue;
      const i = list.indexOf(o);
      if (i >= 0) list.splice(i, 1);
      if (list.length === 0) this.byChunk.delete(key);
    }
    this.onDiscard?.(o);
  }
}
