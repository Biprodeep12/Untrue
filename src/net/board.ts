// The board of open dimension instances, kept on public Nostr relays. A host
// posts a small signed note every minute (dimension, players, seals broken,
// game version, the code to join by); each note says when it expires
// (NIP-40), and a newer note from the same host replaces the last
// (addressable kind, keyed by the instance id). Guests ask for the notes of
// one dimension and keep the live, open, compatible ones not from blocked keys.

import { normalizeCode } from './codes';
import { cleanName } from './identity';
import { signEvent, tagValue, type Keypair, type NostrEvent, type RelayPool } from './nostr';
import { MAX_MEMBERS } from './protocol';

/** Addressable application data (NIP-78). */
export const BOARD_KIND = 30078;
/** A host posts this often, in ms. */
export const BOARD_INTERVAL_MS = 60_000;
/** A note lives this long unless renewed, in seconds. */
export const BOARD_TTL_S = 180;
/** After the first relay has sent all it has, wait this long for the rest, in ms. */
const EOSE_GRACE_MS = 400;
/** Clocks differ: a note may be this far ahead of ours, in seconds. */
const CLOCK_SKEW_S = 60;

export interface BoardInfo {
  /** The instance's id, random per instance: the note's address. */
  instance: string;
  dimension: string;
  players: number;
  capacity: number;
  /** Trials done, of how many. */
  seals: number;
  sealsTotal: number;
  gameVersion: string;
  /** The join code for this instance (posted publicly: anyone may join). */
  code: string;
  /** The host's name. */
  name: string;
}

export interface BoardEntry extends BoardInfo {
  /** The host's public key, hex. */
  host: string;
  /** Seconds since 1970. */
  postedAt: number;
  expiresAt: number;
}

const dimTag = (dimension: string) => `untrue-dim-${dimension}`;
const ID = /^[A-Za-z0-9_-]{1,64}$/;

function content(info: BoardInfo): string {
  return JSON.stringify({
    v: 1,
    players: info.players,
    cap: info.capacity,
    seals: info.seals,
    of: info.sealsTotal,
    ver: info.gameVersion,
    code: info.code,
    name: info.name,
  });
}

const smallInt = (v: unknown, max: number): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= max;

/** A note as an entry, or null if it is malformed or claims what no host
 *  could (more room than an instance has, a time ahead of now, a life
 *  longer than a note's). */
export function parseNote(e: NostrEvent, nowS = Math.floor(Date.now() / 1000)): BoardEntry | null {
  if (e.kind !== BOARD_KIND) return null;
  const instance = tagValue(e, 'd');
  const t = tagValue(e, 't');
  const exp = Number(tagValue(e, 'expiration'));
  if (!instance || !ID.test(instance) || !t?.startsWith('untrue-dim-') || !Number.isInteger(exp)) return null;
  const dimension = t.slice('untrue-dim-'.length);
  if (!ID.test(dimension)) return null;
  let v: Record<string, unknown>;
  try {
    v = JSON.parse(e.content) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (!v || typeof v !== 'object' || v.v !== 1) return null;
  if (!smallInt(v.players, MAX_MEMBERS) || !smallInt(v.cap, MAX_MEMBERS) || !smallInt(v.seals, 255) || !smallInt(v.of, 255)) return null;
  if (v.players > v.cap || v.seals > v.of) return null;
  if (e.created_at > nowS + CLOCK_SKEW_S || exp > e.created_at + BOARD_TTL_S + CLOCK_SKEW_S) return null;
  if (typeof v.ver !== 'string' || v.ver.length > 32 || typeof v.code !== 'string' || typeof v.name !== 'string') return null;
  const code = normalizeCode(v.code);
  if (!code) return null;
  return {
    instance,
    dimension,
    players: v.players,
    capacity: v.cap,
    seals: v.seals,
    sealsTotal: v.of,
    gameVersion: v.ver,
    code,
    name: cleanName(v.name),
    host: e.pubkey,
    postedAt: e.created_at,
    expiresAt: exp,
  };
}

export class Board {
  private timer: ReturnType<typeof setInterval> | undefined;
  private hosting: (() => BoardInfo) | null = null;

  constructor(
    private readonly pool: RelayPool,
    private readonly keys: Keypair,
    private readonly now: () => number = Date.now,
  ) {}

  private post(info: BoardInfo, ttl: number): Promise<boolean> {
    const at = Math.floor(this.now() / 1000);
    const tags = [
      ['d', info.instance],
      ['t', dimTag(info.dimension)],
      ['expiration', String(at + ttl)],
    ];
    return this.pool.publish(signEvent(this.keys, BOARD_KIND, tags, content(info), at));
  }

  /** Posts this instance now and every minute while hosting. */
  startHosting(info: () => BoardInfo): void {
    this.stopTimer();
    this.hosting = info;
    void this.post(info(), BOARD_TTL_S);
    this.timer = setInterval(() => {
      if (this.hosting) void this.post(this.hosting(), BOARD_TTL_S);
    }, BOARD_INTERVAL_MS);
  }

  /** Stops posting, and replaces the note with one that expires at once. */
  async stopHosting(): Promise<void> {
    const info = this.hosting?.();
    this.stopTimer();
    this.hosting = null;
    if (info) await this.post({ ...info, players: info.capacity }, 1);
  }

  private stopTimer(): void {
    clearInterval(this.timer);
    this.timer = undefined;
  }

  /** Open instances of a dimension: live, not full, on this game version,
   *  not from `skip`ped hosts, one per host (its newest), in a random order
   *  (so made-up notes cannot crowd the top). Waits for the first relay to
   *  send all it has, or `timeoutMs`. */
  query(dimension: string, gameVersion: string, skip: (host: string) => boolean, timeoutMs = 3000): Promise<BoardEntry[]> {
    return new Promise((resolve) => {
      const found = new Map<string, BoardEntry>();
      const since = Math.floor(this.now() / 1000) - BOARD_TTL_S;
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        unsubscribe();
        const nowS = Math.floor(this.now() / 1000);
        const list = [...found.values()].filter((e) => e.expiresAt > nowS && e.players < e.capacity && e.gameVersion === gameVersion && !skip(e.host));
        for (let i = list.length - 1; i > 0; i--) {
          const j = Math.floor(Math.random() * (i + 1));
          [list[i], list[j]] = [list[j], list[i]];
        }
        resolve(list);
      };
      const unsubscribe = this.pool.subscribe(
        [{ kinds: [BOARD_KIND], '#t': [dimTag(dimension)], since, limit: 100 }],
        (e) => {
          const entry = parseNote(e, Math.floor(this.now() / 1000));
          if (!entry || entry.dimension !== dimension) return;
          // One note per host: a host runs one instance at a time.
          const key = entry.host;
          const old = found.get(key);
          if (!old || old.postedAt < entry.postedAt) found.set(key, entry);
        },
        // The first relay is done: give the slower ones a moment more.
        () => setTimeout(finish, EOSE_GRACE_MS),
      );
      const timer = setTimeout(finish, timeoutMs);
    });
  }

  close(): void {
    this.stopTimer();
    this.hosting = null;
  }
}
