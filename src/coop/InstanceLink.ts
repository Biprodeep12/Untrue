// One player's part in a shared dimension instance: the network glue between
// a `Session` (src/net) and the game's trip into the dimension.
//
// The host runs the instance: its run (trials, gates, the Warden, the tally),
// every creature and shot, and the hits on them. It sees every player's feet
// and sends each guest, 20 times a second, the creatures and shots near them
// (delta snapshots), and the run's state when it changes. Guests run only
// their own player: they move, slip, read stones and fight locally, but their
// blows on a creature are requests the host checks and applies, and its blows
// on them come back as events. Everyone sends their own player's state to
// everyone (the instance is a mesh), and draws the others a tenth of a second
// in the past, between updates, so they glide.
//
// When the host goes, the longest-connected member takes over (the session
// decides): its mirror of the run becomes the run, carrying on from the last
// state the host shared, and the creatures it was drawing become real.
//
// Nothing here allocates per frame on the steady path: messages are read into
// reused objects, frames are reused columns, and the lists drawn are kept, not
// rebuilt.

import type { DimEvent } from '../dimension/Challenges';
import { LOCAL } from '../dimension/Contribution';
import { Enemy } from '../entities/Enemy';
import type { RiftTrip } from '../game/RiftTrip';
import { itemById, type ItemDef } from '../items/Items';
import type { RemotePlayer } from '../rendering/EntityRenderer';
import type { CombatSystem, Projectile } from '../systems/CombatSystem';
import {
  Action,
  CTRL,
  Msg,
  newPlayerState,
  quantizePos,
  readAck,
  readEvent,
  readPlayerState,
  readRequest,
  Reader,
  SNAP,
  SnapshotReceiver,
  SnapshotSender,
  toHex,
  typeOf,
  unquantizePos,
  writeAck,
  writeEvent,
  writePlayerState,
  writeRequest,
  Writer,
  type Member,
  type RunState,
  type Session,
} from '../net';
import { MAX_DAMAGE_TAKEN, MAX_KILL_XP, maxBlow, MoveGuard } from './guard';
import { ENEMY_STATES, enemyState, EntityFlag, GameEvent, itemAt, itemId, PlayerFlag, SHOT_KIND_BIT, SHOT_KINDS, shotKind, speciesAt, speciesId } from './ids';
import { SEND_HZ, TickClock, Track } from './interp';
import { packRun, runEventIn, runEventOut, tallyOf, unpackRun } from './runSync';

/** What the link needs of the game. */
export interface CoopGame {
  readonly trip: RiftTrip;
  readonly combat: CombatSystem;
  /** The local player as others see them. */
  player(): { x: number; y: number; facing: number; frame: number; moving: boolean; hurt: number; guarding: boolean; holding: number; health: number };
  notify(text: string): void;
  /** A run event from the host, for its sounds and notices. */
  runEvent(e: DimEvent): void;
  give(item: ItemDef, count: number): void;
  grantXp(xp: number): void;
  /** A creature drawn here is gone: killed (show it), or out of sight. */
  replicaGone(e: Enemy, killed: boolean): void;
}

/** Creatures and shots each guest is sent about: those within this many tiles of them. */
const SEND_RANGE = 36;
/** A guest's blow may land this far from them, in tiles (reach, plus their lag). */
const MELEE_SLACK = 3;
const SHOT_RANGE = 15;
/** Blows a guest may land a second (their strength is the weapon's: `maxBlow`). */
const HITS_PER_SECOND = 10;
/** Run state goes out at most this often, and at least this often while anything is live. */
const RUN_MIN_MS = 100;
const RUN_HEARTBEAT_MS = 2000;
const ITEM_PAIRS = 7;

/** Another member, as this machine draws them and (as host) runs them. */
interface Remote {
  slot: number;
  key: string;
  view: RemotePlayer;
  track: Track;
  clock: TickClock;
  /** Their feet as last reported (not smoothed): what the host plays against. */
  x: number;
  y: number;
  heard: boolean;
  /** Host: blows they may still land this second. */
  tokens: number;
  body: { slot: number; x: number; y: number };
  /** Host: where they may truly be (see `MoveGuard`); `x`, `y` and `body` follow it. */
  move: MoveGuard;
}

/** A creature or shot drawn here that another machine runs. */
interface Replica {
  id: number;
  enemy: Enemy | null;
  shot: Projectile | null;
  track: Track;
  seen: number;
  health: number;
}

export class InstanceLink {
  /** Others in the instance, for drawing; changes only as they come and go. */
  readonly players: RemotePlayer[] = [];
  /** Lost touch with everyone: the instance goes on here alone. */
  alone = false;
  private readonly remotes = new Map<number, Remote>();
  /** The same, as a list walked every frame. */
  private readonly remoteList: Remote[] = [];
  private readonly w = new Writer(1500);
  private readonly r = new Reader();
  private readonly state = newPlayerState();
  private readonly heard = newPlayerState();
  private tick = 0;
  private sendTimer = 0;
  private readonly myKey: string;
  // Host side.
  private readonly senders = new Map<number, SnapshotSender>();
  private snapTick = 0;
  private stateVersion = 0;
  private sentVersion = -1;
  private sentAt = -Infinity;
  private sentBoss = 1;
  private runStart = 0;
  private band: number;
  // Guest side.
  private receiver = new SnapshotReceiver();
  private readonly snapClock = new TickClock();
  private readonly replicas = new Map<number, Replica>();
  private readonly replicaList: Replica[] = [];
  private stamp = 0;
  private clockSet = false;
  private requestId = 0;
  private leaving = false;

  constructor(
    readonly session: Session,
    private readonly game: CoopGame,
    /** The instance's join code, for the beacon. */
    readonly code: string,
    private readonly stop: () => void,
  ) {
    this.myKey = toHex(session.members().find((m) => m.slot === session.slot)?.key ?? new Uint8Array(32));
    this.band = game.trip.band;
    const run = game.trip.run;
    run.shared = true;
    for (const m of session.members()) if (m.slot !== session.slot) this.addRemote(m);
    session.on = {
      peerJoined: (m) => this.addRemote(m),
      peerBack: (m) => this.addRemote(m),
      peerAway: (slot) => this.away(slot),
      peerLeft: (slot) => this.removeRemote(slot),
      message: (slot, _channel, data) => this.receive(slot, data),
      runState: (s) => this.applyRun(s),
      roleChanged: (role) => (role === 'host' ? this.takeOver() : this.stepDown()),
      ended: () => this.lost(),
    };
    if (session.isHost) this.beginHosting();
    else {
      run.authority = false;
      if (session.runState) this.applyRun(session.runState);
      this.hookGuest();
    }
  }

  get isHost(): boolean {
    return this.session.isHost && !this.alone;
  }

  /** Names of everyone here, this player first. */
  names(): string[] {
    return this.session.members().map((m) => (m.slot === this.session.slot ? `${m.name} (you)` : m.name));
  }

  // Per frame ----------------------------------------------------------------------

  /** Sends what is due, and moves what others run to where it should be drawn. */
  update(dt: number, now = performance.now()): void {
    if (this.alone) return;
    this.sendTimer -= dt;
    if (this.sendTimer <= 0) {
      this.sendTimer = Math.max(0, this.sendTimer + 1 / SEND_HZ);
      this.sendState();
      if (this.isHost) this.sendSnapshots();
    }
    if (this.isHost) this.hostFrame(dt, now);
    for (const rm of this.remoteList) {
      if (!rm.heard) continue;
      rm.track.sample(rm.clock.at(now));
      rm.view.x = rm.track.x;
      rm.view.y = rm.track.y;
      if (rm.view.hurt > 0) rm.view.hurt = Math.max(0, rm.view.hurt - dt);
    }
    if (!this.isHost) {
      const at = this.snapClock.at(now);
      for (const rep of this.replicaList) {
        rep.track.sample(at);
        const thing = rep.enemy ?? rep.shot!;
        thing.x = rep.track.x;
        thing.y = rep.track.y;
      }
    }
  }

  /** This player leaves the instance (home through a rift, or dead). */
  leave(): void {
    if (this.leaving) return;
    this.leaving = true;
    this.unhook();
    this.stop();
  }

  /** A guest asks the host for their share of the vault. */
  claim(): void {
    if (this.isHost) return;
    this.session.sendToHost(CTRL, writeRequest(this.w, { id: this.nextRequest(), action: Action.OpenChest, target: 0, x: 0, y: 0, arg: 0 }));
  }

  /** Every run event the trip passes the game: the host passes others' shares of the vault on. */
  tripEvent(e: DimEvent): void {
    if (!this.isHost || e.type !== 'reward' || e.player === LOCAL) return;
    const rm = this.byKey(e.player);
    if (!rm) return;
    const ints: number[] = [];
    for (const { item: id, count } of e.items) {
      const item = itemById(id);
      if (item && count > 0 && ints.length < ITEM_PAIRS * 2) ints.push(itemId(item), count);
    }
    this.event(rm.slot, GameEvent.Reward, ints);
  }

  // Players ------------------------------------------------------------------------

  private addRemote(m: Member): void {
    if (m.slot === this.session.slot) return;
    const key = toHex(m.key);
    let rm = this.remotes.get(m.slot);
    if (!rm || rm.key !== key) {
      if (rm) this.removeRemote(m.slot);
      const view: RemotePlayer = { slot: m.slot, name: m.name, x: 0, y: 0, facing: 0, frame: 0, holding: -1, hurt: 0 };
      const a = this.game.trip.layout.arrival;
      rm = { slot: m.slot, key, view, track: new Track(), clock: new TickClock(), x: a.x, y: a.y, heard: false, tokens: HITS_PER_SECOND, body: { slot: m.slot, x: a.x, y: a.y }, move: new MoveGuard() };
      this.remotes.set(m.slot, rm);
      this.remoteList.push(rm);
    }
    rm.view.name = m.name;
    if (this.isHost) this.hostAdd(rm);
  }

  /** A member's link dropped (they may be back within the session's window):
   *  they vanish until they are heard from again. */
  private away(slot: number): void {
    const rm = this.remotes.get(slot);
    if (!rm) return;
    rm.heard = false;
    rm.track.restart();
    const i = this.players.indexOf(rm.view);
    if (i >= 0) this.players.splice(i, 1);
    if (this.isHost) {
      this.game.trip.run.leave(rm.key);
      const others = this.game.combat.others;
      const k = others.indexOf(rm.body);
      if (k >= 0) others.splice(k, 1);
    }
  }

  private removeRemote(slot: number): void {
    const rm = this.remotes.get(slot);
    if (!rm) return;
    this.remotes.delete(slot);
    this.remoteList.splice(this.remoteList.indexOf(rm), 1);
    const i = this.players.indexOf(rm.view);
    if (i >= 0) this.players.splice(i, 1);
    if (this.isHost) {
      this.game.trip.run.leave(rm.key);
      this.senders.delete(slot);
      const others = this.game.combat.others;
      const k = others.indexOf(rm.body);
      if (k >= 0) others.splice(k, 1);
    }
  }

  /** Forgets those no longer in the session (a host that went is dropped
   *  quietly as another takes over). */
  private prune(): void {
    const members = this.session.members();
    for (let k = this.remoteList.length - 1; k >= 0; k--) {
      const rm = this.remoteList[k];
      if (!members.some((m) => m.slot === rm.slot)) this.removeRemote(rm.slot);
    }
  }

  private byKey(key: string): Remote | undefined {
    for (const rm of this.remotes.values()) if (rm.key === key) return rm;
    return undefined;
  }

  private sendState(): void {
    const p = this.game.player();
    const s = this.state;
    s.slot = this.session.slot;
    s.tick = ++this.tick;
    s.x = p.x;
    s.y = p.y;
    s.facing = p.facing;
    s.anim = p.frame;
    s.health = p.health;
    s.holding = p.holding + 1;
    s.flags = (p.moving ? PlayerFlag.Moving : 0) | (p.hurt > 0 ? PlayerFlag.Hurt : 0) | (p.guarding ? PlayerFlag.Guarding : 0);
    this.session.broadcast(SNAP, writePlayerState(this.w, s));
  }

  // Receiving ----------------------------------------------------------------------

  private receive(slot: number, data: Uint8Array): void {
    switch (typeOf(data)) {
      case Msg.PlayerState:
        this.heardState(slot, data);
        break;
      case Msg.Snapshot:
        if (!this.isHost && slot === this.session.hostSlot) this.heardSnapshot(data);
        break;
      case Msg.Ack: {
        const tick = readAck(this.r, data);
        if (tick !== null && this.isHost) this.senders.get(slot)?.ack(tick);
        break;
      }
      case Msg.Event:
        if (!this.isHost && slot === this.session.hostSlot) this.heardEvent(data);
        break;
      case Msg.Request:
        if (this.isHost) this.heardRequest(slot, data);
        break;
    }
  }

  private heardState(slot: number, data: Uint8Array): void {
    const s = this.heard;
    const rm = this.remotes.get(slot);
    if (!rm || !readPlayerState(this.r, data, s) || s.slot !== slot) return;
    if (!Number.isFinite(s.x) || !Number.isFinite(s.y)) return;
    if (!rm.heard) {
      rm.heard = true;
      this.players.push(rm.view);
    }
    const now = performance.now();
    rm.clock.observe(s.tick, now);
    rm.track.push(s.tick, s.x, s.y);
    // Drawn where they say; played (reach, creatures, the run) only where they could be.
    if (this.isHost && !rm.move.check(s.x, s.y, now)) return this.heardLook(rm, s);
    rm.x = rm.body.x = s.x;
    rm.y = rm.body.y = s.y;
    this.heardLook(rm, s);
    if (this.isHost) this.game.trip.run.move(rm.key, s.x, s.y);
  }

  private heardLook(rm: Remote, s: typeof this.heard): void {
    const v = rm.view;
    v.facing = s.facing & 3;
    v.frame = s.flags & PlayerFlag.Moving ? s.anim & 3 : 0;
    v.holding = s.holding > 0 && itemAt(s.holding - 1) ? s.holding - 1 : -1;
    if (s.flags & PlayerFlag.Hurt && v.hurt <= 0) v.hurt = 0.4;
  }

  // Hosting ------------------------------------------------------------------------

  /** This machine runs the instance from now on. */
  private beginHosting(): void {
    const { trip } = this.game;
    const run = trip.run;
    run.authority = true;
    this.runStart = this.session.time() - run.time * 1000;
    run.clock = () => (this.session.time() - this.runStart) / 1000;
    for (const rm of this.remotes.values()) this.hostAdd(rm);
    this.hookHost();
    this.sentVersion = -1;
  }

  private hostAdd(rm: Remote): void {
    const run = this.game.trip.run;
    run.join(rm.key, rm.x, rm.y);
    if (!this.senders.has(rm.slot)) this.senders.set(rm.slot, new SnapshotSender());
    const others = this.game.combat.others;
    if (!others.includes(rm.body)) others.push(rm.body);
    // The Warden fell before they came (or before this machine hosted): they
    // hear what they are owed now, so the portal can answer them.
    if (run.wardenFellAt >= 0) {
      const s = run.share(rm.key);
      this.event(rm.slot, GameEvent.Settle, [s.xp, s.attuned ? 1 : 0, Math.round(s.share * 10000)]);
    }
  }

  private hookHost(): void {
    const combat = this.game.combat;
    combat.onReplicaHit = undefined;
    combat.onOtherHit = (slot, raw, species, fx, fy) => this.event(slot, GameEvent.Damage, [Math.round(raw * 100), speciesId(species), quantizePos(fx), quantizePos(fy)]);
    combat.onOtherKill = (who, _e, xp, drops) => {
      const rm = this.byKey(who);
      if (!rm) return;
      // Spoils that do not fit one event follow in more (without the xp).
      let ints = [xp];
      for (const [item, count] of drops) {
        if (count <= 0) continue;
        if (ints.length >= 1 + ITEM_PAIRS * 2) {
          this.event(rm.slot, GameEvent.Kill, ints);
          ints = [0];
        }
        ints.push(itemId(item), count);
      }
      this.event(rm.slot, GameEvent.Kill, ints);
    };
  }

  private hookGuest(): void {
    const combat = this.game.combat;
    combat.onOtherHit = undefined;
    combat.onOtherKill = undefined;
    combat.others.length = 0;
    combat.onReplicaHit = (e, amount, crit, px, py, ranged) => {
      const rep = this.replicaOf(e);
      if (!rep) return;
      this.session.sendToHost(CTRL, writeRequest(this.w, { id: this.nextRequest(), action: Action.Hit, target: rep.id, x: amount, y: Math.atan2(py, px), arg: (crit ? 1 : 0) | (ranged ? 2 : 0) }));
    };
  }

  private unhook(): void {
    const combat = this.game.combat;
    combat.onOtherHit = combat.onOtherKill = combat.onReplicaHit = undefined;
    combat.others.length = 0;
    this.session.on = {};
  }

  /** Once a frame as host: the run's news to everyone, its state when it changed. */
  private hostFrame(dt: number, now: number): void {
    const run = this.game.trip.run;
    for (const e of run.takeShared()) {
      const m = runEventOut(e);
      if (m) this.session.broadcast(CTRL, writeEvent(this.w, m));
      if (e.type === 'cleared' && e.kind === 'boss') this.settleAll();
    }
    for (const rm of this.remoteList) rm.tokens = Math.min(HITS_PER_SECOND, rm.tokens + HITS_PER_SECOND * dt);
    if (!this.remotes.size) return;
    const boss = run.boss?.share ?? 1;
    const since = now - this.sentAt;
    if (since < RUN_MIN_MS) return;
    if (run.version === this.sentVersion && since < RUN_HEARTBEAT_MS && Math.abs(boss - this.sentBoss) < 0.02) return;
    this.sentVersion = run.version;
    this.sentAt = now;
    this.sentBoss = boss;
    this.stateVersion = Math.max(this.stateVersion, this.session.runState?.version ?? 0) + 1;
    this.session.setRunState(packRun(run, this.stateVersion, this.band, this.runStart, this.myKey, (p) => run.hasClaimed(p)));
  }

  /** The Warden fell: each guest hears what they are owed. */
  private settleAll(): void {
    const run = this.game.trip.run;
    for (const rm of this.remotes.values()) {
      const s = run.share(rm.key);
      this.event(rm.slot, GameEvent.Settle, [s.xp, s.attuned ? 1 : 0, Math.round(s.share * 10000)]);
    }
  }

  /** The creatures and shots near each guest, as a delta against what it has. */
  private sendSnapshots(): void {
    const { combat, trip } = this.game;
    const tick = ++this.snapTick;
    const boss = combat.boss;
    const r2 = SEND_RANGE * SEND_RANGE;
    for (const [slot, sender] of this.senders) {
      const rm = this.remotes.get(slot);
      if (!rm) continue;
      const f = sender.frame;
      f.clear();
      // The Warden first: it is never left out of a full frame.
      if (boss) this.pushEnemy(f, boss, trip.netIdOf(boss));
      for (const e of combat.enemies) {
        if (e === boss || (e.x - rm.x) ** 2 + (e.y - rm.y) ** 2 > r2) continue;
        if (!this.pushEnemy(f, e, trip.netIdOf(e))) break;
      }
      for (const p of combat.projectiles) {
        if (p.fromPlayer || !p.id || (p.x - rm.x) ** 2 + (p.y - rm.y) ** 2 > r2) continue;
        const angle = Math.round(((Math.atan2(p.vy, p.vx) / (Math.PI * 2)) * 256) & 0xff);
        if (!f.push(p.id, SHOT_KIND_BIT | shotKind(p.kind), quantizePos(p.x), quantizePos(p.y), angle, 0xffff, 0)) break;
      }
      this.session.send(slot, SNAP, sender.encode(this.w, tick));
    }
  }

  private pushEnemy(f: SnapshotSender['frame'], e: Enemy, id: number): boolean {
    if (!id) return true;
    const dir = (e.facing > 0 ? 1 : 0) | (enemyState(e.state) << 2);
    const flags = (e.elite ? EntityFlag.Elite : 0) | (e.hitFlash > 0 ? EntityFlag.Flash : 0) | (e.windingUp ? EntityFlag.Windup : 0) | (e.moving ? EntityFlag.Moving : 0);
    return f.push(id, speciesId(e.species), quantizePos(e.x), quantizePos(e.y), dir, Math.round((Math.max(0, e.hp) / e.maxHp) * 0xffff), flags);
  }

  private heardRequest(slot: number, data: Uint8Array): void {
    const q = readRequest(this.r, data);
    const rm = this.remotes.get(slot);
    if (!q || !rm) return;
    const { trip, combat } = this.game;
    if (q.action === Action.Hit) {
      const e = trip.enemyByNet(q.target);
      if (!e || !e.alive || e.replica || rm.tokens < 1) return;
      const d = Math.hypot(e.x - rm.x, e.y - rm.y);
      if (d > SHOT_RANGE || !(q.x >= 1)) return;
      // A sword's blow must be within reach; arrows (bit 2) fly further.
      if (!(q.arg & 2) && d > MELEE_SLACK) return;
      rm.tokens--;
      // No stronger than the weapon in their hand could strike.
      combat.strike(e, Math.min(maxBlow(rm.view.holding), Math.round(q.x)), (q.arg & 1) === 1, Math.cos(q.y), Math.sin(q.y), rm.key);
    } else if (q.action === Action.OpenChest) {
      // A `reward` event follows for them (see `tripEvent`); else they hear why not.
      if (!trip.run.claimChest(rm.key)) this.event(slot, GameEvent.Denied, [], trip.run.hasClaimed(rm.key) ? 'You have already taken your share.' : 'The vault stays shut to you.');
      else {
        // Shared at once, so a new host taking over now knows it was claimed.
        this.sentAt = -Infinity;
        this.hostFrame(0, performance.now());
      }
    }
  }

  private event(slot: number, kind: number, ints: number[], text = ''): void {
    this.session.send(slot, CTRL, writeEvent(this.w, { kind, ints, text }));
  }

  // Guest side -----------------------------------------------------------------------

  /** The host's run state: the mirror takes it on. */
  private applyRun(state: RunState): void {
    if (this.isHost) return;
    const x = unpackRun(state);
    if (!x) return;
    const run = this.game.trip.run;
    run.applyShared(x.shared);
    this.band = x.band;
    this.runStart = x.runStart;
    if (!this.clockSet) {
      this.clockSet = true;
      run.clock = () => (this.session.time() - this.runStart) / 1000;
    }
    for (const t of tallyOf(state, this.myKey)) if (t.player === LOCAL && t.claimed) run.markClaimed(LOCAL);
  }

  private heardEvent(data: Uint8Array): void {
    const m = readEvent(this.r, data);
    if (!m) return;
    const { game } = this;
    const run = game.trip.run;
    const n = m.ints;
    switch (m.kind) {
      case GameEvent.Run: {
        const e = runEventIn(m);
        if (e) game.runEvent(e);
        break;
      }
      case GameEvent.Damage: {
        const species = speciesAt(n[1]);
        // No blow harder than a creature could strike.
        if (species && n[0] > 0) game.combat.takeHit(Math.min(MAX_DAMAGE_TAKEN, n[0] / 100), species, unquantizePos(n[2]), unquantizePos(n[3]));
        break;
      }
      case GameEvent.Kill:
        if (n[0] > 0) game.grantXp(Math.min(MAX_KILL_XP, n[0]));
        this.giveAll(n, 1);
        break;
      case GameEvent.Settle:
        run.adoptSettlement({ xp: Math.max(0, n[0] | 0), attuned: n[1] === 1, share: Math.max(0, Math.min(1, n[2] / 10000)), items: [] });
        if (n[1] === 1) game.notify('The portal hums for you: step through to close your rift.');
        break;
      case GameEvent.Reward:
        run.markClaimed(LOCAL);
        this.giveAll(n, 0);
        break;
      case GameEvent.Denied:
        run.claimDenied();
        if (m.text) game.notify(m.text);
        break;
    }
  }

  private giveAll(ints: readonly number[], from: number): void {
    for (let i = from; i + 1 < ints.length; i += 2) {
      const item = itemAt(ints[i]);
      const count = ints[i + 1];
      if (item && count > 0 && count <= 999) this.game.give(item, count);
    }
  }

  private heardSnapshot(data: Uint8Array): void {
    const f = this.receiver.read(this.r, data);
    if (!f) return;
    this.session.sendToHost(SNAP, writeAck(this.w, f.tick));
    this.snapClock.observe(f.tick, performance.now());
    const stamp = ++this.stamp;
    const { combat } = this.game;
    for (let i = 0; i < f.count; i++) {
      const id = f.id[i];
      let rep = this.replicas.get(id);
      if (!rep) {
        rep = this.makeReplica(id, f.kind[i], f.flags[i], unquantizePos(f.x[i]), unquantizePos(f.y[i])) ?? undefined;
        if (!rep) continue;
      }
      rep.seen = stamp;
      rep.track.push(f.tick, unquantizePos(f.x[i]), unquantizePos(f.y[i]));
      rep.health = f.health[i];
      const e = rep.enemy;
      if (e) {
        const dir = f.dir[i];
        e.facing = dir & 1 ? 1 : -1;
        e.state = ENEMY_STATES[dir >> 2] ?? 'chase';
        const flags = f.flags[i];
        e.moving = (flags & EntityFlag.Moving) !== 0;
        e.windupShown = (flags & EntityFlag.Windup) !== 0;
        if (flags & EntityFlag.Flash && e.hitFlash <= 0) e.hitFlash = 0.15;
        e.hp = Math.max(0, (rep.health / 0xffff) * e.maxHp);
      } else if (rep.shot) {
        const a = (f.dir[i] / 256) * Math.PI * 2;
        rep.shot.vx = Math.cos(a);
        rep.shot.vy = Math.sin(a);
      }
    }
    // What is no longer sent is gone: dead, or out of range.
    for (let k = this.replicaList.length - 1; k >= 0; k--) {
      const rep = this.replicaList[k];
      if (rep.seen === stamp) continue;
      this.dropReplica(k);
      if (rep.enemy) {
        combat.remove(rep.enemy);
        this.game.replicaGone(rep.enemy, rep.health === 0);
      } else if (rep.shot) {
        const j = combat.projectiles.indexOf(rep.shot);
        if (j >= 0) combat.projectiles.splice(j, 1);
      }
    }
  }

  private makeReplica(id: number, kind: number, flags: number, x: number, y: number): Replica | null {
    const { combat } = this.game;
    let enemy: Enemy | null = null;
    let shot: Projectile | null = null;
    if (kind & SHOT_KIND_BIT) {
      const k = SHOT_KINDS[kind & 0xff];
      if (!k) return null;
      shot = { x, y, vx: 1, vy: 0, kind: k, damage: 0, fromPlayer: false, ttl: Infinity, id, replica: true };
      combat.projectiles.push(shot);
    } else {
      const species = speciesAt(kind);
      if (!species) return null;
      enemy = new Enemy(species, x, y, this.band, (flags & EntityFlag.Elite) !== 0);
      enemy.replica = true;
      combat.add(enemy);
    }
    const rep: Replica = { id, enemy, shot, track: new Track(), seen: 0, health: 0xffff };
    this.replicas.set(id, rep);
    this.replicaList.push(rep);
    return rep;
  }

  private dropReplica(k: number): void {
    const rep = this.replicaList[k];
    this.replicas.delete(rep.id);
    const last = this.replicaList.pop()!;
    if (k < this.replicaList.length) this.replicaList[k] = last;
  }

  private replicaOf(e: Enemy): Replica | undefined {
    for (const rep of this.replicaList) if (rep.enemy === e) return rep;
    return undefined;
  }

  // Changes of host ------------------------------------------------------------------

  /** The host is gone and this machine runs the instance now: the mirror
   *  becomes the run, from the last state shared, and what was drawn here
   *  becomes real. */
  private takeOver(): void {
    const { trip, combat } = this.game;
    const run = trip.run;
    const last = this.session.runState;
    if (last) {
      const x = unpackRun(last);
      if (x) {
        run.applyShared(x.shared);
        this.runStart = x.runStart;
      }
      this.stateVersion = last.version;
    }
    run.becomeAuthority(last ? tallyOf(last, this.myKey) : []);
    for (const rep of this.replicaList) {
      if (rep.enemy) trip.adopt(rep.enemy, rep.id);
      else if (rep.shot) {
        const j = combat.projectiles.indexOf(rep.shot);
        if (j >= 0) combat.projectiles.splice(j, 1);
      }
    }
    this.replicas.clear();
    this.replicaList.length = 0;
    // Creatures the old host ran that never reached this machine are gone:
    // a wave goes on without them, a Warden nobody runs waits again.
    run.prune((id) => trip.enemyByNet(id) !== undefined);
    this.prune();
    this.beginHosting();
    this.game.notify('The one who held this place open is gone. It holds on through you now.');
  }

  /** Another member hosts now (or claimed it first): this machine mirrors theirs. */
  private stepDown(): void {
    const { trip } = this.game;
    if (trip.run.authority) {
      // It was running the run: what it ran comes back as the new host's.
      trip.releaseAll();
      trip.run.authority = false;
      this.senders.clear();
      this.game.combat.others.length = 0;
      this.hookGuest();
    }
    this.receiver = new SnapshotReceiver();
    this.snapClock.reset();
    for (const rep of this.replicaList) rep.track.restart();
    this.prune();
  }

  /** Every link is gone: the instance carries on here, alone. */
  private lost(): void {
    if (this.leaving) return;
    if (!this.game.trip.run.authority) this.takeOver();
    this.alone = true;
    this.unhook();
    this.players.length = 0;
    this.game.trip.run.shared = false;
    this.game.notify('The others fade from the Drift. You go on alone.');
  }

  private nextRequest(): number {
    this.requestId = (this.requestId + 1) & 0xffff;
    return this.requestId;
  }
}

