// A guest's side of a shared overworld: this player visits a friend's world.
// The guest's world is a copy (`WorldManager` in replica mode): its terrain,
// objects, biomes, region visits, harvest and ground all come from the host
// (see `WorldHost`); it composes chunks the same way, so they come out the
// same, byte for byte. The guest moves its own player and gathers, fights and
// trades as usual, but what changes the world is asked of the host: gathering
// is applied here at once and confirmed (or put right) by the host; chests,
// picking up, dropping and closing rifts wait for the host's word. Creatures
// are the host's, drawn here from its snapshots; blows on them are requests.
//
// World messages are applied strictly in the order they came, one after
// another (unpacking terrain is asynchronous), so a later change is never
// overtaken by an earlier chunk.

import { chunkKey, tileToChunk } from '../coords';
import { Enemy } from '../entities/Enemy';
import { difficultyBand } from '../generation/WorldRules';
import { itemById, type ItemDef } from '../items/Items';
import { loadStack, type Stack } from '../systems/InventorySystem';
import type { Projectile } from '../systems/CombatSystem';
import type { View } from '../world/ChunkManager';
import { Interior } from '../world/Interior';
import type { WorldChanges } from '../world/WorldManager';
import { WorldObject } from '../world/WorldObject';
import {
  Action,
  CTRL,
  Msg,
  newPlayerState,
  readEvent,
  Reader,
  SNAP,
  SnapshotReceiver,
  typeOf,
  unquantizePos,
  writeAck,
  writePlayerState,
  writeRequest,
  Writer,
  type Session,
} from '../net';
import { inflateRaw } from '../net/crypto';
import { MAX_DAMAGE_TAKEN, MAX_KILL_XP } from './guard';
import { ENEMY_STATES, EntityFlag, GameEvent, itemAt, itemId, PlayerFlag, SHOT_KIND_BIT, SHOT_KINDS, speciesAt } from './ids';
import { SEND_HZ, TickClock, Track } from './interp';
import { NetChunkGenerator } from './NetChunkGenerator';
import { Players, type Whereabouts } from './players';
import type { WorldGame } from './worldGame';
import {
  layoutFrom,
  Place,
  readChestReply,
  readChunk,
  readChunkAt,
  readGroundAdd,
  readHarvest,
  readHarvestReply,
  readInfo,
  readNet,
  readObject,
  readObjectState,
  readRiftInstance,
  readStack,
  readTime,
  readWhere,
  W,
  worldKind,
  writeChestReq,
  writeChunkAt,
  writeEmpty,
  writeHarvestReq,
  writeMineReq,
  writeNet,
  writeRiftInstance,
  writeStack,
  writeView,
  writeWhere,
  type GroundWire,
  type WorldInfo,
} from './worldWire';

const CHUNK_BYTES = 2048;
/** How long to wait for the host's Info after joining, in ms. */
const INFO_MS = 10_000;
/** The view is sent again once the player has moved this far, in tiles, or
 *  their spot in the world (where the host measures their reach) this far. */
const VIEW_STEP = 4;
const SPOT_STEP = 1;
/** Chunks waited on with no word at all from the host this long: it is gone, in ms. */
const SILENT_MS = 30_000;
/** Gatherings and minings waiting on the host's word, at most. */
const MAX_ASKED = 64;

/** A creature or shot drawn here that the host runs. */
interface Replica {
  id: number;
  enemy: Enemy | null;
  shot: Projectile | null;
  track: Track;
  seen: number;
  health: number;
}

/** Why a visit ended, in words. */
const ENDED: Record<string, string> = {
  'host-left': 'Your friend closed their world, and the Drift carries you home.',
  kicked: 'Your friend sent you home.',
  lost: 'You lost touch with your friend’s world, and the Drift carries you home.',
  rejected: 'Your friend’s world would not let you in.',
  left: 'You head home.',
};

export class WorldGuest {
  readonly generator: NetChunkGenerator;
  readonly players: Players;
  info: WorldInfo | null = null;
  private game: WorldGame | null = null;
  private readonly w = new Writer(2048);
  private readonly r = new Reader();
  private readonly state = newPlayerState();
  private tick = 0;
  private sendTimer = 0;
  private connected = true;
  private suspended = false;
  private closed = false;
  private readonly mine: Whereabouts = { place: Place.Outdoors, object: 0, index: 0, floor: 0, tick: 0 };
  private whereSent = false;
  private viewAt = { x: NaN, y: NaN, px: NaN, py: NaN, hw: 0, hh: 0, dx: 0, dy: 0, place: -1 };
  /** Why the session ended before the game was attached, to say once it is. */
  private endedEarly: string | null = null;
  private infoFailed: ((e: Error) => void) | null = null;
  /** When the host was last heard on the world's channel (ms). */
  private heardAt = 0;
  private pruneTimer = 0;
  /** Things put down while the host could not be reached: sent once it can. */
  private readonly undelivered: Stack[] = [];
  // World messages, applied in order.
  private readonly inbox: Uint8Array[] = [];
  private draining = false;
  private infoWaiter: ((info: WorldInfo) => void) | null = null;
  // The host's objects, by its ids.
  private readonly netObj = new Map<number, WorldObject>();
  private readonly objNet = new Map<WorldObject, number>();
  private readonly needed = new Set<number>();
  /** Objects the host took away: their going is not news to it. */
  private hostRemoving = false;
  // Requests waiting on the host.
  private readonly chests = new Map<number, () => void>();
  private nextReq = 0;
  /** Gatherings and minings waiting on the host's word: what to hand over if yes. */
  private readonly asked = new Map<number, { give: () => void; object: WorldObject | null; id: number }>();
  /** Room tiles mined here and not yet confirmed: kept through the host's
   *  updates of the object, which do not have them yet. */
  private readonly minedHere = new Map<WorldObject, Set<number>>();
  // Creatures.
  private receiver = new SnapshotReceiver();
  private readonly snapClock = new TickClock();
  private readonly replicas = new Map<number, Replica>();
  private readonly replicaList: Replica[] = [];
  private stamp = 0;

  // Gathering goes to the host through `confirm` (with its word back), not as a change.
  private readonly changes: WorldChanges = {
    objectChanged: (o) => {
      const net = this.objNet.get(o);
      if (net && o.kind === 'rift' && o.closed) this.session.sendToHost(CTRL, writeNet(this.w, W.CloseRiftReq, net));
    },
    objectRemoved: (o) => {
      const net = this.objNet.get(o);
      if (!net) return;
      this.objNet.delete(o);
      if (this.netObj.get(net) === o) this.netObj.delete(net);
      if (!this.hostRemoving) this.session.sendToHost(CTRL, writeNet(this.w, W.ObjectForget, net));
    },
  };

  constructor(
    readonly session: Session,
    /** The world's join code. */
    readonly code: string,
  ) {
    this.generator = new NetChunkGenerator((cx, cy) => this.session.sendToHost(CTRL, writeChunkAt(this.w, W.ChunkReq, cx, cy)));
    this.players = new Players(newPlayerState());
    for (const m of session.members()) this.players.add(m, session.slot);
    session.on = {
      peerJoined: (m) => {
        this.players.add(m, session.slot);
        this.game?.peopleChanged();
      },
      peerBack: (m) => this.players.add(m, session.slot),
      peerAway: (slot) => this.players.away(slot),
      peerLeft: (slot) => {
        this.players.remove(slot);
        this.game?.peopleChanged();
      },
      message: (slot, _channel, data) => this.receive(slot, data),
      hostLost: () => (this.connected = false),
      ended: (reason) => this.end(reason),
    };
  }

  /** Asks the host for the world, and waits for its answer. */
  hello(timeoutMs = INFO_MS): Promise<WorldInfo> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.infoWaiter = this.infoFailed = null;
        reject(new Error('Your friend’s world did not answer.'));
      }, timeoutMs);
      this.infoWaiter = (info) => {
        clearTimeout(timer);
        this.infoFailed = null;
        resolve(info);
      };
      // Ended before it answered (closed, or this player sent away): say why at once.
      this.infoFailed = (e) => {
        clearTimeout(timer);
        this.infoWaiter = null;
        reject(e);
      };
      this.session.sendToHost(CTRL, writeEmpty(this.w, W.Hello));
    });
  }

  /** The game is ready: hook into its world and fight, and take in what waited. */
  attach(game: WorldGame): void {
    this.game = game;
    // The session ended while the game was loading: home at once, with the reason.
    if (this.endedEarly !== null) {
      game.ended(this.endedEarly);
      return;
    }
    this.heardAt = performance.now();
    game.world.changes = this.changes;
    game.world.ground.reach = (g) => {
      // Where this player stands first, so the host finds them beside it.
      this.sendState();
      this.session.sendToHost(CTRL, writeNet(this.w, W.PickupReq, g.id));
    };
    this.hookCombat();
    void this.drain();
  }

  /** Names of everyone here, this player first. */
  names(): string[] {
    return this.session.members().map((m) => (m.slot === this.session.slot ? `${m.name} (you)` : m.name));
  }

  /** Where the host stands in the world, if outdoors and heard; else where
   *  they last stood outdoors (by the door they went in, or the rift); else
   *  where they stood when this player arrived. */
  hostSpot(): { x: number; y: number } {
    const rm = this.players.bySlot.get(this.session.hostSlot);
    if (rm?.heard && rm.where.place === Place.Outdoors) return { x: rm.x, y: rm.y };
    if (rm?.wasOut) return { x: rm.outX, y: rm.outY };
    return { x: this.info?.x ?? 0, y: this.info?.y ?? 0 };
  }

  /** The host's name. */
  get hostName(): string {
    return this.session.members().find((m) => m.slot === this.session.hostSlot)?.name ?? 'your friend';
  }

  get isClosed(): boolean {
    return this.closed;
  }

  /** Goes home. */
  leave(): void {
    if (this.closed) return;
    this.closed = true;
    this.unhook();
    this.session.leave();
  }

  // Per frame ----------------------------------------------------------------------

  /** Sends this player's state, place and view as due; moves what the host runs. */
  update(dt: number, now = performance.now()): void {
    const game = this.game;
    if (!game || this.closed) return;
    const where = game.where();
    const mine = this.mine;
    const object = where.object ? (this.objNet.get(where.object) ?? 0) : 0;
    const place = where.place === Place.Indoors && !object ? Place.Away : where.place;
    if (!this.whereSent || place !== mine.place || object !== mine.object || where.index !== mine.index || where.floor !== mine.floor) {
      mine.place = place;
      mine.object = object;
      mine.index = where.index;
      mine.floor = where.floor;
      // States from here on are of the new place.
      mine.tick = this.tick + 1;
      this.whereSent = this.session.sendToHost(CTRL, writeWhere(this.w, { ...mine, slot: this.session.slot }));
    }
    this.sendTimer -= dt;
    if (this.sendTimer <= 0) {
      this.sendTimer = Math.max(0, this.sendTimer + 1 / SEND_HZ);
      const back = this.sendState();
      if (back && !this.connected) this.reconnected();
      this.connected = back;
    }
    this.pruneTimer -= dt;
    if (this.pruneTimer <= 0) {
      this.pruneTimer = 1;
      this.pruneChunks();
      // Chunks waited on, and not a word from the host for long: it is gone.
      if (this.connected && this.generator.pending && now - this.heardAt > SILENT_MS) {
        this.end('lost');
        return;
      }
    }
    this.generator.update(now);
    this.players.update(dt, now, mine);
    if (this.suspended) return;
    const at = this.snapClock.at(now);
    for (const rep of this.replicaList) {
      rep.track.sample(at);
      const thing = rep.enemy ?? rep.shot!;
      thing.x = rep.track.x;
      thing.y = rep.track.y;
    }
  }

  /** What this player sees, before the world streams: the host keeps it too. */
  view(v: View): void {
    if (this.closed) return;
    const x = (v.minX + v.maxX) / 2;
    const y = (v.minY + v.maxY) / 2;
    const hw = Math.ceil((v.maxX - v.minX) / 2);
    const hh = Math.ceil((v.maxY - v.minY) / 2);
    const a = this.viewAt;
    const place = this.mine.place;
    // The spot counts too: indoors or behind a rift, the host measures reach from it.
    const spotMoved = Math.abs(v.playerX - a.px) >= SPOT_STEP || Math.abs(v.playerY - a.py) >= SPOT_STEP || place !== a.place;
    if (Math.abs(x - a.x) < VIEW_STEP && Math.abs(y - a.y) < VIEW_STEP && hw === a.hw && hh === a.hh && v.dirX === a.dx && v.dirY === a.dy && !spotMoved) return;
    if (!this.session.sendToHost(CTRL, writeView(this.w, { x, y, px: v.playerX, py: v.playerY, halfW: hw, halfH: hh, dirX: v.dirX, dirY: v.dirY }))) return;
    a.x = x;
    a.y = y;
    a.px = v.playerX;
    a.py = v.playerY;
    a.place = place;
    a.hw = hw;
    a.hh = hh;
    a.dx = v.dirX;
    a.dy = v.dirY;
  }

  /** This player went behind a rift: the overworld's creatures are put away
   *  (another fight takes the combat) until `resume`. */
  suspend(): void {
    if (this.suspended) return;
    this.suspended = true;
    this.clearReplicas();
    if (this.game) this.game.combat.onReplicaHit = undefined;
  }

  resume(): void {
    if (!this.suspended || this.closed) return;
    this.suspended = false;
    this.hookCombat();
    this.resync();
  }

  /** This player went into a shared instance behind a rift: friends may follow. */
  wentBehind(dimension: string, code: string): void {
    this.session.sendToHost(CTRL, writeRiftInstance(this.w, this.session.slot, dimension, code));
  }

  /** Asks the host to open a chest: an object's (by its place in the layout)
   *  or one in a room of it (by its id there). `grant` runs if it may. */
  claimChest(o: WorldObject, index: number, grant: () => void): boolean {
    const net = this.objNet.get(o);
    if (!net || this.closed) return false;
    const req = (this.nextReq = (this.nextReq + 1) & 0xffff);
    this.chests.set(req, grant);
    this.session.sendToHost(CTRL, writeChestReq(this.w, req, net, index));
    return true;
  }

  /** Puts a stack down on the host's ground. While the host cannot be
   *  reached it waits here, and goes once it can (or back in the bag if
   *  the visit ends first): nothing put down is lost on the way. A spot is
   *  sent first, so the host measures from where this player is now. */
  drop(stack: Stack, x: number, y: number): void {
    if (this.closed) return;
    if (!this.sendDrop(stack, x, y)) this.undelivered.push({ ...stack });
    this.game?.saveSoon();
  }

  private sendDrop(stack: Stack, x: number, y: number): boolean {
    return this.session.sendToHost(CTRL, writeStack(this.w, W.DropReq, { item: itemId(stack.item), count: stack.count, durability: stack.durability ?? -1 }, x, y));
  }

  /** Gathered something: the host is asked, and `give` runs if it says yes.
   *  Outdoors by tile, in a room by the tile's id in its object's opened set. */
  confirm(ground: unknown, gx: number, gy: number, deco: number, give: () => void): void {
    if (this.closed) return;
    const req = this.nextRequest();
    if (ground instanceof Interior) {
      const net = this.objNet.get(ground.object);
      if (!net) return;
      const id = ground.minedId(gx, gy);
      let mined = this.minedHere.get(ground.object);
      if (!mined) this.minedHere.set(ground.object, (mined = new Set()));
      mined.add(id);
      this.ask(req, give, ground.object, id);
      this.session.sendToHost(CTRL, writeMineReq(this.w, req, net, id));
    } else {
      this.ask(req, give, null, 0);
      this.session.sendToHost(CTRL, writeHarvestReq(this.w, req, gx, gy, deco));
    }
  }

  private ask(req: number, give: () => void, object: WorldObject | null, id: number): void {
    // Unanswered ones are forgotten past a few (the host never saw them).
    if (this.asked.size >= MAX_ASKED) this.asked.delete(this.asked.keys().next().value!);
    this.asked.set(req, { give, object, id });
  }

  private nextRequest(): number {
    this.nextReq = (this.nextReq % 0xffff) + 1;
    return this.nextReq;
  }

  // Receiving ----------------------------------------------------------------------

  private receive(slot: number, data: Uint8Array): void {
    switch (typeOf(data)) {
      case Msg.PlayerState:
        this.players.hear(this.r, data, performance.now());
        break;
      case Msg.Snapshot:
        if (slot === this.session.hostSlot && !this.suspended && this.game) this.heardSnapshot(data);
        break;
      case Msg.Event:
        if (slot === this.session.hostSlot) this.heardEvent(data);
        break;
      case Msg.World:
        if (slot !== this.session.hostSlot) return;
        this.heardAt = performance.now();
        if (worldKind(data) === W.Info) {
          const info = readInfo(this.r, data);
          if (info && !this.info) {
            this.info = info;
            this.infoWaiter?.(info);
            this.infoWaiter = null;
          }
          return;
        }
        // Copied: the link may reuse its buffer before this is applied.
        this.inbox.push(data.slice());
        void this.drain();
        break;
    }
  }

  private async drain(): Promise<void> {
    if (this.draining || !this.game) return;
    this.draining = true;
    try {
      while (this.inbox.length && !this.closed) {
        const data = this.inbox.shift()!;
        try {
          await this.apply(data);
        } catch (e) {
          console.warn('A message from the host could not be applied:', e);
        }
      }
    } finally {
      this.draining = false;
    }
  }

  private async apply(data: Uint8Array): Promise<void> {
    const game = this.game!;
    const { world } = game;
    const r = this.r;
    switch (worldKind(data)) {
      case W.Chunk: {
        const m = readChunk(r, data);
        if (!m) return;
        const bytes = await inflateRaw(m.packed, CHUNK_BYTES);
        if (this.closed) return;
        if (!bytes || bytes.length !== CHUNK_BYTES) {
          this.generator.later(m.cx, m.cy, performance.now());
          return;
        }
        // Only for requests the chunk manager still waits on.
        this.pruneChunks();
        if (!this.generator.wants(m.cx, m.cy)) {
          this.refreshChunk(m);
          return;
        }
        world.adoptChunk(m.cx, m.cy, m.visit, m.biome);
        for (const net of m.objects) this.need(net);
        const key = chunkKey(m.cx, m.cy);
        world.setHarvest(key, m.harvest);
        for (const g of m.ground) this.groundAdd(g, true);
        this.generator.answer(m.cx, m.cy, bytes.subarray(0, CHUNK_BYTES / 2), bytes.subarray(CHUNK_BYTES / 2));
        return;
      }
      case W.ChunkLater: {
        const at = readChunkAt(r, data, W.ChunkLater);
        if (!at) return;
        // Not asked again if it is no longer wanted here.
        this.pruneChunks();
        this.generator.later(at.cx, at.cy, performance.now());
        return;
      }
      case W.ObjectDef: {
        const m = readObject(r, data);
        if (!m) return;
        const bytes = await inflateRaw(m.packed, m.w * m.h * 2);
        if (this.closed) return;
        const layout = layoutFrom(m.w, m.h, bytes, m.buildings);
        this.needed.delete(m.net);
        if (!layout) return;
        const o = new WorldObject(m.id, m.kind, m.name, m.x, m.y, layout);
        o.anchor = m.anchor;
        o.emptyChests = m.emptyChests;
        o.closed = m.closed;
        o.dimension = m.dimension;
        for (const i of m.opened) o.opened.add(i);
        const old = this.netObj.get(m.net);
        if (old) this.objNet.delete(old);
        this.netObj.set(m.net, o);
        this.objNet.set(o, m.net);
        this.hostRemoving = true;
        try {
          world.adoptObject(o);
        } finally {
          this.hostRemoving = false;
        }
        // Let go of at once (none of its chunks is here): tell the host.
        if (!world.objects.objects.has(o.id)) this.session.sendToHost(CTRL, writeNet(this.w, W.ObjectForget, m.net));
        return;
      }
      case W.ObjectGone: {
        const net = readNet(r, data, W.ObjectGone);
        const o = net === null ? undefined : this.netObj.get(net);
        if (!o) return;
        this.hostRemoving = true;
        try {
          world.removeObject(o);
        } finally {
          this.hostRemoving = false;
        }
        this.netObj.delete(net!);
        this.objNet.delete(o);
        return;
      }
      case W.ObjectState: {
        const m = readObjectState(r, data);
        const o = m && this.netObj.get(m.net);
        if (!m || !o) return;
        o.emptyChests = m.emptyChests;
        o.closed = m.closed;
        o.opened.clear();
        for (const i of m.opened) o.opened.add(i);
        // Mined here, not confirmed yet: still gone here.
        const mined = this.minedHere.get(o);
        if (mined) for (const i of mined) o.opened.add(i);
        world.refreshObject(o);
        return;
      }
      case W.Harvest: {
        const m = readHarvest(r, data);
        if (m) world.setHarvest(chunkKey(m.cx, m.cy), m.cells);
        return;
      }
      case W.GroundAdd: {
        const m = readGroundAdd(r, data);
        if (m) this.groundAdd(m.g, m.armed);
        return;
      }
      case W.GroundGone: {
        const id = readNet(r, data, W.GroundGone);
        if (id !== null) world.ground.remove(id);
        return;
      }
      case W.Time: {
        const m = readTime(r, data);
        if (m) game.setClock(m.day, m.minutes, m.weather);
        return;
      }
      case W.Where: {
        const m = readWhere(r, data);
        const rm = m && this.players.bySlot.get(m.slot);
        if (m && rm) this.players.moved(rm, m);
        return;
      }
      case W.RiftInstance: {
        const m = readRiftInstance(r, data);
        if (m) game.riftInstance(m.dimension, m.code);
        return;
      }
      case W.ChestReply: {
        const m = readChestReply(r, data);
        if (!m) return;
        const grant = this.chests.get(m.req);
        this.chests.delete(m.req);
        if (m.ok) {
          grant?.();
          game.saveSoon();
        } else game.notify('Someone got to it first');
        return;
      }
      case W.HarvestReply: {
        const m = readHarvestReply(r, data);
        const a = m && this.asked.get(m.req);
        if (!m || !a) return;
        this.asked.delete(m.req);
        if (a.object) {
          const mined = this.minedHere.get(a.object);
          mined?.delete(a.id);
          if (mined && !mined.size) this.minedHere.delete(a.object);
        }
        if (m.ok) {
          a.give();
          game.saveSoon();
        } else {
          // Not theirs after all: the room shows what the host says.
          if (a.object) {
            a.object.opened.delete(a.id);
            world.refreshObject(a.object);
          }
          game.notify('Someone got to it first');
        }
        return;
      }
      case W.Give: {
        const s = readStack(r, data, W.Give);
        const item = s && itemAt(s.item);
        if (s && item) {
          game.give(item, s.count, s.durability >= 0 ? s.durability : undefined);
          game.saveSoon();
        }
        return;
      }
    }
  }

  /** A chunk named an object this player lacks: ask for it, once. */
  private need(net: number): void {
    if (this.netObj.has(net) || this.needed.has(net)) return;
    this.needed.add(net);
    this.session.sendToHost(CTRL, writeNet(this.w, W.ObjectNeed, net));
  }

  /** A chunk this player holds already, sent again (back after the link
   *  dropped): what was gathered there, what lies there, and which objects
   *  stand over it, as the host has them now. */
  private refreshChunk(m: NonNullable<ReturnType<typeof readChunk>>): void {
    const { world } = this.game!;
    const key = chunkKey(m.cx, m.cy);
    const chunk = world.chunks.chunks.get(key);
    if (!chunk?.ready) return;
    world.setHarvest(key, m.harvest);
    // Objects over it the host no longer has go; ones it lacks are asked for.
    const keep = new Set(m.objects);
    for (const o of world.objects.inChunk(key).slice()) {
      const net = this.objNet.get(o);
      if (net !== undefined && !keep.has(net)) {
        this.hostRemoving = true;
        try {
          world.removeObject(o);
        } finally {
          this.hostRemoving = false;
        }
        this.netObj.delete(net);
        this.objNet.delete(o);
      }
    }
    for (const net of m.objects) this.need(net);
    // The ground there is the host's list.
    const listed = new Set(m.ground.map((g) => g.id));
    for (const it of world.ground.items.slice()) {
      if (chunkKey(tileToChunk(it.x), tileToChunk(it.y)) === key && !listed.has(it.id)) world.ground.remove(it.id);
    }
    for (const g of m.ground) this.groundAdd(g, true);
  }

  /** Lets go of chunk requests the chunk manager no longer waits on. */
  private pruneChunks(): void {
    const chunks = this.game?.world.chunks.chunks;
    if (!chunks) return;
    this.generator.prune((cx, cy, token) => {
      const c = chunks.get(chunkKey(cx, cy));
      return !!c && c.token === token && !c.ready;
    });
  }

  private groundAdd(g: GroundWire, armed: boolean): void {
    const { world } = this.game!;
    const item: ItemDef | undefined = itemAt(g.item);
    if (!item || !itemById(item.id)) return;
    const stack = loadStack(item, { id: item.id, count: g.count, durability: g.durability >= 0 ? g.durability : undefined });
    if (!stack) return;
    const had = world.ground.byId(g.id);
    if (had) {
      had.stack = stack;
      had.x = g.x;
      had.y = g.y;
      return;
    }
    world.ground.drop(stack, g.x, g.y, armed, g.visit, g.id);
  }

  // Creatures ------------------------------------------------------------------------

  private hookCombat(): void {
    const combat = this.game?.combat;
    if (!combat) return;
    combat.onOtherHit = combat.onOtherKill = undefined;
    combat.others.length = 0;
    combat.onReplicaHit = (e, amount, crit, px, py, ranged) => {
      const rep = this.replicaOf(e);
      if (!rep) return;
      this.session.sendToHost(CTRL, writeRequest(this.w, { id: 0, action: Action.Hit, target: rep.id, x: amount, y: Math.atan2(py, px), arg: (crit ? 1 : 0) | (ranged ? 2 : 0) }));
    };
  }

  private heardEvent(data: Uint8Array): void {
    const m = readEvent(this.r, data);
    const game = this.game;
    if (!m || !game) return;
    const n = m.ints;
    switch (m.kind) {
      case GameEvent.Damage: {
        const species = speciesAt(n[1]);
        // No blow harder than a creature could strike.
        if (species && n[0] > 0 && !this.suspended && this.mine.place === Place.Outdoors) game.combat.takeHit(Math.min(MAX_DAMAGE_TAKEN, n[0] / 100), species, unquantizePos(n[2]), unquantizePos(n[3]));
        break;
      }
      case GameEvent.WorldKill: {
        if (n[0] > 0) game.grantXp(Math.min(MAX_KILL_XP, n[0]));
        const species = speciesAt(n[1]);
        if (species) game.killed(species);
        let given = false;
        for (let i = 2; i + 1 < n.length; i += 2) {
          const item = itemAt(n[i]);
          const count = n[i + 1];
          if (item && count > 0 && count <= 999) {
            game.give(item, count);
            given = true;
          }
        }
        if (given) game.saveSoon();
        break;
      }
    }
  }

  private heardSnapshot(data: Uint8Array): void {
    const f = this.receiver.read(this.r, data);
    if (!f) return;
    this.session.sendToHost(SNAP, writeAck(this.w, f.tick));
    this.snapClock.observe(f.tick, performance.now());
    const stamp = ++this.stamp;
    const { combat } = this.game!;
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
        this.game!.replicaGone(rep.enemy, rep.health === 0);
      } else if (rep.shot) {
        const j = combat.projectiles.indexOf(rep.shot);
        if (j >= 0) combat.projectiles.splice(j, 1);
      }
    }
  }

  private makeReplica(id: number, kind: number, flags: number, x: number, y: number): Replica | null {
    const { combat } = this.game!;
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
      enemy = new Enemy(species, x, y, difficultyBand(Math.floor(x), Math.floor(y)), (flags & EntityFlag.Elite) !== 0);
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

  /** Takes every creature and shot drawn here away. */
  private clearReplicas(): void {
    const combat = this.game?.combat;
    for (const rep of this.replicaList) {
      if (!combat) continue;
      if (rep.enemy) combat.remove(rep.enemy);
      else if (rep.shot) {
        const j = combat.projectiles.indexOf(rep.shot);
        if (j >= 0) combat.projectiles.splice(j, 1);
      }
    }
    this.replicas.clear();
    this.replicaList.length = 0;
  }

  /** Starts creatures over: a fresh frame from the host. */
  private resync(): void {
    this.receiver = new SnapshotReceiver();
    this.snapClock.reset();
    this.session.sendToHost(CTRL, writeEmpty(this.w, W.Resync));
  }

  // State and links ---------------------------------------------------------------------

  private sendState(): boolean {
    const p = this.game!.player();
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
    return this.session.sendToHost(SNAP, writePlayerState(this.w, s));
  }

  /** The link to the host is back (the same code, within the window): it
   *  forgot this player's view and what was waiting; say them again. */
  private reconnected(): void {
    this.viewAt.x = NaN;
    this.whereSent = false;
    this.heardAt = performance.now();
    this.pruneChunks();
    this.generator.askAll();
    this.clearReplicas();
    this.resync();
    // What was put down meanwhile goes now.
    const p = this.game?.player();
    for (const s of this.undelivered.splice(0)) if (!this.sendDrop(s, p?.x ?? 0, p?.y ?? 0)) this.undelivered.push(s);
  }

  private unhook(): void {
    const game = this.game;
    if (game) {
      if (game.world.changes === this.changes) game.world.changes = null;
      game.world.ground.reach = null;
      this.clearReplicas();
      const combat = game.combat;
      combat.onReplicaHit = undefined;
    }
    this.session.on = {};
  }

  private end(reason: string): void {
    if (this.closed) return;
    this.closed = true;
    const text = ENDED[reason] ?? ENDED.lost;
    this.infoFailed?.(new Error(text));
    this.infoFailed = this.infoWaiter = null;
    // Things put down that never reached the host come back to the bag.
    const game = this.game;
    if (game) for (const s of this.undelivered.splice(0)) game.give(s.item, s.count, s.durability);
    this.asked.clear();
    this.unhook();
    if (reason !== 'left') this.session.leave();
    if (game) game.ended(text);
    else this.endedEarly = text;
  }
}
