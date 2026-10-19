// Combat (spec 5): spawning and despawning inside the simulation radius,
// dungeon guards and bosses, player attacks, projectiles, damage and drops.
// It fights on an `Arena`: the overworld, or an outer dimension, where the
// overworld's own spawning, guards and legends wait until the player is back.

import { CHUNK_SIZE, SIM_RADIUS } from '../config';
import { chunkKey, inRect, tileToChunk, type ChunkRect } from '../coords';
import { Enemy, type EnemyContext } from '../entities/Enemy';
import { elementFactor, SPECIES, type ProjectileKind, type Species } from '../entities/Species';
import { eliteChance, groupSize, LEGEND_CHANCE, MIN_SPAWN_DISTANCE, pickSpecies, populationCap, SAFE_RADIUS } from '../generation/EnemyGenerator';
import { Rng, streamRng, Stream } from '../generation/Random';
import { difficultyBand } from '../generation/WorldRules';
import { BiomeType, isWater } from '../generation/Tiles';
import { Items, type Element, type ItemDef, type WeaponStats } from '../items/Items';
import type { Stack } from './InventorySystem';
import type { WorldManager } from '../world/WorldManager';
import type { WorldObject } from '../world/WorldObject';
import type { Inventory } from './InventorySystem';
import { rollChest } from './Loot';
import type { Progression } from './Progression';
import type { Vitals } from './Vitals';

const FISTS: WeaponStats = { kind: 'melee', damage: 5, durability: 0, reach: 1.1, cooldown: 0.45 };
export const CRIT_CHANCE = 0.1;
/** The legend that roams a land: the Elder Stag near home, a land's own
 *  legend further out. `roll` is 0 to 1. */
export function legendFor(biome: BiomeType | undefined, band: number, roll: number): Species {
  if (biome === BiomeType.Desert && band >= 1) return SPECIES.duneTyrant;
  if (biome === BiomeType.Snow && band >= 1) return roll < 0.5 ? SPECIES.ancientGolem : SPECIES.alphaWolf;
  if (band >= 2 && roll < 0.5) return SPECIES.alphaWolf;
  return SPECIES.stag;
}

/** Share of damage that gets through a block. */
const BLOCK_PASS = 0.3;
const BLOCK_STAMINA = 8;
const ARROW_SPEED = 14;
const SPAWN_INTERVAL = 2.5;
/** Wildlife kept around the player, by day and by night. Animals roam the
 *  safe zone too. */
const ANIMAL_CAP = { day: 6, night: 3 };
/** Melee hits land within this many degrees either side of the swing. */
const SWING_COS = Math.cos((60 * Math.PI) / 180);
/** Enemies are hit around their middle, this far above their feet. */
const BODY = 0.4;
const DUNGEON_CLEAR_XP = 60;
/** Structures whose guards wake when the player walks in. */
const GUARDED_KINDS = new Set(['dungeon', 'boss-arena']);

export interface Projectile {
  x: number;
  y: number;
  vx: number;
  vy: number;
  kind: ProjectileKind;
  damage: number;
  /** The damage type of the player's shot, if any. */
  element?: Element;
  fromPlayer: boolean;
  /** Seconds left in flight. */
  ttl: number;
  source?: Enemy;
  /** Its id on the network (enemy shots on a shared dimension's host). */
  id?: number;
  /** Another machine's shot, drawn here: the network moves it; it hits nothing. */
  replica?: boolean;
}

/** Another player in a fight this machine runs (a shared dimension's host). */
export interface OtherBody {
  slot: number;
  x: number;
  y: number;
}

/** Ids for enemy shots on the network: a range of their own. */
const SHOT_IDS = 0x8000;

/** The player as combat sees it. */
export interface PlayerBody {
  x: number;
  y: number;
  /** Unit vector the player faces. */
  faceX: number;
  faceY: number;
  blocking: boolean;
  invulnerable: boolean;
}

export interface CombatEvents {
  damage(x: number, y: number, amount: number, crit: boolean, toPlayer: boolean): void;
  swing(x: number, y: number, dx: number, dy: number, reach: number): void;
  /** The player took a hit from this direction. */
  playerHurt(fromX: number, fromY: number): void;
  notify(text: string): void;
  killed?(e: Enemy): void;
  levelUp?(level: number): void;
}

/** Damage the player deals with one hit. */
export function playerHitDamage(base: number, levelBonus: number, crit: boolean): number {
  return Math.round(base * levelBonus * (crit ? 2 : 1));
}

/** Damage that gets through armor and an optional block. */
export function incomingDamage(raw: number, armor: number, blocked: boolean, pass = BLOCK_PASS): number {
  return Math.max(1, Math.round(raw * (1 - armor) * (blocked ? pass : 1)));
}

/** The ground a fight happens on. */
export interface Arena {
  /** The overworld: spawning, guards, legends and despawning by distance run. */
  readonly wild: boolean;
  /** Walls and anything else a walking enemy cannot cross. */
  blocksEnemies(gx: number, gy: number): boolean;
  /** What stops flyers; nothing does in the overworld. */
  blocksFlyers(gx: number, gy: number): boolean;
  /** Knockback stops at it. */
  isSolid(gx: number, gy: number): boolean;
  /** Shots break on it. */
  blocksShots(gx: number, gy: number): boolean;
  /** Nothing to stand on: a walker knocked onto it falls (and dies). */
  isHole(gx: number, gy: number): boolean;
  /** Puts drops that do not fit in the bag on the ground. */
  drop(stack: Stack, x: number, y: number): void;
  /** An enemy died, by the player's hand or by falling. */
  killed?(e: Enemy): void;
  /** A player took `amount` of an enemy's health (a dimension tallies who
   *  hurt its Warden): `who` is another player's id, null for this one. */
  hurt?(e: Enemy, amount: number, who: string | null): void;
}

interface Guarded {
  remaining: number;
  /** Key recorded in world.clearedAnchors once every guard falls; empty for events. */
  key: string;
  name: string;
  /** What was cleared: a structure kind, 'legend', or an event name. */
  kind: string;
}

export interface GroupOptions {
  /** Announced as cleared once the whole group falls. */
  label?: string;
  kind?: string;
  /** Charge straight at the player. */
  provoke?: boolean;
}

export class CombatSystem {
  readonly enemies: Enemy[] = [];
  readonly projectiles: Projectile[] = [];
  /** Night brings more enemies, and some that only walk in the dark. */
  night = false;
  onKill?: (e: Enemy) => void;
  /** A dungeon, arena, legendary creature or event group was cleared. */
  onCleared?: (kind: string) => void;
  /** Other players on ground this machine runs (a shared dimension's host),
   *  written in place by the network: enemies hunt whoever is nearest. */
  readonly others: OtherBody[] = [];
  /** An enemy, or its shot, struck another player: their machine takes the hit. */
  onOtherHit?: (slot: number, raw: number, species: Species, fromX: number, fromY: number) => void;
  /** Another player's blow killed an enemy here: what they earned of it. */
  onOtherKill?: (who: string, e: Enemy, xp: number, drops: ReadonlyArray<readonly [ItemDef, number]>) => void;
  /** This player struck a replica (another machine runs it): tell that machine. */
  onReplicaHit?: (e: Enemy, amount: number, crit: boolean, pushX: number, pushY: number, ranged: boolean) => void;
  /** The other player an enemy is after while it thinks, or -1 for this one. */
  private targetSlot = -1;
  private nextShot = 0;
  private readonly rng: Rng;
  private spawnTimer = SPAWN_INTERVAL;
  private cooldown = 0;
  private nextGroup = 1;
  private body: PlayerBody = { x: 0, y: 0, faceX: 0, faceY: 1, blocking: false, invulnerable: false };
  /** Dungeons, arenas and legendary spots with live guards, by tag. */
  private readonly guarded = new Map<string, Guarded>();
  /** Chunks already rolled for a legendary creature this region visit. */
  private readonly legendChecked = new Set<string>();
  private legendRect = '';
  /** The overworld as an arena. */
  readonly overworld: Arena = {
    wild: true,
    blocksEnemies: (gx, gy) => this.world.isSolidAt(gx, gy),
    blocksFlyers: () => false,
    isSolid: (gx, gy) => this.world.isSolidAt(gx, gy),
    blocksShots: (gx, gy) => this.blocksShots(gx, gy),
    isHole: () => false,
    drop: (stack, x, y) => this.world.ground.drop(stack, x, y),
  };
  /** Where fights happen now. */
  arena: Arena = this.overworld;
  /** The overworld's enemies and shots, kept while another arena is in use. */
  private stashed: Enemy[] = [];
  /** What enemies ask of the world; built once, not every frame. */
  private readonly ctx: EnemyContext = {
    playerX: 0,
    playerY: 0,
    isSolid: (gx, gy) => this.arena.blocksEnemies(gx, gy),
    blocksFlyers: (gx, gy) => this.arena.blocksFlyers(gx, gy),
    alert: (group) => {
      for (const e of this.enemies) if (e.group === group) e.provoke();
    },
    hitPlayer: (e) => {
      if (this.targetSlot >= 0) this.onOtherHit?.(this.targetSlot, e.damage, e.species, e.x, e.y);
      else this.hitPlayer(e.damage, e.species, e.x, e.y);
    },
    shoot: (e, dx, dy) => {
      const r = e.species.ranged!;
      const id = SHOT_IDS + (this.nextShot = (this.nextShot + 1) & 0x7fff);
      this.projectiles.push({ x: e.x, y: e.y - BODY, vx: dx * r.speed, vy: dy * r.speed, kind: r.kind, damage: e.damage * 0.8, fromPlayer: false, ttl: (r.range + 1) / r.speed, source: e, id });
    },
    random: () => this.rng.next(),
  };

  constructor(
    private readonly world: WorldManager,
    private readonly inv: Inventory,
    private readonly vitals: Vitals,
    private readonly progression: Progression,
    private readonly events: CombatEvents,
    seed = world.seed,
  ) {
    this.rng = new Rng(seed ^ 0x5eed);
  }

  /** The boss currently fighting the player, for the HUD bar. */
  get boss(): Enemy | undefined {
    return this.enemies.find((e) => e.species.boss && e.state !== 'patrol');
  }

  /** Shots fly over water but not through walls, rocks or trees. */
  private blocksShots(gx: number, gy: number): boolean {
    const t = this.world.tileAt(gx, gy);
    if (t && isWater(t.tile) && !t.deco) return false;
    return this.world.isSolidAt(gx, gy);
  }

  /** Fights on another arena: the overworld's enemies wait, untouched, until `leaveArena`. */
  enterArena(arena: Arena): void {
    if (this.arena !== this.overworld) this.leaveArena();
    this.stashed = this.enemies.splice(0);
    this.projectiles.length = 0;
    this.arena = arena;
  }

  /** Back to the overworld: the other arena's enemies go, the overworld's come back. */
  leaveArena(): void {
    if (this.arena === this.overworld) return;
    this.enemies.length = 0;
    for (const e of this.stashed) this.enemies.push(e);
    this.stashed = [];
    this.projectiles.length = 0;
    this.arena = this.overworld;
  }

  /** Adds an enemy made elsewhere (an outer dimension's spawns). */
  add(e: Enemy): void {
    this.enemies.push(e);
  }

  /** Takes an enemy away without a kill: no XP, no drops. */
  remove(e: Enemy): void {
    const i = this.enemies.indexOf(e);
    if (i >= 0) this.enemies.splice(i, 1);
  }

  update(dt: number, body: PlayerBody): void {
    this.body = body;
    this.cooldown = Math.max(0, this.cooldown - dt);
    // A guest's wild is the host's: its creatures come from there.
    if (this.arena.wild && !this.world.replica) {
      this.despawn();
      this.spawnTimer -= dt;
      if (this.spawnTimer <= 0) {
        this.spawnTimer = SPAWN_INTERVAL;
        this.spawnAll();
      }
      this.triggers();
      this.rollLegends();
    }

    const ctx = this.ctx;
    const others = this.others;
    for (const e of this.enemies) {
      // Another machine's enemy: only its flash fades here.
      if (e.replica) {
        e.hitFlash = Math.max(0, e.hitFlash - dt);
        continue;
      }
      ctx.playerX = body.x;
      ctx.playerY = body.y;
      this.targetSlot = -1;
      if (others.length) {
        // Each hunts whichever player is nearest.
        let best = (e.x - body.x) ** 2 + (e.y - body.y) ** 2;
        for (const o of others) {
          const d = (e.x - o.x) ** 2 + (e.y - o.y) ** 2;
          if (d >= best) continue;
          best = d;
          ctx.playerX = o.x;
          ctx.playerY = o.y;
          this.targetSlot = o.slot;
        }
      }
      e.update(dt, ctx);
    }
    this.targetSlot = -1;
    this.updateProjectiles(dt);
  }

  /** Another player's blow, as their machine reports it (already checked by
   *  the caller): `amount` is what it takes, `who` is whose it was. */
  strike(e: Enemy, amount: number, crit: boolean, pushX: number, pushY: number, who: string): void {
    if (e.alive && this.enemies.includes(e)) this.damageEnemy(e, amount, crit, pushX, pushY, undefined, who);
  }

  /** An enemy on another machine struck this player there. */
  takeHit(raw: number, species: Species, fromX: number, fromY: number): void {
    this.hitPlayer(raw, species, fromX, fromY);
  }

  /** Swings or shoots with the weapon in a hotbar slot (or fists). */
  attack(dx: number, dy: number, slot: number | null): boolean {
    if (this.cooldown > 0) return false;
    const len = Math.hypot(dx, dy) || 1;
    dx /= len;
    dy /= len;
    const stack = slot === null ? null : this.inv.slots[slot];
    const weapon = stack?.item.weapon ?? FISTS;
    const { x, y } = this.body;

    if (weapon.kind === 'bow') {
      if (!this.inv.remove(Items.arrow, 1)) {
        this.events.notify('No arrows');
        this.cooldown = 0.3;
        return false;
      }
      const crit = this.rng.chance(CRIT_CHANCE);
      this.projectiles.push({
        x, y: y - BODY, vx: dx * ARROW_SPEED, vy: dy * ARROW_SPEED, kind: 'arrow',
        damage: playerHitDamage(weapon.damage, this.progression.damageBonus, crit), element: weapon.element, fromPlayer: true, ttl: weapon.reach / ARROW_SPEED,
      });
    } else {
      this.events.swing(x, y - BODY, dx, dy, weapon.reach);
      for (const e of [...this.enemies]) {
        if (e.state === 'burrowed' || !e.alive) continue;
        const ex = e.x - x;
        const ey = e.y - y;
        const d = Math.hypot(ex, ey);
        if (d > weapon.reach + 0.4 || (d > 0.3 && (ex * dx + ey * dy) / d < SWING_COS)) continue;
        const crit = this.rng.chance(CRIT_CHANCE);
        const raw = playerHitDamage(weapon.damage, this.progression.damageBonus, crit);
        if (e.replica) this.hitReplica(e, raw, crit, dx, dy, weapon.element, false);
        else this.damageEnemy(e, raw, crit, dx, dy, weapon.element);
      }
    }
    this.cooldown = weapon.cooldown;
    if (slot !== null && stack?.item.weapon && this.inv.wear(slot)) this.events.notify(`Your ${stack.item.name} broke`);
    return true;
  }

  /** A blow on another machine's enemy: shown here at once, and sent there,
   *  where it really lands. */
  private hitReplica(e: Enemy, raw: number, crit: boolean, pushX: number, pushY: number, element: Element | undefined, ranged: boolean): void {
    const amount = Math.max(1, Math.round(raw * elementFactor(e.species, element)));
    e.hitFlash = 0.15;
    this.events.damage(e.x, e.y - 1, amount, crit, false);
    this.onReplicaHit?.(e, amount, crit, pushX, pushY, ranged);
  }

  /** `who`: another player's blow (a shared dimension's host applies it), or
   *  null for this player's. */
  private damageEnemy(e: Enemy, raw: number, crit: boolean, pushX: number, pushY: number, element?: Element, who: string | null = null): void {
    // Some creatures are weak to a damage type, some shrug it off.
    const amount = Math.max(1, Math.round(raw * elementFactor(e.species, element)));
    const before = e.hp;
    e.takeHit(amount);
    this.events.damage(e.x, e.y - 1, amount, crit, false);
    // Knockback, unless something solid is in the way. A walker knocked off
    // the edge falls; bosses keep their footing.
    const nx = e.x + pushX * 0.35;
    const ny = e.y + pushY * 0.35;
    const arena = this.arena;
    if (!arena.isSolid(Math.floor(nx), Math.floor(ny))) {
      const fall = !arena.wild && !e.species.flying && arena.isHole(Math.floor(nx), Math.floor(ny - 0.15));
      if (!fall) {
        e.x = nx;
        e.y = ny;
      } else if (!e.species.boss && e.alive) {
        e.x = nx;
        e.y = ny;
        e.hp = 0;
        this.events.notify(`The ${e.name} falls into the void`);
      }
    }
    // What was really taken, a fall included, before a death is reported.
    this.arena.hurt?.(e, before - Math.max(0, e.hp), who);
    if (!e.alive) this.kill(e, who);
  }

  private hitPlayer(raw: number, species: Species, fromX: number, fromY: number): void {
    const b = this.body;
    if (b.invulnerable) return;
    const towards = (fromX - b.x) * b.faceX + (fromY - b.y) * b.faceY > 0;
    // A shield in the off hand blocks more, and tires the arm less.
    const shield = this.inv.shield();
    const blocked = b.blocking && towards && this.vitals.spend(shield?.stamina ?? BLOCK_STAMINA);
    const amount = incomingDamage(raw, this.inv.armor(), blocked, shield?.pass ?? BLOCK_PASS);
    this.vitals.hurt(amount);
    // The hit makes the player briefly invulnerable; this frame's body is a
    // snapshot, so mark it here too or every enemy in reach lands this frame.
    b.invulnerable = true;
    if (species.inflicts && !blocked) this.vitals.afflict(species.inflicts.kind, species.inflicts.seconds);
    this.events.damage(b.x, b.y - 1.2, amount, false, true);
    this.events.playerHurt(fromX, fromY);
  }

  private kill(e: Enemy, who: string | null = null): void {
    const i = this.enemies.indexOf(e);
    // Already gone: splice(-1) would remove another enemy.
    if (i < 0) return;
    this.enemies.splice(i, 1);
    if (who === null) {
      this.grantXp(e.xp);
      if (e.species.boss) this.progression.trophies[e.species.id] = (this.progression.trophies[e.species.id] ?? 0) + 1;
      this.onKill?.(e);
    }
    this.arena.killed?.(e);
    this.events.killed?.(e);
    const drops: Array<[typeof Items.wood, number]> = [];
    // Hunters get more from animals.
    const hunter = e.species.passive && who === null ? 0.35 * this.progression.rank('hunter') : 0;
    for (const [item, min, max, chance] of e.species.drops) {
      if (this.rng.chance(chance)) drops.push([item, this.rng.int(min, max) * (e.elite ? 2 : 1) + (this.rng.chance(hunter) ? 1 : 0)]);
    }
    if (e.species.boss || e.elite) drops.push(...rollChest(this.rng, e.band + (e.species.boss ? 3 : 0)));
    // Another player's kill: the experience and the spoils are theirs.
    if (who !== null) {
      this.onOtherKill?.(who, e, e.xp, drops);
      return;
    }
    for (const [item, count] of drops) {
      const left = this.inv.add(item, count);
      if (count > left) this.events.notify(`+${count - left} ${item.name}`);
      // A full bag leaves the rest where the enemy fell.
      if (left > 0) {
        this.arena.drop({ item, count: left }, e.x, e.y);
        this.events.notify(`Bag full: ${left} ${item.name} left on the ground`);
      }
    }
    this.events.notify(e.species.passive ? `Hunted a ${e.name}` : `Defeated ${e.name}`);

    const g = e.tag ? this.guarded.get(e.tag) : undefined;
    if (g && --g.remaining <= 0) {
      this.guarded.delete(e.tag);
      if (g.key) this.world.clearedAnchors.add(g.key);
      this.events.notify(`${g.name} cleared!`);
      this.grantXp(DUNGEON_CLEAR_XP);
      this.onCleared?.(g.kind);
    }
  }

  /** Adds experience, applying any level-ups to max health. */
  grantXp(xp: number): void {
    const levels = this.progression.add(xp);
    if (!levels) return;
    const before = this.vitals.maxHealth;
    this.vitals.maxHealth = this.progression.maxHealth;
    this.vitals.health += this.vitals.maxHealth - before;
    this.events.notify(`Level up! You are level ${this.progression.level}. New skill point: spend it in the Skills tab`);
    this.events.levelUp?.(this.progression.level);
  }

  private updateProjectiles(dt: number): void {
    const b = this.body;
    for (let i = this.projectiles.length - 1; i >= 0; i--) {
      const p = this.projectiles[i];
      // Another machine's shot: drawn where the network puts it, nothing more.
      if (p.replica) continue;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.ttl -= dt;
      let done = p.ttl <= 0 || this.arena.blocksShots(Math.floor(p.x), Math.floor(p.y + BODY));
      if (!done && p.fromPlayer) {
        const hit = this.enemies.find((e) => e.state !== 'burrowed' && Math.hypot(e.x - p.x, e.y - BODY - p.y) < 0.6);
        if (hit) {
          const len = Math.hypot(p.vx, p.vy) || 1;
          if (hit.replica) this.hitReplica(hit, p.damage, false, p.vx / len, p.vy / len, p.element, true);
          else this.damageEnemy(hit, p.damage, false, p.vx / len, p.vy / len, p.element);
          done = true;
        }
      } else if (!done && Math.hypot(b.x - p.x, b.y - BODY - p.y) < 0.5) {
        this.hitPlayer(p.damage, p.source?.species ?? SPECIES.skeleton, p.x - p.vx, p.y - p.vy);
        done = true;
      } else if (!done) {
        for (const o of this.others) {
          if (Math.hypot(o.x - p.x, o.y - BODY - p.y) >= 0.5) continue;
          this.onOtherHit?.(o.slot, p.damage, p.source?.species ?? SPECIES.skeleton, p.x - p.vx, p.y - p.vy);
          done = true;
          break;
        }
      }
      if (done) this.projectiles.splice(i, 1);
    }
  }

  /** Spawns a group around a point in the overworld, e.g. for an ambush or an
   *  invasion; it waits there while the player is in another arena. */
  spawnGroup(species: Species, x: number, y: number, count: number, opts: GroupOptions = {}): Enemy[] {
    const band = difficultyBand(x, y);
    const list = this.arena === this.overworld ? this.enemies : this.stashed;
    const tag = opts.label ? `group@${this.nextGroup}` : '';
    const group = this.nextGroup++;
    const spawned: Enemy[] = [];
    for (let attempt = 0; attempt < count * 10 && spawned.length < count; attempt++) {
      const ex = x + this.rng.range(-2.5, 2.5);
      const ey = y + this.rng.range(-2.5, 2.5);
      if (this.world.isSolidAt(Math.floor(ex), Math.floor(ey))) continue;
      const e = new Enemy(species, ex, ey, band, false);
      e.group = group;
      e.tag = tag;
      if (opts.provoke) e.provoke();
      list.push(e);
      spawned.push(e);
    }
    if (tag && spawned.length) this.guarded.set(tag, { remaining: spawned.length, key: '', name: opts.label!, kind: opts.kind ?? 'event' });
    return spawned;
  }

  /** Inside the simulation radius of this player, or of another player on
   *  this ground (a host's guests). */
  private simulated(sim: ChunkRect, x: number, y: number): boolean {
    const cx = tileToChunk(x);
    const cy = tileToChunk(y);
    if (inRect(sim, cx, cy)) return true;
    for (const o of this.others) {
      if (Math.abs(tileToChunk(o.x) - cx) <= SIM_RADIUS && Math.abs(tileToChunk(o.y) - cy) <= SIM_RADIUS) return true;
    }
    return false;
  }

  /** Each other player's simulation radius, as a chunk rectangle (reused). */
  private areaOf(o: OtherBody): ChunkRect {
    const a = this.area;
    const cx = tileToChunk(o.x);
    const cy = tileToChunk(o.y);
    a.x0 = cx - SIM_RADIUS;
    a.y0 = cy - SIM_RADIUS;
    a.x1 = cx + SIM_RADIUS;
    a.y1 = cy + SIM_RADIUS;
    return a;
  }

  private readonly area: ChunkRect = { x0: 0, y0: 0, x1: 0, y1: 0 };

  /** Enemies leave with the simulation radius; guards come back next visit.
   *  Night walkers fade at dawn. */
  private despawn(): void {
    const sim = this.world.chunks.simRect;
    if (!sim) return;
    let reset: Set<string> | null = null;
    for (let i = this.enemies.length - 1; i >= 0; i--) {
      const e = this.enemies[i];
      const faded = e.species.nightOnly && !this.night;
      if (!faded && this.simulated(sim, e.x, e.y)) continue;
      this.enemies.splice(i, 1);
      if (e.tag && this.guarded.delete(e.tag)) (reset ??= new Set()).add(e.tag);
    }
    // A place resets whole: guards left behind would otherwise stay with no
    // record, and the next visit would wake a second set beside them.
    if (reset) {
      for (let i = this.enemies.length - 1; i >= 0; i--) if (reset.has(this.enemies[i].tag)) this.enemies.splice(i, 1);
    }
    for (let i = this.projectiles.length - 1; i >= 0; i--) {
      const p = this.projectiles[i];
      if (!this.simulated(sim, p.x, p.y)) this.projectiles.splice(i, 1);
    }
  }

  /** The wild around this player and, on a host, around each guest outdoors. */
  private spawnAll(): void {
    const sim = this.world.chunks.simRect;
    if (!sim) return;
    const { x, y } = this.body;
    const shared = this.others.length > 0;
    this.spawnWild(sim, x, y, shared);
    this.spawnAnimals(sim, x, y, shared);
    for (const o of this.others) {
      // A guest beside the host shares the host's wild.
      if (Math.abs(o.x - x) < CHUNK_SIZE && Math.abs(o.y - y) < CHUNK_SIZE) continue;
      const area = this.areaOf(o);
      this.spawnWild(area, o.x, o.y, true);
      this.spawnAnimals(this.areaOf(o), o.x, o.y, true);
    }
  }

  /** How many matching enemies are in an area. */
  private countIn(sim: ChunkRect, match: (e: Enemy) => boolean): number {
    let n = 0;
    for (const e of this.enemies) if (match(e) && inRect(sim, tileToChunk(e.x), tileToChunk(e.y))) n++;
    return n;
  }

  /** `local`: count only the enemies in this area against the cap (with
   *  guests about); alone, every enemy counts, as they all live in it. */
  private spawnWild(sim: ChunkRect, px: number, py: number, local: boolean): void {
    if (Math.hypot(px, py) < SAFE_RADIUS) return;
    const band = difficultyBand(px, py);
    const hostile = (e: Enemy) => !e.tag && !e.species.passive;
    if ((local ? this.countIn(sim, hostile) : this.enemies.filter(hostile).length) >= populationCap(band, this.night)) return;

    for (let attempt = 0; attempt < 8; attempt++) {
      const gx = this.rng.int(sim.x0 * CHUNK_SIZE, (sim.x1 + 1) * CHUNK_SIZE - 1);
      const gy = this.rng.int(sim.y0 * CHUNK_SIZE, (sim.y1 + 1) * CHUNK_SIZE - 1);
      if (Math.hypot(gx - px, gy - py) < MIN_SPAWN_DISTANCE || Math.hypot(gx, gy) < SAFE_RADIUS) continue;
      if (this.world.isSolidAt(gx, gy)) continue;
      const biome = this.world.biomeAt(gx, gy);
      const species = biome && pickSpecies(this.rng, biome.type, this.night);
      if (!species) continue;
      const group = species.pack ? this.nextGroup++ : 0;
      const elite = this.rng.chance(eliteChance(band));
      for (let n = groupSize(this.rng, species); n > 0; n--) {
        const x = gx + 0.5 + this.rng.range(-1.5, 1.5);
        const y = gy + 0.9 + this.rng.range(-1.5, 1.5);
        if (this.world.isSolidAt(Math.floor(x), Math.floor(y))) continue;
        const e = new Enemy(species, x, y, band, elite && n === 1);
        e.group = group;
        this.enemies.push(e);
      }
      return;
    }
  }

  private spawnAnimals(sim: ChunkRect, px: number, py: number, local: boolean): void {
    const cap = this.night ? ANIMAL_CAP.night : ANIMAL_CAP.day;
    const animal = (e: Enemy) => !!e.species.passive;
    if ((local ? this.countIn(sim, animal) : this.enemies.filter(animal).length) >= cap) return;
    for (let attempt = 0; attempt < 8; attempt++) {
      const gx = this.rng.int(sim.x0 * CHUNK_SIZE, (sim.x1 + 1) * CHUNK_SIZE - 1);
      const gy = this.rng.int(sim.y0 * CHUNK_SIZE, (sim.y1 + 1) * CHUNK_SIZE - 1);
      if (Math.hypot(gx - px, gy - py) < MIN_SPAWN_DISTANCE || this.world.isSolidAt(gx, gy)) continue;
      const biome = this.world.biomeAt(gx, gy);
      const species = biome && pickSpecies(this.rng, biome.type, this.night, true);
      if (!species) continue;
      const group = species.pack ? this.nextGroup++ : 0;
      const band = difficultyBand(gx, gy);
      for (let n = groupSize(this.rng, species); n > 0; n--) {
        const x = gx + 0.5 + this.rng.range(-1.5, 1.5);
        const y = gy + 0.9 + this.rng.range(-1.5, 1.5);
        if (this.world.isSolidAt(Math.floor(x), Math.floor(y))) continue;
        const e = new Enemy(species, x, y, band, false);
        e.group = group;
        this.enemies.push(e);
      }
      return;
    }
  }

  /** Entering an uncleared dungeon or boss arena wakes its guards: this
   *  player, or a guest on a host's ground. */
  private triggers(): void {
    this.triggerAt(this.body.x, this.body.y);
    for (const o of this.others) this.triggerAt(o.x, o.y);
  }

  private triggerAt(x: number, y: number): void {
    const gx = Math.floor(x);
    const gy = Math.floor(y);
    for (const o of this.world.objects.inChunk(chunkKey(tileToChunk(gx), tileToChunk(gy)))) {
      if (!GUARDED_KINDS.has(o.kind) || !o.contains(gx, gy)) continue;
      const key = o.anchor || o.id;
      if (this.world.clearedAnchors.has(key) || this.guarded.has(o.id)) continue;
      if (o.kind === 'dungeon') {
        // Skeletons, archers behind them, and further out a ghoul or two.
        const band = difficultyBand(o.x, o.y);
        const ghouls = band >= 3 ? 2 : band >= 2 ? 1 : 0;
        this.spawnGuards(o, [[SPECIES.skeleton, this.rng.int(2, 3)], [SPECIES.skeletonArcher, this.rng.int(1, 2)], [SPECIES.ghoul, ghouls]], key);
      } else this.spawnGuards(o, [[SPECIES.guardian, 1]], key);
    }
  }

  private spawnGuards(o: WorldObject, groups: ReadonlyArray<[Species, number]>, key: string): void {
    const band = difficultyBand(o.x, o.y);
    let placed = 0;
    let boss: Species | null = null;
    for (const [species, count] of groups) {
      let n = 0;
      for (let attempt = 0; attempt < 60 && n < count; attempt++) {
        // Bosses take the centre; guards spread over the floor.
        const lx = species.boss ? Math.floor(o.w / 2) : this.rng.int(1, o.w - 2);
        const ly = species.boss ? Math.floor(o.h / 2) + 2 : this.rng.int(1, o.h - 2);
        if (this.world.isSolidAt(o.x + lx, o.y + ly)) continue;
        const e = new Enemy(species, o.x + lx + 0.5, o.y + ly + 0.9, band, false);
        e.tag = o.id;
        this.enemies.push(e);
        n++;
      }
      if (n && species.boss) boss = species;
      placed += n;
    }
    if (!placed) return;
    this.guarded.set(o.id, { remaining: placed, key, name: o.name, kind: o.kind });
    this.events.notify(boss ? `${boss.name} awakens!` : `Something stirs in the ${o.name.toLowerCase()}…`);
  }

  /** Rolls each simulated chunk once per region visit for a legendary
   *  creature, around this player and any guests. */
  private rollLegends(): void {
    const sim = this.world.chunks.simRect;
    if (!sim) return;
    // Only new chunks can roll: look again when a simulated area moves.
    let at = `${sim.x0},${sim.y0},${sim.x1},${sim.y1}`;
    for (const o of this.others) at += `;${tileToChunk(o.x)},${tileToChunk(o.y)}`;
    if (at === this.legendRect) return;
    this.legendRect = at;
    // Rolls are seeded, so forgetting old ones only means rolling them again.
    if (this.legendChecked.size > 4096) this.legendChecked.clear();
    this.legendsIn(sim);
    for (const o of this.others) this.legendsIn(this.areaOf(o));
  }

  private legendsIn(sim: ChunkRect): void {
    for (let cy = sim.y0; cy <= sim.y1; cy++) {
      for (let cx = sim.x0; cx <= sim.x1; cx++) {
        const visit = this.world.regions.visit(cx, cy);
        const id = `${cx},${cy}#${visit}`;
        if (this.legendChecked.has(id)) continue;
        this.legendChecked.add(id);
        // Per visit: once the region drifts, a new legend may roam here.
        const key = `legend@${cx},${cy}#${visit}`;
        if (this.world.clearedAnchors.has(key) || this.guarded.has(key)) continue;
        const gx = cx * CHUNK_SIZE + 16;
        const gy = cy * CHUNK_SIZE + 16;
        const band = difficultyBand(gx, gy);
        // Legends grow commoner, and fiercer, the further out.
        const rng = streamRng(Stream.RareEvent, this.world.seed, cx, cy, visit, 77);
        if (rng.next() >= LEGEND_CHANCE * (1 + band)) continue;
        if (this.world.isSolidAt(gx, gy)) continue;
        const species = legendFor(this.world.biomeAt(gx, gy)?.type, band, rng.next());
        const e = new Enemy(species, gx + 0.5, gy + 0.9, band, false);
        e.tag = key;
        this.enemies.push(e);
        this.guarded.set(key, { remaining: 1, key, name: `The ${species.name}`, kind: 'legend' });
        this.events.notify('A legendary creature roams nearby…');
      }
    }
  }
}
