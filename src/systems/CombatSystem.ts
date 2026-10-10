// Combat (spec 5): spawning and despawning inside the simulation radius,
// dungeon guards and bosses, player attacks, projectiles, damage and drops.

import { CHUNK_SIZE } from '../config';
import { chunkKey, inRect, tileToChunk } from '../coords';
import { Enemy, type EnemyContext } from '../entities/Enemy';
import { SPECIES, type ProjectileKind, type Species } from '../entities/Species';
import { eliteChance, groupSize, LEGEND_CHANCE, MIN_SPAWN_DISTANCE, pickSpecies, populationCap, SAFE_RADIUS } from '../generation/EnemyGenerator';
import { Rng, streamRng, Stream } from '../generation/Random';
import { difficultyBand } from '../generation/WorldRules';
import { isWater } from '../generation/Tiles';
import { Items, type WeaponStats } from '../items/Items';
import type { WorldManager } from '../world/WorldManager';
import type { WorldObject } from '../world/WorldObject';
import type { Inventory } from './InventorySystem';
import { rollChest } from './Loot';
import type { Progression } from './Progression';
import type { Vitals } from './Vitals';

const FISTS: WeaponStats = { kind: 'melee', damage: 5, durability: 0, reach: 1.1, cooldown: 0.45 };
export const CRIT_CHANCE = 0.1;
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
const GUARDED_KINDS = new Set(['dungeon', 'boss-arena', 'story-archive']);

export interface Projectile {
  x: number;
  y: number;
  vx: number;
  vy: number;
  kind: ProjectileKind;
  damage: number;
  fromPlayer: boolean;
  /** Seconds left in flight. */
  ttl: number;
  source?: Enemy;
}

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
  private readonly rng: Rng;
  private spawnTimer = SPAWN_INTERVAL;
  private cooldown = 0;
  private nextGroup = 1;
  private body: PlayerBody = { x: 0, y: 0, faceX: 0, faceY: 1, blocking: false, invulnerable: false };
  /** Dungeons, arenas and legendary spots with live guards, by tag. */
  private readonly guarded = new Map<string, Guarded>();
  /** Chunks already rolled for a legendary creature this region visit. */
  private readonly legendChecked = new Set<string>();

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

  update(dt: number, body: PlayerBody): void {
    this.body = body;
    this.cooldown = Math.max(0, this.cooldown - dt);
    this.despawn();
    this.spawnTimer -= dt;
    if (this.spawnTimer <= 0) {
      this.spawnTimer = SPAWN_INTERVAL;
      this.spawnWild();
      this.spawnAnimals();
    }
    this.triggers();
    this.rollLegends();

    const ctx: EnemyContext = {
      playerX: body.x,
      playerY: body.y,
      isSolid: (gx, gy) => this.world.isSolidAt(gx, gy),
      alert: (group) => {
        for (const e of this.enemies) if (e.group === group) e.provoke();
      },
      hitPlayer: (e) => this.hitPlayer(e.damage, e.species, e.x, e.y),
      shoot: (e, dx, dy) => {
        const r = e.species.ranged!;
        this.projectiles.push({ x: e.x, y: e.y - BODY, vx: dx * r.speed, vy: dy * r.speed, kind: r.kind, damage: e.damage * 0.8, fromPlayer: false, ttl: (r.range + 1) / r.speed, source: e });
      },
      random: () => this.rng.next(),
    };
    for (const e of this.enemies) e.update(dt, ctx);
    this.updateProjectiles(dt);
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
        damage: playerHitDamage(weapon.damage, this.progression.damageBonus, crit), fromPlayer: true, ttl: weapon.reach / ARROW_SPEED,
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
        this.damageEnemy(e, playerHitDamage(weapon.damage, this.progression.damageBonus, crit), crit, dx, dy);
      }
    }
    this.cooldown = weapon.cooldown;
    if (slot !== null && stack?.item.weapon && this.inv.wear(slot)) this.events.notify(`Your ${stack.item.name} broke`);
    return true;
  }

  private damageEnemy(e: Enemy, amount: number, crit: boolean, pushX: number, pushY: number): void {
    e.takeHit(amount);
    this.events.damage(e.x, e.y - 1, amount, crit, false);
    // Knockback, unless something solid is in the way.
    const nx = e.x + pushX * 0.35;
    const ny = e.y + pushY * 0.35;
    if (!this.world.isSolidAt(Math.floor(nx), Math.floor(ny))) {
      e.x = nx;
      e.y = ny;
    }
    if (!e.alive) this.kill(e);
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
    if (species.inflicts && !blocked) this.vitals.afflict(species.inflicts.kind, species.inflicts.seconds);
    this.events.damage(b.x, b.y - 1.2, amount, false, true);
    this.events.playerHurt(fromX, fromY);
  }

  private kill(e: Enemy): void {
    this.enemies.splice(this.enemies.indexOf(e), 1);
    this.grantXp(e.xp);
    this.onKill?.(e);
    this.events.killed?.(e);
    const drops: Array<[typeof Items.wood, number]> = [];
    // Hunters get more from animals.
    const hunter = e.species.passive ? 0.35 * this.progression.rank('hunter') : 0;
    for (const [item, min, max, chance] of e.species.drops) {
      if (this.rng.chance(chance)) drops.push([item, this.rng.int(min, max) * (e.elite ? 2 : 1) + (this.rng.chance(hunter) ? 1 : 0)]);
    }
    if (e.species.boss || e.elite) drops.push(...rollChest(this.rng, e.band + (e.species.boss ? 3 : 0)));
    for (const [item, count] of drops) {
      const left = this.inv.add(item, count);
      if (count > left) this.events.notify(`+${count - left} ${item.name}`);
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
    this.events.notify(`Level up! You are level ${this.progression.level}. New skill point (Tab → Skills)`);
    this.events.levelUp?.(this.progression.level);
  }

  private updateProjectiles(dt: number): void {
    const b = this.body;
    for (let i = this.projectiles.length - 1; i >= 0; i--) {
      const p = this.projectiles[i];
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.ttl -= dt;
      let done = p.ttl <= 0 || this.blocksShots(Math.floor(p.x), Math.floor(p.y + BODY));
      if (!done && p.fromPlayer) {
        const hit = this.enemies.find((e) => e.state !== 'burrowed' && Math.hypot(e.x - p.x, e.y - BODY - p.y) < 0.6);
        if (hit) {
          const len = Math.hypot(p.vx, p.vy) || 1;
          this.damageEnemy(hit, p.damage, false, p.vx / len, p.vy / len);
          done = true;
        }
      } else if (!done && Math.hypot(b.x - p.x, b.y - BODY - p.y) < 0.5) {
        this.hitPlayer(p.damage, p.source?.species ?? SPECIES.skeleton, p.x - p.vx, p.y - p.vy);
        done = true;
      }
      if (done) this.projectiles.splice(i, 1);
    }
  }

  /** Spawns a group around a point, e.g. for an ambush or an invasion. */
  spawnGroup(species: Species, x: number, y: number, count: number, opts: GroupOptions = {}): Enemy[] {
    const band = difficultyBand(x, y);
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
      this.enemies.push(e);
      spawned.push(e);
    }
    if (tag && spawned.length) this.guarded.set(tag, { remaining: spawned.length, key: '', name: opts.label!, kind: opts.kind ?? 'event' });
    return spawned;
  }

  /** Enemies leave with the simulation radius; guards come back next visit.
   *  Night walkers fade at dawn. */
  private despawn(): void {
    const sim = this.world.chunks.simRect;
    if (!sim) return;
    for (let i = this.enemies.length - 1; i >= 0; i--) {
      const e = this.enemies[i];
      const faded = e.species.nightOnly && !this.night;
      if (!faded && inRect(sim, tileToChunk(e.x), tileToChunk(e.y))) continue;
      this.enemies.splice(i, 1);
      if (e.tag) this.guarded.delete(e.tag);
    }
    for (let i = this.projectiles.length - 1; i >= 0; i--) {
      const p = this.projectiles[i];
      if (!inRect(sim, tileToChunk(p.x), tileToChunk(p.y))) this.projectiles.splice(i, 1);
    }
  }

  private spawnWild(): void {
    const sim = this.world.chunks.simRect;
    const { x: px, y: py } = this.body;
    if (!sim || Math.hypot(px, py) < SAFE_RADIUS) return;
    const band = difficultyBand(px, py);
    if (this.enemies.filter((e) => !e.tag && !e.species.passive).length >= populationCap(band, this.night)) return;

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

  private spawnAnimals(): void {
    const sim = this.world.chunks.simRect;
    const { x: px, y: py } = this.body;
    if (!sim) return;
    const cap = this.night ? ANIMAL_CAP.night : ANIMAL_CAP.day;
    if (this.enemies.filter((e) => e.species.passive).length >= cap) return;
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

  /** Entering an uncleared dungeon or boss arena wakes its guards. */
  private triggers(): void {
    const { x, y } = this.body;
    const gx = Math.floor(x);
    const gy = Math.floor(y);
    for (const o of this.world.objects.inChunk(chunkKey(tileToChunk(gx), tileToChunk(gy)))) {
      if (!GUARDED_KINDS.has(o.kind) || !o.contains(gx, gy)) continue;
      const key = o.anchor || o.id;
      if (this.world.clearedAnchors.has(key) || this.guarded.has(o.id)) continue;
      if (o.kind === 'dungeon') this.spawnGuards(o, SPECIES.skeleton, this.rng.int(3, 5), key);
      else if (o.kind === 'story-archive') this.spawnGuards(o, SPECIES.skeleton, 6, key);
      else this.spawnGuards(o, SPECIES.guardian, 1, key);
    }
  }

  private spawnGuards(o: WorldObject, species: Species, count: number, key: string): void {
    const band = difficultyBand(o.x, o.y);
    let placed = 0;
    for (let attempt = 0; attempt < 60 && placed < count; attempt++) {
      // Bosses take the centre; guards spread over the floor.
      const lx = count === 1 ? Math.floor(o.w / 2) : this.rng.int(1, o.w - 2);
      const ly = count === 1 ? Math.floor(o.h / 2) + 2 : this.rng.int(1, o.h - 2);
      if (this.world.isSolidAt(o.x + lx, o.y + ly)) continue;
      const e = new Enemy(species, o.x + lx + 0.5, o.y + ly + 0.9, band, false);
      e.tag = o.id;
      this.enemies.push(e);
      placed++;
    }
    if (!placed) return;
    this.guarded.set(o.id, { remaining: placed, key, name: o.name, kind: o.kind });
    this.events.notify(species.boss ? `${species.name} awakens!` : `Something stirs in the ${o.name.toLowerCase()}…`);
  }

  /** Rolls each simulated chunk once per region visit for a legendary creature. */
  private rollLegends(): void {
    const sim = this.world.chunks.simRect;
    if (!sim) return;
    for (let cy = sim.y0; cy <= sim.y1; cy++) {
      for (let cx = sim.x0; cx <= sim.x1; cx++) {
        const visit = this.world.regions.visit(cx, cy);
        const id = `${cx},${cy}#${visit}`;
        if (this.legendChecked.has(id)) continue;
        this.legendChecked.add(id);
        const key = `legend@${cx},${cy}`;
        if (this.world.clearedAnchors.has(key) || this.guarded.has(key)) continue;
        if (streamRng(Stream.RareEvent, this.world.seed, cx, cy, visit, 77).next() >= LEGEND_CHANCE) continue;
        const gx = cx * CHUNK_SIZE + 16;
        const gy = cy * CHUNK_SIZE + 16;
        if (this.world.isSolidAt(gx, gy)) continue;
        const e = new Enemy(SPECIES.stag, gx + 0.5, gy + 0.9, difficultyBand(gx, gy), false);
        e.tag = key;
        this.enemies.push(e);
        this.guarded.set(key, { remaining: 1, key, name: 'The Elder Stag', kind: 'legend' });
        this.events.notify('A legendary creature roams nearby…');
      }
    }
  }
}
