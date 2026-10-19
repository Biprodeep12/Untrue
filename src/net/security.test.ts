import { schnorr } from '@noble/curves/secp256k1.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { toHex, Writer } from './codec';
import { FakeSwitch, type FakeTransport } from './fake';
import { CTRL, Mode, RejectReason, writeEvent, writeHostClaim, writeIntro } from './protocol';
import { ConnectError, Session, type SessionConfig } from './session';
import { CodeHost, MemoryHub, requestJoin } from './signaling';
import type { Linker } from './transport';

// Peers may be strangers: what one cannot do to the others.

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

const MAP = new Uint8Array(32).fill(9);
const w = new Writer(4096);

interface Player {
  name: string;
  session: Session;
  linker: Linker;
  key: Uint8Array;
  log: string[];
  heard: number;
}

function world(mode: Mode, sw = new FakeSwitch({ latency: 10, openDelay: 20 })) {
  const make = (name: string, host: boolean, over: Partial<SessionConfig> = {}): Player => {
    const { secretKey, publicKey } = schnorr.keygen();
    const linker = sw.linker(name);
    const c: SessionConfig = { mode, gameVersion: '1.0', dimension: mode === Mode.Dimension ? 'hollow' : '', mapHash: MAP, key: publicKey, secret: secretKey, name, linker, ...over };
    const session = host ? Session.host(c) : Session.guest(c);
    const p: Player = { name, session, linker, key: publicKey, log: [], heard: 0 };
    session.on = {
      message: () => p.heard++,
      peerAway: (s) => p.log.push(`away ${s}`),
      peerLeft: (s, why) => p.log.push(`left ${s} ${why}`),
      roleChanged: (role, h) => p.log.push(`role ${role} ${h}`),
      ended: (why) => p.log.push(`ended ${why}`),
    };
    return p;
  };
  return { sw, make };
}

/** Joins as signaling would: `claim` is the key the offer names (the guest's own by default). */
async function join(host: Player, guest: Player, options: { claim?: Uint8Array; expectHost?: Uint8Array } = {}): Promise<{ ok: boolean; reason?: unknown }> {
  const made = await guest.linker.offer();
  const res = await host.session.admit(made.sdp, guest.name, options.claim ?? guest.key);
  if ('reject' in res) {
    made.link.close();
    return { ok: false, reason: res.reject };
  }
  await made.complete(res.answer);
  const settled = guest.session.connect(made.link, { expectHost: options.expectHost }).then(
    () => ({ ok: true }),
    (e: ConnectError) => ({ ok: false, reason: e.reason }),
  );
  await vi.advanceTimersByTimeAsync(500);
  return settled;
}

async function instance(n: number) {
  const ctx = world(Mode.Dimension);
  const host = ctx.make('Host', true);
  const guests: Player[] = [];
  for (let i = 0; i < n; i++) {
    const g = ctx.make(`G${i + 1}`, false);
    expect(await join(host, g)).toEqual({ ok: true });
    guests.push(g);
  }
  await vi.advanceTimersByTimeAsync(500);
  return { ...ctx, host, guests };
}

describe('who is host', () => {
  it('follows no one who claims the host while it is up, nor any far-future claim', async () => {
    const { host, guests, sw } = await instance(3);
    const [g1, g2, g3] = guests;
    // The newest member claims the instance, for the next handover and for a far one.
    g3.session.broadcast(CTRL, writeHostClaim(w, { slot: g3.session.slot, epoch: g3.session.epoch + 1 }));
    g3.session.broadcast(CTRL, writeHostClaim(w, { slot: g3.session.slot, epoch: 0xffffffff }));
    await vi.advanceTimersByTimeAsync(100);
    for (const g of [g1, g2]) expect(g.session.hostSlot).toBe(0);
    // When the host really goes, the longest-connected member takes over, not the claimer.
    sw.drop('Host');
    await vi.advanceTimersByTimeAsync(800);
    expect(g1.session.isHost).toBe(true);
    expect(g2.session.hostSlot).toBe(g1.session.slot);
    expect(g3.session.hostSlot).toBe(g1.session.slot);
    expect(host.session.isHost).toBe(true);
  });

  it('refuses a host that is not the one expected (a stranger who answered a public code)', async () => {
    const { make } = world(Mode.Dimension);
    const impostor = make('Impostor', true);
    const g = make('G', false);
    const real = schnorr.keygen().publicKey;
    expect(await join(impostor, g, { expectHost: real })).toEqual({ ok: false, reason: 'impostor' });
  });

  it('remembers the host it met: a rejoin finds the same one or none', async () => {
    const { make } = world(Mode.Overworld);
    const host = make('Host', true);
    const g = make('G', false);
    expect(await join(host, g)).toEqual({ ok: true });
    expect(g.session.hostKey && toHex(g.session.hostKey)).toBe(toHex(host.key));
    // Another host on the same code is not the one met.
    const other = make('Other', true);
    expect(await join(other, g)).toEqual({ ok: false, reason: 'impostor' });
  });
});

describe('joining', () => {
  it('a returning member skips the question only as themselves', async () => {
    const { make } = world(Mode.Overworld);
    const host = make('Host', true);
    let asked = 0;
    const on = host.session.on;
    host.session.on = { ...on, joinRequest: () => (asked++, true) };
    const friend = make('Friend', false);
    expect(await join(host, friend)).toEqual({ ok: true });
    expect(asked).toBe(1);
    // A stranger names the friend's key (public: the Welcome lists it) to skip the host's question.
    const stranger = make('Stranger', false);
    expect(await join(host, stranger, { claim: friend.key })).toEqual({ ok: false, reason: RejectReason.BadHello });
    expect(asked).toBe(1);
  });

  it('keeps out a player sent away, for the rest of the session', async () => {
    const { make } = world(Mode.Overworld);
    const host = make('Host', true);
    const g = make('G', false);
    expect(await join(host, g)).toEqual({ ok: true });
    host.session.kick(g.session.slot);
    await vi.advanceTimersByTimeAsync(500);
    const again = make('G again', false);
    // The same key, as a new session would bring.
    (again.session as unknown as { cfg: SessionConfig }).cfg.key = g.key;
    (again.session as unknown as { cfg: SessionConfig }).cfg.secret = (g.session as unknown as { cfg: SessionConfig }).cfg.secret;
    expect(await join(host, again, { claim: g.key })).toEqual({ ok: false, reason: RejectReason.Blocked });
  });
});

describe('mesh introductions', () => {
  it('relays only the introductions the host asked for', async () => {
    const { host, guests, sw } = await instance(2);
    const [g1, g2] = guests;
    const toG2 = sw.links.find((t: FakeTransport) => t.owner === 'Host' && t.peer.owner === 'G2')!;
    const before = toG2.sent[CTRL];
    // Offers the host never asked for, from a member to another.
    for (let i = 0; i < 20; i++) g1.session.sendToHost(CTRL, writeIntro(w, { kind: 1, from: g1.session.slot, to: g2.session.slot, sdp: 'v=0 flood' }));
    await vi.advanceTimersByTimeAsync(50);
    expect(toG2.sent[CTRL]).toBe(before);
    expect(host.session.isHost).toBe(true);
  });
});

describe('floods', () => {
  it('drops a flood past a link’s allowance, and cuts a link that keeps flooding', async () => {
    const { host, guests } = await instance(1);
    const [g] = guests;
    const msg = writeEvent(w, { kind: 1, ints: [], text: 'spam' }).slice();
    for (let i = 0; i < 2000; i++) g.session.sendToHost(CTRL, msg);
    await vi.advanceTimersByTimeAsync(200);
    expect(host.heard).toBeLessThanOrEqual(620);
    expect(host.log).toContain(`away ${g.session.slot}`);
  });
});

describe('signed answers', () => {
  const FAST = { iterations: 10 };

  it('only the expected host may answer, or turn a guest away', async () => {
    vi.useRealTimers();
    const hub = new MemoryHub();
    const real = schnorr.keygen();
    const fake = schnorr.keygen();
    const signer = (k: typeof real) => ({ pubkey: toHex(k.publicKey), secret: k.secretKey });
    // A stranger on the public code answers at once, and refuses too; the real host a moment later.
    const impostor = await CodeHost.listen(hub.bus(), 'EEEEEEEE', (o) => {
      void impostor.reject(o.from, RejectReason.Full);
      void impostor.answer(o.from, 'from the impostor');
    }, { ...FAST, signer: signer(fake) });
    const unsigned = await CodeHost.listen(hub.bus(), 'EEEEEEEE', (o) => void unsigned.answer(o.from, 'unsigned'), FAST);
    const host = await CodeHost.listen(hub.bus(), 'EEEEEEEE', (o) => setTimeout(() => void host.answer(o.from, 'from the host'), 30), { ...FAST, signer: signer(real) });
    const answer = await requestJoin(hub.bus(), 'EEEEEEEE', { sdp: 'v=0', name: 'G', key: '' }, { ...FAST, expectHost: toHex(real.publicKey) });
    expect(answer).toBe('from the host');
    for (const h of [impostor, unsigned, host]) h.close();
  });
});
