// The network messages: their type bytes, shapes, and binary encoding.
// Every message starts with its type byte. Types 1–31 belong to the session
// (joining, links between peers, hosts), 32–63 to the game. Decoders return
// null for anything malformed and never throw: a peer can send any bytes.
//
// Positions travel as whole 1/32 tiles in an i32 (about ±67 million tiles);
// health as a u16 share of the maximum. Item and entity kinds are u16 indices
// the game maps to its own ids; the codec knows nothing of them.

import { Reader, Writer } from './codec';

/** Raised whenever any message changes shape. Peers on another version are refused. */
export const PROTOCOL = 2;

/** Reliable, ordered: joining, events, requests, world and run state. */
export const CTRL = 0;
/** Unreliable, unordered: player state and snapshots, sent often. */
export const SNAP = 1;
export type Channel = typeof CTRL | typeof SNAP;

/** A snap-channel message must fit one packet (no IP fragmentation). */
export const MAX_SNAP_BYTES = 1200;
/** Longest ctrl message accepted, in bytes. */
export const MAX_CTRL_BYTES = 64 * 1024;

export const Msg = {
  // Session.
  Hello: 1,
  Welcome: 2,
  Reject: 3,
  Ping: 4,
  Pong: 5,
  MemberJoined: 6,
  MemberLeft: 7,
  MemberAway: 8,
  Intro: 9,
  PeerHello: 10,
  HostClaim: 11,
  Handoff: 12,
  Bye: 13,
  RunState: 14,
  Challenge: 15,
  // Game.
  PlayerState: 32,
  Snapshot: 33,
  Ack: 34,
  Event: 35,
  Request: 36,
  Response: 37,
  /** A shared overworld's own messages (the land, its objects, its ground);
   *  their shapes are the game's (`src/coop/worldWire.ts`). */
  World: 38,
} as const;
export type MsgType = (typeof Msg)[keyof typeof Msg];

/** True for types the session handles itself; the rest go to the game. */
export const isSessionMsg = (type: number): boolean => type >= 1 && type < 32;

/** The type byte of a message, or -1 if it is empty. */
export const typeOf = (data: Uint8Array): number => (data.length ? data[0] : -1);

export const Mode = { Overworld: 0, Dimension: 1 } as const;
export type Mode = (typeof Mode)[keyof typeof Mode];

/** Why a join was refused or a peer removed. */
export const RejectReason = {
  Protocol: 1,
  GameVersion: 2,
  WrongMode: 3,
  MapMismatch: 4,
  Full: 5,
  Blocked: 6,
  Declined: 7,
  RateLimited: 8,
  Kicked: 9,
  BadHello: 10,
  Closing: 11,
} as const;
export type RejectReason = (typeof RejectReason)[keyof typeof RejectReason];

export const REJECT_TEXT: Record<RejectReason, string> = {
  1: 'They are on a different version of the network protocol. Update the game.',
  2: 'They are on a different version of the game. Update the game.',
  3: 'That code is for a different kind of world.',
  4: 'Your copy of that dimension differs from theirs. Update the game.',
  5: 'That world is full.',
  6: 'You cannot join that world.',
  7: 'The host declined.',
  8: 'Too many tries. Wait a moment and try again.',
  9: 'The host removed you from the world.',
  10: 'The join request was malformed.',
  11: 'The world is closing.',
};

/** Public keys are 32-byte x-only secp256k1 keys (as on Nostr). */
export const KEY_BYTES = 32;
/** Map file hashes are SHA-256. */
export const HASH_BYTES = 32;
/** Schnorr signatures are 64 bytes. */
export const SIG_BYTES = 64;
/** Challenge nonces are 32 bytes. */
export const NONCE_BYTES = 32;
/** Most members a session holds, the host included. */
export const MAX_MEMBERS = 8;

// ---------------------------------------------------------------------------
// Session messages.

export interface Hello {
  protocol: number;
  gameVersion: string;
  mode: Mode;
  /** The dimension's id, empty for the overworld. */
  dimension: string;
  /** SHA-256 of the dimension's map file; zeros for the overworld. */
  mapHash: Uint8Array;
  key: Uint8Array;
  name: string;
  /** Signature by `key` over the host's challenge and this link (see `auth.ts`). */
  sig: Uint8Array;
}

export interface Member {
  slot: number;
  key: Uint8Array;
  name: string;
  /** When they joined, in the host's join count: lower is longer connected. */
  order: number;
}

export interface Welcome {
  slot: number;
  hostSlot: number;
  /** Rises with each new host. */
  epoch: number;
  /** The host's clock, in ms, when this was sent. */
  hostTime: number;
  /** Whether this rejoin took back a slot held while away. */
  resumed: boolean;
  members: Member[];
}

export interface IntroMsg {
  /** 0: please offer a link to `to`; 1: an offer from `from`; 2: an answer from `from`. */
  kind: 0 | 1 | 2;
  from: number;
  to: number;
  sdp: string;
}

export interface HostClaim {
  slot: number;
  epoch: number;
}

export interface Handoff {
  /** The member to take over as host. */
  successor: number;
  epoch: number;
}

export function writeHello(w: Writer, h: Hello): Uint8Array {
  w.reset().u8(Msg.Hello).u8(h.protocol).str(h.gameVersion).u8(h.mode).str(h.dimension).fixed(h.mapHash, HASH_BYTES).fixed(h.key, KEY_BYTES).str(h.name).fixed(h.sig, SIG_BYTES);
  return w.finish();
}

export function readHello(r: Reader, data: Uint8Array): Hello | null {
  r.reset(data);
  if (r.u8() !== Msg.Hello) return null;
  const protocol = r.u8();
  const gameVersion = r.str();
  const mode = r.u8();
  const dimension = r.str();
  const mapHash = r.fixed(HASH_BYTES);
  const key = r.fixed(KEY_BYTES);
  const name = r.str();
  const sig = r.fixed(SIG_BYTES);
  if (!r.done || (mode !== Mode.Overworld && mode !== Mode.Dimension)) return null;
  return { protocol, gameVersion, mode, dimension, mapHash, key, name, sig };
}

/** The host's first words on a new link: prove you hold your key. The host
 *  proves its own too: its key, signed over the nonce and this link (see
 *  `auth.ts`), so a stranger who answered a public code first is found out. */
export interface Challenge {
  nonce: Uint8Array;
  hostKey: Uint8Array;
  hostSig: Uint8Array;
}

export function writeChallenge(w: Writer, c: Challenge): Uint8Array {
  return w.reset().u8(Msg.Challenge).fixed(c.nonce, NONCE_BYTES).fixed(c.hostKey, KEY_BYTES).fixed(c.hostSig, SIG_BYTES).finish();
}

export function readChallenge(r: Reader, data: Uint8Array): Challenge | null {
  r.reset(data);
  if (r.u8() !== Msg.Challenge) return null;
  const nonce = r.fixed(NONCE_BYTES);
  const hostKey = r.fixed(KEY_BYTES);
  const hostSig = r.fixed(SIG_BYTES);
  return r.done ? { nonce, hostKey, hostSig } : null;
}

function writeMember(w: Writer, m: Member): void {
  w.u8(m.slot).fixed(m.key, KEY_BYTES).str(m.name).u32(m.order);
}

function readMember(r: Reader): Member {
  return { slot: r.u8(), key: r.fixed(KEY_BYTES), name: r.str(), order: r.u32() };
}

export function writeWelcome(w: Writer, m: Welcome): Uint8Array {
  w.reset().u8(Msg.Welcome).u8(m.slot).u8(m.hostSlot).u32(m.epoch).f64(m.hostTime).bool(m.resumed).u8(m.members.length);
  for (const member of m.members) writeMember(w, member);
  return w.finish();
}

export function readWelcome(r: Reader, data: Uint8Array): Welcome | null {
  r.reset(data);
  if (r.u8() !== Msg.Welcome) return null;
  const slot = r.u8();
  const hostSlot = r.u8();
  const epoch = r.u32();
  const hostTime = r.f64();
  const resumed = r.bool();
  const n = r.u8();
  if (n > MAX_MEMBERS) return null;
  const members: Member[] = [];
  for (let i = 0; i < n && r.ok; i++) members.push(readMember(r));
  return r.done ? { slot, hostSlot, epoch, hostTime, resumed, members } : null;
}

export function writeReject(w: Writer, reason: RejectReason): Uint8Array {
  return w.reset().u8(Msg.Reject).u8(reason).finish();
}

export function readReject(r: Reader, data: Uint8Array): RejectReason | null {
  r.reset(data);
  if (r.u8() !== Msg.Reject) return null;
  const reason = r.u8();
  return r.done && reason in REJECT_TEXT ? (reason as RejectReason) : null;
}

/** Ping and pong share a shape: a sequence number and the sender's clock;
 *  a pong also echoes the ping's clock. */
export interface PingMsg {
  seq: number;
  /** The pinger's clock when the ping left, in ms. */
  sent: number;
  /** The ponger's clock when it answered, in ms (pongs only). */
  reply: number;
}

export function writePing(w: Writer, seq: number, sent: number): Uint8Array {
  return w.reset().u8(Msg.Ping).u16(seq).f64(sent).finish();
}

export function writePong(w: Writer, seq: number, sent: number, reply: number): Uint8Array {
  return w.reset().u8(Msg.Pong).u16(seq).f64(sent).f64(reply).finish();
}

/** Reads a ping or a pong into `out`; false if malformed. */
export function readPing(r: Reader, data: Uint8Array, out: PingMsg): boolean {
  r.reset(data);
  const type = r.u8();
  out.seq = r.u16();
  out.sent = r.f64();
  out.reply = type === Msg.Pong ? r.f64() : 0;
  return r.done && (type === Msg.Ping || type === Msg.Pong);
}

export function writeMemberJoined(w: Writer, m: Member): Uint8Array {
  w.reset().u8(Msg.MemberJoined);
  writeMember(w, m);
  return w.finish();
}

export function readMemberJoined(r: Reader, data: Uint8Array): Member | null {
  r.reset(data);
  if (r.u8() !== Msg.MemberJoined) return null;
  const m = readMember(r);
  return r.done ? m : null;
}

/** MemberLeft and MemberAway: just a slot. Bye has none. */
export function writeSlotMsg(w: Writer, type: typeof Msg.MemberLeft | typeof Msg.MemberAway, slot: number): Uint8Array {
  return w.reset().u8(type).u8(slot).finish();
}

export function readSlotMsg(r: Reader, data: Uint8Array): number | null {
  r.reset(data);
  const type = r.u8();
  const slot = r.u8();
  return r.done && (type === Msg.MemberLeft || type === Msg.MemberAway) ? slot : null;
}

export function writeBye(w: Writer): Uint8Array {
  return w.reset().u8(Msg.Bye).finish();
}

export function writeIntro(w: Writer, m: IntroMsg): Uint8Array {
  return w.reset().u8(Msg.Intro).u8(m.kind).u8(m.from).u8(m.to).longStr(m.sdp).finish();
}

export function readIntro(r: Reader, data: Uint8Array): IntroMsg | null {
  r.reset(data);
  if (r.u8() !== Msg.Intro) return null;
  const kind = r.u8();
  const from = r.u8();
  const to = r.u8();
  const sdp = r.longStr();
  return r.done && kind <= 2 ? { kind: kind as 0 | 1 | 2, from, to, sdp } : null;
}

/** First message on a direct link between two members: who is on the other end. */
export function writePeerHello(w: Writer, slot: number, key: Uint8Array): Uint8Array {
  return w.reset().u8(Msg.PeerHello).u8(slot).fixed(key, KEY_BYTES).finish();
}

export function readPeerHello(r: Reader, data: Uint8Array): { slot: number; key: Uint8Array } | null {
  r.reset(data);
  if (r.u8() !== Msg.PeerHello) return null;
  const slot = r.u8();
  const key = r.fixed(KEY_BYTES);
  return r.done ? { slot, key } : null;
}

export function writeHostClaim(w: Writer, c: HostClaim): Uint8Array {
  return w.reset().u8(Msg.HostClaim).u8(c.slot).u32(c.epoch).finish();
}

export function readHostClaim(r: Reader, data: Uint8Array): HostClaim | null {
  r.reset(data);
  if (r.u8() !== Msg.HostClaim) return null;
  const slot = r.u8();
  const epoch = r.u32();
  return r.done ? { slot, epoch } : null;
}

export function writeHandoff(w: Writer, h: Handoff): Uint8Array {
  return w.reset().u8(Msg.Handoff).u8(h.successor).u32(h.epoch).finish();
}

export function readHandoff(r: Reader, data: Uint8Array): Handoff | null {
  r.reset(data);
  if (r.u8() !== Msg.Handoff) return null;
  const successor = r.u8();
  const epoch = r.u32();
  return r.done ? { successor, epoch } : null;
}

// ---------------------------------------------------------------------------
// A dimension instance's run state: what a new host needs to carry on.

/** Most trials, summons, chest shares and contributions a run state holds. */
export const MAX_TRIALS = 16;
export const MAX_CONTRIBUTORS = 32;
/** Room for the game's own run data (e.g. per-trial details), in bytes. */
export const MAX_RUN_EXTRA = 1024;

export interface Contribution {
  /** Who: their public key, so it survives slots being reused. */
  key: Uint8Array;
  score: number;
  /** May step through the portal and close their rift. */
  attuned: boolean;
  /** Has taken their share of the vault's chest. */
  claimed: boolean;
}

export interface RunState {
  /** Rises with each change, so stale copies are ignored. */
  version: number;
  /** Per trial: 0 idle, 1 active, 2 done. */
  trials: number[];
  /** Whether the boss gate is open. */
  bossOpen: boolean;
  /** The boss's health as a share of its maximum (0 to 1), and its phase. */
  bossHealth: number;
  bossPhase: number;
  bossAlive: boolean;
  summons: number;
  /** Host clock (ms) at which the boss returns, 0 if it is not waiting. */
  bossReturnsAt: number;
  contributions: Contribution[];
  /** Anything else the game keeps per run, opaque here. */
  extra: Uint8Array;
}

export function writeRunState(w: Writer, s: RunState): Uint8Array {
  const trials = Math.min(s.trials.length, MAX_TRIALS);
  const contributors = Math.min(s.contributions.length, MAX_CONTRIBUTORS);
  w.reset().u8(Msg.RunState).u32(s.version).u8(trials);
  for (let i = 0; i < trials; i++) w.u8(s.trials[i]);
  w.bool(s.bossOpen).u16(Math.round(Math.max(0, Math.min(1, s.bossHealth)) * 0xffff)).u8(s.bossPhase).bool(s.bossAlive).u8(s.summons).f64(s.bossReturnsAt);
  w.u8(contributors);
  for (let i = 0; i < contributors; i++) {
    const c = s.contributions[i];
    w.fixed(c.key, KEY_BYTES).f32(c.score).u8((c.attuned ? 1 : 0) | (c.claimed ? 2 : 0));
  }
  w.bytes(s.extra.length > MAX_RUN_EXTRA ? s.extra.subarray(0, MAX_RUN_EXTRA) : s.extra);
  return w.finish();
}

export function readRunState(r: Reader, data: Uint8Array): RunState | null {
  r.reset(data);
  if (r.u8() !== Msg.RunState) return null;
  const version = r.u32();
  const n = r.u8();
  if (n > MAX_TRIALS) return null;
  const trials: number[] = [];
  for (let i = 0; i < n; i++) {
    const t = r.u8();
    if (t > 2) r.fail();
    trials.push(t);
  }
  const bossOpen = r.bool();
  const bossHealth = r.u16() / 0xffff;
  const bossPhase = r.u8();
  const bossAlive = r.bool();
  const summons = r.u8();
  const bossReturnsAt = r.f64();
  const m = r.u8();
  if (m > MAX_CONTRIBUTORS) return null;
  const contributions: Contribution[] = [];
  for (let i = 0; i < m && r.ok; i++) {
    const key = r.fixed(KEY_BYTES);
    const score = r.f32();
    const flags = r.u8();
    if (score < 0 || flags > 3) r.fail();
    contributions.push({ key, score, attuned: (flags & 1) !== 0, claimed: (flags & 2) !== 0 });
  }
  const extra = r.bytes(MAX_RUN_EXTRA);
  if (!r.done) return null;
  return { version, trials, bossOpen, bossHealth, bossPhase, bossAlive, summons, bossReturnsAt, contributions, extra };
}

// ---------------------------------------------------------------------------
// Game messages.

/** Whole 1/32 tiles: positions travel as integers. */
export const POS_SCALE = 32;

export const quantizePos = (tiles: number): number => Math.round(tiles * POS_SCALE);
export const unquantizePos = (q: number): number => q / POS_SCALE;

/** A player's own state, sent by its owner many times a second. */
export interface PlayerState {
  slot: number;
  /** The sender's tick: older ones are dropped (the snap channel reorders). */
  tick: number;
  x: number;
  y: number;
  /** 0–3. */
  facing: number;
  /** The game's animation index. */
  anim: number;
  /** Health as a share of the maximum, 0 to 1. */
  health: number;
  /** The item in hand, as the game's item index; 0 for none. */
  holding: number;
  /** Game flags (running, guarding, swimming, ...). */
  flags: number;
}

export const newPlayerState = (): PlayerState => ({ slot: 0, tick: 0, x: 0, y: 0, facing: 0, anim: 0, health: 1, holding: 0, flags: 0 });

/** 21 bytes. */
export function writePlayerState(w: Writer, s: PlayerState): Uint8Array {
  return w
    .reset()
    .u8(Msg.PlayerState)
    .u8(s.slot)
    .u32(s.tick)
    .i32(quantizePos(s.x))
    .i32(quantizePos(s.y))
    .u8((s.facing & 3) | ((s.anim & 0x3f) << 2))
    .u16(Math.round(Math.max(0, Math.min(1, s.health)) * 0xffff))
    .u16(s.holding)
    .u16(s.flags)
    .finish();
}

/** Reads into `out` (no allocation); false if malformed. */
export function readPlayerState(r: Reader, data: Uint8Array, out: PlayerState): boolean {
  r.reset(data);
  if (r.u8() !== Msg.PlayerState) return false;
  out.slot = r.u8();
  out.tick = r.u32();
  out.x = unquantizePos(r.i32());
  out.y = unquantizePos(r.i32());
  const fa = r.u8();
  out.facing = fa & 3;
  out.anim = fa >> 2;
  out.health = r.u16() / 0xffff;
  out.holding = r.u16();
  out.flags = r.u16();
  return r.done;
}

/** Acknowledges the newest snapshot tick received, so the sender can delta against it. */
export function writeAck(w: Writer, tick: number): Uint8Array {
  return w.reset().u8(Msg.Ack).u32(tick).finish();
}

export function readAck(r: Reader, data: Uint8Array): number | null {
  r.reset(data);
  if (r.u8() !== Msg.Ack) return null;
  const tick = r.u32();
  return r.done ? tick : null;
}

/** Something that happened, for the game to act on: a kind and a few numbers. */
export interface GameEvent {
  kind: number;
  /** Up to 16 integers. */
  ints: number[];
  /** Optional text (a notice, a name). */
  text: string;
}

export const MAX_EVENT_INTS = 16;

export function writeEvent(w: Writer, e: GameEvent): Uint8Array {
  const n = Math.min(e.ints.length, MAX_EVENT_INTS);
  w.reset().u8(Msg.Event).u16(e.kind).u8(n);
  for (let i = 0; i < n; i++) w.i32(e.ints[i]);
  return w.str(e.text).finish();
}

export function readEvent(r: Reader, data: Uint8Array): GameEvent | null {
  r.reset(data);
  if (r.u8() !== Msg.Event) return null;
  const kind = r.u16();
  const n = r.u8();
  if (n > MAX_EVENT_INTS) return null;
  const ints: number[] = [];
  for (let i = 0; i < n; i++) ints.push(r.i32());
  const text = r.str();
  return r.done ? { kind, ints, text } : null;
}

/** What a guest asks the host to do; the host checks and answers. */
export const Action = { Hit: 1, PickUp: 2, Interact: 3, OpenChest: 4, Harvest: 5, Drop: 6, Use: 7 } as const;
export type Action = (typeof Action)[keyof typeof Action];

export interface RequestMsg {
  /** Echoed in the response. */
  id: number;
  action: Action;
  /** An entity or object id, if the action has one. */
  target: number;
  /** A tile or aim point, in tiles. */
  x: number;
  y: number;
  /** An extra argument (slot, item index, ...). */
  arg: number;
}

export function writeRequest(w: Writer, q: RequestMsg): Uint8Array {
  return w.reset().u8(Msg.Request).u16(q.id).u8(q.action).u32(q.target).i32(quantizePos(q.x)).i32(quantizePos(q.y)).u16(q.arg).finish();
}

export function readRequest(r: Reader, data: Uint8Array): RequestMsg | null {
  r.reset(data);
  if (r.u8() !== Msg.Request) return null;
  const id = r.u16();
  const action = r.u8();
  const target = r.u32();
  const x = unquantizePos(r.i32());
  const y = unquantizePos(r.i32());
  const arg = r.u16();
  return r.done && action >= 1 && action <= 7 ? { id, action: action as Action, target, x, y, arg } : null;
}

export interface ResponseMsg {
  id: number;
  ok: boolean;
  /** Why not, as the game's code; 0 if ok. */
  code: number;
}

export function writeResponse(w: Writer, s: ResponseMsg): Uint8Array {
  return w.reset().u8(Msg.Response).u16(s.id).bool(s.ok).u8(s.code).finish();
}

export function readResponse(r: Reader, data: Uint8Array): ResponseMsg | null {
  r.reset(data);
  if (r.u8() !== Msg.Response) return null;
  const id = r.u16();
  const ok = r.bool();
  const code = r.u8();
  return r.done ? { id, ok, code } : null;
}
