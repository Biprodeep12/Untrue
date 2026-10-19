import { schnorr } from '@noble/curves/secp256k1.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Writer } from './codec';
import { FakeSwitch, type FakeTransport } from './fake';
import { CTRL, Mode, Msg, readEvent, RejectReason, SNAP, writeEvent, type RunState } from './protocol';
import { Reader } from './codec';
import { ConnectError, Session, type SessionConfig } from './session';
import type { Linker } from './transport';

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

const MAP = new Uint8Array(32).fill(9);

interface Player {
  name: string;
  session: Session;
  linker: Linker;
  key: Uint8Array;
  secret: Uint8Array;
  /** What the game heard. */
  heard: Array<{ from: number; text: string }>;
  log: string[];
}

function world(mode: Mode = Mode.Overworld, sw = new FakeSwitch({ latency: 10, openDelay: 20 })) {
  const players: Player[] = [];
  const cfg = (name: string, linker: Linker, key: Uint8Array, secret: Uint8Array, over: Partial<SessionConfig>): SessionConfig => ({
    mode,
    gameVersion: '1.0',
    dimension: mode === Mode.Dimension ? 'hollow' : '',
    mapHash: MAP,
    key,
    secret,
    name,
    linker,
    ...over,
  });
  const make = (name: string, host: boolean, over: Partial<SessionConfig> = {}): Player => {
    const { secretKey, publicKey } = schnorr.keygen();
    const linker = sw.linker(name);
    const c = cfg(name, linker, publicKey, secretKey, over);
    const session = host ? Session.host(c) : Session.guest(c);
    const p: Player = { name, session, linker, key: publicKey, secret: secretKey, heard: [], log: [] };
    const r = new Reader();
    session.on = {
      message: (from, _ch, data) => {
        const e = readEvent(r, data);
        if (e) p.heard.push({ from, text: e.text });
      },
      peerJoined: (m) => p.log.push(`joined ${m.name}`),
      peerLeft: (s, why) => p.log.push(`left ${s} ${why}`),
      peerAway: (s) => p.log.push(`away ${s}`),
      peerBack: (m) => p.log.push(`back ${m.name}`),
      roleChanged: (role, h) => p.log.push(`role ${role} ${h}`),
      ended: (why) => p.log.push(`ended ${why}`),
    };
    players.push(p);
    return p;
  };
  return { sw, make, players };
}

/** Joins `guest` to `host` (as signaling would), and returns how it went. */
async function join(host: Player, guest: Player, wait = 300): Promise<{ ok: boolean; reason?: unknown }> {
  const made = await guest.linker.offer();
  const res = await host.session.admit(made.sdp, guest.name, guest.key);
  if ('reject' in res) {
    made.link.close();
    return { ok: false, reason: res.reject };
  }
  await made.complete(res.answer);
  const settled = guest.session.connect(made.link).then(
    () => ({ ok: true }),
    (e: ConnectError) => ({ ok: false, reason: e.reason }),
  );
  await vi.advanceTimersByTimeAsync(wait);
  return settled;
}

const w = new Writer();
const say = (text: string) => writeEvent(w, { kind: 1, ints: [], text }).slice();

describe('overworld sessions', () => {
  it('lets friends join, talk and see each other', async () => {
    const { make } = world();
    const host = make('Host', true);
    const ana = make('Ana', false);
    const bo = make('Bo', false);
    expect(await join(host, ana)).toEqual({ ok: true });
    expect(await join(host, bo)).toEqual({ ok: true });
    expect(host.session.members().map((m) => m.name)).toEqual(['Host', 'Ana', 'Bo']);
    expect(ana.session.members().map((m) => m.name)).toEqual(['Host', 'Ana', 'Bo']);
    expect(ana.log).toContain('joined Bo');
    expect(ana.session.slot).not.toBe(bo.session.slot);

    ana.session.sendToHost(CTRL, say('hi host'));
    host.session.broadcast(SNAP, say('hi all'));
    await vi.advanceTimersByTimeAsync(50);
    expect(host.heard).toEqual([{ from: ana.session.slot, text: 'hi host' }]);
    expect(ana.heard).toEqual([{ from: 0, text: 'hi all' }]);
    expect(bo.heard).toEqual([{ from: 0, text: 'hi all' }]);
    // In the overworld a guest reaches only the host.
    ana.session.broadcast(CTRL, say('to everyone'));
    await vi.advanceTimersByTimeAsync(50);
    expect(bo.heard.length).toBe(1);
  });

  it('keeps a shared clock', async () => {
    const { make } = world();
    const host = make('Host', true);
    const ana = make('Ana', false);
    await join(host, ana);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(Math.abs(ana.session.time() - host.session.time())).toBeLessThan(15);
    expect(ana.session.rttTo(0)).toBeGreaterThan(10);
  });

  it('refuses when full, declined, blocked, or on another version', async () => {
    const { make } = world();
    const host = make('Host', true, { capacity: 2 });
    const ana = make('Ana', false);
    const bo = make('Bo', false);
    expect(await join(host, ana)).toEqual({ ok: true });
    expect(await join(host, bo)).toEqual({ ok: false, reason: RejectReason.Full });

    const host2 = make('Host2', true, { isBlocked: (k) => k[0] === cy.key[0] && k[1] === cy.key[1] });
    host2.session.on.joinRequest = (name) => name !== 'Dee';
    const cy = make('Cy', false);
    const dee = make('Dee', false);
    const old = make('Old', false, { gameVersion: '0.9' });
    expect(await join(host2, cy)).toEqual({ ok: false, reason: RejectReason.Blocked });
    expect(await join(host2, dee)).toEqual({ ok: false, reason: RejectReason.Declined });
    expect(await join(host2, old)).toEqual({ ok: false, reason: RejectReason.GameVersion });
    expect(host2.session.peers.size).toBe(0);
  });

  it('refuses a Hello signed with the wrong key', async () => {
    const { make } = world();
    const host = make('Host', true);
    const ana = make('Ana', false);
    await join(host, ana);
    // Mallory names Ana's (public) key but cannot sign for it.
    const mallory = make('Mallory', false, { key: ana.key });
    expect(await join(host, mallory)).toEqual({ ok: false, reason: RejectReason.BadHello });
    expect(host.session.members().length).toBe(2);
  });

  it('holds a dropped guest’s slot, and gives it back on rejoining', async () => {
    const { make, sw } = world();
    const host = make('Host', true, { reconnectMs: 5000 });
    const ana = make('Ana', false, { reconnectMs: 5000 });
    await join(host, ana);
    const slot = ana.session.slot;
    let lost = 0;
    ana.session.on.hostLost = () => lost++;
    sw.drop('Ana');
    await vi.advanceTimersByTimeAsync(100);
    expect(host.log).toContain(`away ${slot}`);
    expect(lost).toBe(1);
    expect(await join(host, ana)).toEqual({ ok: true });
    expect(ana.session.slot).toBe(slot);
    expect(host.log).toContain('back Ana');
    // Gone for good after the window.
    sw.drop('Ana');
    await vi.advanceTimersByTimeAsync(6000);
    expect(host.log).toContain(`left ${slot} timeout`);
    expect(ana.log).toContain('ended lost');
  });

  it('ends for everyone when the host leaves, and kicks', async () => {
    const { make } = world();
    const host = make('Host', true);
    const ana = make('Ana', false);
    const bo = make('Bo', false);
    await join(host, ana);
    await join(host, bo);
    host.session.kick(bo.session.slot);
    await vi.advanceTimersByTimeAsync(100);
    expect(bo.log).toContain('ended kicked');
    expect(ana.log).toContain(`left ${bo.session.slot} left`);
    host.session.leave();
    await vi.advanceTimersByTimeAsync(100);
    expect(ana.log).toContain('ended host-left');
  });
});

describe('dimension instances', () => {
  const runState = (version: number): RunState => ({
    version,
    trials: [2, 2, 1],
    bossOpen: false,
    bossHealth: 1,
    bossPhase: 0,
    bossAlive: true,
    summons: 0,
    bossReturnsAt: 0,
    contributions: [],
    extra: new Uint8Array(0),
  });

  async function instance(n: number) {
    const ctx = world(Mode.Dimension);
    const host = ctx.make('Host', true);
    const guests: Player[] = [];
    for (let i = 0; i < n; i++) {
      const g = ctx.make(`G${i + 1}`, false);
      expect(await join(host, g, 500)).toEqual({ ok: true });
      guests.push(g);
    }
    await vi.advanceTimersByTimeAsync(500);
    return { ...ctx, host, guests };
  }

  /** True if every member has a working link to every other. */
  function fullMesh(players: Player[]): boolean {
    for (const p of players) {
      for (const q of players) {
        if (p === q) continue;
        const peer = p.session.peers.get(q.session.slot);
        if (!peer?.link?.open) return false;
      }
    }
    return true;
  }

  it('refuses a different map', async () => {
    const { make } = world(Mode.Dimension);
    const host = make('Host', true);
    const odd = make('Odd', false, { mapHash: new Uint8Array(32).fill(1) });
    expect(await join(host, odd)).toEqual({ ok: false, reason: RejectReason.MapMismatch });
  });

  it('links every member to every other, through the host', async () => {
    const { host, guests } = await instance(3);
    expect(fullMesh([host, ...guests])).toBe(true);
    const [a, b] = guests;
    a.session.send(b.session.slot, CTRL, say('direct'));
    await vi.advanceTimersByTimeAsync(50);
    expect(b.heard).toEqual([{ from: a.session.slot, text: 'direct' }]);
    expect(host.heard).toEqual([]);
  });

  it('carries on under the longest-connected member when the host drops', async () => {
    const { host, guests, sw, make } = await instance(3);
    host.session.setRunState(runState(5));
    await vi.advanceTimersByTimeAsync(100);
    const [g1, g2, g3] = guests;
    sw.drop('Host');
    await vi.advanceTimersByTimeAsync(500);
    expect(g1.session.isHost).toBe(true);
    for (const g of [g2, g3]) {
      expect(g.session.hostSlot).toBe(g1.session.slot);
      expect(g.session.isHost).toBe(false);
      expect(g.session.epoch).toBe(2);
      expect(g.session.peers.has(0)).toBe(false);
    }
    expect(g1.session.runState?.version).toBe(5);
    expect(g1.log).toContain(`role host ${g1.session.slot}`);
    // The new host admits newcomers and introduces them to everyone.
    const g4 = make('G4', false);
    expect(await join(g1, g4, 500)).toEqual({ ok: true });
    await vi.advanceTimersByTimeAsync(500);
    expect(fullMesh([g1, g2, g3, g4])).toBe(true);
    expect(g4.session.runState?.version).toBe(5);
  });

  it('passes over a successor that is gone too', async () => {
    const { host, guests, sw } = await instance(3);
    const [g1, g2, g3] = guests;
    sw.drop('Host');
    sw.drop('G1');
    await vi.advanceTimersByTimeAsync(8000);
    expect(g2.session.isHost).toBe(true);
    expect(g3.session.hostSlot).toBe(g2.session.slot);
    expect(host.session.isHost).toBe(true);
    expect(g1.session.ended).toBeNull();
  });

  it('hands off when the host leaves on purpose', async () => {
    const { host, guests } = await instance(2);
    const [g1, g2] = guests;
    host.session.leave();
    await vi.advanceTimersByTimeAsync(500);
    expect(g1.session.isHost).toBe(true);
    expect(g2.session.hostSlot).toBe(g1.session.slot);
    expect(g2.log).not.toContain('ended host-left');
  });

  it('does not split when one member loses only its link to a live host', async () => {
    const { host, guests, sw } = await instance(2);
    const [g1, g2] = guests;
    // Only the G1–host link breaks.
    const link = sw.links.find((t: FakeTransport) => t.owner === 'G1' && t.peer.owner === 'Host')!;
    link.cut();
    await vi.advanceTimersByTimeAsync(500);
    expect(host.session.isHost).toBe(true);
    expect(host.log).toContain(`away ${g1.session.slot}`);
    expect(g2.session.hostSlot).toBe(0);
    expect(g2.session.isHost).toBe(false);
  });

  it('drops a type it does not know, and messages over the size limits', async () => {
    const { host, guests } = await instance(1);
    const [g] = guests;
    const big = new Uint8Array(2000);
    big[0] = Msg.Event;
    g.session.sendToHost(SNAP, big);
    g.session.sendToHost(CTRL, new Uint8Array([200, 1, 2]));
    await vi.advanceTimersByTimeAsync(100);
    expect(host.heard).toEqual([]);
  });
});
