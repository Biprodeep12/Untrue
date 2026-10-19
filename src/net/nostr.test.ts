import { afterEach, describe, expect, it, vi } from 'vitest';
import { Board, BOARD_KIND, parseNote, type BoardInfo } from './board';
import { Identity, cleanName, type KeyValueStore } from './identity';
import { FakeRelay } from './fakeRelay';
import { newKeypair, RelayPool, signEvent, verifyEvent } from './nostr';

afterEach(() => vi.useRealTimers());

describe('nostr events', () => {
  it('signs events others can verify, and catches tampering', () => {
    const k = newKeypair();
    const e = signEvent(k, 1, [['t', 'x']], 'hello');
    expect(verifyEvent(e)).toBe(true);
    expect(verifyEvent({ ...e, content: 'hellO' })).toBe(false);
    expect(verifyEvent({ ...e, pubkey: newKeypair().pubkey })).toBe(false);
    expect(verifyEvent({ ...e, tags: 'nope' })).toBe(false);
    expect(verifyEvent(null)).toBe(false);
  });
});

describe('relay pool', () => {
  it('publishes, subscribes, drops forgeries, and resubscribes after a reconnect', async () => {
    vi.useFakeTimers();
    const relay = new FakeRelay();
    const pool = new RelayPool(['wss://a', 'wss://b'], () => relay.socket());
    const got: string[] = [];
    pool.subscribe([{ kinds: [1], '#t': ['x'] }], (e) => got.push(e.content));
    const k = newKeypair();
    const ok = pool.publish(signEvent(k, 1, [['t', 'x']], 'one'));
    await vi.advanceTimersByTimeAsync(20);
    await expect(ok).resolves.toBe(true);
    // Both "relays" are the same fake: the event arrives twice, is given once.
    expect(got).toEqual(['one']);
    // A relay passing on a forged event: dropped.
    pool.receive(JSON.stringify(['EVENT', 'u1', { ...signEvent(k, 1, [['t', 'x']], 'two'), content: 'forged' }]));
    expect(got).toEqual(['one']);

    relay.restart();
    await vi.advanceTimersByTimeAsync(2000);
    expect(relay.connects).toBeGreaterThanOrEqual(4);
    void pool.publish(signEvent(k, 1, [['t', 'x']], 'three'));
    await vi.advanceTimersByTimeAsync(20);
    expect(got).toEqual(['one', 'three']);
    pool.close();
  });

  it('ignores junk from relays', () => {
    const pool = new RelayPool([], () => {
      throw new Error('unused');
    });
    for (const junk of ['', 'null', '[]', '["EVENT"]', '["EVENT","u1",{}]', '["OK"]', '{"a":1}', '["EOSE",5]']) expect(() => pool.receive(junk)).not.toThrow();
  });
});

describe('board', () => {
  const info = (over: Partial<BoardInfo> = {}): BoardInfo => ({ instance: 'abc123', dimension: 'hollow', players: 2, capacity: 8, seals: 1, sealsTotal: 3, gameVersion: '1', code: 'K7QF2M9A', name: 'Ana', ...over });

  it('lists live, open, compatible instances of a dimension', async () => {
    vi.useFakeTimers();
    const relay = new FakeRelay();
    const pool = new RelayPool(['wss://a'], () => relay.socket());
    const ana = new Board(pool, newKeypair());
    const bo = new Board(pool, newKeypair());
    const old = new Board(pool, newKeypair());
    const full = new Board(pool, newKeypair());
    ana.startHosting(() => info());
    bo.startHosting(() => info({ instance: 'b', players: 5, name: 'Bo' }));
    old.startHosting(() => info({ instance: 'c', gameVersion: '0' }));
    full.startHosting(() => info({ instance: 'd', players: 8 }));
    new Board(pool, newKeypair()).startHosting(() => info({ instance: 'e', dimension: 'other' }));
    await vi.advanceTimersByTimeAsync(50);
    const found = ana.query('hollow', '1', () => false);
    await vi.advanceTimersByTimeAsync(1000);
    const list = await found;
    // In no set order (made-up notes cannot buy the top), one per host.
    expect(list.map((e) => e.name).sort()).toEqual(['Ana', 'Bo']);
    expect(list.find((e) => e.name === 'Ana')!.code).toBe('K7QF2M9A');

    // Blocked hosts are skipped; a host that stops is gone at once.
    const bob = list.find((e) => e.name === 'Bo')!.host;
    const stopped = ana.stopHosting();
    await vi.advanceTimersByTimeAsync(50);
    await stopped;
    const again = bo.query('hollow', '1', (h) => h === bob);
    await vi.advanceTimersByTimeAsync(1000);
    expect((await again).length).toBe(0);

    // Notes expire unless renewed.
    for (const b of [bo, old, full]) b.close();
    await vi.advanceTimersByTimeAsync(200_000);
    const later = bo.query('hollow', '1', () => false);
    await vi.advanceTimersByTimeAsync(1000);
    expect(await later).toEqual([]);
    pool.close();
  });

  it('refuses malformed notes, and notes claiming what no host could', () => {
    const k = newKeypair();
    const now = Math.floor(Date.now() / 1000);
    const note = (over: Record<string, unknown> = {}, exp = now + 180, at = now) =>
      signEvent(k, BOARD_KIND, [['d', 'x'], ['t', 'untrue-dim-hollow'], ['expiration', String(exp)]], JSON.stringify({ v: 1, players: 1, cap: 8, seals: 0, of: 3, ver: '1', code: 'K7QF-2M9A', name: 'A', ...over }), at);
    const good = note();
    expect(parseNote(good, now)?.code).toBe('K7QF2M9A');
    // Room no instance has, more players than room, a time ahead of now, a life too long.
    expect(parseNote(note({ cap: 255 }), now)).toBeNull();
    expect(parseNote(note({ players: 8, cap: 4 }), now)).toBeNull();
    expect(parseNote(note({}, now + 4000, now + 3600), now)).toBeNull();
    expect(parseNote(note({}, now + 99_999), now)).toBeNull();
    for (const content of ['{', '{"v":2}', JSON.stringify({ v: 1, players: -1, cap: 8, seals: 0, of: 3, ver: '1', code: 'K7QF2M9A', name: 'A' }), JSON.stringify({ v: 1, players: 1, cap: 8, seals: 0, of: 3, ver: '1', code: 'nope', name: 'A' })]) {
      expect(parseNote({ ...good, content }, now)).toBeNull();
    }
    expect(parseNote({ ...good, tags: [['d', 'x']] }, now)).toBeNull();
  });
});

describe('identity', () => {
  it('keeps one key and a block list, and copes without storage', () => {
    const data = new Map<string, string>();
    const storage: KeyValueStore = { getItem: (k) => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v) };
    const a = new Identity(storage);
    const b = new Identity(storage);
    expect(b.keys.pubkey).toBe(a.keys.pubkey);
    a.block('f'.repeat(64));
    expect(new Identity(storage).isBlocked('f'.repeat(64))).toBe(true);
    a.name = '  Ana‮\u0000 the\nBold  ';
    expect(new Identity(storage).name).toBe('Ana the Bold');
    const broken: KeyValueStore = {
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => {
        throw new Error('denied');
      },
    };
    expect(() => new Identity(broken).block('a'.repeat(64))).not.toThrow();
    expect(new Identity(null).keys.pubkey).toMatch(/^[0-9a-f]{64}$/);
    expect(cleanName('x'.repeat(40)).length).toBe(24);
  });

  it('gives each tab of one browser its own key, kept across a reload of that tab', async () => {
    const shared = new Map<string, string>();
    const local: KeyValueStore = { getItem: (k) => shared.get(k) ?? null, setItem: (k, v) => void shared.set(k, v) };
    const tabStore = () => {
      const data = new Map<string, string>();
      return { data, store: { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v) } as KeyValueStore };
    };
    // One browser's locks: held until released (a tab closing).
    const held = new Set<string>();
    const lockManager = {
      request: async (name: string, _o: { ifAvailable: boolean }, cb: (lock: unknown) => unknown) => {
        if (held.has(name)) return cb(null);
        held.add(name);
        return cb({ name });
      },
    };
    const tab1 = tabStore();
    const tab2 = tabStore();
    const first = new Identity(local, tab1.store, lockManager);
    await first.claim();
    const second = new Identity(local, tab2.store, lockManager);
    await second.claim();
    // The first tab is the browser's player; the second is someone else, named for its own key.
    expect(first.keys.pubkey).toBe(new Identity(local, null, null).keys.pubkey);
    expect(second.keys.pubkey).not.toBe(first.keys.pubkey);
    expect(second.name).not.toBe(first.name);
    // The second tab reloads: its old page let go of its lock, and it keeps its key.
    held.delete('untrue.net.id:' + second.keys.pubkey);
    const reloaded = new Identity(local, tab2.store, lockManager);
    await reloaded.claim();
    expect(reloaded.keys.pubkey).toBe(second.keys.pubkey);
    // A duplicate of that tab comes with a copy of its storage, but not its lock: a new key.
    const copy = tabStore();
    for (const [k, v] of tab2.data) copy.data.set(k, v);
    const duplicate = new Identity(local, copy.store, lockManager);
    await duplicate.claim();
    expect(new Set([first, reloaded, duplicate].map((i) => i.keys.pubkey)).size).toBe(3);
    // A chosen name is shared by every tab.
    first.name = 'Ana';
    expect(new Identity(local, tab1.store, lockManager).name).toBe('Ana');
  });
});
