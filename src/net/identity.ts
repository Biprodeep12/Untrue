// Who this browser is on the network: a keypair made once and kept, a name,
// and the keys this player has blocked. No accounts: the public key is the
// identity. Storage can be missing or refuse (private windows, blocked site
// data), so every read and write is guarded and the game still plays, with
// an identity that lasts only for this page.
//
// Two tabs of one browser must not be the same player: a host refuses a
// guest with its own key, and a session can hold a key only once. So each
// tab claims its key (`claim`, with the Web Locks API): the first tab gets
// the browser's kept key, any other tab one of its own, kept in that tab's
// session storage so a reload keeps it.

import { fromHex, toHex } from './codec';
import { keypairFrom, newKeypair, type Keypair } from './nostr';

const KEY = 'untrue.net.key';
const NAME = 'untrue.net.name';
const BLOCKED = 'untrue.net.blocked';
/** This tab's own key, when another tab holds the browser's. */
const TAB_KEY = 'untrue.net.tabkey';
/** Lock names, one per key in use. */
const LOCK = 'untrue.net.id:';
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

function tabStore(): KeyValueStore | null {
  try {
    return typeof sessionStorage === 'undefined' ? null : sessionStorage;
  } catch {
    return null;
  }
}

/** What claiming needs of the Web Locks API (navigator.locks, or a stand-in in tests). */
export interface LockManagerLike {
  request(name: string, options: { ifAvailable: boolean }, callback: (lock: unknown) => Promise<unknown> | unknown): Promise<unknown>;
}

function locks(): LockManagerLike | null {
  try {
    return typeof navigator !== 'undefined' && navigator.locks ? (navigator.locks as unknown as LockManagerLike) : null;
  } catch {
    return null;
  }
}

/** Holds the lock for `key` until the page goes, if no other tab has it: true if held. */
function hold(manager: LockManagerLike, key: Keypair): Promise<boolean> {
  return new Promise((resolve) => {
    manager
      .request(LOCK + key.pubkey, { ifAvailable: true }, (lock) => {
        resolve(!!lock);
        // Kept for the page's life: the browser lets go when the tab closes.
        return lock ? new Promise(() => {}) : undefined;
      })
      .catch(() => resolve(false));
  });
}

function keysFrom(hex: string | null): Keypair | null {
  const saved = fromHex(hex ?? '');
  if (saved?.length !== 32) return null;
  try {
    return keypairFrom(saved);
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
  private _keys: Keypair;
  private _keyBytes: Uint8Array;
  private _name: string;
  private readonly blocked: Set<string>;
  private claiming: Promise<void> | null = null;
  private readonly storage: KeyValueStore | null;
  private readonly tabStorage: KeyValueStore | null;
  private readonly lockManager: LockManagerLike | null;

  /** With no `storage` given, the browser's (local and session storage, and
   *  its locks); tests pass their own, or null. */
  constructor(storage?: KeyValueStore | null, tabStorage?: KeyValueStore | null, lockManager?: LockManagerLike | null) {
    const browser = storage === undefined;
    this.storage = browser ? store() : (storage ?? null);
    this.tabStorage = tabStorage !== undefined ? tabStorage : browser ? tabStore() : null;
    this.lockManager = lockManager !== undefined ? lockManager : browser ? locks() : null;
    storage = this.storage;
    let keys = keysFrom(read(storage, KEY));
    if (!keys) {
      keys = newKeypair();
      write(storage, KEY, toHex(keys.secret));
    }
    this._keys = keys;
    this._keyBytes = fromHex(keys.pubkey)!;
    this._name = cleanName(read(storage, NAME) ?? '');
    let list: unknown = [];
    try {
      list = JSON.parse(read(storage, BLOCKED) ?? '[]');
    } catch {
      list = [];
    }
    this.blocked = new Set(Array.isArray(list) ? list.filter((k): k is string => typeof k === 'string' && /^[0-9a-f]{64}$/.test(k)).slice(-MAX_BLOCKED) : []);
  }

  get keys(): Keypair {
    return this._keys;
  }

  /** The public key as bytes, for the wire. */
  get keyBytes(): Uint8Array {
    return this._keyBytes;
  }

  /** Makes sure no other tab of this browser plays under this tab's key
   *  (see the top of this file). Await it before the key is used; it runs
   *  once. Without the Web Locks API the kept key is used as it is. */
  claim(): Promise<void> {
    this.claiming ??= this.claimKey();
    return this.claiming;
  }

  private async claimKey(): Promise<void> {
    const manager = this.lockManager;
    if (!manager) return;
    if (await hold(manager, this._keys)) return;
    // Another tab is this browser's player: this tab is someone else.
    let keys = keysFrom(read(this.tabStorage, TAB_KEY));
    if (!keys || !(await hold(manager, keys))) {
      // None yet, or a duplicated tab came with it: a new one.
      do keys = newKeypair();
      while (!(await hold(manager, keys)));
      write(this.tabStorage, TAB_KEY, toHex(keys.secret));
    }
    this._keys = keys;
    this._keyBytes = fromHex(keys.pubkey)!;
  }

  /** The name the player chose, or one made from this tab's key. */
  get name(): string {
    return this._name || `Traveller ${this._keys.pubkey.slice(0, 4).toUpperCase()}`;
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
