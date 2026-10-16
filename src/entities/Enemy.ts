// An enemy and its AI (spec 5): patrol, aggro, chase, attack and flee, plus
// burrowed for ambushers.

import { ENEMY_HALF_W } from '../config';
import type { Species } from './Species';

export type EnemyState = 'patrol' | 'aggro' | 'chase' | 'attack' | 'flee' | 'burrowed';

/** Pause between noticing the player and charging, so the player can react. */
const AGGRO_PAUSE = 0.4;
/** Melee wind-up: the hit lands this long after the attack starts. */
const WINDUP = 0.3;
const FLEE_SECONDS = 3;

/** What an enemy can ask of the world. */
export interface EnemyContext {
  playerX: number;
  playerY: number;
  isSolid(gx: number, gy: number): boolean;
  /** Puts the rest of a pack on alert. */
  alert(group: number): void;
  hitPlayer(enemy: Enemy): void;
  shoot(enemy: Enemy, dx: number, dy: number): void;
  random(): number;
}

let nextId = 1;

export class Enemy {
  readonly id = nextId++;
  hp: number;
  readonly maxHp: number;
  readonly damage: number;
  state: EnemyState;
  /** 1 faces right, -1 left. */
  facing = 1;
  moving = false;
  /** Seconds left on the red hit flash. */
  hitFlash = 0;
  /** What spawned it: a dungeon or arena object id, or a legendary spot. */
  tag = '';
  group = 0;
  private stateTime = 0;
  private cooldown = 0;
  private wanderX = 0;
  private wanderY = 0;
  private wanderTime = 0;
  private swung = false;

  constructor(
    readonly species: Species,
    public x: number,
    public y: number,
    /** Difficulty band: tougher with distance from the origin. */
    readonly band: number,
    readonly elite: boolean,
  ) {
    const eliteHp = elite ? 2.5 : 1;
    const eliteDmg = elite ? 1.5 : 1;
    this.maxHp = this.hp = Math.round(species.hp * (1 + 0.6 * band) * eliteHp);
    this.damage = species.damage * (1 + 0.5 * band) * eliteDmg;
    this.state = species.ambush ? 'burrowed' : 'patrol';
  }

  get name(): string {
    return this.elite ? `Elite ${this.species.name}` : this.species.name;
  }

  get alive(): boolean {
    return this.hp > 0;
  }

  /** Experience for defeating it. */
  get xp(): number {
    return Math.round(this.species.xp * (1 + 0.5 * this.band) * (this.elite ? 3 : 1));
  }

  /** Puts it straight into the chase, e.g. when its pack is alerted or it is hit.
   *  Skittish animals bolt instead. */
  provoke(): void {
    if (this.species.passive === 'skittish') {
      if (this.state !== 'flee') this.enter('flee');
    } else if (this.state === 'patrol' || this.state === 'burrowed') this.enter('aggro');
  }

  takeHit(amount: number): void {
    this.hp = Math.max(0, this.hp - amount);
    this.hitFlash = 0.15;
    const flee = this.species.fleeBelow;
    if (flee && this.hp > 0 && this.hp < this.maxHp * flee) this.enter('flee');
    else this.provoke();
  }

  update(dt: number, ctx: EnemyContext): void {
    this.hitFlash = Math.max(0, this.hitFlash - dt);
    this.cooldown = Math.max(0, this.cooldown - dt);
    this.stateTime += dt;
    this.moving = false;
    const dx = ctx.playerX - this.x;
    const dy = ctx.playerY - this.y;
    const dist = Math.hypot(dx, dy);
    const sp = this.species;

    switch (this.state) {
      case 'burrowed':
        if (dist < sp.aggroRange) this.enter('aggro');
        break;
      case 'patrol':
        this.wander(dt, ctx);
        if (sp.passive === 'skittish' && dist < sp.aggroRange) {
          this.enter('flee');
          if (this.group) ctx.alert(this.group);
        } else if (!sp.passive && dist < sp.aggroRange) {
          this.enter('aggro');
          if (this.group) ctx.alert(this.group);
        }
        break;
      case 'aggro':
        this.face(dx);
        if (this.stateTime > AGGRO_PAUSE) this.enter('chase');
        break;
      case 'chase': {
        if (dist > sp.aggroRange * 2.5) {
          this.enter('patrol');
          break;
        }
        const inMelee = dist <= sp.attackRange;
        const inRange = sp.ranged && dist <= sp.ranged.range && dist > sp.attackRange * 2;
        if ((inMelee || inRange) && this.cooldown === 0) {
          this.enter('attack');
          break;
        }
        // Ranged attackers hold their distance while reloading.
        if (dist > 0 && !(sp.ranged && dist <= sp.ranged.range * 0.6 && !inMelee)) this.step(dx / dist, dy / dist, sp.speed * dt, ctx);
        this.face(dx);
        break;
      }
      case 'attack':
        this.face(dx);
        if (!this.swung && this.stateTime >= WINDUP) {
          this.swung = true;
          if (dist <= sp.attackRange + 0.4) ctx.hitPlayer(this);
          else if (sp.ranged && dist <= sp.ranged.range + 1) ctx.shoot(this, dx / dist, dy / dist);
          this.cooldown = sp.attackCooldown;
        }
        if (this.stateTime >= WINDUP + 0.2) this.enter('chase');
        break;
      case 'flee':
        if (dist > 0) this.step(-dx / dist, -dy / dist, sp.speed * 1.1 * dt, ctx);
        this.face(-dx);
        if (this.stateTime > FLEE_SECONDS) this.enter('patrol');
        break;
    }
  }

  /** True during the wind-up, so the renderer can telegraph the hit. */
  get windingUp(): boolean {
    return this.state === 'attack' && !this.swung;
  }

  private enter(state: EnemyState): void {
    this.state = state;
    this.stateTime = 0;
    this.swung = false;
  }

  private face(dx: number): void {
    if (Math.abs(dx) > 0.05) this.facing = dx > 0 ? 1 : -1;
  }

  private wander(dt: number, ctx: EnemyContext): void {
    this.wanderTime -= dt;
    if (this.wanderTime <= 0) {
      // Half the time it stands still.
      const a = ctx.random() * Math.PI * 2;
      const go = ctx.random() < 0.5;
      this.wanderX = go ? Math.cos(a) : 0;
      this.wanderY = go ? Math.sin(a) : 0;
      this.wanderTime = 1 + ctx.random() * 2;
    }
    if (this.wanderX || this.wanderY) {
      this.step(this.wanderX, this.wanderY, this.species.speed * 0.35 * dt, ctx);
      this.face(this.wanderX);
    }
  }

  /** Moves with tile collision, sliding along walls. */
  private step(ux: number, uy: number, dist: number, ctx: EnemyContext): void {
    const nx = this.x + ux * dist;
    if (!this.blocked(nx, this.y, ctx)) this.x = nx;
    const ny = this.y + uy * dist;
    if (!this.blocked(this.x, ny, ctx)) this.y = ny;
    this.moving = true;
  }

  private blocked(x: number, y: number, ctx: EnemyContext): boolean {
    if (this.species.flying) return false;
    return (
      ctx.isSolid(Math.floor(x - ENEMY_HALF_W), Math.floor(y - 0.2)) ||
      ctx.isSolid(Math.floor(x + ENEMY_HALF_W), Math.floor(y - 0.2)) ||
      ctx.isSolid(Math.floor(x - ENEMY_HALF_W), Math.floor(y - 0.01)) ||
      ctx.isSolid(Math.floor(x + ENEMY_HALF_W), Math.floor(y - 0.01))
    );
  }
}
