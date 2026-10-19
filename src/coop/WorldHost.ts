// The host's side of a shared overworld: friends visit this player's world by
// its code. Only the host's world is right (biomes grow from whatever loaded
// first, region visits follow where each player went, and engines differ in
// their last bits of `Math.sin`), so the host streams it as it is:
//
// - The land: each guest asks for chunks; the host keeps every guest's view in
//   its own chunk manager (so it generates and keeps what they see, and a
//   region drifts only once it has left everyone's area) and answers with the
//   chunk's base terrain exactly as its workers made it, raw-deflated once,
//   with the region's visit, the biome, the objects over it, what was gathered
//   there and what lies on the ground. Guests compose it the same way.
// - Changes: objects coming and going, chests opened, rifts closed, plants
//   gathered and grown back, items put down and taken, as they happen, to the
//   guests whose area they touch.
// - Creatures: the host runs them all, around every guest too; each guest gets
//   those near it as delta snapshots, 20 times a second. Blows on them are
//   requests the host checks; their blows on a guest are events.
// - The clock and the weather, every few seconds.
//
// Guests' players are their own; everyone sees everyone (the host relays).

import { CHUNK_SIZE, CACHE_MARGIN, RENDER_MARGIN } from '../config';
import { chunkKey, inRect, keyX, keyY, tileToChunk, type ChunkRect } from '../coords';
import { Deco } from '../generation/Tiles';
import type { Enemy } from '../entities/Enemy';
import { itemById, type ItemDef } from '../items/Items';
import { canHarvest } from '../systems/GatheringSystem';
import { loadStack } from '../systems/InventorySystem';
import type { Chunk } from '../world/Chunk';
import { Interior } from '../world/Interior';
import type { View } from '../world/ChunkManager';
import type { GroundItem } from '../world/GroundItems';
import type { WorldChanges } from '../world/WorldManager';
import type { WorldObject } from '../world/WorldObject';
import {
  Action,
  CTRL,
  Msg,
  newPlayerState,
  quantizePos,
  readAck,
  readRequest,
  Reader,
  SNAP,
  SnapshotSender,
  typeOf,
  writeEvent,
  writePlayerState,
  Writer,
  type Member,
  type Session,
} from '../net';
import { deflateRaw } from '../net/crypto';
import { Allowance, maxBlow } from './guard';
import { enemyState, EntityFlag, GameEvent, itemAt, itemId, PlayerFlag, SHOT_KIND_BIT, shotKind, speciesId } from './ids';
import { SEND_HZ } from './interp';
import { Players, type Remote, type Whereabouts } from './players';
import type { WorldGame } from './worldGame';
import {
  Place,
  readChestReq,
  readChunkAt,
  readHarvestReq,
  readMineReq,
  readNet,
  readRiftInstance,
  readStack,
  readView,
  readWhere,
  W,
  worldKind,
  writeChestReply,
  writeChunk,
  writeChunkAt,
  writeGroundAdd,
  writeHarvest,
  writeHarvestReply,
  writeInfo,
  writeNet,
  writeObject,
  writeObjectState,
  writeRiftInstance,
  writeStack,
  writeTime,
  writeWhere,
  type GroundWire,
} from './worldWire';

/** Creatures and shots each guest is sent: those within this many tiles. */
const SEND_RANGE = 36;
/** A guest's blow may land this far from them (reach, plus their lag). */
const MELEE_SLACK = 3;
const SHOT_RANGE = 15;
const HITS_PER_SECOND = 10;
/** How far from a guest what they gather, open, pick up or drop may be, in tiles. */
const HAND_REACH = 4;
/** Picking up and dropping: a little more than a step, for the guest's lag. */
const PICK_REACH = 3;
/** The clock is shared this often, in seconds. */
const CLOCK_EVERY = 5;
const ITEM_PAIRS = 7;
/** Things a guest may put down a second (and at once), and lying on the ground at a time. */
const DROPS_PER_SECOND = 3;
const DROP_BURST = 10;
const GUEST_GROUND = 40;
/** Chunks and objects a guest may ask for a second (and at once: a first view is many). */
const ASKS_PER_SECOND = 40;
const ASK_BURST = 160;
/** Closing a rift: the guest must stand by it, back from behind a rift lately (ms). */
const RIFT_REACH = 6;
const BACK_FROM_RIFT_MS = 120_000;
/** A guest may wake this close to this player (after collapsing). */
const WAKE_REACH = 4;
/** Rooms kept built for checking requests from inside them. */
const ROOMS_KEPT = 16;
/** Creature ids on the wire: 1 to this (shots use the upper half). */
const ENEMY_IDS = 0x7fff;

interface Guest {
  slot: number;
  rm: Remote;
  /** Their view, as the chunk manager streams for it; null until heard. */
  view: View | null;
  /** The chunks they hold (their cache area, as the host works it out). */
  cache: ChunkRect;
  /** Objects they have been sent and not let go of, by host id. */
  sent: Set<number>;
  /** Chunks they asked for that are still generating. */
  pending: Set<number>;
  sender: SnapshotSender;
  /** Blows they may still land this second. */
  tokens: number;
  /** Puttings down, and asks for chunks and objects, they may still make. */
  drops: Allowance;
  asks: Allowance;
  /** What they put down that may still lie on the ground, by id. */
  dropped: Set<number>;
  /** When they were last behind a rift (ms), or -Infinity. */
  awayAt: number;
}

export class WorldHost {
  readonly players: Players;
  /** Guests' views, for the world's chunk manager; changes as views arrive. */
  readonly views: View[] = [];
  private readonly guests = new Map<number, Guest>();
  private readonly w = new Writer(4096);
  private readonly r = new Reader();
  private readonly state = newPlayerState();
  private tick = 0;
  private snapTick = 0;
  private sendTimer = 0;
  private clockTimer = 0;
  private pruneTimer = 0;
  private closed = false;
  /** Behind a rift: the overworld's creatures wait, and guests see none. */
  private suspended = false;
  private readonly mine: Whereabouts = { place: Place.Outdoors, object: 0, index: 0, floor: 0, tick: 0 };
  /** Rooms built to check what guests do inside, by object, building and floor. */
  private readonly rooms = new Map<string, Interior>();
  // Objects and creatures by their ids on the wire.
  private readonly objNet = new Map<WorldObject, number>();
  private readonly netObj = new Map<number, WorldObject>();
  private nextObj = 1;
  private readonly enemyNet = new Map<Enemy, number>();
  private readonly netEnemy = new Map<number, Enemy>();
  private nextEnemy = 1;
  // Deflated terrain, once per chunk generation, and object layouts.
  private readonly packs = new Map<number, { token: number; bytes: Promise<Uint8Array> }>();
  private readonly objPacks = new WeakMap<WorldObject, Promise<Uint8Array>>();

  private readonly changes: WorldChanges = {
    objectAdded: (o) => this.objectAdded(o),
    objectRemoved: (o) => this.objectRemoved(o),
    objectChanged: (o) => this.objectChanged(o),
    harvested: (gx, gy) => this.harvestChanged(tileToChunk(gx), tileToChunk(gy)),
    regrown: (key) => {
      const c = this.game.world.chunks.chunks.get(key);
      if (c) this.harvestChanged(c.cx, c.cy);
    },
  };

  constructor(
    readonly session: Session,
    private readonly game: WorldGame,
    /** The world's join code, to show. */
    readonly code: string,
    private readonly stop: () => void,
    /** A test world: guests save nothing of it. */
    private readonly playground = false,
  ) {
    this.players = new Players(newPlayerState());
    // Opened from behind a rift: the overworld waits (another fight has the combat) until `resume`.
    if (game.where().place === Place.Away) this.suspended = true;
    const world = game.world;
    world.changes = this.changes;
    world.ground.listener = { added: (g) => this.groundAdded(g), removed: (g) => this.groundRemoved(g) };
    world.chunks.onReady = (c) => this.chunkReady(c);
    for (const m of session.members()) if (m.slot !== session.slot) this.addGuest(m);
    session.on = {
      joinRequest: (name) => game.joinRequest(name),
      peerJoined: (m) => this.addGuest(m),
      peerBack: (m) => this.addGuest(m),
      peerAway: (slot) => this.away(slot),
      peerLeft: (slot) => this.removeGuest(slot),
      message: (slot, _channel, data) => this.receive(slot, data),
      ended: () => this.unhook(),
    };
    if (!this.suspended) this.hook();
  }

  /** The session ended (closed here, or lost). */
  get isClosed(): boolean {
    return this.closed;
  }

  get hasGuests(): boolean {
    return this.guests.size > 0;
  }

  /** Some guest is outdoors: the wild must go on around them. */
  get guestsOutdoors(): boolean {
    for (const g of this.guests.values()) if (g.rm.heard && g.rm.where.place === Place.Outdoors) return true;
    return false;
  }

  /** Names of everyone here, this player first. */
  names(): string[] {
    return this.session.members().map((m) => (m.slot === this.session.slot ? `${m.name} (you)` : m.name));
  }

  /** Guests, for the beacon (to send home). */
  guestList(): Array<{ slot: number; name: string }> {
    return [...this.guests.values()].map((g) => ({ slot: g.slot, name: g.rm.view.name }));
  }

  kick(slot: number): void {
    this.session.kick(slot);
  }

  /** Closes the world to visitors: they are sent home. */
  close(): void {
    if (this.closed) return;
    this.unhook();
    this.stop();
  }

  // Per frame ----------------------------------------------------------------------

  update(dt: number, now = performance.now()): void {
    if (this.closed) return;
    const where = this.game.where();
    const mine = this.mine;
    const object = where.object ? this.netOf(where.object) : 0;
    if (where.place !== mine.place || object !== mine.object || where.index !== mine.index || where.floor !== mine.floor) {
      mine.place = where.place;
      mine.object = object;
      mine.index = where.index;
      mine.floor = where.floor;
      mine.tick = this.tick + 1;
      this.session.broadcast(CTRL, writeWhere(this.w, { ...mine, slot: this.session.slot }));
    }
    this.sendTimer -= dt;
    if (this.sendTimer <= 0) {
      this.sendTimer = Math.max(0, this.sendTimer + 1 / SEND_HZ);
      this.sendState();
      this.sendSnapshots();
    }
    this.clockTimer -= dt;
    if (this.clockTimer <= 0) {
      this.clockTimer = CLOCK_EVERY;
      this.sendClock();
    }
    this.pruneTimer -= dt;
    if (this.pruneTimer <= 0) {
      this.pruneTimer = 1;
      this.prune();
    }
    for (const g of this.guests.values()) g.tokens = Math.min(HITS_PER_SECOND, g.tokens + HITS_PER_SECOND * dt);
    this.players.update(dt, now, mine);
    if (!this.suspended) {
      // Creatures hunt every guest outdoors as well as this player.
      const others = this.game.combat.others;
      others.length = 0;
      for (const g of this.guests.values()) if (g.rm.heard && g.rm.where.place === Place.Outdoors) others.push(g.rm.body);
    }
  }

  /** The clock changed at once (a night slept through): tell everyone now. */
  clockJumped(): void {
    this.clockTimer = 0;
  }

  /** This player went behind a rift: the overworld's creatures wait (another
   *  fight takes the combat), and guests see none until `resume`. */
  suspend(): void {
    if (this.suspended) return;
    this.suspended = true;
    this.unhookCombat();
  }

  resume(): void {
    if (!this.suspended || this.closed) return;
    this.suspended = false;
    this.hook();
  }

  /** This player went into a shared instance behind a rift: friends may follow. */
  wentBehind(dimension: string, code: string): void {
    this.session.broadcast(CTRL, writeRiftInstance(this.w, this.session.slot, dimension, code));
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

  private sendClock(): void {
    const c = this.game.clock();
    if (this.guests.size) this.session.broadcast(CTRL, writeTime(this.w, c.day, c.minutes, c.weather));
  }

  // Guests -------------------------------------------------------------------------

  private addGuest(m: Member): void {
    if (m.slot === this.session.slot) return;
    const rm = this.players.add(m, this.session.slot);
    if (!rm) return;
    const back = this.guests.get(m.slot);
    if (!back) {
      this.guests.set(m.slot, {
        slot: m.slot,
        rm,
        view: null,
        cache: { x0: 0, y0: 0, x1: -1, y1: -1 },
        sent: new Set(),
        pending: new Set(),
        sender: new SnapshotSender(),
        tokens: HITS_PER_SECOND,
        drops: new Allowance(DROPS_PER_SECOND, DROP_BURST),
        asks: new Allowance(ASKS_PER_SECOND, ASK_BURST),
        dropped: new Set(),
        awayAt: -Infinity,
      });
      this.game.notify(`${m.name} steps into your world.`);
    } else if (back.rm === rm) this.resync(back);
    this.game.peopleChanged();
  }

  /** Their link dropped: they may be back within the session's window. Their
   *  view stays (their land must not drift meanwhile); they vanish until heard. */
  private away(slot: number): void {
    this.players.away(slot);
  }

  /** Back after their link dropped: what changed meanwhile never reached
   *  them, so every chunk they hold is sent again (they put right what they
   *  have), and every object's state. */
  private resync(g: Guest): void {
    g.pending.clear();
    g.sender.resetBaseline();
    if (!g.view) return;
    const { chunks } = this.game.world;
    for (const c of chunks.chunks.values()) if (c.ready && inRect(g.cache, c.cx, c.cy)) this.serve(g, c);
    for (const net of g.sent) {
      const o = this.netObj.get(net);
      if (o) this.session.send(g.slot, CTRL, writeObjectState(this.w, net, o.emptyChests, o.closed, o.opened));
    }
  }

  private removeGuest(slot: number): void {
    const g = this.guests.get(slot);
    this.players.remove(slot);
    if (!g) return;
    this.guests.delete(slot);
    this.dropView(g);
    this.game.notify(`${g.rm.view.name} leaves your world.`);
    this.game.peopleChanged();
  }

  private dropView(g: Guest): void {
    if (!g.view) return;
    const i = this.views.indexOf(g.view);
    if (i >= 0) this.views.splice(i, 1);
    g.view = null;
    g.pending.clear();
  }

  private setView(g: Guest, x: number, y: number, px: number, py: number, halfW: number, halfH: number, dirX: number, dirY: number): void {
    let v = g.view;
    if (!v) {
      v = g.view = { minX: 0, minY: 0, maxX: 0, maxY: 0, playerX: 0, playerY: 0, dirX: 0, dirY: 0 };
      this.views.push(v);
    }
    v.minX = x - halfW;
    v.minY = y - halfH;
    v.maxX = x + halfW;
    v.maxY = y + halfH;
    v.playerX = px;
    v.playerY = py;
    v.dirX = dirX;
    v.dirY = dirY;
    // Their cache area, as their own chunk manager works it out, and a chunk
    // more: their view is only sent again after a few steps, so they may hold
    // a chunk past what it last said.
    const c = g.cache;
    c.x0 = tileToChunk(v.minX) - RENDER_MARGIN - CACHE_MARGIN - 1;
    c.y0 = tileToChunk(v.minY) - RENDER_MARGIN - CACHE_MARGIN - 1;
    c.x1 = tileToChunk(Math.ceil(v.maxX) - 1) + RENDER_MARGIN + CACHE_MARGIN + 1;
    c.y1 = tileToChunk(Math.ceil(v.maxY) - 1) + RENDER_MARGIN + CACHE_MARGIN + 1;
  }

  /** Their feet in the world: outdoors, where they stand; else their view's spot. */
  private spot(g: Guest): { x: number; y: number } | null {
    if (g.rm.heard && g.rm.where.place === Place.Outdoors) return g.rm.body;
    return g.view ? { x: g.view.playerX, y: g.view.playerY } : null;
  }

  // Receiving ----------------------------------------------------------------------

  private receive(slot: number, data: Uint8Array): void {
    const g = this.guests.get(slot);
    if (!g) return;
    switch (typeOf(data)) {
      case Msg.PlayerState: {
        // Guests may only speak for themselves, and move as a player can.
        if (data.length < 2 || data[1] !== slot) return;
        this.heardAt = performance.now();
        if (this.players.hear(this.r, data, this.heardAt, this.believe)) this.session.broadcast(SNAP, data, slot);
        break;
      }
      case Msg.Ack: {
        const tick = readAck(this.r, data);
        if (tick !== null) g.sender.ack(tick);
        break;
      }
      case Msg.Request:
        this.request(g, data);
        break;
      case Msg.World:
        this.world(g, data);
        break;
    }
  }

  private world(g: Guest, data: Uint8Array): void {
    const r = this.r;
    const { world } = this.game;
    switch (worldKind(data)) {
      case W.Hello: {
        const at = this.game.spot();
        const c = this.game.clock();
        this.session.send(g.slot, CTRL, writeInfo(this.w, { seed: world.seed, x: at.x, y: at.y, day: c.day, minutes: c.minutes, weather: c.weather, playground: this.playground }));
        // Where everyone is, so the newcomer draws them in the right place.
        this.session.send(g.slot, CTRL, writeWhere(this.w, { slot: this.session.slot, ...this.mine }));
        for (const o of this.guests.values()) if (o !== g) this.session.send(g.slot, CTRL, writeWhere(this.w, { slot: o.slot, ...o.rm.where }));
        break;
      }
      case W.View: {
        const v = readView(r, data);
        if (v) this.setView(g, v.x, v.y, v.px, v.py, v.halfW, v.halfH, v.dirX, v.dirY);
        break;
      }
      case W.ChunkReq: {
        const at = readChunkAt(r, data, W.ChunkReq);
        if (!at) break;
        // Asked too fast: later (they ask again).
        if (g.asks.take(performance.now())) this.chunkWanted(g, at.cx, at.cy);
        else this.session.send(g.slot, CTRL, writeChunkAt(this.w, W.ChunkLater, at.cx, at.cy));
        break;
      }
      case W.ObjectNeed: {
        const net = readNet(r, data, W.ObjectNeed);
        // What they were sent (or is on its way) is not sent again.
        if (net === null || g.sent.has(net) || !g.asks.take(performance.now())) break;
        const o = this.netObj.get(net);
        if (o) this.sendObject(g, o);
        else this.session.send(g.slot, CTRL, writeNet(this.w, W.ObjectGone, net));
        break;
      }
      case W.ObjectForget: {
        const net = readNet(r, data, W.ObjectForget);
        if (net !== null) g.sent.delete(net);
        break;
      }
      case W.Where: {
        const m = readWhere(r, data);
        if (!m) break;
        // Rooms only of objects this world has.
        if (m.place === Place.Indoors && !this.netObj.has(m.object)) m.place = Place.Away;
        if (m.place === Place.Away || g.rm.where.place === Place.Away) g.awayAt = performance.now();
        this.players.moved(g.rm, m);
        if (m.place !== Place.Outdoors) g.sender.resetBaseline();
        this.session.broadcast(CTRL, writeWhere(this.w, { ...m, slot: g.slot }), g.slot);
        break;
      }
      case W.RiftInstance: {
        const m = readRiftInstance(r, data);
        if (m) this.session.broadcast(CTRL, writeRiftInstance(this.w, g.slot, m.dimension, m.code), g.slot);
        if (m) this.game.riftInstance(m.dimension, m.code);
        break;
      }
      case W.Resync:
        g.sender.resetBaseline();
        break;
      case W.HarvestReq: {
        const m = readHarvestReq(r, data);
        if (!m) break;
        const ok = this.harvestWanted(g, m.gx, m.gy, m.deco);
        if (m.req) this.session.send(g.slot, CTRL, writeHarvestReply(this.w, m.req, ok));
        break;
      }
      case W.MineReq: {
        const m = readMineReq(r, data);
        if (m) this.session.send(g.slot, CTRL, writeHarvestReply(this.w, m.req, this.mineWanted(g, m.net, m.id)));
        break;
      }
      case W.ChestReq: {
        const m = readChestReq(r, data);
        if (m) this.session.send(g.slot, CTRL, writeChestReply(this.w, m.req, this.chestWanted(g, m.net, m.index)));
        break;
      }
      case W.PickupReq: {
        const id = readNet(r, data, W.PickupReq);
        if (id !== null) this.pickupWanted(g, id);
        break;
      }
      case W.DropReq: {
        const s = readStack(r, data, W.DropReq);
        if (s) this.dropWanted(g, s.item, s.count, s.durability, s.x, s.y);
        break;
      }
      case W.CloseRiftReq: {
        const net = readNet(r, data, W.CloseRiftReq);
        const o = net === null ? undefined : this.netObj.get(net);
        if (o?.kind !== 'rift' || o.closed) break;
        // Only by one who just came back out of it.
        if (performance.now() - g.awayAt > BACK_FROM_RIFT_MS || !this.nearSpot(g, o.x + o.w / 2, o.y + o.h / 2, RIFT_REACH + Math.max(o.w, o.h) / 2)) break;
        world.closeRift(o);
        break;
      }
    }
  }

  /** When the state being heard came, and whether its position can be true (no closure per message). */
  private heardAt = 0;
  private readonly believe = (rm: Remote, x: number, y: number): boolean => rm.move.check(x, y, this.heardAt, this.wakesHere);

  /** A guest woke beside this player after collapsing: a fair jump. */
  private readonly wakesHere = (x: number, y: number): boolean => {
    const p = this.game.player();
    return this.mine.place === Place.Outdoors && Math.hypot(p.x - x, p.y - y) <= WAKE_REACH;
  };

  private request(g: Guest, data: Uint8Array): void {
    const q = readRequest(this.r, data);
    if (!q || q.action !== Action.Hit || this.suspended) return;
    const e = this.netEnemy.get(q.target);
    const at = g.rm.heard && g.rm.where.place === Place.Outdoors ? g.rm.body : null;
    if (!e || !at || !e.alive || e.replica || g.tokens < 1) return;
    const d = Math.hypot(e.x - at.x, e.y - at.y);
    if (d > SHOT_RANGE || !(q.x >= 1)) return;
    // A sword's blow must be within reach; arrows (bit 2) fly further.
    if (!(q.arg & 2) && d > MELEE_SLACK) return;
    g.tokens--;
    // No stronger than the weapon in their hand could strike.
    this.game.combat.strike(e, Math.min(maxBlow(g.rm.view.holding), Math.round(q.x)), (q.arg & 1) === 1, Math.cos(q.y), Math.sin(q.y), g.rm.key);
  }

  // The land -----------------------------------------------------------------------

  private chunkWanted(g: Guest, cx: number, cy: number): void {
    const { chunks } = this.game.world;
    // Only within what their view reaches (and the chunk manager keeps).
    if (!g.view || !inRect(g.cache, cx, cy) || !chunks.demand(cx, cy)) {
      this.session.send(g.slot, CTRL, writeChunkAt(this.w, W.ChunkLater, cx, cy));
      return;
    }
    const c = chunks.get(cx, cy);
    if (c?.ready) this.serve(g, c);
    else g.pending.add(chunkKey(cx, cy));
  }

  private chunkReady(c: Chunk): void {
    for (const g of this.guests.values()) {
      if (!g.pending.delete(c.key)) continue;
      this.serve(g, c);
    }
  }

  private pack(c: Chunk): Promise<Uint8Array> {
    let p = this.packs.get(c.key);
    if (!p || p.token !== c.token) {
      const both = new Uint8Array(CHUNK_SIZE * CHUNK_SIZE * 2);
      both.set(c.baseTiles);
      both.set(c.baseDecos, CHUNK_SIZE * CHUNK_SIZE);
      p = { token: c.token, bytes: deflateRaw(both) };
      this.packs.set(c.key, p);
    }
    return p.bytes;
  }

  private objPack(o: WorldObject): Promise<Uint8Array> {
    let p = this.objPacks.get(o);
    if (!p) {
      const { tiles, decos } = o.layout;
      const both = new Uint8Array(tiles.length * 2);
      both.set(tiles);
      both.set(decos, tiles.length);
      p = deflateRaw(both);
      this.objPacks.set(o, p);
    }
    return p;
  }

  /** Sends a guest a chunk, after any objects over it they lack. */
  private serve(g: Guest, c: Chunk): void {
    const { world } = this.game;
    const token = c.token;
    const objects = world.objects.inChunk(c.key).slice();
    void Promise.all([this.pack(c), ...objects.map((o) => this.objPack(o))]).then(([packed, ...layouts]) => {
      if (this.closed || this.guests.get(g.slot) !== g) return;
      if (world.chunks.chunks.get(c.key) !== c || c.token !== token || !c.ready) {
        // Gone meanwhile: they will ask again.
        this.session.send(g.slot, CTRL, writeChunkAt(this.w, W.ChunkLater, c.cx, c.cy));
        return;
      }
      // The objects first, so the chunk is composed with them.
      const nets: number[] = [];
      for (const o of world.objects.inChunk(c.key)) {
        const net = this.netOf(o);
        nets.push(net);
        if (g.sent.has(net)) continue;
        const k = objects.indexOf(o);
        // One that came while packing is sent on its own.
        if (k >= 0) this.writeObject(g, o, net, layouts[k]);
        else this.sendObject(g, o);
      }
      const b = world.biomes.at(c.key);
      const ground: GroundWire[] = [];
      for (const it of world.ground.items) {
        if (tileToChunk(it.x) === c.cx && tileToChunk(it.y) === c.cy) ground.push(groundWire(it));
      }
      this.session.send(
        g.slot,
        CTRL,
        writeChunk(this.w, {
          cx: c.cx,
          cy: c.cy,
          visit: world.regions.visit(c.cx, c.cy),
          biome: b ? { id: b.id, type: b.type, variant: b.variant, seed: b.seed } : null,
          packed,
          objects: nets,
          harvest: world.harvestOf(c.key),
          ground,
        }),
      );
    });
  }

  private netOf(o: WorldObject): number {
    let net = this.objNet.get(o);
    if (!net) {
      net = this.nextObj++;
      this.objNet.set(o, net);
      this.netObj.set(net, o);
    }
    return net;
  }

  /** Sends an object's whole record, once its layout is packed. */
  private sendObject(g: Guest, o: WorldObject): void {
    const net = this.netOf(o);
    g.sent.add(net);
    void this.objPack(o).then((packed) => {
      if (this.closed || this.guests.get(g.slot) !== g || this.netObj.get(net) !== o || !g.sent.has(net)) return;
      this.writeObject(g, o, net, packed);
    });
  }

  private writeObject(g: Guest, o: WorldObject, net: number, packed: Uint8Array): void {
    g.sent.add(net);
    this.session.send(
      g.slot,
      CTRL,
      writeObject(this.w, {
        net,
        id: o.id,
        kind: o.kind,
        name: o.name,
        x: o.x,
        y: o.y,
        w: o.w,
        h: o.h,
        packed,
        buildings: o.layout.buildings,
        anchor: o.anchor,
        emptyChests: o.emptyChests,
        closed: o.closed,
        dimension: o.dimension,
        opened: o.opened,
      }),
    );
  }

  private touches(g: Guest, o: WorldObject): boolean {
    for (const key of o.chunks) if (inRect(g.cache, keyX(key), keyY(key))) return true;
    return false;
  }

  private objectAdded(o: WorldObject): void {
    for (const g of this.guests.values()) if (g.view && this.touches(g, o)) this.sendObject(g, o);
  }

  private objectRemoved(o: WorldObject): void {
    const net = this.objNet.get(o);
    if (!net) return;
    this.objNet.delete(o);
    this.netObj.delete(net);
    for (const g of this.guests.values()) {
      if (g.sent.delete(net)) this.session.send(g.slot, CTRL, writeNet(this.w, W.ObjectGone, net));
    }
  }

  private objectChanged(o: WorldObject): void {
    const net = this.objNet.get(o);
    if (!net) return;
    for (const g of this.guests.values()) {
      if (g.sent.has(net)) this.session.send(g.slot, CTRL, writeObjectState(this.w, net, o.emptyChests, o.closed, o.opened));
    }
  }

  private harvestChanged(cx: number, cy: number): void {
    if (!this.guests.size) return;
    const cells = this.game.world.harvestOf(chunkKey(cx, cy));
    for (const g of this.guests.values()) {
      if (g.view && inRect(g.cache, cx, cy)) this.session.send(g.slot, CTRL, writeHarvest(this.w, cx, cy, cells));
    }
  }

  private groundAdded(it: GroundItem): void {
    const cx = tileToChunk(it.x);
    const cy = tileToChunk(it.y);
    for (const g of this.guests.values()) {
      if (g.view && inRect(g.cache, cx, cy)) this.session.send(g.slot, CTRL, writeGroundAdd(this.w, groundWire(it), it.armed));
    }
  }

  private groundRemoved(it: GroundItem): void {
    for (const g of this.guests.values()) this.session.send(g.slot, CTRL, writeNet(this.w, W.GroundGone, it.id));
  }

  // What guests ask -----------------------------------------------------------------

  /** Outdoors and within reach of this spot. */
  private near(g: Guest, x: number, y: number, reach: number): boolean {
    return g.rm.where.place === Place.Outdoors && this.nearSpot(g, x, y, reach);
  }

  /** Within reach of their spot in the world: where they stand outdoors, or
   *  the doorstep of their room or rift (what does not fit in their bag
   *  there is left outside). */
  private nearSpot(g: Guest, x: number, y: number, reach: number): boolean {
    const at = this.spot(g);
    return !!at && Math.hypot(at.x - x, at.y - y) <= reach;
  }

  /** Gathering outdoors; true if it was theirs to take. */
  private harvestWanted(g: Guest, gx: number, gy: number, deco: number): boolean {
    const { world } = this.game;
    if (deco && canHarvest(deco) && this.near(g, gx + 0.5, gy + 0.5, HAND_REACH) && world.tileAt(gx, gy)?.deco === deco) {
      world.harvest(gx, gy);
      return true;
    }
    // Not theirs to take (gone already, or out of reach): set them right.
    const cx = tileToChunk(gx);
    const cy = tileToChunk(gy);
    this.session.send(g.slot, CTRL, writeHarvest(this.w, cx, cy, world.harvestOf(chunkKey(cx, cy))));
    return false;
  }

  /** The room a guest is in, built here to check what they do there; null if
   *  they are not in one of this object's rooms. */
  private roomOf(g: Guest, o: WorldObject, net: number): Interior | null {
    const w = g.rm.where;
    if (w.place !== Place.Indoors || w.object !== net) return null;
    const spec = o.layout.buildings[w.index];
    if (!spec || (w.floor !== 0 && (spec.style !== 'keep' || w.floor < -1 || w.floor > 1))) return null;
    const key = `${o.id}/${w.index}/${w.floor}`;
    let room = this.rooms.get(key);
    if (!room) {
      room = new Interior(o, w.index, w.floor);
      if (this.rooms.size >= ROOMS_KEPT) this.rooms.delete(this.rooms.keys().next().value!);
      this.rooms.set(key, room);
    }
    return room;
  }

  /** Within reach of a tile of their room (their feet, as last said, are in the room's tiles). */
  private nearInside(g: Guest, x: number, y: number): boolean {
    return g.rm.heard && Math.hypot(g.rm.x - (x + 0.5), g.rm.y - (y + 0.5)) <= HAND_REACH;
  }

  /** A chest outdoors (by its place in the layout) or in a room (by its id there). */
  private chestWanted(g: Guest, net: number, index: number): boolean {
    const o = this.netObj.get(net);
    if (!o || o.opened.has(index) || o.emptyChests) return false;
    const room = this.roomOf(g, o, net);
    if (room) {
      // A chest really there, in their room, within their reach.
      const t = room.tileOf(index);
      if (!t || t.deco !== Deco.Chest || room.chestId(t.x, t.y) !== index || !this.nearInside(g, t.x, t.y)) return false;
    } else {
      if (index >= o.w * o.h || o.layout.decos[index] !== Deco.Chest) return false;
      if (!this.near(g, o.x + (index % o.w) + 0.5, o.y + Math.floor(index / o.w) + 0.5, HAND_REACH)) return false;
    }
    this.game.world.openChest(o, index);
    return true;
  }

  /** Mining or gathering in a room; true if it was theirs to take (it is gone for everyone). */
  private mineWanted(g: Guest, net: number, id: number): boolean {
    const o = this.netObj.get(net);
    if (!o || o.opened.has(id)) return false;
    const room = this.roomOf(g, o, net);
    const t = room?.tileOf(id);
    if (!room || !t || room.minedId(t.x, t.y) !== id || !canHarvest(t.deco) || !this.nearInside(g, t.x, t.y)) return false;
    o.opened.add(id);
    this.game.world.refreshObject(o);
    this.objectChanged(o);
    return true;
  }

  private pickupWanted(g: Guest, id: number): void {
    const { world } = this.game;
    const it = world.ground.byId(id);
    if (!it || !this.near(g, it.x, it.y, PICK_REACH)) return;
    world.ground.remove(id);
    const s = it.stack;
    this.give(g, itemId(s.item), s.count, s.durability ?? -1);
  }

  /** Something a guest put down: on this world's ground, or (if it may not
   *  lie there) given back, so nothing is ever lost on the way. */
  private dropWanted(g: Guest, itemIndex: number, count: number, durability: number, x: number, y: number): void {
    const item: ItemDef | undefined = itemAt(itemIndex);
    const known = !!item && !!itemById(item.id);
    const ok =
      known &&
      !item.bound &&
      count <= Math.max(1, item.stack) &&
      this.nearSpot(g, x, y, PICK_REACH) &&
      g.drops.take(performance.now()) &&
      this.groundRoom(g);
    const stack = ok ? loadStack(item, { id: item.id, count, durability: durability >= 0 ? durability : undefined }) : null;
    if (stack) {
      g.dropped.add(this.game.world.ground.drop(stack, x, y).id);
      return;
    }
    // Refused: back to them (not if no such item exists).
    if (known) this.give(g, itemIndex, count, durability);
  }

  /** Whether a guest may put one more thing on the ground (their own
   *  things lying there are few enough). */
  private groundRoom(g: Guest): boolean {
    if (g.dropped.size < GUEST_GROUND) return true;
    const ground = this.game.world.ground;
    for (const id of g.dropped) if (!ground.byId(id)) g.dropped.delete(id);
    return g.dropped.size < GUEST_GROUND;
  }

  private give(g: Guest, item: number, count: number, durability: number): void {
    this.session.send(g.slot, CTRL, writeStack(this.w, W.Give, { item, count, durability }));
  }

  // Creatures ------------------------------------------------------------------------

  private hook(): void {
    const combat = this.game.combat;
    combat.onReplicaHit = undefined;
    combat.onOtherHit = (slot, raw, species, fx, fy) => {
      if (this.guests.has(slot)) this.event(slot, GameEvent.Damage, [Math.round(raw * 100), speciesId(species), quantizePos(fx), quantizePos(fy)]);
    };
    combat.onOtherKill = (who, e, xp, drops) => {
      let slot = -1;
      for (const g of this.guests.values()) if (g.rm.key === who) slot = g.slot;
      if (slot < 0) return;
      // The xp and the creature first; spoils that do not fit follow in more events (no xp, no creature).
      let ints = [xp, speciesId(e.species)];
      for (const [item, count] of drops) {
        if (count <= 0) continue;
        if (ints.length >= 2 + ITEM_PAIRS * 2) {
          this.event(slot, GameEvent.WorldKill, ints);
          ints = [0, -1];
        }
        ints.push(itemId(item), count);
      }
      this.event(slot, GameEvent.WorldKill, ints);
    };
  }

  private unhookCombat(): void {
    const combat = this.game.combat;
    combat.onOtherHit = combat.onOtherKill = undefined;
    combat.others.length = 0;
  }

  private unhook(): void {
    if (this.closed) return;
    this.closed = true;
    const { world } = this.game;
    if (world.changes === this.changes) world.changes = null;
    world.ground.listener = null;
    world.chunks.onReady = undefined;
    this.views.length = 0;
    if (!this.suspended) this.unhookCombat();
    this.session.on = {};
    this.game.peopleChanged();
  }

  private event(slot: number, kind: number, ints: number[], text = ''): void {
    this.session.send(slot, CTRL, writeEvent(this.w, { kind, ints, text }));
  }

  private enemyId(e: Enemy): number {
    let id = this.enemyNet.get(e);
    if (id) return id;
    for (let tries = 0; tries < ENEMY_IDS; tries++) {
      id = this.nextEnemy;
      this.nextEnemy = (this.nextEnemy % ENEMY_IDS) + 1;
      if (!this.netEnemy.has(id)) break;
    }
    this.enemyNet.set(e, id!);
    this.netEnemy.set(id!, e);
    return id!;
  }

  /** Forgets creatures that are gone, and packed terrain of chunks unloaded. */
  private prune(): void {
    const enemies = this.game.combat.enemies;
    if (this.enemyNet.size) {
      const live = new Set(enemies);
      for (const [e, id] of this.enemyNet) {
        if (live.has(e) && e.alive) continue;
        this.enemyNet.delete(e);
        this.netEnemy.delete(id);
      }
    }
    const chunks = this.game.world.chunks.chunks;
    for (const [key, p] of this.packs) if (chunks.get(key)?.token !== p.token) this.packs.delete(key);
    // Chunks a guest waits on that were let go before they were made: say so,
    // or they would wait for ever.
    for (const g of this.guests.values()) {
      for (const key of g.pending) {
        if (chunks.has(key)) continue;
        g.pending.delete(key);
        this.session.send(g.slot, CTRL, writeChunkAt(this.w, W.ChunkLater, keyX(key), keyY(key)));
      }
    }
  }

  /** The creatures and enemy shots near each guest outdoors; none while this
   *  player is behind a rift (they wait, with the overworld). */
  private sendSnapshots(): void {
    if (!this.guests.size) return;
    const { combat } = this.game;
    const tick = ++this.snapTick;
    const r2 = SEND_RANGE * SEND_RANGE;
    for (const g of this.guests.values()) {
      const at = g.rm.heard && g.rm.where.place === Place.Outdoors ? g.rm.body : null;
      if (!at) continue;
      const f = g.sender.frame;
      f.clear();
      if (!this.suspended) {
        for (const e of combat.enemies) {
          if ((e.x - at.x) ** 2 + (e.y - at.y) ** 2 > r2) continue;
          const dir = (e.facing > 0 ? 1 : 0) | (enemyState(e.state) << 2);
          const flags = (e.elite ? EntityFlag.Elite : 0) | (e.hitFlash > 0 ? EntityFlag.Flash : 0) | (e.windingUp ? EntityFlag.Windup : 0) | (e.moving ? EntityFlag.Moving : 0);
          if (!f.push(this.enemyId(e), speciesId(e.species), quantizePos(e.x), quantizePos(e.y), dir, Math.round((Math.max(0, e.hp) / e.maxHp) * 0xffff), flags)) break;
        }
        for (const p of combat.projectiles) {
          if (p.fromPlayer || !p.id || (p.x - at.x) ** 2 + (p.y - at.y) ** 2 > r2) continue;
          const angle = Math.round(((Math.atan2(p.vy, p.vx) / (Math.PI * 2)) * 256) & 0xff);
          if (!f.push(p.id, SHOT_KIND_BIT | shotKind(p.kind), quantizePos(p.x), quantizePos(p.y), angle, 0xffff, 0)) break;
        }
      }
      this.session.send(g.slot, SNAP, g.sender.encode(this.w, tick));
    }
  }
}

function groundWire(it: GroundItem): GroundWire {
  return { id: it.id, item: itemId(it.stack.item), count: it.stack.count, durability: it.stack.durability ?? -1, x: it.x, y: it.y, visit: it.visit };
}
