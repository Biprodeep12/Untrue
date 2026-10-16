// Environmental hazards (spec 6.1, 6.2): lightning in thunderstorms, and fire
// that burns trees and spreads unless the weather is wet.

import { Deco } from '../generation/Tiles';
import type { Rng } from '../generation/Random';
import type { WorldManager } from '../world/WorldManager';
import type { Vitals } from './Vitals';

/** Seconds a strike is telegraphed before it lands. */
export const STRIKE_WARNING = 1.2;
const STRIKE_RADIUS = 1.3;
const STRIKE_DAMAGE = 25;
const BURN_SECONDS = 7;
const FIRE_DAMAGE_PER_SEC = 6;
const FIRE_RADIUS = 1.1;
const TREES = new Set<number>([Deco.Oak, Deco.OakAutumn, Deco.Pine, Deco.PineSnow, Deco.Palm, Deco.Bush, Deco.DeadBush]);

export interface Strike {
  x: number;
  y: number;
  /** Seconds until it lands. */
  timer: number;
}

export interface Fire {
  gx: number;
  gy: number;
  /** Seconds left burning. */
  timer: number;
  spread: boolean;
}

export interface HazardHooks {
  flash(): void;
  hurt(fromX: number, fromY: number): void;
  notify(text: string): void;
}

export class HazardSystem {
  readonly strikes: Strike[] = [];
  readonly fires: Fire[] = [];
  private nextStrike = 8;
  /** Tiles alight, so spreading checks a set rather than every fire. */
  private readonly burning = new Set<string>();

  constructor(
    private readonly world: WorldManager,
    private readonly vitals: Vitals,
    private readonly rng: Rng,
    private readonly hooks: HazardHooks,
  ) {}

  update(dt: number, storm: boolean, wet: boolean, px: number, py: number, invulnerable: boolean): void {
    if (storm) {
      this.nextStrike -= dt;
      if (this.nextStrike <= 0) {
        this.nextStrike = this.rng.range(5, 13);
        this.strikes.push({ ...this.strikeTarget(px, py), timer: STRIKE_WARNING });
      }
    }
    for (let i = this.strikes.length - 1; i >= 0; i--) {
      const s = this.strikes[i];
      s.timer -= dt;
      if (s.timer > 0) continue;
      this.strikes.splice(i, 1);
      this.hooks.flash();
      if (!invulnerable && Math.hypot(px - s.x, py - s.y) < STRIKE_RADIUS) {
        this.vitals.hurt(STRIKE_DAMAGE);
        this.hooks.hurt(s.x, s.y);
        this.hooks.notify('Struck by lightning!');
      }
      this.ignite(Math.floor(s.x), Math.floor(s.y));
    }
    for (let i = this.fires.length - 1; i >= 0; i--) {
      const f = this.fires[i];
      f.timer -= dt * (wet ? 2 : 1);
      if (!invulnerable && Math.hypot(px - (f.gx + 0.5), py - (f.gy + 0.9)) < FIRE_RADIUS) this.vitals.hurt(FIRE_DAMAGE_PER_SEC * dt);
      if (f.spread && f.timer < BURN_SECONDS / 2) {
        f.spread = false;
        for (let dy = -2; dy <= 2; dy++) {
          for (let dx = -2; dx <= 2; dx++) if ((dx || dy) && this.rng.chance(wet ? 0.05 : 0.35)) this.ignite(f.gx + dx, f.gy + dy);
        }
      }
      if (f.timer > 0) continue;
      this.fires.splice(i, 1);
      this.burning.delete(`${f.gx},${f.gy}`);
      if (TREES.has(this.world.tileAt(f.gx, f.gy)?.deco ?? 0)) this.world.harvest(f.gx, f.gy);
    }
  }

  /** Sets a tree alight, if there is one. */
  ignite(gx: number, gy: number): boolean {
    if (!TREES.has(this.world.tileAt(gx, gy)?.deco ?? 0)) return false;
    const key = `${gx},${gy}`;
    if (this.burning.has(key)) return false;
    this.burning.add(key);
    this.fires.push({ gx, gy, timer: BURN_SECONDS, spread: true });
    return true;
  }

  /** Lightning likes trees: often it picks one near the player. */
  private strikeTarget(px: number, py: number): { x: number; y: number } {
    if (this.rng.chance(0.5)) {
      for (let attempt = 0; attempt < 20; attempt++) {
        const gx = Math.floor(px) + this.rng.int(-8, 8);
        const gy = Math.floor(py) + this.rng.int(-6, 6);
        if (TREES.has(this.world.tileAt(gx, gy)?.deco ?? 0)) return { x: gx + 0.5, y: gy + 0.9 };
      }
    }
    return { x: px + this.rng.range(-7, 7), y: py + this.rng.range(-5, 5) };
  }
}
