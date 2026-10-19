// A multiplayer session: who is in it, who hosts, and the links between them.
// Engine-agnostic: it moves bytes and keeps membership, and the game reads
// and writes its own messages through `send`, `broadcast` and `on.message`.
//
// Two shapes:
// - Overworld (star): guests link to the host only. When the host leaves,
//   the session ends for everyone. A guest whose link drops may rejoin (by
//   the same code) within the reconnect window and gets its slot back.
// - Dimension (mesh): every member links to every other. The host admits
//   newcomers and introduces them to the rest, relaying their session
//   descriptions over the links it already has, so only the first link
//   ever needs signaling. When the host goes, the longest-connected member
//   (lowest join order, then lowest key) takes over from the last run state,
//   over the links that already exist.
//
// The host owns membership: it hands out slots (1–254; the first host is 0)
// and join orders, and tells everyone who joined, left or went away.

import { helloDigest, hostDigest, newNonce, signDigest, verifyDigest } from './auth';
import { compareBytes, equalBytes, Reader, toHex, Writer } from './codec';
import { cleanName } from './identity';
import {
  CTRL,
  isSessionMsg,
  KEY_BYTES,
  MAX_CTRL_BYTES,
  MAX_MEMBERS,
  MAX_SNAP_BYTES,
  Mode,
  Msg,
  PROTOCOL,
  readChallenge,
  readHandoff,
  readHello,
  readHostClaim,
  readIntro,
  readMemberJoined,
  readPeerHello,
  readPing,
  readReject,
  readRunState,
  readSlotMsg,
  readWelcome,
  RejectReason,
  typeOf,
  writeBye,
  writeChallenge,
  writeHandoff,
  writeHello,
  writeHostClaim,
  writeIntro,
  writeMemberJoined,
  writePeerHello,
  writePing,
  writePong,
  writeReject,
  writeRunState,
  writeSlotMsg,
  writeWelcome,
  type Channel,
  type Member,
  type PingMsg,
  type RunState,
  type Welcome,
} from './protocol';
import type { CloseReason, Linker, Transport } from './transport';

export type Role = 'host' | 'guest';

/** Why a session ended for this player. */
export type EndReason = 'left' | 'host-left' | 'kicked' | 'rejected' | 'lost';

export interface SessionConfig {
  mode: Mode;
  gameVersion: string;
  /** The dimension's id; empty for the overworld. */
  dimension: string;
  /** SHA-256 of the dimension's map file; zeros for the overworld. */
  mapHash: Uint8Array;
  /** This player's public key (32 bytes) and its secret, to prove it in a Hello. */
  key: Uint8Array;
  secret: Uint8Array;
  name: string;
  linker: Linker;
  /** Most members, the host included: 5 in the overworld, 8 in a dimension by default. */
  capacity?: number;
  /** How long an away member's slot is held, in ms. */
  reconnectMs?: number;
  /** Ping period, in ms. */
  pingMs?: number;
  /** Longest wait for a link's Hello or Welcome, in ms. */
  helloMs?: number;
  /** Longest wait for the expected new host to claim, in ms. */
  claimMs?: number;
  isBlocked?: (key: Uint8Array) => boolean;
  now?: () => number;
}

export interface SessionEvents {
  /** Host: may this player join? Default yes. */
  joinRequest?(name: string, key: Uint8Array | null): boolean | Promise<boolean>;
  peerJoined?(member: Member): void;
  /** A member's link dropped; their slot is held for a while. */
  peerAway?(slot: number): void;
  /** An away member came back. */
  peerBack?(member: Member): void;
  peerLeft?(slot: number, reason: 'left' | 'timeout' | 'kicked'): void;
  /** A game message (type 32 and up) from a member. */
  message?(slot: number, channel: Channel, data: Uint8Array): void;
  /** The host changed (or this player became it). */
  roleChanged?(role: Role, hostSlot: number): void;
  /** New run state from the host. */
  runState?(state: RunState): void;
  /** Overworld guest: the link to the host dropped; rejoin by code within the window. */
  hostLost?(): void;
  ended?(reason: EndReason, detail?: RejectReason | CloseReason): void;
}

interface Peer {
  member: Member;
  link: Transport | null;
  away: boolean;
  awayTimer: ReturnType<typeof setTimeout> | undefined;
  /** Round trip, in ms, smoothed; -1 until measured. */
  rtt: number;
  /** What its link may still send (see `spend`). */
  budget: Budget;
}

/** A link's allowance: a token bucket for messages and one for bytes, and
 *  how often it ran over lately. */
interface Budget {
  msgs: number;
  bytes: number;
  at: number;
  strikes: number;
}

/** Why connecting to a host failed. `impostor`: the other end was not the host it should be. */
export class ConnectError extends Error {
  constructor(readonly reason: RejectReason | CloseReason | 'timeout' | 'impostor') {
    super(typeof reason === 'number' ? `Refused (${reason})` : reason);
  }
}

const RECONNECT_MS = 30_000;
const PING_MS = 2000;
const HELLO_MS = 10_000;
const CLAIM_MS = 5000;
/** A link closed right after a last message still delivers it. */
const LINGER_MS = 250;
const ZERO_HASH = new Uint8Array(32);
/** What one link may send: messages and bytes a second, and the most at once.
 *  Generous for play (a guest's first chunks come in a burst); a flood past
 *  them is dropped, and a link that keeps flooding is closed. */
const MSG_RATE = 200;
const MSG_BURST = 600;
const BYTE_RATE = 256 * 1024;
const BYTE_BURST = 1024 * 1024;
const MAX_STRIKES = 200;
/** Two members taking over for the same handover settle it within this many claim waits. */
const RIVAL_WINDOW = 2;
/** An introduction between two slots, as one number. */
const pair = (from: number, to: number): number => (from << 8) | to;
const newBudget = (at: number): Budget => ({ msgs: MSG_BURST, bytes: BYTE_BURST, at, strikes: 0 });

export class Session {
  role: Role;
  /** This player's slot, -1 until welcomed. */
  slot = -1;
  hostSlot = -1;
  /** Rises with each new host. */
  epoch = 0;
  /** This player's join order. */
  order = 0;
  /** Everyone else in the session. */
  readonly peers = new Map<number, Peer>();
  on: SessionEvents = {};
  /** For the network's own glue (rejoining, re-listening): called alongside `on`. */
  readonly hooks: { hostLost?: () => void; roleChanged?: (role: Role) => void; ended?: () => void } = {};
  /** The last run state from the host (or set here as host). */
  runState: RunState | null = null;
  ended: EndReason | null = null;

  private readonly cfg: Required<Omit<SessionConfig, 'isBlocked'>> & Pick<SessionConfig, 'isBlocked'>;
  private readonly w = new Writer(2048);
  private readonly r = new Reader();
  private readonly ping: PingMsg = { seq: 0, sent: 0, reply: 0 };
  private pingSeq = 0;
  private pingTimer: ReturnType<typeof setInterval> | undefined;
  /** Links the host is waiting on for a Hello. */
  private readonly pending = new Set<Transport>();
  /** Offers made at the host's request, waiting for answers, by target slot. */
  private readonly intros = new Map<number, { link: Transport; complete(answer: string): Promise<void> }>();
  /** The link to the host (guests). */
  private hostLink: Transport | null = null;
  private nextOrder = 1;
  /** Session clock = local clock + this (see `time`). */
  private offset = 0;
  private bestRtt = Infinity;
  private lostTimer: ReturnType<typeof setTimeout> | undefined;
  private claimTimer: ReturnType<typeof setTimeout> | undefined;
  /** Members passed over as the next host because they never claimed. */
  private readonly skipped = new Set<number>();
  /** When the current host took over: a rival claim for the same handover
   *  counts only for a moment after it. */
  private hostSince = 0;
  /** Host: keys sent away this session; they may not come back. */
  private readonly kicked = new Set<string>();
  /** Host, mesh: introductions asked for, so only those are relayed: offers
   *  expected (from, to), and the answers expected back. */
  private readonly introOffers = new Set<number>();
  private readonly introAnswers = new Set<number>();
  /** Guest, mesh: offers being answered, by the offering slot. */
  private readonly answering = new Set<number>();
  /** Guest: the host's key, proved on the link; a rejoin must find the same one. */
  private knownHost: Uint8Array | null = null;
  /** Waiting for the expected new host to claim. */
  private awaiting = false;
  /** A claim heard while the host was still reachable: kept in case it goes. */
  private heldClaim: { slot: number; epoch: number } | null = null;
  private connecting: { resolve(w: Welcome): void; reject(e: ConnectError): void; timer: ReturnType<typeof setTimeout> } | null = null;

  private constructor(config: SessionConfig, role: Role) {
    const mesh = config.mode === Mode.Dimension;
    this.cfg = {
      capacity: Math.min(MAX_MEMBERS, config.capacity ?? (mesh ? MAX_MEMBERS : 5)),
      reconnectMs: RECONNECT_MS,
      pingMs: PING_MS,
      helloMs: HELLO_MS,
      claimMs: CLAIM_MS,
      now: Date.now,
      ...config,
      mapHash: config.mode === Mode.Overworld ? ZERO_HASH : config.mapHash,
    };
    this.role = role;
    this.pingTimer = setInterval(() => this.pingAll(), this.cfg.pingMs);
  }

  /** A new session with this player as host (slot 0). */
  static host(config: SessionConfig): Session {
    const s = new Session(config, 'host');
    s.slot = 0;
    s.hostSlot = 0;
    s.epoch = 1;
    s.hostSince = s.cfg.now();
    return s;
  }

  /** A session to join: call `connect` with a link to the host. */
  static guest(config: SessionConfig): Session {
    return new Session(config, 'guest');
  }

  /** Guest: the host's key as it proved it on the link, once welcomed. */
  get hostKey(): Uint8Array | null {
    return this.knownHost;
  }

  /** The dimension's id; empty for the overworld. */
  get dimension(): string {
    return this.cfg.dimension;
  }

  get mesh(): boolean {
    return this.cfg.mode === Mode.Dimension;
  }

  get isHost(): boolean {
    return this.role === 'host';
  }

  /** The shared clock in ms: the host's, as estimated from pings (continuous across new hosts). */
  time(): number {
    return this.cfg.now() + this.offset;
  }

  /** Everyone, this player included. */
  members(): Member[] {
    const list = [...this.peers.values()].map((p) => p.member);
    if (this.slot >= 0) list.push(this.self());
    return list.sort((a, b) => a.order - b.order);
  }

  private self(): Member {
    return { slot: this.slot, key: this.cfg.key, name: this.cfg.name, order: this.order };
  }

  /** Round trip to a member in ms, or -1. */
  rttTo(slot: number): number {
    return this.peers.get(slot)?.rtt ?? -1;
  }

  // -------------------------------------------------------------------------
  // Sending.

  send(slot: number, channel: Channel, data: Uint8Array): boolean {
    const link = slot === this.hostSlot && !this.isHost ? (this.hostLink ?? this.peers.get(slot)?.link) : this.peers.get(slot)?.link;
    return link ? link.send(channel, data) : false;
  }

  sendToHost(channel: Channel, data: Uint8Array): boolean {
    return this.isHost ? false : this.send(this.hostSlot, channel, data);
  }

  /** To every member linked to this one (in the overworld, a guest reaches only the host). */
  broadcast(channel: Channel, data: Uint8Array, except = -1): void {
    for (const [slot, p] of this.peers) if (slot !== except && p.link && !p.away) p.link.send(channel, data);
  }

  /** Host: shares the run state with everyone (and keeps it, for a new host). */
  setRunState(state: RunState): void {
    if (!this.isHost) return;
    this.runState = state;
    this.broadcast(CTRL, writeRunState(this.w, state));
  }

  // -------------------------------------------------------------------------
  // Joining.

  private isFull(): boolean {
    return this.peers.size + 1 >= this.cfg.capacity;
  }

  /** Host: a join offer arrived through signaling. Returns the answer to send
   *  back, or why not. The joiner's claimed key is checked again on the link. */
  async admit(offer: string, name: string, claimedKey: Uint8Array | null): Promise<{ answer: string } | { reject: RejectReason }> {
    if (!this.isHost || this.ended) return { reject: RejectReason.Closing };
    const returning = claimedKey && [...this.peers.values()].some((p) => equalBytes(p.member.key, claimedKey));
    if (this.isFull() && !returning) return { reject: RejectReason.Full };
    if (claimedKey && (this.cfg.isBlocked?.(claimedKey) || this.kicked.has(toHex(claimedKey)))) return { reject: RejectReason.Blocked };
    if (!returning && this.on.joinRequest && !(await this.on.joinRequest(name, claimedKey))) return { reject: RejectReason.Declined };
    let made: { sdp: string; link: Transport };
    try {
      made = await this.cfg.linker.answer(offer);
    } catch {
      return { reject: RejectReason.BadHello };
    }
    this.watchPending(made.link, claimedKey);
    return { answer: made.sdp };
  }

  /** Host: a link that must say Hello in time, from the key it claimed when it
   *  asked (a returning member skips the host's question, so it must be them).
   *  The host's challenge proves the host's own key on the link too. */
  private watchPending(link: Transport, claimedKey: Uint8Array | null): void {
    this.pending.add(link);
    const timer = setTimeout(() => {
      if (this.pending.delete(link)) link.close();
    }, this.cfg.helloMs);
    const nonce = newNonce();
    const challenge = () => {
      const cfg = this.cfg;
      const hostSig = signDigest(cfg.secret, hostDigest(nonce, link.binding(), cfg.key));
      link.send(CTRL, writeChallenge(this.w, { nonce, hostKey: cfg.key, hostSig }));
    };
    link.onOpen = challenge;
    if (link.open) challenge();
    link.onMessage = (channel, data) => {
      if (channel === CTRL && typeOf(data) === Msg.Hello) {
        clearTimeout(timer);
        this.pending.delete(link);
        this.hello(link, data, nonce, claimedKey);
      }
    };
    link.onClose = () => {
      clearTimeout(timer);
      this.pending.delete(link);
    };
  }

  private refuse(link: Transport, reason: RejectReason): void {
    link.send(CTRL, writeReject(this.w, reason));
    setTimeout(() => link.close(), LINGER_MS);
  }

  private hello(link: Transport, data: Uint8Array, nonce: Uint8Array, claimedKey: Uint8Array | null): void {
    const h = readHello(this.r, data);
    const cfg = this.cfg;
    if (!h) return this.refuse(link, RejectReason.BadHello);
    // They must hold the key they name, on this very link, and be who asked to come in.
    if (!verifyDigest(h.key, helloDigest(nonce, link.binding(), h.key), h.sig)) return this.refuse(link, RejectReason.BadHello);
    if (claimedKey && !equalBytes(claimedKey, h.key)) return this.refuse(link, RejectReason.BadHello);
    if (this.kicked.has(toHex(h.key))) return this.refuse(link, RejectReason.Blocked);
    h.name = cleanName(h.name) || 'Traveller';
    if (h.protocol !== PROTOCOL) return this.refuse(link, RejectReason.Protocol);
    if (h.gameVersion !== cfg.gameVersion) return this.refuse(link, RejectReason.GameVersion);
    if (h.mode !== cfg.mode || h.dimension !== cfg.dimension) return this.refuse(link, RejectReason.WrongMode);
    if (!equalBytes(h.mapHash, cfg.mapHash)) return this.refuse(link, RejectReason.MapMismatch);
    if (equalBytes(h.key, cfg.key) || cfg.isBlocked?.(h.key)) return this.refuse(link, RejectReason.Blocked);

    let peer = [...this.peers.values()].find((p) => equalBytes(p.member.key, h.key));
    const resumed = !!peer;
    if (peer) {
      // Back within the window, or a new link replacing one not yet seen to drop.
      clearTimeout(peer.awayTimer);
      peer.awayTimer = undefined;
      const old = peer.link;
      if (old && old !== link) {
        old.onClose = null;
        old.close();
      }
      peer.away = false;
      peer.member.name = h.name;
    } else {
      if (this.isFull()) return this.refuse(link, RejectReason.Full);
      const slot = this.freeSlot();
      if (slot < 0) return this.refuse(link, RejectReason.Full);
      peer = { member: { slot, key: h.key, name: h.name, order: this.nextOrder++ }, link: null, away: false, awayTimer: undefined, rtt: -1, budget: newBudget(this.cfg.now()) };
      this.peers.set(slot, peer);
    }
    this.bind(link, peer.member.slot);
    link.send(CTRL, writeWelcome(this.w, { slot: peer.member.slot, hostSlot: this.slot, epoch: this.epoch, hostTime: this.time(), resumed, members: this.members() }));
    if (this.runState) link.send(CTRL, writeRunState(this.w, this.runState));
    this.broadcast(CTRL, writeMemberJoined(this.w, peer.member), peer.member.slot);
    if (this.mesh) this.introduce(peer.member.slot);
    if (resumed) this.on.peerBack?.(peer.member);
    else this.on.peerJoined?.(peer.member);
  }

  private freeSlot(): number {
    for (let s = 1; s < 255; s++) if (s !== this.slot && !this.peers.has(s)) return s;
    return -1;
  }

  /** Host, mesh: asks every other member to link to the newcomer. */
  private introduce(newcomer: number): void {
    for (const [slot, p] of this.peers) {
      if (slot === newcomer || !p.link || p.away) continue;
      this.introOffers.add(pair(slot, newcomer));
      p.link.send(CTRL, writeIntro(this.w, { kind: 0, from: this.slot, to: newcomer, sdp: '' }));
    }
  }

  /** Guest: says Hello on a link to the host and waits for the welcome.
   *  Also used to rejoin after the link dropped. The host proves its key on
   *  the link first: it must be `expectHost` if given (the board's host), and
   *  on a rejoin the host met before. */
  connect(link: Transport, options: { expectHost?: Uint8Array | null; timeoutMs?: number } = {}): Promise<Welcome> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.failConnect(new ConnectError('timeout'), link), options.timeoutMs ?? this.cfg.helloMs + 15_000);
      this.connecting = { resolve, reject, timer };
      const cfg = this.cfg;
      const expect = options.expectHost ?? this.knownHost;
      let hostKey: Uint8Array | null = null;
      link.onOpen = null;
      link.onMessage = (channel, data) => {
        if (channel !== CTRL) return;
        const type = typeOf(data);
        if (type === Msg.Challenge) {
          const c = readChallenge(this.r, data);
          if (!c || hostKey) return;
          if (!verifyDigest(c.hostKey, hostDigest(c.nonce, link.binding(), c.hostKey), c.hostSig) || (expect && !equalBytes(expect, c.hostKey))) {
            this.failConnect(new ConnectError('impostor'), link);
            return;
          }
          hostKey = c.hostKey;
          const sig = signDigest(cfg.secret, helloDigest(c.nonce, link.binding(), cfg.key));
          link.send(CTRL, writeHello(this.w, { protocol: PROTOCOL, gameVersion: cfg.gameVersion, mode: cfg.mode, dimension: cfg.dimension, mapHash: cfg.mapHash, key: cfg.key, name: cfg.name, sig }));
        } else if (type === Msg.Welcome) {
          if (hostKey) this.welcomed(link, data, hostKey);
        }
        else if (type === Msg.Reject) this.failConnect(new ConnectError(readReject(this.r, data) ?? RejectReason.BadHello), link);
      };
      link.onClose = (reason) => this.failConnect(new ConnectError(reason), link);
    });
  }

  private failConnect(e: ConnectError, link: Transport): void {
    const c = this.connecting;
    if (!c) return;
    this.connecting = null;
    clearTimeout(c.timer);
    link.onClose = null;
    link.close();
    c.reject(e);
  }

  private welcomed(link: Transport, data: Uint8Array, hostKey: Uint8Array): void {
    const c = this.connecting;
    const m = readWelcome(this.r, data);
    if (!c || !m) return;
    // The host it names must be the one that proved itself on this link.
    const named = m.members.find((x) => x.slot === m.hostSlot);
    if (!named || !equalBytes(named.key, hostKey) || m.slot === m.hostSlot) {
      this.failConnect(new ConnectError('impostor'), link);
      return;
    }
    this.knownHost = hostKey;
    this.connecting = null;
    clearTimeout(c.timer);
    clearTimeout(this.lostTimer);
    this.lostTimer = undefined;
    this.slot = m.slot;
    this.hostSlot = m.hostSlot;
    this.epoch = m.epoch;
    this.hostSince = this.cfg.now();
    this.offset = m.hostTime - this.cfg.now();
    this.bestRtt = Infinity;
    const known = new Set<number>();
    for (const member of m.members) {
      if (member.slot === m.slot) {
        this.order = member.order;
        continue;
      }
      known.add(member.slot);
      member.name = cleanName(member.name) || 'Traveller';
      const p = this.peers.get(member.slot);
      if (p) p.member = member;
      else this.peers.set(member.slot, { member, link: null, away: false, awayTimer: undefined, rtt: -1, budget: newBudget(this.cfg.now()) });
    }
    for (const slot of [...this.peers.keys()]) if (!known.has(slot)) this.dropPeer(slot);
    this.hostLink = link;
    this.bind(link, m.hostSlot);
    c.resolve(m);
  }

  // -------------------------------------------------------------------------
  // Links.

  /** Makes `link` the link to `slot` and routes its messages. */
  private bind(link: Transport, slot: number): void {
    const p = this.peers.get(slot);
    if (p) p.link = link;
    link.onMessage = (channel, data) => this.receive(slot, link, channel, data);
    link.onClose = (reason) => this.linkClosed(slot, link, reason);
  }

  private receive(slot: number, link: Transport, channel: Channel, data: Uint8Array): void {
    if (this.ended) return;
    if (data.length > (channel === CTRL ? MAX_CTRL_BYTES : MAX_SNAP_BYTES)) return;
    const peer = this.peers.get(slot);
    if (peer && !this.spend(peer.budget, data.length)) {
      // Flooding: dropped, and a link that will not stop is cut.
      if (peer.budget.strikes > MAX_STRIKES && peer.link === link) link.close();
      return;
    }
    const type = typeOf(data);
    if (!isSessionMsg(type)) {
      if (type >= 32) this.on.message?.(slot, channel, data);
      return;
    }
    if (channel !== CTRL && type !== Msg.Ping && type !== Msg.Pong) return;
    const fromHost = slot === this.hostSlot;
    switch (type) {
      case Msg.Ping:
        if (readPing(this.r, data, this.ping)) link.send(channel, writePong(this.w, this.ping.seq, this.ping.sent, this.time()));
        break;
      case Msg.Pong:
        if (readPing(this.r, data, this.ping)) this.pong(slot);
        break;
      case Msg.MemberJoined: {
        const m = fromHost && !this.isHost ? readMemberJoined(this.r, data) : null;
        if (!m || m.slot === this.slot) break;
        m.name = cleanName(m.name) || 'Traveller';
        const p = this.peers.get(m.slot);
        if (p) {
          p.member = m;
          if (p.away) {
            p.away = false;
            this.on.peerBack?.(m);
          }
        } else {
          this.peers.set(m.slot, { member: m, link: null, away: false, awayTimer: undefined, rtt: -1, budget: newBudget(this.cfg.now()) });
          this.on.peerJoined?.(m);
        }
        break;
      }
      case Msg.MemberLeft: {
        const s = fromHost && !this.isHost ? readSlotMsg(this.r, data) : null;
        if (s !== null && s !== this.slot && this.peers.has(s)) {
          this.dropPeer(s);
          this.on.peerLeft?.(s, 'left');
        }
        break;
      }
      case Msg.MemberAway: {
        const s = fromHost && !this.isHost ? readSlotMsg(this.r, data) : null;
        const p = s !== null ? this.peers.get(s) : undefined;
        if (p && !p.away) {
          p.away = true;
          this.on.peerAway?.(s!);
        }
        break;
      }
      case Msg.Intro:
        this.intro(slot, data);
        break;
      case Msg.PeerHello: {
        const h = readPeerHello(this.r, data);
        const p = this.peers.get(slot);
        if (!h || h.slot !== slot || !p || !equalBytes(h.key, p.member.key)) link.close();
        break;
      }
      case Msg.HostClaim: {
        const c = readHostClaim(this.r, data);
        if (c && c.slot === slot) this.claim(c.slot, c.epoch);
        break;
      }
      case Msg.Handoff: {
        const h = fromHost ? readHandoff(this.r, data) : null;
        if (h) this.handoff(h.successor, h.epoch);
        break;
      }
      case Msg.Bye:
        this.bye(slot);
        break;
      case Msg.RunState: {
        const s = fromHost && !this.isHost ? readRunState(this.r, data) : null;
        if (s && (!this.runState || s.version >= this.runState.version)) {
          this.runState = s;
          this.on.runState?.(s);
        }
        break;
      }
      case Msg.Reject: {
        const reason = fromHost && !this.isHost ? readReject(this.r, data) : null;
        if (reason !== null) this.end(reason === RejectReason.Kicked ? 'kicked' : 'rejected', reason);
        break;
      }
      default:
        break;
    }
  }

  /** Takes a message from a link's allowance; false if it has run out. */
  private spend(b: Budget, bytes: number): boolean {
    const now = this.cfg.now();
    const secs = Math.max(0, now - b.at) / 1000;
    b.at = now;
    b.msgs = Math.min(MSG_BURST, b.msgs + secs * MSG_RATE);
    b.bytes = Math.min(BYTE_BURST, b.bytes + secs * BYTE_RATE);
    // Strikes fade as the link behaves.
    b.strikes = Math.max(0, b.strikes - secs * 20);
    if (b.msgs < 1 || b.bytes < bytes) {
      b.strikes++;
      return false;
    }
    b.msgs--;
    b.bytes -= bytes;
    return true;
  }

  private pong(slot: number): void {
    const p = this.peers.get(slot);
    if (!p) return;
    const now = this.cfg.now();
    const rtt = Math.max(0, now - this.ping.sent);
    p.rtt = p.rtt < 0 ? rtt : p.rtt * 0.8 + rtt * 0.2;
    // The host's clock, from its pongs: trust the quickest round trips most.
    if (!this.isHost && slot === this.hostSlot && rtt <= this.bestRtt * 1.5 + 5) {
      this.bestRtt = Math.min(this.bestRtt, rtt);
      const sample = this.ping.reply + rtt / 2 - now;
      this.offset = this.offset * 0.7 + sample * 0.3;
    }
  }

  private pingAll(): void {
    if (this.ended) return;
    const seq = (this.pingSeq = (this.pingSeq + 1) & 0xffff);
    const msg = writePing(this.w, seq, this.cfg.now());
    for (const p of this.peers.values()) p.link?.send(CTRL, msg);
  }

  private linkClosed(slot: number, link: Transport, _reason: CloseReason): void {
    if (this.ended) return;
    const p = this.peers.get(slot);
    if (p?.link === link) p.link = null;
    if (link === this.hostLink) this.hostLink = null;
    if (this.isHost) {
      if (!p || p.away) return;
      // Hold their slot for a while: they may be back.
      p.away = true;
      this.broadcast(CTRL, writeSlotMsg(this.w, Msg.MemberAway, slot));
      p.awayTimer = setTimeout(() => this.expire(slot), this.cfg.reconnectMs);
      this.on.peerAway?.(slot);
      return;
    }
    if (slot !== this.hostSlot) return;
    if (this.mesh) this.migrate();
    else {
      this.on.hostLost?.();
      this.hooks.hostLost?.();
      this.lostTimer = setTimeout(() => this.end('lost'), this.cfg.reconnectMs);
    }
  }

  /** Host: an away member did not come back in time. */
  private expire(slot: number): void {
    const p = this.peers.get(slot);
    if (!p?.away) return;
    this.dropPeer(slot);
    this.broadcast(CTRL, writeSlotMsg(this.w, Msg.MemberLeft, slot));
    this.on.peerLeft?.(slot, 'timeout');
  }

  private dropPeer(slot: number): void {
    const p = this.peers.get(slot);
    if (!p) return;
    clearTimeout(p.awayTimer);
    this.peers.delete(slot);
    const link = p.link;
    if (link && link !== this.hostLink) {
      link.onClose = null;
      link.close();
    }
    const intro = this.intros.get(slot);
    if (intro) {
      this.intros.delete(slot);
      intro.link.close();
    }
    this.answering.delete(slot);
    for (const set of [this.introOffers, this.introAnswers]) {
      for (const k of set) if (k >> 8 === slot || (k & 0xff) === slot) set.delete(k);
    }
  }

  private bye(slot: number): void {
    if (this.isHost) {
      if (!this.peers.has(slot)) return;
      this.dropPeer(slot);
      this.broadcast(CTRL, writeSlotMsg(this.w, Msg.MemberLeft, slot));
      this.on.peerLeft?.(slot, 'left');
    } else if (slot === this.hostSlot) {
      // A host leaving a dimension hands off first; without that, migrate.
      if (this.mesh) {
        this.dropHostLink();
        this.migrate();
      } else this.end('host-left');
    } else if (this.peers.has(slot)) {
      this.dropPeer(slot);
      this.on.peerLeft?.(slot, 'left');
    }
  }

  private dropHostLink(): void {
    const link = this.hostLink;
    this.hostLink = null;
    const p = this.peers.get(this.hostSlot);
    if (p) p.link = null;
    if (link) {
      link.onClose = null;
      link.close();
    }
  }

  // -------------------------------------------------------------------------
  // Mesh introductions.

  private intro(slot: number, data: Uint8Array): void {
    if (!this.mesh) return;
    const m = readIntro(this.r, data);
    if (!m) return;
    if (this.isHost) {
      // Relay an offer or answer between two members; they must be who they
      // say, and send only what this host asked for: one offer per
      // introduction, and its answer back.
      if (m.kind === 0 || m.from !== slot) return;
      const target = this.peers.get(m.to);
      if (!target?.link || target.away) return;
      if (m.kind === 1) {
        if (!this.introOffers.delete(pair(slot, m.to))) return;
        this.introAnswers.add(pair(m.to, slot));
      } else if (!this.introAnswers.delete(pair(slot, m.to))) return;
      target.link.send(CTRL, writeIntro(this.w, m));
      return;
    }
    if (slot !== this.hostSlot) return;
    if (m.kind === 0) void this.offerTo(m.to);
    else if (m.kind === 1) void this.answerFrom(m.from, m.sdp);
    else {
      const pending = this.intros.get(m.from);
      if (!pending) return;
      this.intros.delete(m.from);
      pending.complete(m.sdp).catch(() => pending.link.close());
    }
  }

  /** Asked by the host: make an offer to a newcomer. */
  private async offerTo(slot: number): Promise<void> {
    const p = this.peers.get(slot);
    if (!p || p.link || this.intros.has(slot)) return;
    let made;
    try {
      made = await this.cfg.linker.offer();
    } catch {
      return;
    }
    if (this.ended || !this.peers.has(slot)) {
      made.link.close();
      return;
    }
    this.intros.get(slot)?.link.close();
    this.intros.set(slot, { link: made.link, complete: made.complete });
    this.directLink(made.link, slot);
    this.sendToHost(CTRL, writeIntro(this.w, { kind: 1, from: this.slot, to: slot, sdp: made.sdp }));
  }

  /** An offer from another member, relayed by the host: answer it. */
  private async answerFrom(slot: number, sdp: string): Promise<void> {
    const p = this.peers.get(slot);
    // One link per member: an offer while one is open or being answered is ignored.
    if (!p || p.link || this.answering.has(slot)) return;
    this.answering.add(slot);
    let made;
    try {
      made = await this.cfg.linker.answer(sdp);
    } catch {
      this.answering.delete(slot);
      return;
    }
    if (this.ended || !this.peers.has(slot)) {
      this.answering.delete(slot);
      made.link.close();
      return;
    }
    this.directLink(made.link, slot);
    this.sendToHost(CTRL, writeIntro(this.w, { kind: 2, from: this.slot, to: slot, sdp: made.sdp }));
  }

  /** A link to another member: once open, says who this is, then carries messages. */
  private directLink(link: Transport, slot: number): void {
    link.onOpen = () => {
      const p = this.peers.get(slot);
      if (this.ended || !p) {
        link.close();
        return;
      }
      if (p.link && p.link !== link) {
        // Both sides offered at once (after a new host): keep one.
        link.close();
        return;
      }
      this.intros.delete(slot);
      this.answering.delete(slot);
      this.bind(link, slot);
      link.send(CTRL, writePeerHello(this.w, this.slot, this.cfg.key));
    };
    link.onClose = () => {
      this.answering.delete(slot);
      const pending = this.intros.get(slot);
      if (pending?.link === link) this.intros.delete(slot);
    };
  }

  // -------------------------------------------------------------------------
  // Hosts.

  /** Mesh guest: the host is gone; work out who takes over. */
  private migrate(): void {
    const old = this.hostSlot;
    if (this.peers.has(old)) this.dropPeer(old);
    this.skipped.clear();
    this.pickHost(old);
  }

  /** Accepts a claim heard earlier, if it is the next host's own, for this
   *  handover, and its claimer is still reachable. */
  private takeHeldClaim(): boolean {
    const held = this.heldClaim;
    this.heldClaim = null;
    if (!held || held.epoch !== this.epoch + 1 || !this.peers.get(held.slot)?.link || held.slot !== this.successor()) return false;
    this.accept(held.slot, held.epoch);
    return true;
  }

  /** The longest-connected member left (lowest order, then lowest key) among
   *  those this one can reach, leaving out `except`. */
  private successor(except = -1): number {
    let best = this.self();
    for (const p of this.peers.values()) {
      const slot = p.member.slot;
      if (slot === except || p.away || !p.link || this.skipped.has(slot)) continue;
      const m = p.member;
      if (m.order < best.order || (m.order === best.order && compareBytes(m.key, best.key) < 0)) best = m;
    }
    return best.slot;
  }

  /** A member this one cannot reach would host before it: taking over would split the instance. */
  private outrankedUnseen(): boolean {
    for (const p of this.peers.values()) {
      const slot = p.member.slot;
      if (!p.link && !p.away && !this.skipped.has(slot) && this.ranks(slot, this.slot)) return true;
    }
    return false;
  }

  private pickHost(old: number): void {
    clearTimeout(this.claimTimer);
    this.awaiting = false;
    if (this.takeHeldClaim()) return;
    const next = this.successor();
    if (next === this.slot) {
      // Cut off from the one who should host: this side goes on alone rather than splitting.
      if (this.outrankedUnseen()) this.end('lost');
      else this.becomeHost(this.epoch + 1, old);
      return;
    }
    this.hostSlot = next;
    this.awaiting = true;
    // If they never claim (gone too), pass them over.
    this.claimTimer = setTimeout(() => {
      if (this.isHost || this.hostSlot !== next || !this.awaiting) return;
      this.skipped.add(next);
      this.pickHost(old);
    }, this.cfg.claimMs);
  }

  private becomeHost(epoch: number, old: number): void {
    clearTimeout(this.claimTimer);
    this.awaiting = false;
    this.heldClaim = null;
    this.role = 'host';
    this.hostSlot = this.slot;
    this.epoch = epoch;
    this.hostSince = this.cfg.now();
    this.hostLink = null;
    // The session clock carries on from the old host's: `offset` stays.
    let top = this.order;
    for (const p of this.peers.values()) top = Math.max(top, p.member.order);
    this.nextOrder = top + 1;
    this.broadcast(CTRL, writeHostClaim(this.w, { slot: this.slot, epoch }));
    if (old >= 0) this.broadcast(CTRL, writeSlotMsg(this.w, Msg.MemberLeft, old));
    // Members this one has no link to cannot be reached: they count as away.
    for (const [slot, p] of this.peers) {
      if (p.link || p.away) continue;
      p.away = true;
      p.awayTimer = setTimeout(() => this.expire(slot), this.cfg.reconnectMs);
    }
    if (this.runState) this.broadcast(CTRL, writeRunState(this.w, this.runState));
    this.on.roleChanged?.('host', this.slot);
    this.hooks.roleChanged?.('host');
  }

  /** Another member says it is the host now. Only a claim for the very next
   *  handover counts, and only from the member who should take over (the
   *  longest-connected one reachable, or one outranking it), so no member can
   *  seize the instance by claiming it. A host gives way only to a rival claim
   *  for the same handover that outranks it, made at the same moment; a member
   *  keeps (but does not act on) the next host's claim while its own host
   *  still answers, so one member losing its link to a live host cannot split
   *  the instance. */
  private claim(slot: number, epoch: number): void {
    if (!this.peers.get(slot)?.link) return;
    const rival = epoch === this.epoch && this.cfg.now() - this.hostSince < this.cfg.claimMs * RIVAL_WINDOW;
    if (this.isHost) {
      if (rival && this.ranks(slot, this.slot)) this.accept(slot, epoch);
      return;
    }
    const hostUp = !this.awaiting && slot !== this.hostSlot && !!this.peers.get(this.hostSlot)?.link;
    if (hostUp) {
      if (epoch === this.epoch + 1 && slot === this.successor(this.hostSlot)) this.heldClaim = { slot, epoch };
      return;
    }
    if (this.awaiting && epoch === this.epoch + 1 && (slot === this.hostSlot || this.ranks(slot, this.hostSlot))) this.accept(slot, epoch);
    else if (!this.awaiting && rival && slot !== this.hostSlot && this.ranks(slot, this.hostSlot)) this.accept(slot, epoch);
  }

  private accept(slot: number, epoch: number): void {
    const p = this.peers.get(slot);
    if (!p) return;
    clearTimeout(this.claimTimer);
    this.awaiting = false;
    this.heldClaim = null;
    const wasHost = this.isHost;
    const old = this.hostSlot;
    this.epoch = epoch;
    this.hostSlot = slot;
    this.hostSince = this.cfg.now();
    this.role = 'guest';
    this.hostLink = p.link;
    this.bestRtt = Infinity;
    if (old !== slot && old !== this.slot && this.peers.get(old)?.link === null && this.peers.has(old)) this.dropPeer(old);
    if (wasHost) {
      // Two claimed at once and this one lost: hand back what was taken over.
      for (const q of this.peers.values()) {
        clearTimeout(q.awayTimer);
        q.awayTimer = undefined;
        if (q.link) q.away = false;
      }
    }
    this.on.roleChanged?.('guest', slot);
    this.hooks.roleChanged?.('guest');
  }

  /** True if member `a` outranks `b` as host (earlier order, then lower key). */
  private ranks(a: number, b: number): boolean {
    const ma = a === this.slot ? this.self() : this.peers.get(a)?.member;
    const mb = b === this.slot ? this.self() : this.peers.get(b)?.member;
    if (!ma) return false;
    if (!mb) return true;
    return ma.order < mb.order || (ma.order === mb.order && compareBytes(ma.key, mb.key) < 0);
  }

  /** The host is leaving and names who takes over. */
  private handoff(successor: number, epoch: number): void {
    if (!this.mesh || epoch !== this.epoch + 1) return;
    const old = this.hostSlot;
    if (successor === this.slot) {
      this.dropHostLink();
      if (this.peers.has(old)) this.dropPeer(old);
      this.becomeHost(epoch, old);
    } else if (this.peers.has(successor)) {
      // Wait for their claim, as after a drop.
      this.dropHostLink();
      if (this.peers.has(old)) this.dropPeer(old);
      this.epoch = epoch - 1;
      this.hostSlot = successor;
      this.awaiting = true;
      clearTimeout(this.claimTimer);
      const held = this.heldClaim;
      if (held?.slot === successor && held.epoch === epoch && this.peers.get(successor)?.link) {
        this.accept(successor, epoch);
        return;
      }
      this.heldClaim = null;
      this.claimTimer = setTimeout(() => {
        if (this.isHost || this.hostSlot !== successor || !this.awaiting) return;
        this.skipped.add(successor);
        this.pickHost(old);
      }, this.cfg.claimMs);
    }
  }

  // -------------------------------------------------------------------------
  // Leaving.

  /** Host: removes a member (and they may not come back while blocked). */
  kick(slot: number): void {
    const p = this.peers.get(slot);
    if (!this.isHost || !p) return;
    this.kicked.add(toHex(p.member.key));
    if (p.link) {
      p.link.send(CTRL, writeReject(this.w, RejectReason.Kicked));
      const link = p.link;
      link.onClose = null;
      setTimeout(() => link.close(), LINGER_MS);
      p.link = null;
    }
    this.dropPeer(slot);
    this.broadcast(CTRL, writeSlotMsg(this.w, Msg.MemberLeft, slot));
    this.on.peerLeft?.(slot, 'kicked');
  }

  /** Leaves the session. A dimension host hands off to the longest-connected member first. */
  leave(): void {
    if (this.ended) return;
    if (this.isHost && this.mesh && this.peers.size) {
      const next = this.successorExcludingSelf();
      if (next >= 0) this.broadcast(CTRL, writeHandoff(this.w, { successor: next, epoch: this.epoch + 1 }));
    }
    this.broadcast(CTRL, writeBye(this.w));
    this.end('left');
  }

  private successorExcludingSelf(): number {
    let best: Member | null = null;
    for (const p of this.peers.values()) {
      if (p.away || !p.link) continue;
      const m = p.member;
      if (!best || m.order < best.order || (m.order === best.order && compareBytes(m.key, best.key) < 0)) best = m;
    }
    return best ? best.slot : -1;
  }

  private end(reason: EndReason, detail?: RejectReason | CloseReason): void {
    if (this.ended) return;
    this.ended = reason;
    clearInterval(this.pingTimer);
    clearTimeout(this.lostTimer);
    clearTimeout(this.claimTimer);
    const links = new Set<Transport>();
    for (const p of this.peers.values()) {
      clearTimeout(p.awayTimer);
      if (p.link) links.add(p.link);
    }
    for (const i of this.intros.values()) links.add(i.link);
    for (const l of this.pending) links.add(l);
    if (this.hostLink) links.add(this.hostLink);
    this.intros.clear();
    this.pending.clear();
    for (const l of links) {
      l.onClose = null;
      l.onMessage = null;
      // Let a Bye or Handoff go out first.
      setTimeout(() => l.close(), LINGER_MS);
    }
    this.on.ended?.(reason, detail);
    this.hooks.ended?.();
  }

  /** Ends the session at once, without telling anyone (tests, page unload). */
  dispose(): void {
    if (!this.ended) this.end('left');
  }
}

/** Keys travel as 32 bytes. */
export const isKey = (k: Uint8Array): boolean => k.length === KEY_BYTES;
