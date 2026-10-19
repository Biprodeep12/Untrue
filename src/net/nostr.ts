// A minimal Nostr client (NIP-01): signed events, and a pool of public relays
// reached over WebSocket. Used only to find other players: encrypted join
// offers and answers (ephemeral events relays never store) and the board of
// open dimension instances (addressable notes that expire, NIP-40). Nothing of
// the game itself travels here.
//
// Every relay in the pool gets every publish and subscription; the first to
// answer wins, and duplicates are dropped by event id. Relays reconnect with
// backoff. Incoming events are checked (shape, id, signature) before use:
// relays are strangers.

import { schnorr } from '@noble/curves/secp256k1.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { fromHex, toHex } from './codec';

/** Public relays, chosen for being long-running and free. All must be in the CSP's connect-src. */
export const DEFAULT_RELAYS = [
  'wss://relay.damus.io',
  'wss://nos.lol',
  'wss://relay.primal.net',
  'wss://relay.nostr.band',
  'wss://nostr.mom',
  'wss://offchain.pub',
];

export interface NostrEvent {
  id: string;
  pubkey: string;
  created_at: number;
  kind: number;
  tags: string[][];
  content: string;
  sig: string;
}

export interface Filter {
  kinds?: number[];
  authors?: string[];
  since?: number;
  until?: number;
  limit?: number;
  /** Tag filters, e.g. `'#t': ['topic']`. */
  [tag: `#${string}`]: string[];
}

/** Longest event content accepted, in characters. */
const MAX_CONTENT = 64 * 1024;
/** Longest relay message accepted, in characters. */
const MAX_FRAME = 128 * 1024;
const HEX64 = /^[0-9a-f]{64}$/;
const HEX128 = /^[0-9a-f]{128}$/;
const enc = new TextEncoder();

export interface Keypair {
  secret: Uint8Array;
  /** x-only public key, hex. */
  pubkey: string;
}

export function newKeypair(): Keypair {
  const secret = schnorr.utils.randomSecretKey();
  return { secret, pubkey: toHex(schnorr.getPublicKey(secret)) };
}

export function keypairFrom(secret: Uint8Array): Keypair {
  return { secret, pubkey: toHex(schnorr.getPublicKey(secret)) };
}

function eventHash(pubkey: string, created_at: number, kind: number, tags: string[][], content: string): Uint8Array {
  return sha256(enc.encode(JSON.stringify([0, pubkey, created_at, kind, tags, content])));
}

/** Signs an event with `key`. */
export function signEvent(key: Keypair, kind: number, tags: string[][], content: string, created_at = Math.floor(Date.now() / 1000)): NostrEvent {
  const hash = eventHash(key.pubkey, created_at, kind, tags, content);
  return { id: toHex(hash), pubkey: key.pubkey, created_at, kind, tags, content, sig: toHex(schnorr.sign(hash, key.secret)) };
}

/** True if `e` is a well-formed event whose id and signature are right. */
export function verifyEvent(e: unknown): e is NostrEvent {
  if (!e || typeof e !== 'object') return false;
  const v = e as Record<string, unknown>;
  if (typeof v.id !== 'string' || !HEX64.test(v.id)) return false;
  if (typeof v.pubkey !== 'string' || !HEX64.test(v.pubkey)) return false;
  if (typeof v.sig !== 'string' || !HEX128.test(v.sig)) return false;
  if (typeof v.created_at !== 'number' || !Number.isInteger(v.created_at) || v.created_at < 0) return false;
  if (typeof v.kind !== 'number' || !Number.isInteger(v.kind) || v.kind < 0 || v.kind > 65535) return false;
  if (typeof v.content !== 'string' || v.content.length > MAX_CONTENT) return false;
  if (!Array.isArray(v.tags) || v.tags.length > 64) return false;
  for (const t of v.tags) {
    if (!Array.isArray(t) || t.length > 16 || !t.every((x) => typeof x === 'string' && x.length <= 1024)) return false;
  }
  const hash = eventHash(v.pubkey, v.created_at, v.kind, v.tags as string[][], v.content);
  if (toHex(hash) !== v.id) return false;
  try {
    return schnorr.verify(fromHex(v.sig)!, hash, fromHex(v.pubkey)!);
  } catch {
    return false;
  }
}

/** The first value of a tag, if the event has it. */
export function tagValue(e: NostrEvent, name: string): string | undefined {
  for (const t of e.tags) if (t[0] === name) return t[1];
  return undefined;
}

/** What the pool needs of a WebSocket (so tests can give it a fake). */
export interface SocketLike {
  readonly readyState: number;
  send(data: string): void;
  close(): void;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: unknown) => void) | null;
  onerror: ((ev: unknown) => void) | null;
}
export type SocketFactory = (url: string) => SocketLike;

const OPEN = 1;
const BACKOFF_MIN = 1000;
const BACKOFF_MAX = 30_000;
/** Messages held for a relay while it connects. */
const MAX_QUEUE = 64;
const PUBLISH_TIMEOUT = 6000;
/** Sockets with nothing to do are closed after this long, in ms. */
const IDLE_MS = 20_000;
/** Signatures checked per subscription per second, at most: a relay sending
 *  junk cannot make this page spend its time verifying it. */
const VERIFY_RATE = 40;

interface Sub {
  id: string;
  filters: Filter[];
  onEvent: (e: NostrEvent) => void;
  onEose?: () => void;
  eosed: boolean;
  /** Event ids already given to this subscription. */
  seen: Set<string>;
  /** Signature checks left this second, and when the second began. */
  verifies: number;
  second: number;
}

/** True if an event could match one of the filters (kinds and tags), checked
 *  before its signature is: a cheap way to drop what was never asked for. */
function couldMatch(e: NostrEvent, filters: readonly Filter[]): boolean {
  if (!Array.isArray(e.tags) || typeof e.kind !== 'number') return false;
  for (const f of filters) {
    if (f.kinds && !f.kinds.includes(e.kind)) continue;
    let ok = true;
    for (const name of Object.keys(f)) {
      if (name[0] !== '#') continue;
      const want = f[name as `#${string}`];
      const tag = name.slice(1);
      if (!e.tags.some((t) => Array.isArray(t) && t[0] === tag && want.includes(t[1]))) {
        ok = false;
        break;
      }
    }
    if (ok) return true;
  }
  return false;
}

class Relay {
  private ws: SocketLike | null = null;
  private backoff = BACKOFF_MIN;
  private retry: ReturnType<typeof setTimeout> | undefined;
  private readonly queue: string[] = [];
  private closed = false;

  constructor(
    readonly url: string,
    private readonly factory: SocketFactory,
    private readonly pool: RelayPool,
  ) {}

  private connect(): void {
    if (this.closed || this.ws) return;
    let ws: SocketLike;
    try {
      ws = this.factory(this.url);
    } catch {
      this.scheduleRetry();
      return;
    }
    this.ws = ws;
    ws.onopen = () => {
      this.backoff = BACKOFF_MIN;
      // Subscriptions live on: send them again after every reconnect.
      for (const sub of this.pool.subs.values()) ws.send(JSON.stringify(['REQ', sub.id, ...sub.filters]));
      for (const m of this.queue.splice(0)) ws.send(m);
    };
    ws.onmessage = (ev) => {
      if (typeof ev.data === 'string' && ev.data.length <= MAX_FRAME) this.pool.receive(ev.data);
    };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      // Back only while there is something to do: idle, it stays closed.
      if (!this.pool.idle || this.queue.length) this.scheduleRetry();
    };
    ws.onerror = () => {
      // A close follows.
    };
  }

  private scheduleRetry(): void {
    if (this.closed || this.retry) return;
    const wait = this.backoff * (0.75 + Math.random() * 0.5);
    this.backoff = Math.min(BACKOFF_MAX, this.backoff * 2);
    this.retry = setTimeout(() => {
      this.retry = undefined;
      this.connect();
    }, wait);
  }

  send(message: string): void {
    if (this.closed) return;
    if (this.ws?.readyState === OPEN) {
      try {
        this.ws.send(message);
        return;
      } catch {
        // Queued below; the close handler reconnects.
      }
    }
    if (this.queue.length >= MAX_QUEUE) this.queue.shift();
    this.queue.push(message);
    this.connect();
  }

  /** Closes the socket for now (nothing to do); the next send reconnects. */
  rest(): void {
    clearTimeout(this.retry);
    this.retry = undefined;
    this.backoff = BACKOFF_MIN;
    const ws = this.ws;
    this.ws = null;
    try {
      ws?.close();
    } catch {
      // Gone already.
    }
  }

  close(): void {
    this.closed = true;
    this.rest();
  }
}

/** Relays, used together. */
export class RelayPool {
  private readonly relays: Relay[];
  readonly subs = new Map<string, Sub>();
  private readonly pendingOk = new Map<string, (ok: boolean) => void>();
  private subSeq = 0;
  private idleTimer: ReturnType<typeof setTimeout> | undefined;

  /** Nothing to listen for or wait on: sockets may rest. */
  get idle(): boolean {
    return this.subs.size === 0 && this.pendingOk.size === 0;
  }

  /** Closes the sockets a while after the last use, so an idle page holds none open. */
  private checkIdle(): void {
    clearTimeout(this.idleTimer);
    if (!this.idle) return;
    this.idleTimer = setTimeout(() => {
      if (this.idle) for (const r of this.relays) r.rest();
    }, IDLE_MS);
  }

  constructor(urls: readonly string[] = DEFAULT_RELAYS, factory: SocketFactory = (url) => new WebSocket(url) as unknown as SocketLike) {
    this.relays = urls.map((u) => new Relay(u, factory, this));
  }

  /** Sends an event to every relay; true once any accepts it, false if none does in time. */
  publish(e: NostrEvent): Promise<boolean> {
    const message = JSON.stringify(['EVENT', e]);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pendingOk.delete(e.id);
        this.checkIdle();
        resolve(false);
      }, PUBLISH_TIMEOUT);
      this.pendingOk.set(e.id, (ok) => {
        if (!ok) return;
        clearTimeout(timer);
        this.pendingOk.delete(e.id);
        this.checkIdle();
        resolve(true);
      });
      for (const r of this.relays) r.send(message);
    });
  }

  /** Receives matching events (each once, verified) until the returned
   *  function is called. `onEose` fires when the first relay has sent
   *  everything it stored. */
  subscribe(filters: Filter[], onEvent: (e: NostrEvent) => void, onEose?: () => void): () => void {
    const id = `u${++this.subSeq}`;
    const sub: Sub = { id, filters, onEvent, onEose, eosed: false, seen: new Set(), verifies: VERIFY_RATE, second: 0 };
    this.subs.set(id, sub);
    const message = JSON.stringify(['REQ', id, ...filters]);
    for (const r of this.relays) r.send(message);
    return () => {
      if (!this.subs.delete(id)) return;
      const close = JSON.stringify(['CLOSE', id]);
      for (const r of this.relays) r.send(close);
      this.checkIdle();
    };
  }

  /** One message from a relay. */
  receive(text: string): void {
    let m: unknown;
    try {
      m = JSON.parse(text);
    } catch {
      return;
    }
    if (!Array.isArray(m) || typeof m[0] !== 'string') return;
    switch (m[0]) {
      case 'EVENT': {
        const sub = typeof m[1] === 'string' ? this.subs.get(m[1]) : undefined;
        const e = m[2] as NostrEvent;
        if (!sub || !e || typeof e !== 'object' || typeof e.id !== 'string') return;
        if (sub.seen.has(e.id) || !couldMatch(e, sub.filters)) return;
        // A budget of signature checks a second, for each subscription.
        const second = Math.floor(Date.now() / 1000);
        if (second !== sub.second) {
          sub.second = second;
          sub.verifies = VERIFY_RATE;
        }
        if (sub.verifies <= 0) return;
        sub.verifies--;
        // Checked every time: a cached id could come back with other content.
        if (!verifyEvent(e)) return;
        if (sub.seen.size > 4096) sub.seen.clear();
        sub.seen.add(e.id);
        sub.onEvent(e);
        break;
      }
      case 'EOSE': {
        const sub = typeof m[1] === 'string' ? this.subs.get(m[1]) : undefined;
        if (sub && !sub.eosed) {
          sub.eosed = true;
          sub.onEose?.();
        }
        break;
      }
      case 'OK':
        if (typeof m[1] === 'string') this.pendingOk.get(m[1])?.(m[2] === true);
        break;
      default:
        // NOTICE, CLOSED, AUTH: nothing to do.
        break;
    }
  }

  close(): void {
    clearTimeout(this.idleTimer);
    for (const r of this.relays) r.close();
    this.subs.clear();
    this.pendingOk.clear();
  }
}
