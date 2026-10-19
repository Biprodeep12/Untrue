import { describe, expect, it } from 'vitest';
import { fromHex, Reader, toHex, Writer } from './codec';
import {
  Action,
  MAX_SNAP_BYTES,
  Mode,
  Msg,
  newPlayerState,
  readAck,
  readChallenge,
  readEvent,
  readHandoff,
  readHello,
  readHostClaim,
  readIntro,
  readMemberJoined,
  readPeerHello,
  readPing,
  readPlayerState,
  readReject,
  readRequest,
  readResponse,
  readRunState,
  readSlotMsg,
  readWelcome,
  RejectReason,
  writeAck,
  writeChallenge,
  writeEvent,
  writeHandoff,
  writeHello,
  writeHostClaim,
  writeIntro,
  writeMemberJoined,
  writePeerHello,
  writePing,
  writePlayerState,
  writePong,
  writeReject,
  writeRequest,
  writeResponse,
  writeRunState,
  writeSlotMsg,
  writeWelcome,
  type RunState,
} from './protocol';

const key = (n: number) => new Uint8Array(32).fill(n);
const copy = (b: Uint8Array) => b.slice();

/** A seeded generator, so fuzz failures can be replayed. */
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

const run: RunState = {
  version: 7,
  trials: [2, 1, 0],
  bossOpen: true,
  bossHealth: 0.5,
  bossPhase: 2,
  bossAlive: true,
  summons: 3,
  bossReturnsAt: 123456.5,
  contributions: [
    { key: key(1), score: 120.5, attuned: true, claimed: false },
    { key: key(2), score: 3, attuned: false, claimed: true },
  ],
  extra: new Uint8Array([9, 8, 7]),
};

/** One valid example of every message, as bytes. */
function samples(): Uint8Array[] {
  const w = new Writer(64);
  const ps = { ...newPlayerState(), slot: 3, tick: 99, x: -12.5, y: 40000.25, facing: 2, anim: 5, health: 0.75, holding: 17, flags: 3 };
  return [
    copy(writeHello(w, { protocol: 1, gameVersion: '0.1.0', mode: Mode.Dimension, dimension: 'hollow', mapHash: key(4), key: key(5), name: 'Ana', sig: new Uint8Array(64).fill(6) })),
    copy(writeWelcome(w, { slot: 2, hostSlot: 0, epoch: 3, hostTime: 1000.5, resumed: true, members: [{ slot: 0, key: key(1), name: 'Host', order: 0 }, { slot: 2, key: key(2), name: 'Bo', order: 4 }] })),
    copy(writeReject(w, RejectReason.Full)),
    copy(writePing(w, 5, 1234.5)),
    copy(writePong(w, 5, 1234.5, 99)),
    copy(writeMemberJoined(w, { slot: 4, key: key(3), name: 'Cy', order: 9 })),
    copy(writeSlotMsg(w, Msg.MemberLeft, 4)),
    copy(writeSlotMsg(w, Msg.MemberAway, 4)),
    copy(writeIntro(w, { kind: 1, from: 2, to: 3, sdp: 'v=0\r\nfake' })),
    copy(writePeerHello(w, 2, key(2))),
    copy(writeHostClaim(w, { slot: 2, epoch: 4 })),
    copy(writeHandoff(w, { successor: 2, epoch: 4 })),
    copy(writeRunState(w, run)),
    copy(writeChallenge(w, { nonce: key(7), hostKey: key(1), hostSig: new Uint8Array(64).fill(9) })),
    copy(writePlayerState(w, ps)),
    copy(writeAck(w, 77)),
    copy(writeEvent(w, { kind: 12, ints: [1, -2, 3], text: 'hi' })),
    copy(writeRequest(w, { id: 4, action: Action.OpenChest, target: 77, x: 1.5, y: -2.25, arg: 3 })),
    copy(writeResponse(w, { id: 4, ok: false, code: 2 })),
  ];
}

/** Every decoder, on any bytes. */
function decodeAll(r: Reader, data: Uint8Array): unknown[] {
  const ps = newPlayerState();
  const ping = { seq: 0, sent: 0, reply: 0 };
  return [
    readHello(r, data),
    readWelcome(r, data),
    readReject(r, data),
    readPing(r, data, ping),
    readMemberJoined(r, data),
    readSlotMsg(r, data),
    readIntro(r, data),
    readPeerHello(r, data),
    readHostClaim(r, data),
    readHandoff(r, data),
    readRunState(r, data),
    readChallenge(r, data),
    readPlayerState(r, data, ps),
    readAck(r, data),
    readEvent(r, data),
    readRequest(r, data),
    readResponse(r, data),
  ];
}

describe('codec', () => {
  it('writes and reads every kind of value', () => {
    const w = new Writer(4);
    w.reset().u8(255).bool(true).u16(65535).i16(-5).u32(4e9).i32(-7).f32(1.5).f64(Math.PI).str('héllo').longStr('x'.repeat(3000)).bytes(new Uint8Array([1, 2]));
    const r = new Reader().reset(w.finish());
    expect([r.u8(), r.bool(), r.u16(), r.i16(), r.u32(), r.i32(), r.f32(), r.f64(), r.str(), r.longStr().length, [...r.bytes()]]).toEqual([255, true, 65535, -5, 4e9, -7, 1.5, Math.PI, 'héllo', 3000, [1, 2]]);
    expect(r.done).toBe(true);
  });

  it('fails instead of throwing past the end, and on bad values', () => {
    const r = new Reader().reset(new Uint8Array([1]));
    expect(r.u32()).toBe(0);
    expect(r.ok).toBe(false);
    const w = new Writer();
    expect(new Reader().reset(w.reset().f64(NaN).finish()).f64()).toBe(0);
    expect(new Reader().reset(w.reset().u8(2).finish()).bool()).toBe(false);
  });

  it('cuts long strings at a character boundary', () => {
    const w = new Writer();
    const s = 'é'.repeat(200);
    const out = new Reader().reset(w.reset().str(s).finish()).str();
    expect(out).toBe('é'.repeat(127));
  });

  it('converts hex both ways', () => {
    expect(toHex(fromHex('00ff10')!)).toBe('00ff10');
    expect(fromHex('abc')).toBeNull();
    expect(fromHex('zz')).toBeNull();
  });
});

describe('protocol', () => {
  it('round-trips every message', () => {
    const r = new Reader();
    const [hello, welcome, reject, ping, pong, joined, left, away, intro, peerHello, claim, handoff, runState, challenge, player, ack, event, request, response] = samples();
    expect(readHello(r, hello)).toMatchObject({ gameVersion: '0.1.0', mode: Mode.Dimension, dimension: 'hollow', name: 'Ana' });
    expect(readWelcome(r, welcome)?.members.map((m) => m.name)).toEqual(['Host', 'Bo']);
    expect(readReject(r, reject)).toBe(RejectReason.Full);
    const p = { seq: 0, sent: 0, reply: 0 };
    expect(readPing(r, ping, p) && p.seq === 5 && p.sent === 1234.5).toBe(true);
    expect(readPing(r, pong, p) && p.reply === 99).toBe(true);
    expect(readMemberJoined(r, joined)?.order).toBe(9);
    expect([readSlotMsg(r, left), readSlotMsg(r, away)]).toEqual([4, 4]);
    expect(readIntro(r, intro)).toEqual({ kind: 1, from: 2, to: 3, sdp: 'v=0\r\nfake' });
    expect(readPeerHello(r, peerHello)?.slot).toBe(2);
    expect(readHostClaim(r, claim)).toEqual({ slot: 2, epoch: 4 });
    expect(readHandoff(r, handoff)).toEqual({ successor: 2, epoch: 4 });
    const rs = readRunState(r, runState)!;
    expect(rs.trials).toEqual([2, 1, 0]);
    expect(rs.bossHealth).toBeCloseTo(0.5, 4);
    expect(rs.contributions.map((c) => [c.score, c.attuned, c.claimed])).toEqual([
      [120.5, true, false],
      [3, false, true],
    ]);
    expect([...rs.extra]).toEqual([9, 8, 7]);
    expect(readChallenge(r, challenge)?.nonce).toEqual(key(7));
    const ps = newPlayerState();
    expect(readPlayerState(r, player, ps)).toBe(true);
    expect(ps).toMatchObject({ slot: 3, tick: 99, x: -12.5, y: 40000.25, facing: 2, anim: 5, holding: 17, flags: 3 });
    expect(ps.health).toBeCloseTo(0.75, 4);
    expect(player.length).toBe(21);
    expect(readAck(r, ack)).toBe(77);
    expect(readEvent(r, event)).toEqual({ kind: 12, ints: [1, -2, 3], text: 'hi' });
    expect(readRequest(r, request)).toEqual({ id: 4, action: Action.OpenChest, target: 77, x: 1.5, y: -2.25, arg: 3 });
    expect(readResponse(r, response)).toEqual({ id: 4, ok: false, code: 2 });
  });

  it('keeps snap messages within one packet', () => {
    for (const m of samples()) if (m[0] === Msg.PlayerState || m[0] === Msg.Ack) expect(m.length).toBeLessThanOrEqual(MAX_SNAP_BYTES);
  });

  it('refuses every message cut short or with a byte added', () => {
    const r = new Reader();
    for (const m of samples()) {
      for (let n = 0; n < m.length; n++) expect(decodeAll(r, m.subarray(0, n)).every((v) => v === null || v === false)).toBe(true);
      const longer = new Uint8Array(m.length + 1);
      longer.set(m);
      expect(decodeAll(r, longer).every((v) => v === null || v === false)).toBe(true);
    }
  });

  it('never throws on random bytes', () => {
    const r = new Reader();
    const rand = rng(42);
    for (let i = 0; i < 20000; i++) {
      const data = new Uint8Array(Math.floor(rand() * 80));
      for (let j = 0; j < data.length; j++) data[j] = Math.floor(rand() * 256);
      // Sometimes a real type byte, so decoders get past the first check.
      if (data.length && rand() < 0.7) data[0] = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 14, 15, 32, 34, 35, 36, 37][Math.floor(rand() * 19)];
      expect(() => decodeAll(r, data)).not.toThrow();
    }
  });

  it('never throws on mutated valid messages', () => {
    const r = new Reader();
    const rand = rng(7);
    for (const m of samples()) {
      for (let i = 0; i < 500; i++) {
        const data = m.slice();
        const flips = 1 + Math.floor(rand() * 4);
        for (let f = 0; f < flips; f++) data[Math.floor(rand() * data.length)] = Math.floor(rand() * 256);
        expect(() => decodeAll(r, data)).not.toThrow();
      }
    }
  });
});
