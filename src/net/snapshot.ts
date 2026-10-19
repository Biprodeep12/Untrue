// Entity snapshots, delta-compressed against the last one the receiver
// acknowledged. The host keeps one `SnapshotSender` per receiver; each tick
// the game fills its frame with what that receiver should see (most important
// first), and `encode` writes only what changed since the acknowledged frame,
// in at most one packet (`MAX_SNAP_BYTES`). Whatever does not fit waits for a
// later tick: the sender records each frame exactly as the receiver will
// rebuild it, so leaving things out never desynchronises the two.
//
// Frames are columns of typed arrays reused for the whole session, and id
// lookups go through a stamped table, so a tick allocates nothing.

import type { Reader, Writer } from './codec';
import { MAX_SNAP_BYTES, Msg } from './protocol';

/** Most entities a frame holds. */
export const MAX_SNAPSHOT_ENTITIES = 128;
/** Frames remembered on each side: a delta's baseline must be this recent. */
export const SNAPSHOT_RING = 32;

// Entry mask bits.
const REMOVED = 1;
const POS = 2;
const DIR = 4;
const HEALTH = 8;
const FLAGS = 16;
const KIND = 32;
/** The position change fits a signed byte on each axis. */
const SMALL = 64;
const ALL = POS | DIR | HEALTH | FLAGS | KIND;

/** One tick's entities, as columns. Positions are whole 1/32 tiles. */
export class Frame {
  tick = 0;
  count = 0;
  readonly id = new Uint16Array(MAX_SNAPSHOT_ENTITIES);
  readonly kind = new Uint16Array(MAX_SNAPSHOT_ENTITIES);
  readonly x = new Int32Array(MAX_SNAPSHOT_ENTITIES);
  readonly y = new Int32Array(MAX_SNAPSHOT_ENTITIES);
  /** Facing (2 bits) and animation (6 bits). */
  readonly dir = new Uint8Array(MAX_SNAPSHOT_ENTITIES);
  /** Health as a share of 65535. */
  readonly health = new Uint16Array(MAX_SNAPSHOT_ENTITIES);
  readonly flags = new Uint16Array(MAX_SNAPSHOT_ENTITIES);

  clear(): void {
    this.count = 0;
  }

  /** Adds an entity; false (and nothing added) once the frame is full. */
  push(id: number, kind: number, x: number, y: number, dir: number, health: number, flags: number): boolean {
    const i = this.count;
    if (i >= MAX_SNAPSHOT_ENTITIES) return false;
    this.id[i] = id;
    this.kind[i] = kind;
    this.x[i] = x;
    this.y[i] = y;
    this.dir[i] = dir;
    this.health[i] = health;
    this.flags[i] = flags;
    this.count = i + 1;
    return true;
  }

  /** Copies entity `i` of another frame onto the end of this one. */
  pushFrom(f: Frame, i: number): boolean {
    return this.push(f.id[i], f.kind[i], f.x[i], f.y[i], f.dir[i], f.health[i], f.flags[i]);
  }

  /** Removes entity `i` by moving the last one into its place; returns the
   *  id now at `i`, or -1 if `i` was the last. */
  swapRemove(i: number): number {
    const last = --this.count;
    if (i === last) return -1;
    this.id[i] = this.id[last];
    this.kind[i] = this.kind[last];
    this.x[i] = this.x[last];
    this.y[i] = this.y[last];
    this.dir[i] = this.dir[last];
    this.health[i] = this.health[last];
    this.flags[i] = this.flags[last];
    return this.id[i];
  }

  copyFrom(f: Frame): void {
    this.tick = f.tick;
    this.count = f.count;
    const n = f.count;
    this.id.set(f.id.subarray(0, n));
    this.kind.set(f.kind.subarray(0, n));
    this.x.set(f.x.subarray(0, n));
    this.y.set(f.y.subarray(0, n));
    this.dir.set(f.dir.subarray(0, n));
    this.health.set(f.health.subarray(0, n));
    this.flags.set(f.flags.subarray(0, n));
  }
}

/** Id → index lookups without clearing: an entry counts only if its stamp is current. */
class IdTable {
  private readonly stamp = new Uint32Array(0x10000);
  private readonly index = new Uint16Array(0x10000);
  private now = 0;

  /** Forgets everything, in O(1). */
  next(): void {
    this.now++;
    if (this.now === 0xffffffff) {
      this.stamp.fill(0);
      this.now = 1;
    }
  }

  set(id: number, i: number): void {
    this.stamp[id] = this.now;
    this.index[id] = i;
  }

  delete(id: number): void {
    this.stamp[id] = 0;
  }

  /** The index, or -1. */
  get(id: number): number {
    return this.stamp[id] === this.now ? this.index[id] : -1;
  }
}

// Shared scratch: encoding and decoding never interleave on one thread.
const baseIds = new IdTable();
const curIds = new IdTable();
const EMPTY = new Frame();
const SCRATCH = new Frame();

const makeRing = (): Frame[] => Array.from({ length: SNAPSHOT_RING }, () => new Frame());

/** Bytes an entry takes, by mask. */
function entrySize(mask: number): number {
  let n = 3;
  if (mask & POS) n += mask & SMALL ? 2 : 8;
  if (mask & DIR) n += 1;
  if (mask & HEALTH) n += 2;
  if (mask & FLAGS) n += 2;
  if (mask & KIND) n += 2;
  return n;
}

/** Header: type, tick, baseline tick, entry count. */
const HEADER = 1 + 4 + 4 + 1;

/** One receiver's snapshots, on the host. */
export class SnapshotSender {
  /** Fill this each tick, most important entities first. */
  readonly frame = new Frame();
  private readonly ring = makeRing();
  /** Newest tick the receiver acknowledged, 0 for none. */
  private acked = 0;

  /** The receiver says it has `tick`: later deltas build on it. */
  ack(tick: number): void {
    if (tick <= this.acked) return;
    const f = this.ring[tick % SNAPSHOT_RING];
    if (f.tick === tick) this.acked = tick;
  }

  /** Sends everything in full again (after the receiver lost track). */
  resetBaseline(): void {
    this.acked = 0;
  }

  /** Encodes `frame` as snapshot `tick` (ticks rise from 1). The result is a
   *  view into `w`'s buffer. */
  encode(w: Writer, tick: number): Uint8Array {
    const cur = this.frame;
    let base = EMPTY;
    let baseTick = 0;
    if (this.acked && tick > this.acked && tick - this.acked < SNAPSHOT_RING) {
      const f = this.ring[this.acked % SNAPSHOT_RING];
      if (f.tick === this.acked) {
        base = f;
        baseTick = this.acked;
      }
    }
    const rec = this.ring[tick % SNAPSHOT_RING];
    rec.clear();
    rec.tick = tick;

    baseIds.next();
    for (let i = 0; i < base.count; i++) baseIds.set(base.id[i], i);
    // Which of this frame's entities the baseline has (each takes a place in
    // the rebuilt frame whatever is sent); duplicates count once.
    curIds.next();
    let inBase = 0;
    for (let i = 0; i < cur.count; i++) {
      const id = cur.id[i];
      if (curIds.get(id) >= 0) continue;
      curIds.set(id, i);
      if (baseIds.get(id) >= 0) inBase++;
    }

    w.reset().u8(Msg.Snapshot).u32(tick).u32(baseTick);
    const countAt = w.pos;
    w.u8(0);
    let entries = 0;
    let room = MAX_SNAP_BYTES - HEADER;

    // Removals first: they free places for new entities on the other side.
    let kept = 0;
    for (let b = 0; b < base.count; b++) {
      if (curIds.get(base.id[b]) >= 0) continue;
      if (room >= 3 && entries < 255) {
        room -= 3;
        entries++;
        w.u16(base.id[b]).u8(REMOVED);
      } else {
        rec.pushFrom(base, b);
        kept++;
      }
    }
    let free = MAX_SNAPSHOT_ENTITIES - inBase - kept;

    for (let i = 0; i < cur.count; i++) {
      const id = cur.id[i];
      if (curIds.get(id) !== i) continue; // A duplicate.
      const b = baseIds.get(id);
      let mask = 0;
      let dx = 0;
      let dy = 0;
      if (b < 0) {
        if (free <= 0) continue;
        mask = ALL;
      } else {
        dx = cur.x[i] - base.x[b];
        dy = cur.y[i] - base.y[b];
        if (dx || dy) mask |= POS;
        if (cur.dir[i] !== base.dir[b]) mask |= DIR;
        if (cur.health[i] !== base.health[b]) mask |= HEALTH;
        if (cur.flags[i] !== base.flags[b]) mask |= FLAGS;
        if (cur.kind[i] !== base.kind[b]) mask |= KIND;
        if (mask & POS && dx >= -128 && dx <= 127 && dy >= -128 && dy <= 127) mask |= SMALL;
        if (mask === 0) {
          rec.pushFrom(base, b);
          continue;
        }
      }
      const size = entrySize(mask);
      if (size > room || entries === 255) {
        // Does not fit: the receiver keeps what it had.
        if (b >= 0) rec.pushFrom(base, b);
        continue;
      }
      room -= size;
      entries++;
      if (b < 0) free--;
      w.u16(id).u8(mask);
      if (mask & POS) {
        if (mask & SMALL) w.u8(dx & 0xff).u8(dy & 0xff);
        else w.i32(cur.x[i]).i32(cur.y[i]);
      }
      if (mask & DIR) w.u8(cur.dir[i]);
      if (mask & HEALTH) w.u16(cur.health[i]);
      if (mask & FLAGS) w.u16(cur.flags[i]);
      if (mask & KIND) w.u16(cur.kind[i]);
      rec.pushFrom(cur, i);
    }

    w.patchU8(countAt, entries);
    return w.finish();
  }
}

/** Snapshots from the host, rebuilt into frames. */
export class SnapshotReceiver {
  private readonly ring = makeRing();
  /** The newest frame rebuilt, or null before the first. */
  latest: Frame | null = null;

  /** Rebuilds a snapshot. Returns its frame, or null if it is malformed,
   *  older than the latest, or built on a frame this side no longer has
   *  (the host then sends in full once acks catch up). Acknowledge the
   *  returned frame's tick. */
  read(r: Reader, data: Uint8Array): Frame | null {
    r.reset(data);
    if (r.u8() !== Msg.Snapshot) return null;
    const tick = r.u32();
    const baseTick = r.u32();
    const n = r.u8();
    if (!r.ok || tick === 0 || (this.latest && tick <= this.latest.tick)) return null;
    let base = EMPTY;
    if (baseTick) {
      if (baseTick >= tick || tick - baseTick >= SNAPSHOT_RING) return null;
      base = this.ring[baseTick % SNAPSHOT_RING];
      if (base.tick !== baseTick) return null;
    }
    // Build in scratch first: a malformed snapshot must not spoil the ring.
    const out = SCRATCH;
    out.copyFrom(base);
    out.tick = tick;
    baseIds.next();
    for (let i = 0; i < out.count; i++) baseIds.set(out.id[i], i);

    for (let e = 0; e < n; e++) {
      const id = r.u16();
      const mask = r.u8();
      if (!r.ok || mask & 0x80) return null;
      let i = baseIds.get(id);
      if (mask & REMOVED) {
        if (mask !== REMOVED || i < 0) return null;
        baseIds.delete(id);
        const moved = out.swapRemove(i);
        if (moved >= 0) baseIds.set(moved, i);
        continue;
      }
      if (i < 0) {
        if ((mask & ALL) !== ALL || mask & SMALL) return null;
        if (!out.push(id, 0, 0, 0, 0, 0, 0)) return null;
        i = out.count - 1;
        baseIds.set(id, i);
      }
      if (mask & POS) {
        if (mask & SMALL) {
          out.x[i] += (r.u8() << 24) >> 24;
          out.y[i] += (r.u8() << 24) >> 24;
        } else {
          out.x[i] = r.i32();
          out.y[i] = r.i32();
        }
      } else if (mask & SMALL) return null;
      if (mask & DIR) out.dir[i] = r.u8();
      if (mask & HEALTH) out.health[i] = r.u16();
      if (mask & FLAGS) out.flags[i] = r.u16();
      if (mask & KIND) out.kind[i] = r.u16();
    }
    if (!r.done) return null;

    const rec = this.ring[tick % SNAPSHOT_RING];
    rec.copyFrom(out);
    this.latest = rec;
    return rec;
  }
}
