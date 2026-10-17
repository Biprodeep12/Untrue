// One trip into an outer dimension behind a rift: the run (src/dimension),
// the enemies it asked for, what the player has seen of it (the map's fog),
// and the ground under the player for collision and combat. The game makes
// one when the player steps into a rift and drops it on the way out; the
// overworld waits meanwhile, its own enemies stashed by the combat system.

import { DimensionRun, type DimEvent } from '../dimension/Challenges';
import type { ChamberKind, DimensionDef } from '../dimension/Dimension';
import { Enemy } from '../entities/Enemy';
import { Deco } from '../generation/Tiles';
import type { Arena, CombatSystem } from '../systems/CombatSystem';
import type { Stack } from '../systems/InventorySystem';
import type { WorldObject } from '../world/WorldObject';
import type { Place } from './Place';

/** How far the player sees on the map, in tiles. */
const SIGHT = 6;

export const CHAMBER_NAMES: Record<ChamberKind, string> = {
  arrival: 'Arrival',
  combat: 'Glitch nest',
  hazard: 'Crumbling path',
  puzzle: 'Glyph hall',
  boss: "Warden's arena",
  vault: 'Vault',
};

export interface TripHooks {
  /** Every event of the run, after the trip has handled its own (spawns,
   *  despawns, boss phases): the game moves the player, grants rewards,
   *  shows notices and takes the player home. */
  event(e: DimEvent): void;
  /** Drops that do not fit in the bag; they go outside the rift. */
  drop(stack: Stack): void;
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
  /** Tiles the player has seen, for the map: 1 seen. */
  readonly seen: Uint8Array;
  /** Rises whenever more is seen, so the map redraws only then. */
  seenVersion = 0;
  /** Gone home: later events are ignored. */
  ended = false;
  private readonly byId = new Map<number, Enemy>();
  private readonly ids = new Map<Enemy, number>();
  private boss: Enemy | null = null;
  private bossId = 0;
  private lastTile = -1;

  constructor(
    readonly def: DimensionDef,
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
    this.run = new DimensionRun(def, seed);
    this.seen = new Uint8Array(this.run.layout.w * this.run.layout.h);
  }

  // Place ----------------------------------------------------------------------

  get spot(): { x: number; y: number } {
    return this.outside;
  }

  get arena(): Arena {
    return this;
  }

  /** The player's collision: walls, props and sealed doors. The void is open. */
  isSolidAt(gx: number, gy: number): boolean {
    return this.run.isSolid(gx, gy);
  }

  // Arena ----------------------------------------------------------------------

  blocksEnemies(gx: number, gy: number): boolean {
    return this.run.blocksEnemies(gx, gy);
  }

  /** Wisps float over the void but not through walls. */
  blocksFlyers(gx: number, gy: number): boolean {
    return this.run.isSolid(gx, gy);
  }

  isSolid(gx: number, gy: number): boolean {
    return this.run.isSolid(gx, gy);
  }

  /** Shots fly over the void. */
  blocksShots(gx: number, gy: number): boolean {
    return this.run.isSolid(gx, gy);
  }

  isHole(gx: number, gy: number): boolean {
    return this.run.isHole(gx, gy);
  }

  drop(stack: Stack): void {
    this.hooks.drop(stack);
  }

  killed(e: Enemy): void {
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

  /** Back home: the trip's enemies go, the overworld's come back. */
  end(): void {
    this.ended = true;
    this.combat.leaveArena();
    this.byId.clear();
    this.ids.clear();
    this.boss = null;
  }

  /** Steps the run with the player's feet and acts on what it reports. */
  update(dt: number, px: number, py: number): void {
    if (this.ended) return;
    const run = this.run;
    run.update(dt, px, py);
    this.reveal(px, py);
    if (this.boss) run.enemyHealth(this.bossId, this.boss.hp / this.boss.maxHp);
    const events = run.takeEvents();
    for (let i = 0; i < events.length && !this.ended; i++) this.handle(events[i]);
  }

  /** Challenge chambers done, out of all of them. */
  get chambersDone(): number {
    let n = 0;
    for (const c of this.run.challenges) if (c?.done) n++;
    return n;
  }

  get chambers(): number {
    let n = 0;
    for (const c of this.run.challenges) if (c) n++;
    return n;
  }

  get name(): string {
    return this.def.name;
  }

  get portalOpen(): boolean {
    return this.run.portalOpen;
  }

  /** The chamber the player stands in, by name; '' in a corridor. */
  chamberAt(px: number, py: number): string {
    for (const c of this.run.layout.chambers) {
      const r = c.rect;
      if (px >= r.x && py >= r.y && px < r.x + r.w && py < r.y + r.h) return CHAMBER_NAMES[c.kind];
    }
    return '';
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

  private forget(e: Enemy, id: number): void {
    this.byId.delete(id);
    this.ids.delete(e);
    if (e === this.boss) this.boss = null;
  }

  /** Marks what the player can see as seen, when they reach a new tile. */
  private reveal(px: number, py: number): void {
    const { w, h } = this.run.layout;
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
