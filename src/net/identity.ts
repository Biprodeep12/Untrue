// Who this browser is on the network: a keypair made once and kept, a name,
// and the keys this player has blocked. No accounts: the public key is the
// identity. Storage can be missing or refuse (private windows, blocked site
// data), so every read and write is guarded and the game still plays, with
// an identity that lasts only for this page.

import { fromHex, toHex } from './codec';
import { keypairFrom, newKeypair, type Keypair } from './nostr';

const KEY = 'untrue.net.key';
const NAME = 'untrue.net.name';
const BLOCKED = 'untrue.net.blocked';
/** Most keys kept on the block list. */
const MAX_BLOCKED = 500;
const NAME_MAX = 24;

/** What identity needs of storage (localStorage, or a stand-in in tests). */
export interface KeyValueStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function store(): KeyValueStore | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

function read(s: KeyValueStore | null, key: string): string | null {
  try {
    return s?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

function write(s: KeyValueStore | null, key: string, value: string): void {
  try {
    s?.setItem(key, value);
  } catch {
    // Not kept: fine for this page.
  }
}

export class Identity {
  readonly keys: Keypair;
  /** The public key as bytes, for the wire. */
  readonly keyBytes: Uint8Array;
  private _name: string;
  private readonly blocked: Set<string>;

  constructor(private readonly storage: KeyValueStore | null = store()) {
    const saved = fromHex(read(storage, KEY) ?? '');
    let keys: Keypair | null = null;
    if (saved?.length === 32) {
      try {
        keys = keypairFrom(saved);
      } catch {
        keys = null;
      }
    }
    if (!keys) {
      keys = newKeypair();
      write(storage, KEY, toHex(keys.secret));
    }
    this.keys = keys;
    this.keyBytes = fromHex(keys.pubkey)!;
    this._name = cleanName(read(storage, NAME) ?? '') || `Traveller ${keys.pubkey.slice(0, 4).toUpperCase()}`;
    let list: unknown = [];
    try {
      list = JSON.parse(read(storage, BLOCKED) ?? '[]');
    } catch {
      list = [];
    }
    this.blocked = new Set(Array.isArray(list) ? list.filter((k): k is string => typeof k === 'string' && /^[0-9a-f]{64}$/.test(k)).slice(-MAX_BLOCKED) : []);
  }

  get name(): string {
    return this._name;
  }

  set name(value: string) {
    const n = cleanName(value);
    if (!n) return;
    this._name = n;
    write(this.storage, NAME, n);
  }

  isBlocked(key: string | Uint8Array): boolean {
    return this.blocked.has(typeof key === 'string' ? key : toHex(key));
  }

  block(key: string | Uint8Array): void {
    const k = typeof key === 'string' ? key : toHex(key);
    this.blocked.delete(k);
    this.blocked.add(k);
    while (this.blocked.size > MAX_BLOCKED) this.blocked.delete(this.blocked.values().next().value!);
    this.saveBlocked();
  }

  unblock(key: string | Uint8Array): void {
    if (this.blocked.delete(typeof key === 'string' ? key : toHex(key))) this.saveBlocked();
  }

  private saveBlocked(): void {
    write(this.storage, BLOCKED, JSON.stringify([...this.blocked]));
  }
}

/** A name fit to show other players: printable, trimmed, at most 24 characters. */
export function cleanName(raw: string): string {
  // Control and formatting characters (including bidi overrides) go.
  return raw
    .replace(/\s+/g, ' ')
    .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, '')
    .trim()
    .slice(0, NAME_MAX);
}
