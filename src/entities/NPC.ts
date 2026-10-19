// Non-player characters (spec 6.2): villagers with a daily schedule, traders,
// travelling merchants, and lost travellers that follow the player home.

import { PLAYER_HALF_W } from '../config';
import { Dir } from '../rendering/Atlas';

/** `spirit`: an outer world's resident, drawn faint, standing where it waits. */
export type NpcRole = 'villager' | 'trader' | 'merchant' | 'lost' | 'spirit';

/** Villagers head indoors from this hour, and come out again at MORNING_HOUR. */
export const BEDTIME_HOUR = 20;
export const MORNING_HOUR = 6;
const WALK_SPEED = 2.2;
const FOLLOW_SPEED = 5;
const FOLLOW_GAP = 1.6;

export interface NpcContext {
  hour: number;
  playerX: number;
  playerY: number;
  isSolid(gx: number, gy: number): boolean;
  random(): number;
}

let nextId = 1;

export class Npc {
  readonly id = nextId++;
  facing: number = Dir.Down;
  moving = false;
  /** Indoors, or gone. */
  hidden = false;
  following = false;
  /** Gives quests when talked to. */
  questGiver = false;
  /** Village this NPC belongs to, by object id. */
  village = '';
  /** Lost traveller's quest. */
  questId = '';
  /** In-game minute a travelling merchant packs up. */
  leaveAt = Infinity;
  /** Lives indoors: always at home behind its door, day and night. */
  homebody = false;
  /** In a conversation: stands still, facing the player. */
  talking = false;
  private targetX: number;
  private targetY: number;
  private wait = 0;
  private stuck = 0;

  constructor(
    readonly role: NpcRole,
    readonly name: string,
    readonly outfit: string,
    public x: number,
    public y: number,
    /** Where it wanders around, and its front door for the night. */
    readonly homeX: number,
    readonly homeY: number,
    readonly doorX = homeX,
    readonly doorY = homeY,
  ) {
    this.targetX = x;
    this.targetY = y;
  }

  get title(): string {
    if (this.role === 'trader') return `${this.name} the Trader`;
    if (this.role === 'merchant') return `${this.name}, travelling merchant`;
    return this.name;
  }

  /** Stops and turns to the player for a conversation. */
  listen(playerX: number, playerY: number): void {
    this.talking = true;
    this.moving = false;
    this.faceTowards(playerX - this.x, playerY - this.y);
  }

  /** The conversation is over: wait a moment, then carry on. */
  release(): void {
    this.talking = false;
    this.wait = Math.max(this.wait, 2);
  }

  update(dt: number, ctx: NpcContext): void {
    this.moving = false;
    if (this.talking) {
      this.faceTowards(ctx.playerX - this.x, ctx.playerY - this.y);
      return;
    }
    if (this.following) {
      const dx = ctx.playerX - this.x;
      const dy = ctx.playerY - this.y;
      const d = Math.hypot(dx, dy);
      if (d > 12) {
        // Fell behind: catch up rather than get lost again.
        this.x = ctx.playerX - (dx / d) * FOLLOW_GAP;
        this.y = ctx.playerY - (dy / d) * FOLLOW_GAP;
      } else if (d > FOLLOW_GAP) {
        this.walk(dx / d, dy / d, FOLLOW_SPEED * dt, ctx);
      }
      return;
    }
    if (this.role === 'lost' || this.role === 'merchant') return;
    if (this.homebody) {
      this.hidden = true;
      return;
    }

    const night = ctx.hour >= BEDTIME_HOUR || ctx.hour < MORNING_HOUR;
    if (night) {
      if (this.hidden) return;
      // Walk to the doorstep below the door, then go in.
      if (this.goTo(this.doorX + 0.5, this.doorY + 1.9, dt, ctx)) this.hidden = true;
      return;
    }
    if (this.hidden) {
      this.hidden = false;
      this.x = this.doorX + 0.5;
      this.y = this.doorY + 1.9;
    }
    this.wait -= dt;
    if (this.wait > 0) return;
    if (this.goTo(this.targetX, this.targetY, dt, ctx)) {
      const range = this.role === 'trader' ? 2 : 9;
      this.targetX = this.homeX + (ctx.random() * 2 - 1) * range;
      this.targetY = this.homeY + (ctx.random() * 2 - 1) * range;
      this.wait = 1 + ctx.random() * 4;
    }
  }

  /** Walks toward a point; true once there (or hopelessly stuck). */
  private goTo(tx: number, ty: number, dt: number, ctx: NpcContext): boolean {
    const dx = tx - this.x;
    const dy = ty - this.y;
    const d = Math.hypot(dx, dy);
    if (d < 0.3) return true;
    const before = this.x + this.y;
    this.walk(dx / d, dy / d, Math.min(d, WALK_SPEED * dt), ctx);
    this.stuck = this.x + this.y === before ? this.stuck + dt : 0;
    return this.stuck > 1;
  }

  private walk(ux: number, uy: number, dist: number, ctx: NpcContext): void {
    const free = (x: number, y: number) =>
      !ctx.isSolid(Math.floor(x - PLAYER_HALF_W), Math.floor(y - 0.1)) && !ctx.isSolid(Math.floor(x + PLAYER_HALF_W), Math.floor(y - 0.1));
    if (free(this.x + ux * dist, this.y)) this.x += ux * dist;
    if (free(this.x, this.y + uy * dist)) this.y += uy * dist;
    this.faceTowards(ux, uy);
    this.moving = true;
  }

  faceTowards(dx: number, dy: number): void {
    if (Math.abs(dx) > Math.abs(dy)) this.facing = dx < 0 ? Dir.Left : Dir.Right;
    else this.facing = dy < 0 ? Dir.Up : Dir.Down;
  }
}
