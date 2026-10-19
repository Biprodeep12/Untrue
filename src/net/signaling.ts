// Finding the other player: getting one session description to them and
// theirs back. After that the link is direct and signaling is done with.
//
// Join by code works the same over any `Bus` (a way to post and hear short
// messages on a topic): the code is stretched into a topic and a key
// (`deriveCodeKeys`), every message is sealed with the key, so a bus only
// sees noise on a topic it cannot reverse. Buses: `NostrBus` (public relays,
// the default), `BroadcastBus` (tabs of one browser, for testing) and
// `MemoryBus` (tests). The manual code needs no bus at all: the session
// descriptions themselves are copied and pasted, compressed.

import { schnorr } from '@noble/curves/secp256k1.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { fromHex, toHex } from './codec';
import { deriveCodeKeys, deflateRaw, fromBase64Url, inflateRaw, open, seal, toBase64Url, type CodeKeys } from './crypto';
import { cleanName } from './identity';
import { newKeypair, signEvent, type Keypair, type RelayPool } from './nostr';
import { RejectReason } from './protocol';
import { MAX_SDP } from './transport';

/** Posts and hears short text messages on topics. */
export interface Bus {
  /** Hears messages on a topic until the returned function is called. */
  subscribe(topic: string, onMessage: (payload: string) => void): () => void;
  publish(topic: string, payload: string): Promise<void>;
  close(): void;
}

/** A join request, as the host hears it. */
export interface JoinOffer {
  /** The request's own id, random per attempt; answers go to it. */
  from: string;
  sdp: string;
  name: string;
  /** The joiner's public key, hex, as they claim it (checked again on the link). */
  key: string;
}

/** Why joining by code failed before any link opened. */
export class JoinError extends Error {
  constructor(
    readonly reason: RejectReason | 'no-answer' | 'bad-code',
    message: string,
  ) {
    super(message);
  }
}

/** Messages older than this are ignored (replays). */
const FRESH_MS = 2 * 60_000;
/** A guest posts its offer again this often until answered. */
const REPOST_MS = 4000;
/** Longest sealed message accepted, in characters. */
const MAX_PAYLOAD = 48 * 1024;
const NAME_MAX = 24;

interface Envelope {
  t: 'offer' | 'answer' | 'reject';
  /** The guest's request id. */
  r: string;
  /** Sent at, ms. */
  at: number;
  sdp?: string;
  name?: string;
  key?: string;
  reason?: number;
  /** Answers and refusals: the host's key and its signature over the reply
   *  (`replyDigest`), so a guest who knows whom it is joining (a board's
   *  host) cannot be answered, or turned away, by anyone else on the code. */
  hk?: string;
  hs?: string;
}

/** Who signs replies on a code: the host's identity. */
export interface Signer {
  pubkey: string;
  secret: Uint8Array;
}

const REPLY_TAG = 'untrue/reply/v1';

function replyDigest(e: Envelope): Uint8Array {
  return sha256(enc.encode(JSON.stringify([REPLY_TAG, e.t, e.r, e.at, e.sdp ?? '', e.reason ?? 0, e.hk ?? ''])));
}

function signReply(e: Envelope, signer: Signer | undefined): Envelope {
  if (!signer) return e;
  e.hk = signer.pubkey;
  e.hs = toHex(schnorr.sign(replyDigest(e), signer.secret));
  return e;
}

/** True if a reply is signed by `host` (hex). */
function signedBy(e: Envelope, host: string): boolean {
  if (e.hk !== host || !e.hs) return false;
  const sig = fromHex(e.hs);
  const key = fromHex(host);
  if (!sig || sig.length !== 64 || !key || key.length !== 32) return false;
  try {
    return schnorr.verify(sig, replyDigest(e), key);
  } catch {
    return false;
  }
}

const enc = new TextEncoder();
const dec = new TextDecoder();

async function sealEnvelope(keys: CodeKeys, e: Envelope): Promise<string> {
  // Session descriptions compress well: smaller posts, fewer relay limits hit.
  return toBase64Url(await seal(keys.key, await deflateRaw(enc.encode(JSON.stringify(e)))));
}

async function openEnvelope(keys: CodeKeys, payload: string, now: number): Promise<Envelope | null> {
  if (payload.length > MAX_PAYLOAD) return null;
  const sealed = fromBase64Url(payload);
  if (!sealed) return null;
  const packed = await open(keys.key, sealed);
  if (!packed) return null;
  const plain = await inflateRaw(packed, MAX_SDP + 4096);
  if (!plain) return null;
  let v: unknown;
  try {
    v = JSON.parse(dec.decode(plain));
  } catch {
    return null;
  }
  if (!v || typeof v !== 'object') return null;
  const e = v as Record<string, unknown>;
  if (e.t !== 'offer' && e.t !== 'answer' && e.t !== 'reject') return null;
  if (typeof e.r !== 'string' || e.r.length > 64 || typeof e.at !== 'number' || Math.abs(now - e.at) > FRESH_MS) return null;
  if (e.sdp !== undefined && (typeof e.sdp !== 'string' || e.sdp.length > MAX_SDP)) return null;
  if (e.name !== undefined && typeof e.name !== 'string') return null;
  if (e.key !== undefined && (typeof e.key !== 'string' || (e.key !== '' && !/^[0-9a-f]{64}$/.test(e.key)))) return null;
  if (e.reason !== undefined && typeof e.reason !== 'number') return null;
  if (e.hk !== undefined && (typeof e.hk !== 'string' || !/^[0-9a-f]{64}$/.test(e.hk))) return null;
  if (e.hs !== undefined && (typeof e.hs !== 'string' || !/^[0-9a-f]{128}$/.test(e.hs))) return null;
  return e as unknown as Envelope;
}

function randomId(): string {
  return toBase64Url(crypto.getRandomValues(new Uint8Array(12)));
}

/** The host's side of joining by code. */
export class CodeHost {
  private unsubscribe: (() => void) | null = null;
  /** Answers already sent, by request id: a guest that missed one gets it again. */
  private readonly answered = new Map<string, string>();
  private readonly busy = new Set<string>();

  private constructor(
    private readonly bus: Bus,
    private readonly keys: CodeKeys,
    private readonly now: () => number,
    private readonly signer: Signer | undefined,
  ) {}

  /** Listens for join requests on `code` (normalised); replies are signed by `signer`. */
  static async listen(bus: Bus, code: string, onOffer: (offer: JoinOffer) => void, options: { iterations?: number; now?: () => number; signer?: Signer } = {}): Promise<CodeHost> {
    const keys = await deriveCodeKeys(code, options.iterations);
    const host = new CodeHost(bus, keys, options.now ?? Date.now, options.signer);
    host.unsubscribe = bus.subscribe(keys.topic, (payload) => void host.hear(payload, onOffer));
    return host;
  }

  private async hear(payload: string, onOffer: (offer: JoinOffer) => void): Promise<void> {
    const e = await openEnvelope(this.keys, payload, this.now());
    if (!e || e.t !== 'offer' || !e.sdp) return;
    const again = this.answered.get(e.r);
    if (again) {
      void this.bus.publish(this.keys.topic, again);
      return;
    }
    if (this.busy.has(e.r)) return;
    this.busy.add(e.r);
    onOffer({ from: e.r, sdp: e.sdp, name: cleanName(e.name ?? '').slice(0, NAME_MAX), key: e.key ?? '' });
  }

  async answer(to: string, sdp: string): Promise<void> {
    const payload = await sealEnvelope(this.keys, signReply({ t: 'answer', r: to, at: this.now(), sdp }, this.signer));
    this.remember(to, payload);
    await this.bus.publish(this.keys.topic, payload);
  }

  async reject(to: string, reason: RejectReason): Promise<void> {
    const payload = await sealEnvelope(this.keys, signReply({ t: 'reject', r: to, at: this.now(), reason }, this.signer));
    this.remember(to, payload);
    await this.bus.publish(this.keys.topic, payload);
  }

  /** Forgets an offer without a word (one refused for coming too fast: an
   *  answer would cost a signature and a post, which is what a flood wants). */
  drop(from: string): void {
    this.busy.delete(from);
  }

  private remember(to: string, payload: string): void {
    this.busy.delete(to);
    this.answered.set(to, payload);
    if (this.answered.size > 64) this.answered.delete(this.answered.keys().next().value!);
  }

  close(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
  }
}

/** The guest's side: posts an offer on `code` and waits for the answer.
 *  `expectHost` (hex): only replies signed by that host count. */
export async function requestJoin(
  bus: Bus,
  code: string,
  offer: { sdp: string; name: string; key: string },
  options: { timeoutMs?: number; iterations?: number; now?: () => number; expectHost?: string } = {},
): Promise<string> {
  const now = options.now ?? Date.now;
  const keys = await deriveCodeKeys(code, options.iterations);
  const id = randomId();
  return new Promise<string>((resolve, reject) => {
    let done = false;
    let repost: ReturnType<typeof setInterval> | undefined;
    const finish = (fn: () => void) => {
      if (done) return;
      done = true;
      clearInterval(repost);
      clearTimeout(timer);
      unsubscribe();
      fn();
    };
    const unsubscribe = bus.subscribe(keys.topic, (payload) => {
      void openEnvelope(keys, payload, now()).then((e) => {
        if (!e || e.r !== id) return;
        if (options.expectHost && !signedBy(e, options.expectHost)) return;
        if (e.t === 'answer' && e.sdp) finish(() => resolve(e.sdp!));
        else if (e.t === 'reject') {
          const reason = (e.reason ?? RejectReason.Declined) as RejectReason;
          finish(() => reject(new JoinError(reason, 'Refused')));
        }
      });
    });
    const timer = setTimeout(() => finish(() => reject(new JoinError('no-answer', 'No one answered that code'))), options.timeoutMs ?? 20_000);
    void sealEnvelope(keys, { t: 'offer', r: id, at: now(), sdp: offer.sdp, name: offer.name.slice(0, NAME_MAX), key: offer.key }).then((payload) => {
      if (done) return;
      const post = () => void bus.publish(keys.topic, payload).catch(() => {});
      post();
      // The host may not have been listening yet, or a relay dropped it.
      repost = setInterval(post, REPOST_MS);
    });
  });
}

// ---------------------------------------------------------------------------
// Buses.

/** Tests: one in-memory hub; every bus made from it hears the others. */
export class MemoryHub {
  private readonly subs = new Map<string, Set<(payload: string) => void>>();
  /** Every publish, for tests that look at what a bus would see. */
  readonly log: Array<{ topic: string; payload: string }> = [];
  latency = 5;

  bus(): Bus {
    const mine: Array<() => void> = [];
    return {
      subscribe: (topic, onMessage) => {
        let set = this.subs.get(topic);
        if (!set) this.subs.set(topic, (set = new Set()));
        set.add(onMessage);
        const off = () => set.delete(onMessage);
        mine.push(off);
        return off;
      },
      publish: async (topic, payload) => {
        this.log.push({ topic, payload });
        const set = this.subs.get(topic);
        if (!set) return;
        for (const fn of [...set]) setTimeout(() => fn(payload), this.latency);
      },
      close: () => {
        for (const off of mine) off();
      },
    };
  }
}

/** Tabs of one browser (two-tab testing): a BroadcastChannel. */
export class BroadcastBus implements Bus {
  private readonly channel = new BroadcastChannel('untrue-signal');
  private readonly handlers = new Map<string, Set<(payload: string) => void>>();

  constructor() {
    this.channel.onmessage = (e: MessageEvent) => {
      const d = e.data as { topic?: unknown; payload?: unknown };
      if (typeof d?.topic !== 'string' || typeof d.payload !== 'string') return;
      const set = this.handlers.get(d.topic);
      if (set) for (const fn of set) fn(d.payload);
    };
  }

  subscribe(topic: string, onMessage: (payload: string) => void): () => void {
    let set = this.handlers.get(topic);
    if (!set) this.handlers.set(topic, (set = new Set()));
    set.add(onMessage);
    return () => set.delete(onMessage);
  }

  async publish(topic: string, payload: string): Promise<void> {
    this.channel.postMessage({ topic, payload });
  }

  close(): void {
    this.channel.close();
    this.handlers.clear();
  }
}

/** Ephemeral kind (20000–29999): relays pass these on and never store them. */
export const SIGNAL_KIND = 25050;

/** Public Nostr relays. Posts are signed with a throwaway key, so they say
 *  nothing about who is joining; their content is sealed. */
export class NostrBus implements Bus {
  private readonly key: Keypair = newKeypair();

  constructor(private readonly pool: RelayPool) {}

  subscribe(topic: string, onMessage: (payload: string) => void): () => void {
    return this.pool.subscribe([{ kinds: [SIGNAL_KIND], '#t': [topic], since: Math.floor(Date.now() / 1000) - 60 }], (e) => {
      if (e.pubkey !== this.key.pubkey) onMessage(e.content);
    });
  }

  async publish(topic: string, payload: string): Promise<void> {
    await this.pool.publish(signEvent(this.key, SIGNAL_KIND, [['t', topic]], payload));
  }

  close(): void {
    // The pool is shared; its owner closes it.
  }
}

// ---------------------------------------------------------------------------
// Manual codes: the session description itself, compressed, copied and pasted.

const MANUAL_PREFIX = { invite: 'UNTRUE1I.', reply: 'UNTRUE1R.' } as const;

/** A code holding a whole session description, to copy to the other player. */
export async function manualCode(kind: 'invite' | 'reply', sdp: string): Promise<string> {
  return MANUAL_PREFIX[kind] + toBase64Url(await deflateRaw(enc.encode(sdp)));
}

/** The session description in a pasted code, or null if it is not one of `kind`. */
export async function readManualCode(kind: 'invite' | 'reply', text: string): Promise<string | null> {
  const t = text.replace(/\s+/g, '');
  if (!t.startsWith(MANUAL_PREFIX[kind]) || t.length > MAX_SDP * 2) return null;
  const packed = fromBase64Url(t.slice(MANUAL_PREFIX[kind].length));
  if (!packed) return null;
  const plain = await inflateRaw(packed, MAX_SDP);
  if (!plain) return null;
  const sdp = dec.decode(plain);
  return sdp.startsWith('v=0') ? sdp : null;
}
