// What a host believes of a guest. Guests run their own players, so a
// modified one could say it stands anywhere and hits for anything; the host
// plays only what a real player could have done: moves at a player's speed
// (with room for lag and a dodge), and blows as strong as the weapon in hand.

import { RUN_SPEED } from '../config';
import type { ItemDef } from '../items/Items';
import { itemAt } from './ids';

/** Fastest a player goes for long, in tiles a second (a run, with a dodge now and then). */
const MAX_SPEED = RUN_SPEED * 1.6;
/** Most a guest may move at once, in tiles: lag comes in bursts. */
const CAP = 6;
/** A jump back to a spot held lately (a fall caught, a push back) is no cheat. */
const RECENT = 24;
const RECENT_EVERY_MS = 500;
const RECENT_NEAR = 1.5;
/** Somewhere new, held steadily this long, is believed (a respawn, a long stall), in ms. */
const SETTLE_MS = 1500;

/** Where a guest truly is, as far as the host will play it. */
export class MoveGuard {
  x = 0;
  y = 0;
  private known = false;
  private budget = CAP;
  private at = 0;
  // Spots held lately: a ring of x, y.
  private readonly recent = new Float32Array(RECENT * 2);
  private recentN = 0;
  private recentAt = -Infinity;
  // A jump not believed yet: where it went, and since when it has held.
  private jumpX = 0;
  private jumpY = 0;
  private jumpSince = -1;
  private jumpAt = 0;

  /** Forgets where they were (they changed place: a room, a rift): the next report is believed. */
  reset(): void {
    this.known = false;
    this.recentN = 0;
    this.jumpSince = -1;
  }

  /** A position they reported at `now` (ms); true if believed (and taken). `allow`
   *  may vouch for a jump the game knows to be fair (waking beside the host). */
  check(x: number, y: number, now: number, allow?: (x: number, y: number) => boolean): boolean {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return false;
    if (!this.known) return this.take(x, y, now, true);
    const secs = Math.max(0, now - this.at) / 1000;
    this.at = now;
    this.budget = Math.min(CAP, this.budget + secs * MAX_SPEED);
    const d = Math.hypot(x - this.x, y - this.y);
    if (d <= this.budget) {
      this.budget -= d;
      return this.take(x, y, now, false);
    }
    if (this.wasAt(x, y) || allow?.(x, y)) return this.take(x, y, now, true);
    // Too far, too fast: held steadily somewhere new for a while, it is believed.
    const steady = this.jumpSince >= 0 && Math.hypot(x - this.jumpX, y - this.jumpY) <= MAX_SPEED * Math.max(0.05, (now - this.jumpAt) / 1000) + 1;
    if (!steady) this.jumpSince = now;
    this.jumpX = x;
    this.jumpY = y;
    this.jumpAt = now;
    if (now - this.jumpSince >= SETTLE_MS) return this.take(x, y, now, true);
    return false;
  }

  private take(x: number, y: number, now: number, jump: boolean): boolean {
    this.x = x;
    this.y = y;
    this.at = now;
    this.known = true;
    this.jumpSince = -1;
    if (jump) this.budget = CAP;
    if (now - this.recentAt >= RECENT_EVERY_MS) {
      this.recentAt = now;
      const i = (this.recentN++ % RECENT) * 2;
      this.recent[i] = x;
      this.recent[i + 1] = y;
    }
    return true;
  }

  private wasAt(x: number, y: number): boolean {
    const n = Math.min(this.recentN, RECENT);
    for (let i = 0; i < n; i++) {
      if (Math.abs(this.recent[i * 2] - x) <= RECENT_NEAR && Math.abs(this.recent[i * 2 + 1] - y) <= RECENT_NEAR) return true;
    }
    return false;
  }
}

/** Damage of bare fists (`CombatSystem`'s FISTS). */
const FIST_DAMAGE = 5;
/** Room over a weapon's own damage for a crit (×2), a weakness (×1.5) and a
 *  well-trained hand (levels and the Warrior skill). */
const BLOW_SLACK = 2 * 1.5 * 3;

/** The strongest blow a player holding this item (by its wire index, -1 for
 *  none) could land. */
export function maxBlow(holding: number): number {
  const item: ItemDef | undefined = holding >= 0 ? itemAt(holding) : undefined;
  return Math.ceil((item?.weapon?.damage ?? FIST_DAMAGE) * BLOW_SLACK);
}

/** A rate a guest may ask for something at: tokens a second, and the most saved up. */
export class Allowance {
  private tokens: number;
  private at = 0;

  constructor(
    private readonly rate: number,
    private readonly burst: number,
  ) {
    this.tokens = burst;
  }

  /** Takes one at `now` (ms); false if none is left. */
  take(now: number): boolean {
    this.tokens = Math.min(this.burst, this.tokens + (Math.max(0, now - this.at) / 1000) * this.rate);
    this.at = now;
    if (this.tokens < 1) return false;
    this.tokens--;
    return true;
  }
}

/** Damage a creature's blow may do to a player, at most, and xp a kill may
 *  give: a host could send anything, and a guest takes only what could be. */
export const MAX_DAMAGE_TAKEN = 500;
export const MAX_KILL_XP = 5000;
