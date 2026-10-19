// The network, as the game uses it. Load it lazily (`await import('./net')`)
// when the player first opens the Drift Beacon or enters a rift, so solo play
// never downloads or runs any of it.
//
// - Overworld, by invite: `hostWorld` (shows a code), `joinWorld(code)`.
// - Dimension instances, open to anyone: `findInstances`, `joinInstance`,
//   `hostInstance` (posted on the board while it hosts).
// Each returns a `Session`; the game sends and receives its own messages
// through it (see docs/networking.md).

import { Board, type BoardEntry, type BoardInfo } from './board';
import { toHex } from './codec';
import { formatCode, JoinLimiter, newCode, normalizeCode } from './codes';
import { sha256 } from './crypto';
import { Identity, type KeyValueStore } from './identity';
import { hostByCode, joinByCode } from './join';
import { DEFAULT_RELAYS, RelayPool, type SocketFactory } from './nostr';
import { MAX_MEMBERS, Mode } from './protocol';
import { Session, type SessionConfig } from './session';
import { BroadcastBus, JoinError, NostrBus, type Bus } from './signaling';
import { RtcLinker, type Linker } from './transport';

export * from './protocol';
export { Writer, Reader, toHex, fromHex } from './codec';
export { Frame, SnapshotReceiver, SnapshotSender, MAX_SNAPSHOT_ENTITIES } from './snapshot';
export { Session, ConnectError, type Role, type EndReason, type SessionEvents } from './session';
export { JoinError, manualCode, readManualCode, MemoryHub } from './signaling';
export { formatCode, normalizeCode } from './codes';
export { CLOSE_TEXT, type CloseReason } from './transport';
export type { BoardEntry, BoardInfo } from './board';

export interface NetOptions {
  gameVersion: string;
  /** 'nostr' (public relays, the default) or 'local' (tabs of this browser, for testing). */
  signaling?: 'nostr' | 'local';
  relays?: readonly string[];
  /** Test seams. */
  socket?: SocketFactory;
  storage?: KeyValueStore | null;
  linker?: Linker;
  bus?: Bus;
  /** PBKDF2 rounds for codes (tests only). */
  iterations?: number;
}

/** The SHA-256 of a dimension's map file, as peers compare it. */
export async function hashMap(file: string | Uint8Array): Promise<Uint8Array> {
  return sha256(typeof file === 'string' ? new TextEncoder().encode(file) : file);
}

/** Retries rejoining an overworld host this often while its link is down, in ms. */
const REJOIN_EVERY_MS = 3000;

export class Net {
  readonly identity: Identity;
  private pool: RelayPool | null = null;
  private busy: Bus | null = null;
  private boardInst: Board | null = null;
  readonly linker: Linker;

  constructor(private readonly options: NetOptions) {
    this.identity = new Identity(options.storage);
    this.linker = options.linker ?? new RtcLinker();
  }

  private relays(): RelayPool {
    this.pool ??= new RelayPool(this.options.relays ?? DEFAULT_RELAYS, this.options.socket);
    return this.pool;
  }

  /** Where join requests travel. */
  get bus(): Bus {
    this.busy ??= this.options.bus ?? (this.options.signaling === 'local' ? new BroadcastBus() : new NostrBus(this.relays()));
    return this.busy;
  }

  get board(): Board {
    this.boardInst ??= new Board(this.relays(), this.identity.keys);
    return this.boardInst;
  }

  private config(mode: Mode, dimension: string, mapHash: Uint8Array): SessionConfig {
    return {
      mode,
      gameVersion: this.options.gameVersion,
      dimension,
      mapHash,
      key: this.identity.keyBytes,
      secret: this.identity.keys.secret,
      name: this.identity.name,
      linker: this.linker,
      isBlocked: (k) => this.identity.isBlocked(k),
    };
  }

  private get who(): { name: string; key: string } {
    return { name: this.identity.name, key: this.identity.keys.pubkey };
  }

  /** Replies on this player's codes are signed as them. */
  private get signer(): { pubkey: string; secret: Uint8Array } {
    return { pubkey: this.identity.keys.pubkey, secret: this.identity.keys.secret };
  }

  /** Opens this player's overworld to friends: returns the session and the code
   *  to show (XXXX-XXXX). Joins wait for `session.on.joinRequest`. `capacity`:
   *  most players, the host included (5 by default). */
  async hostWorld(capacity?: number): Promise<{ session: Session; code: string; stop: () => void }> {
    const config = this.config(Mode.Overworld, '', new Uint8Array(32));
    const session = Session.host(capacity ? { ...config, capacity: Math.min(MAX_MEMBERS, capacity) } : config);
    const code = newCode();
    const stopListening = await hostByCode(session, this.bus, code, { iterations: this.options.iterations, limiter: new JoinLimiter(), signer: this.signer });
    const stop = () => {
      stopListening();
      session.leave();
    };
    return { session, code: formatCode(code), stop };
  }

  /** Joins a friend's overworld by code. While the host's link is down the
   *  session tries to rejoin by the same code, within the reconnect window. */
  async joinWorld(typed: string): Promise<Session> {
    const code = normalizeCode(typed);
    if (!code) throw new JoinError('bad-code', 'That is not a code');
    const session = Session.guest(this.config(Mode.Overworld, '', new Uint8Array(32)));
    try {
      await joinByCode(session, this.linker, this.bus, code, this.who, this.options);
    } catch (e) {
      session.dispose();
      throw e;
    }
    let retry: ReturnType<typeof setTimeout> | undefined;
    const rejoin = () => {
      if (session.ended) return;
      // The same host as before, and no one else on the code, may answer.
      const host = session.hostKey;
      joinByCode(session, this.linker, this.bus, code, this.who, { ...this.options, expectHost: host ? toHex(host) : undefined }).catch(() => {
        if (!session.ended) retry = setTimeout(rejoin, REJOIN_EVERY_MS);
      });
    };
    session.hooks.hostLost = () => {
      clearTimeout(retry);
      rejoin();
    };
    session.hooks.ended = () => clearTimeout(retry);
    return session;
  }

  /** Open instances of a dimension, best first. */
  findInstances(dimension: string, timeoutMs?: number): Promise<BoardEntry[]> {
    return this.board.query(dimension, this.options.gameVersion, (host) => this.identity.isBlocked(host) || host === this.identity.keys.pubkey, timeoutMs);
  }

  /** Joins an instance from the board: only the host that posted it may
   *  answer (`entry.host`; empty when following a friend by code).
   *  `timeoutMs` bounds the whole attempt. If this player later becomes its
   *  host, it takes over listening for the instance's code (and its board note). */
  async joinInstance(entry: BoardEntry, mapHash: Uint8Array, isPublic = true, timeoutMs?: number): Promise<Session> {
    const session = Session.guest(this.config(Mode.Dimension, entry.dimension, mapHash));
    const limits = timeoutMs ? { timeoutMs, connectMs: timeoutMs } : {};
    const joining = joinByCode(session, this.linker, this.bus, entry.code, this.who, { ...this.options, ...limits, expectHost: entry.host || undefined });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      // The whole attempt, answer and link together, within `timeoutMs`.
      await (timeoutMs
        ? Promise.race([
            joining,
            new Promise<never>((_, reject) => {
              timer = setTimeout(() => reject(new JoinError('no-answer', 'No answer in time')), timeoutMs);
            }),
          ])
        : joining);
    } catch (e) {
      joining.catch(() => {});
      session.dispose();
      throw e;
    } finally {
      clearTimeout(timer);
    }
    this.keepListed(session, entry.code, isPublic);
    return session;
  }

  /** Hosts a new instance of a dimension. Public instances go on the board
   *  while this player hosts them; whoever takes over keeps them listed under
   *  the same code. Set `runInfo` to report seals for the board. */
  async hostInstance(dimension: string, mapHash: Uint8Array, isPublic = true): Promise<{ session: Session; code: string; stop: () => void }> {
    const session = Session.host(this.config(Mode.Dimension, dimension, mapHash));
    const code = newCode();
    const stop = this.keepListed(session, code, isPublic);
    await this.listing.get(session)?.start();
    return { session, code: formatCode(code), stop };
  }

  /** Seals broken so far, for the board; the game sets it per session. */
  runInfo = (session: Session): Pick<BoardInfo, 'seals' | 'sealsTotal'> => {
    const trials = session.runState?.trials ?? [];
    return { seals: trials.filter((t) => t === 2).length, sealsTotal: trials.length };
  };

  private readonly listing = new WeakMap<Session, { start(): Promise<void>; stop(): void }>();

  /** While `session` is hosted here, listen on its code and post it on the
   *  board; stop when another member hosts, or the session ends. */
  private keepListed(session: Session, code: string, isPublic: boolean): () => void {
    const instance = toHex(crypto.getRandomValues(new Uint8Array(8)));
    let stopListening: (() => void) | null = null;
    let on = false;
    const listing = {
      start: async () => {
        if (on || session.ended) return;
        on = true;
        stopListening = await hostByCode(session, this.bus, code, { iterations: this.options.iterations, signer: this.signer });
        if (!on) stopListening();
        else if (isPublic) {
          this.board.startHosting(() => ({ instance, dimension: session.dimension, players: session.members().length, capacity: MAX_MEMBERS, gameVersion: this.options.gameVersion, code, name: this.identity.name, ...this.runInfo(session) }));
        }
      },
      stop: () => {
        if (!on) return;
        on = false;
        stopListening?.();
        stopListening = null;
        if (isPublic) void this.board.stopHosting();
      },
    };
    this.listing.set(session, listing);
    session.hooks.roleChanged = (role) => void (role === 'host' ? listing.start() : listing.stop());
    session.hooks.ended = () => listing.stop();
    return () => {
      listing.stop();
      session.leave();
    };
  }

  close(): void {
    this.boardInst?.close();
    this.busy?.close();
    this.pool?.close();
  }
}
