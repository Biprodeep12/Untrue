// One trip into an outer dimension behind a rift: its land (a `DimensionWorld`
// streamed like the overworld), the run of its challenges (src/dimension),
// the enemies the run asked for and those roaming its land, what the player
// has seen of it (the map's fog), and the ground under the player for
// collision and combat. The game makes one when the player steps into a rift
// and drops it on the way out; the overworld waits meanwhile, its own enemies
// stashed by the combat system.

import { CHUNK_SIZE } from '../config';
import { DimensionRun, type DimEvent } from '../dimension/Challenges';
import { LOCAL } from '../dimension/Contribution';
import type { Clue, DimensionDef, DimensionLayout, SpawnZone } from '../dimension/Dimension';
import type { DimensionWorld } from '../dimension/DimensionWorld';
import { Enemy } from '../entities/Enemy';
import { hash, Rng } from '../generation/Random';
import { Deco } from '../generation/Tiles';
import type { Arena, CombatSystem } from '../systems/CombatSystem';
import type { Stack } from '../systems/InventorySystem';
import { GroundItems } from '../world/GroundItems';
import type { WorldObject } from '../world/WorldObject';
import type { Place } from './Place';

/** How far the player sees on the map, in tiles. */
const SIGHT = 8;
/** Seconds between looks at the roaming creatures. */
const ROAM_EVERY = 1;
/** Roamers appear this far from the player, in tiles: out of sight, not too far. */
const ROAM_MIN = 13;
const ROAM_MAX = 30;
/** Zones further than this from the player stay empty. */
const ROAM_NEAR = 40;
/** Roamers further than this from the player leave. */
const ROAM_LEAVE = 48;
/** Nothing roams this close to the rift home. */
const ROAM_SAFE = 14;
/** A zone rests this long after one of its creatures is killed. */
const ROAM_REST = 20;
/** Roamers' ids on the network start here; the run's own spawns stay below. */
export const ROAMER_IDS = 0x4000;

export interface TripHooks {
  /** Every event of the run, after the trip has handled its own (spawns,
   *  despawns, boss phases): the game moves the player, grants rewards,
   *  shows notices and takes the player home. */
  event(e: DimEvent): void;
}

/** The rift's tile in its object: where the tear stands. */
export function riftTile(o: WorldObject): { x: number; y: number } {
  const i = o.layout.decos.indexOf(Deco.Rift);
  const at = i < 0 ? Math.floor((o.h / 2) * o.w + o.w / 2) : i;
  return { x: o.x + (at % o.w), y: o.y + Math.floor(at / o.w) };
}

/** Where the player stands outside a rift: on the tile below the tear (feet). */
export function riftDoorstep(o: WorldObject): { x: number; y: number } {
  const t = riftTile(o);
  return { x: t.x + 0.5, y: t.y + 1.9 };
}

export class RiftTrip implements Place, Arena {
  readonly kind = 'dimension';
  readonly wild = false;
  readonly run: DimensionRun;
  readonly layout: DimensionLayout;
  /** Tiles the player has seen, for the map: 1 seen. */
  readonly seen: Uint8Array;
  /** Rises whenever more is seen, so the map redraws only then. */
  seenVersion = 0;
  /** Gone home: later events are ignored. */
  ended = false;
  /** The player's feet, as of the last update. */
  readonly at = { x: 0, y: 0 };
  /** What was left on the ground here (a full bag): it stays behind the rift,
   *  and is lost with the trip. */
  readonly ground = new GroundItems();
  private readonly byId = new Map<number, Enemy>();
  private readonly ids = new Map<Enemy, number>();
  private boss: Enemy | null = null;
  private bossId = 0;
  private lastTile = -1;
  /** Clues by tile index. */
  private readonly clueAt = new Map<number, Clue>();
  /** Roaming creatures, the zone of each, live counts and rests per zone. */
  private readonly roamers: Enemy[] = [];
  private readonly roamZone = new Map<Enemy, number>();
  private readonly zoneLive: Uint8Array;
  private readonly zoneRest: Float32Array;
  private roamTimer = ROAM_EVERY;
  private nextRoamer = 0;
  /** Network ids of the enemies here, both ways. */
  private readonly netIds = new Map<Enemy, number>();
  private readonly byNet = new Map<number, Enemy>();
  private readonly rng: Rng;

  constructor(
    readonly def: DimensionDef,
    /** The dimension's land, streamed like the overworld. */
    readonly world: DimensionWorld,
    readonly seed: number,
    /** The rift's object in the overworld. */
    readonly rift: WorldObject,
    /** Where the player stands outside the rift, in world tiles (feet). */
    readonly outside: { x: number; y: number },
    /** Difficulty band of the rift's land: its creatures are as tough as the land's. */
    readonly band: number,
    private readonly combat: CombatSystem,
    private readonly hooks: TripHooks,
  ) {
    this.layout = world.layout;
    this.run = new DimensionRun(def, this.layout, seed);
    this.seen = new Uint8Array(this.layout.w * this.layout.h);
    for (const c of this.layout.clues) this.clueAt.set(c.y * this.layout.w + c.x, c);
    this.zoneLive = new Uint8Array(this.layout.zones.length);
    this.zoneRest = new Float32Array(this.layout.zones.length);
    this.rng = new Rng(hash(seed, 0x40a3));
  }

  // Place ----------------------------------------------------------------------

  get spot(): { x: number; y: number } {
    return this.outside;
  }

  get arena(): Arena {
    return this;
  }

  /** The player's collision: the land's walls, rocks and trees, the void
   *  (a wall: nobody falls into it), and the sites' sealed gates, stones,
   *  gone slabs and flooded floor. */
  isSolidAt(gx: number, gy: number): boolean {
    if (this.world.isSolidAt(gx, gy)) return true;
    // A hazard path's slabs bridge the void; while there, the run decides.
    if (this.world.isVoidAt(gx, gy) && !this.run.isSlab(gx, gy)) return true;
    return this.run.isSolid(gx, gy);
  }

  // Arena ----------------------------------------------------------------------

  blocksEnemies(gx: number, gy: number): boolean {
    return this.isSolidAt(gx, gy) || this.run.isHole(gx, gy);
  }

  /** Wisps float over the void, gaps and water, but not through walls or trees. */
  blocksFlyers(gx: number, gy: number): boolean {
    return this.world.isSolidAt(gx, gy) || this.run.isSolid(gx, gy) && !this.run.isHole(gx, gy);
  }

  isSolid(gx: number, gy: number): boolean {
    return this.isSolidAt(gx, gy);
  }

  /** Shots fly over the void, gaps and water. */
  blocksShots(gx: number, gy: number): boolean {
    return this.blocksFlyers(gx, gy);
  }

  isHole(gx: number, gy: number): boolean {
    return this.run.isHole(gx, gy);
  }

  /** What does not fit in the bag stays here, where it fell, never outside the rift. */
  drop(stack: Stack, x: number, y: number): void {
    this.ground.drop(stack, x, y);
  }

  /** Blows on the Warden and its summons count toward the striker's share. */
  hurt(e: Enemy, amount: number, who: string | null): void {
    const id = this.ids.get(e);
    if (id !== undefined) this.run.damage(who ?? LOCAL, id, amount);
  }

  killed(e: Enemy): void {
    this.unlist(e);
    const zone = this.roamZone.get(e);
    if (zone !== undefined) {
      this.forgetRoamer(e, zone);
      this.zoneRest[zone] = ROAM_REST;
      return;
    }
    const id = this.ids.get(e);
    if (id === undefined) return;
    this.forget(e, id);
    this.run.enemyKilled(id);
  }

  // ----------------------------------------------------------------------------

  /** Fights move here: the overworld's enemies wait. */
  begin(): void {
    this.combat.enterArena(this);
  }

  /** Everything this machine was running here goes (it is a mirror again,
   *  and the host's word brings back what is still there). */
  releaseAll(): void {
    for (const e of this.byNet.values()) this.combat.remove(e);
    this.byId.clear();
    this.ids.clear();
    this.netIds.clear();
    this.byNet.clear();
    this.roamers.length = 0;
    this.roamZone.clear();
    this.zoneLive.fill(0);
    this.boss = null;
  }

  /** Back home: the trip's enemies go, the overworld's come back. */
  end(): void {
    this.ended = true;
    this.combat.leaveArena();
    this.byId.clear();
    this.ids.clear();
    this.netIds.clear();
    this.byNet.clear();
    this.roamers.length = 0;
    this.roamZone.clear();
    this.boss = null;
  }

  /** Steps the run with the player's feet and acts on what it reports. */
  update(dt: number, px: number, py: number): void {
    if (this.ended) return;
    this.at.x = px;
    this.at.y = py;
    const run = this.run;
    run.update(dt, px, py);
    this.reveal(px, py);
    // A mirror's creatures are its host's: nothing roams or is reported here.
    if (run.authority) {
      this.roam(dt, px, py);
      if (this.boss) run.enemyHealth(this.bossId, this.boss.hp / this.boss.maxHp);
    }
    const events = run.takeEvents();
    for (let i = 0; i < events.length && !this.ended; i++) this.handle(events[i]);
  }

  /** Whether this machine runs the run (see `DimensionRun.authority`). */
  get authority(): boolean {
    return this.run.authority;
  }

  /** An enemy here by its network id. */
  enemyByNet(id: number): Enemy | undefined {
    return this.byNet.get(id);
  }

  /** An enemy's network id, 0 if it has none. */
  netIdOf(e: Enemy): number {
    return this.netIds.get(e) ?? 0;
  }

  /** A replica made real (its host left; this machine runs the run now): it
   *  takes its place as the run's spawn or a roamer, by its id. */
  adopt(e: Enemy, id: number): void {
    e.takeOver();
    this.list(e, id);
    if (id < ROAMER_IDS) {
      this.byId.set(id, e);
      this.ids.set(e, id);
      if (e.species.boss) {
        this.boss = e;
        this.bossId = id;
        // Its phase's quickening carries over to its new host.
        const phase = this.run.boss?.phase ?? 0;
        const ph = phase > 0 ? this.def.boss.phases[phase - 1] : undefined;
        if (ph) {
          e.speedScale = ph.speedScale;
          e.cooldownScale = ph.cooldownScale;
        }
      }
      return;
    }
    const zones = this.layout.zones;
    let zone = 0;
    for (let z = 0; z < zones.length; z++) {
      const r = zones[z].rect;
      if (e.x >= r.x - 2 && e.y >= r.y - 2 && e.x < r.x + r.w + 2 && e.y < r.y + r.h + 2) zone = z;
    }
    if (!zones.length) return;
    this.roamers.push(e);
    this.roamZone.set(e, zone);
    this.zoneLive[zone]++;
    this.nextRoamer = Math.max(this.nextRoamer, id - ROAMER_IDS);
  }

  get trialsDone(): number {
    return this.run.trialsDone;
  }

  get trials(): number {
    return this.run.trials;
  }

  get bossOpen(): boolean {
    return this.run.bossOpen;
  }

  get name(): string {
    return this.layout.name;
  }

  get bossName(): string {
    const n = this.def.boss.species.name;
    return n.startsWith('The ') ? `the ${n.slice(4)}` : n;
  }

  get portalOpen(): boolean {
    return this.run.portalOpen;
  }

  /** Whether the open portal answers the local player. */
  get attuned(): boolean {
    const run = this.run;
    return run.share(LOCAL).attuned || (run.authority && run.contribution.attuned(LOCAL));
  }

  get clues(): number {
    return this.layout.clues.length;
  }

  /** The clue carved on the stone at a tile, if any. */
  clue(gx: number, gy: number): Clue | undefined {
    if (gx < 0 || gy < 0 || gx >= this.layout.w || gy >= this.layout.h) return undefined;
    return this.clueAt.get(gy * this.layout.w + gx);
  }

  /** Where the player stands, by name: a site, else the region. */
  placeAt(px: number, py: number): string {
    const L = this.layout;
    for (const s of L.sites) {
      const r = s.rect;
      if (px >= r.x && py >= r.y && px < r.x + r.w && py < r.y + r.h) return s.name;
    }
    const cx = Math.floor(px / CHUNK_SIZE);
    const cy = Math.floor(py / CHUNK_SIZE);
    const cw = L.w / CHUNK_SIZE;
    if (cx < 0 || cy < 0 || cx >= cw || cy >= L.h / CHUNK_SIZE) return '';
    return L.regions[L.regionOf[cy * cw + cx]] ?? '';
  }

  /** Which way the next step lies from the player, as an angle: the portal
   *  once open, the Warden once its gate is, else the nearest trial not done. */
  goalAngle(): number | null {
    const { at, run, layout: L } = this;
    let x = 0;
    let y = 0;
    if (run.portalOpen) {
      x = (L.portal % L.w) + 0.5;
      y = Math.floor(L.portal / L.w) + 0.5;
    } else {
      let best = Infinity;
      run.challenges.forEach((c, i) => {
        if (!c || c.done) return;
        const boss = L.sites[i].kind === 'boss';
        if (boss !== run.bossOpen) return;
        // The trials from their way in; the Warden where it waits.
        const e = boss ? L.sites[i].center : L.sites[i].entry;
        const d = (e.x - at.x) ** 2 + (e.y - at.y) ** 2;
        if (d < best) {
          best = d;
          x = e.x;
          y = e.y;
        }
      });
      if (best === Infinity) return null;
    }
    return Math.atan2(y - at.y, x - at.x);
  }

  private handle(e: DimEvent): void {
    switch (e.type) {
      case 'spawn': {
        const enemy = new Enemy(e.species, e.x, e.y, this.band, false);
        // They come out of the cracks hunting.
        enemy.provoke();
        this.combat.add(enemy);
        this.byId.set(e.id, enemy);
        this.ids.set(enemy, e.id);
        this.list(enemy, e.id);
        if (e.boss) {
          this.boss = enemy;
          this.bossId = e.id;
        }
        break;
      }
      case 'despawn': {
        const enemy = this.byId.get(e.id);
        if (enemy) {
          this.combat.remove(enemy);
          this.forget(enemy, e.id);
          this.unlist(enemy);
        }
        break;
      }
      case 'bossPhase':
        if (this.boss) {
          this.boss.speedScale = e.speedScale;
          this.boss.cooldownScale = e.cooldownScale;
        }
        break;
    }
    this.hooks.event(e);
  }

  private list(e: Enemy, id: number): void {
    this.netIds.set(e, id);
    this.byNet.set(id, e);
  }

  private unlist(e: Enemy): void {
    const id = this.netIds.get(e);
    if (id === undefined) return;
    this.netIds.delete(e);
    this.byNet.delete(id);
  }

  private forget(e: Enemy, id: number): void {
    this.byId.delete(id);
    this.ids.delete(e);
    if (e === this.boss) this.boss = null;
  }

  /** Creatures roaming the land: a few near the player, from the zones the
   *  map sets out, gone again once far behind. Looked at once a second. */
  private roam(dt: number, _px: number, _py: number): void {
    const zones = this.layout.zones;
    for (let z = 0; z < zones.length; z++) if (this.zoneRest[z] > 0) this.zoneRest[z] -= dt;
    this.roamTimer -= dt;
    if (this.roamTimer > 0) return;
    this.roamTimer = ROAM_EVERY;
    for (let i = this.roamers.length - 1; i >= 0; i--) {
      const e = this.roamers[i];
      if (this.nearAnyone(e.x, e.y, ROAM_LEAVE)) continue;
      this.combat.remove(e);
      this.unlist(e);
      this.forgetRoamer(e, this.roamZone.get(e)!);
    }
    for (let z = 0; z < zones.length; z++) {
      const zone = zones[z];
      if (this.zoneLive[z] >= zone.cap || this.zoneRest[z] > 0 || !this.zoneNearAnyone(zone)) continue;
      this.spawnRoamer(z, zone);
    }
  }

  /** Within `r` tiles of a player in the instance. */
  private nearAnyone(x: number, y: number, r: number): boolean {
    return this.run.nearestPlayer(x, y) < r;
  }

  private zoneNearAnyone(zone: SpawnZone): boolean {
    for (const p of this.run.standings()) if (near(zone, p.x, p.y)) return true;
    return false;
  }

  private spawnRoamer(z: number, zone: SpawnZone): void {
    const { rng, layout: L } = this;
    const r = zone.rect;
    const rx = (L.rift % L.w) + 0.5;
    const ry = Math.floor(L.rift / L.w) + 1;
    for (let attempt = 0; attempt < 8; attempt++) {
      const gx = rng.int(r.x, r.x + r.w - 1);
      const gy = rng.int(r.y, r.y + r.h - 1);
      const x = gx + 0.5;
      const y = gy + 0.9;
      // Out of everyone's sight, but not far from someone.
      const d = this.run.nearestPlayer(x, y);
      if (d < ROAM_MIN || d > ROAM_MAX || Math.hypot(x - rx, y - ry) < ROAM_SAFE) continue;
      if (this.blocksEnemies(gx, gy) || this.inSite(gx, gy)) continue;
      const e = new Enemy(rng.pick(zone.species), x, y, this.band, false);
      this.combat.add(e);
      this.roamers.push(e);
      this.roamZone.set(e, z);
      this.zoneLive[z]++;
      this.nextRoamer = (this.nextRoamer + 1) % ROAMER_IDS;
      this.list(e, ROAMER_IDS + this.nextRoamer);
      return;
    }
  }

  private forgetRoamer(e: Enemy, zone: number): void {
    const i = this.roamers.indexOf(e);
    if (i >= 0) this.roamers.splice(i, 1);
    this.roamZone.delete(e);
    this.zoneLive[zone]--;
  }

  /** Inside a site, or at its edge: the sites' own fights are their own. */
  private inSite(gx: number, gy: number): boolean {
    for (const s of this.layout.sites) {
      const r = s.rect;
      if (gx >= r.x - 2 && gy >= r.y - 2 && gx < r.x + r.w + 2 && gy < r.y + r.h + 2) return true;
    }
    return false;
  }

  /** Marks what the player can see as seen, when they reach a new tile. */
  private reveal(px: number, py: number): void {
    const { w, h } = this.layout;
    const gx = Math.floor(px);
    const gy = Math.floor(py - 0.15);
    const tile = gy * w + gx;
    if (tile === this.lastTile) return;
    this.lastTile = tile;
    let fresh = false;
    for (let y = Math.max(0, gy - SIGHT); y <= Math.min(h - 1, gy + SIGHT); y++) {
      for (let x = Math.max(0, gx - SIGHT); x <= Math.min(w - 1, gx + SIGHT); x++) {
        const i = y * w + x;
        if (this.seen[i] || (x - gx) ** 2 + (y - gy) ** 2 > SIGHT * SIGHT) continue;
        this.seen[i] = 1;
        fresh = true;
      }
    }
    if (fresh) this.seenVersion++;
  }
}

/** A zone within reach of the player. */
function near(zone: SpawnZone, px: number, py: number): boolean {
  const r = zone.rect;
  const dx = Math.max(r.x - px, 0, px - (r.x + r.w));
  const dy = Math.max(r.y - py, 0, py - (r.y + r.h));
  return dx * dx + dy * dy < ROAM_NEAR * ROAM_NEAR;
}
