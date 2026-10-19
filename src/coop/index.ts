// Playing with others behind the rifts. The game loads this lazily, the first
// time it is needed (a public rift trip, or the Drift Beacon's list), so solo
// play never downloads any of it, nor the network beneath it (src/net).
//
// `Coop` finds or opens a shared instance of a dimension; `InstanceLink`
// plays it (see there).

import { SPECIES_LIST } from '../entities/Species';
import { ITEM_LIST } from '../items/Items';
import { hashMap, Net, type BoardEntry, type Session } from '../net';
import { LOCAL_RELAYS, localRelay } from './localRelay';
import { WorldGuest } from './WorldGuest';

export { InstanceLink, type CoopGame } from './InstanceLink';
export { WorldHost } from './WorldHost';
export { WorldGuest } from './WorldGuest';
export { Place } from './worldWire';
export type { WorldGame, SeenAs, LocalWhere } from './worldGame';
export type { WorldInfo } from './worldWire';
export type { BoardEntry } from '../net';

/** Peers must match on this: the network's game messages, and what their
 *  indices name (items, creatures). Raise the last part when the game's own
 *  messages change. */
export const GAME_VERSION = `untrue-${ITEM_LIST.length}.${SPECIES_LIST.length}-c1`;

/** How long to look on the board for an instance to join, in ms. */
const FIND_MS = 2500;
/** Instances tried from the board before opening one, and how long each may take, in ms. */
const JOIN_TRIES = 2;
const JOIN_TRY_MS = 3000;

/** An instance this player is in. */
export interface Joined {
  session: Session;
  isHost: boolean;
  /** The instance's join code. */
  code: string;
  /** Leaves it (a host hands it on to the next). */
  stop(): void;
}

export class Coop {
  readonly net: Net;

  /** `local`: tabs of this browser find each other (two-tab testing), not
   *  public relays; each tab is someone new (tabs share storage, and a key
   *  cannot meet itself). */
  constructor(local: boolean) {
    this.net = new Net(local ? { gameVersion: GAME_VERSION, signaling: 'local', socket: localRelay, relays: LOCAL_RELAYS, storage: null } : { gameVersion: GAME_VERSION });
  }

  get name(): string {
    return this.net.identity.name;
  }

  set name(v: string) {
    this.net.identity.name = v;
  }

  /** Open instances of a dimension, fullest first. */
  find(dimension: string, timeoutMs = FIND_MS): Promise<BoardEntry[]> {
    return this.net.findInstances(dimension, timeoutMs);
  }

  /** Into a shared instance of `dimension` (its map file `mapFile`): one with
   *  room from the board (`prefer`red first), else a new one, listed if `isPublic`. */
  async enter(dimension: string, mapFile: string, isPublic: boolean, prefer?: string): Promise<Joined> {
    const hash = await hashMap(mapFile);
    if (isPublic) {
      const list = await this.find(dimension);
      if (prefer) list.sort((a, b) => Number(b.instance === prefer) - Number(a.instance === prefer));
      for (const entry of list.slice(0, JOIN_TRIES)) {
        try {
          const session = await this.net.joinInstance(entry, hash, true, JOIN_TRY_MS);
          return { session, isHost: false, code: entry.code, stop: () => session.leave() };
        } catch {
          // Full, gone, or out of reach: try the next, or open one.
        }
      }
    }
    const h = await this.net.hostInstance(dimension, hash, isPublic);
    return { session: h.session, isHost: true, code: h.code, stop: h.stop };
  }

  /** Into the instance a friend is in, by its code; null if it cannot be
   *  reached (full, gone), and the trip finds or opens one as usual. */
  async follow(dimension: string, mapFile: string, code: string): Promise<Joined | null> {
    const hash = await hashMap(mapFile);
    try {
      const entry = { instance: '', dimension, players: 0, capacity: 0, seals: 0, sealsTotal: 0, gameVersion: GAME_VERSION, code, name: '', host: '' } as BoardEntry;
      const session = await this.net.joinInstance(entry, hash, false, JOIN_TRY_MS * 2);
      return { session, isHost: false, code, stop: () => session.leave() };
    } catch {
      return null;
    }
  }

  /** Opens this player's world to friends: the session and its code. */
  openWorld(capacity: number): Promise<{ session: Session; code: string; stop: () => void }> {
    return this.net.hostWorld(capacity);
  }

  /** Visits a friend's world by its code: the link, once the host has said
   *  what world it is. Throws (with words for the player) if it cannot. */
  async joinWorld(code: string): Promise<WorldGuest> {
    const session = await this.net.joinWorld(code);
    const guest = new WorldGuest(session, code);
    try {
      await guest.hello();
    } catch (e) {
      session.leave();
      throw e;
    }
    return guest;
  }
}
