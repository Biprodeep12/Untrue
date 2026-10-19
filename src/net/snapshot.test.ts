import { describe, expect, it } from 'vitest';
import { Reader, Writer } from './codec';
import { MAX_SNAP_BYTES } from './protocol';
import { Frame, MAX_SNAPSHOT_ENTITIES, SnapshotReceiver, SnapshotSender } from './snapshot';

function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Thing {
  id: number;
  kind: number;
  x: number;
  y: number;
  dir: number;
  health: number;
  flags: number;
}

/** The receiver's frame as a sorted list, to compare with the truth. */
function list(f: Frame | null): Thing[] {
  if (!f) return [];
  const out: Thing[] = [];
  for (let i = 0; i < f.count; i++) out.push({ id: f.id[i], kind: f.kind[i], x: f.x[i], y: f.y[i], dir: f.dir[i], health: f.health[i], flags: f.flags[i] });
  return out.sort((a, b) => a.id - b.id);
}

function fill(frame: Frame, things: Thing[]): void {
  frame.clear();
  for (const t of things) frame.push(t.id, t.kind, t.x, t.y, t.dir, t.health, t.flags);
}

describe('snapshots', () => {
  it('sends in full first, then only changes', () => {
    const w = new Writer();
    const r = new Reader();
    const tx = new SnapshotSender();
    const rx = new SnapshotReceiver();
    const things: Thing[] = Array.from({ length: 20 }, (_, i) => ({ id: i + 1, kind: 3, x: i * 100, y: 50, dir: 1, health: 65535, flags: 0 }));
    fill(tx.frame, things);
    const full = tx.encode(w, 1).slice();
    const got = rx.read(r, full)!;
    expect(list(got)).toEqual(things);
    tx.ack(got.tick);

    things[3].x += 5;
    things[7].health = 1000;
    fill(tx.frame, things);
    const delta = tx.encode(w, 2).slice();
    expect(delta.length).toBeLessThan(full.length / 5);
    expect(list(rx.read(r, delta))).toEqual(things);
  });

  it('handles removals and new entities', () => {
    const w = new Writer();
    const r = new Reader();
    const tx = new SnapshotSender();
    const rx = new SnapshotReceiver();
    let things: Thing[] = [1, 2, 3].map((id) => ({ id, kind: 1, x: id, y: id, dir: 0, health: 1, flags: 0 }));
    fill(tx.frame, things);
    tx.ack(rx.read(r, tx.encode(w, 1).slice())!.tick);
    things = [things[0], things[2], { id: 9, kind: 2, x: -500000, y: 7, dir: 3, health: 2, flags: 5 }];
    fill(tx.frame, things);
    expect(list(rx.read(r, tx.encode(w, 2).slice()))).toEqual(things);
  });

  it('never exceeds one packet, and catches up over later ticks', () => {
    const w = new Writer();
    const r = new Reader();
    const tx = new SnapshotSender();
    const rx = new SnapshotReceiver();
    const things: Thing[] = Array.from({ length: MAX_SNAPSHOT_ENTITIES }, (_, i) => ({ id: i * 3 + 1, kind: i, x: i * 1e6, y: i ? -i * 1e6 : 0, dir: i & 0xff, health: i * 7, flags: i }));
    fill(tx.frame, things);
    let tick = 0;
    for (let k = 0; k < 6; k++) {
      const msg = tx.encode(w, ++tick);
      expect(msg.length).toBeLessThanOrEqual(MAX_SNAP_BYTES);
      const f = rx.read(r, msg.slice());
      if (f) tx.ack(f.tick);
    }
    expect(list(rx.latest)).toEqual([...things].sort((a, b) => a.id - b.id));
  });

  it('converges under loss, reordering and churn', () => {
    const w = new Writer();
    const r = new Reader();
    const tx = new SnapshotSender();
    const rx = new SnapshotReceiver();
    const rand = rng(3);
    const live = new Map<number, Thing>();
    let nextId = 1;
    let tick = 0;
    const inFlight: Uint8Array[] = [];
    for (let step = 0; step < 600; step++) {
      // The world changes.
      if (live.size < 100 && rand() < 0.3) live.set(nextId, { id: nextId++, kind: 1, x: 0, y: 0, dir: 0, health: 65535, flags: 0 });
      if (live.size && rand() < 0.1) live.delete([...live.keys()][Math.floor(rand() * live.size)]);
      for (const t of live.values()) {
        if (rand() < 0.5) t.x += Math.floor(rand() * 400 - 200);
        if (rand() < 0.1) t.health = Math.floor(rand() * 65535);
      }
      fill(tx.frame, [...live.values()]);
      inFlight.push(tx.encode(w, ++tick).slice());
      // Lose some, deliver the rest out of order.
      while (inFlight.length > 3 || (inFlight.length && rand() < 0.5)) {
        const msg = inFlight.splice(Math.floor(rand() * inFlight.length), 1)[0];
        if (rand() < 0.2) continue;
        const f = rx.read(r, msg);
        if (f && rand() < 0.8) tx.ack(f.tick);
      }
    }
    // A quiet spell: everything arrives.
    for (let k = 0; k < 10; k++) {
      fill(tx.frame, [...live.values()]);
      const f = rx.read(r, tx.encode(w, ++tick).slice());
      if (f) tx.ack(f.tick);
    }
    expect(list(rx.latest)).toEqual([...live.values()].sort((a, b) => a.id - b.id));
  });

  it('drops snapshots built on a frame it does not have', () => {
    const w = new Writer();
    const r = new Reader();
    const tx = new SnapshotSender();
    fill(tx.frame, [{ id: 1, kind: 1, x: 1, y: 1, dir: 0, health: 0, flags: 0 }]);
    tx.encode(w, 1);
    tx.ack(1);
    const delta = tx.encode(w, 2).slice();
    expect(new SnapshotReceiver().read(r, delta)).toBeNull();
  });

  it('never throws on random or mutated bytes', () => {
    const r = new Reader();
    const w = new Writer();
    const rand = rng(11);
    const tx = new SnapshotSender();
    fill(tx.frame, Array.from({ length: 30 }, (_, i) => ({ id: i, kind: 1, x: i, y: i, dir: 0, health: 0, flags: 0 })));
    const good = tx.encode(w, 1).slice();
    for (let i = 0; i < 5000; i++) {
      const rx = new SnapshotReceiver();
      const data = rand() < 0.5 ? good.slice() : new Uint8Array(Math.floor(rand() * 200));
      for (let f = 0; f < 1 + rand() * 6; f++) data[Math.floor(rand() * data.length)] = Math.floor(rand() * 256);
      if (data.length) data[0] = 33;
      expect(() => rx.read(r, data)).not.toThrow();
    }
  });
});
