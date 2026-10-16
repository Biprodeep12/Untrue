// Player vitals (spec 5): health, stamina, hunger and thirst, plus status
// effects. The biome feeds into the rates (spec 6.1: biome, environment, gameplay).

import { BiomeType } from '../generation/Tiles';

export const VITAL_MAX = 100;

/** Seconds for a full bar to drain at rest. */
const HUNGER_SECONDS = 600;
const THIRST_SECONDS = 420;
const RUN_STAMINA_PER_SEC = 18;
const STAMINA_REGEN_PER_SEC = 22;
const STARVE_DAMAGE_PER_SEC = 1.2;
const HEAL_PER_SEC = 0.6;
/** Hunger and thirst above this let health recover. */
const WELL_FED = 40;
const POISON_DAMAGE_PER_SEC = 2.5;
/** Movement speed multiplier while slowed. */
export const SLOW_FACTOR = 0.55;

export type StatusKind = 'poison' | 'slow';

/** Desert heat dries you out; snow burns more food to stay warm. */
const BIOME_THIRST: Record<BiomeType, number> = { [BiomeType.Forest]: 1, [BiomeType.Desert]: 1.6, [BiomeType.Snow]: 0.9 };
const BIOME_HUNGER: Record<BiomeType, number> = { [BiomeType.Forest]: 1, [BiomeType.Desert]: 1, [BiomeType.Snow]: 1.4 };

export interface VitalValues {
  health: number;
  stamina: number;
  hunger: number;
  thirst: number;
}

export class Vitals implements VitalValues {
  /** Grows with level. */
  maxHealth = VITAL_MAX;
  health = VITAL_MAX;
  stamina = VITAL_MAX;
  hunger = VITAL_MAX;
  thirst = VITAL_MAX;
  /** Seconds left on each status effect. */
  readonly status: Record<StatusKind, number> = { poison: 0, slow: 0 };

  get canRun(): boolean {
    return this.stamina > 1;
  }

  /** Advances one frame; returns true when the player collapses. `weather`
   *  multiplies hunger and thirst drain on top of the biome's own rates, and
   *  `drain` the stamina an effort costs. */
  update(dt: number, running: boolean, biome: BiomeType | undefined, weather = { hunger: 1, thirst: 1 }, drain = 1): boolean {
    const effort = running ? 1.5 : 1;
    const b = biome ?? BiomeType.Forest;
    this.hunger = clamp(this.hunger - (VITAL_MAX / HUNGER_SECONDS) * effort * BIOME_HUNGER[b] * weather.hunger * dt);
    this.thirst = clamp(this.thirst - (VITAL_MAX / THIRST_SECONDS) * effort * BIOME_THIRST[b] * weather.thirst * dt);

    if (running) this.stamina = clamp(this.stamina - RUN_STAMINA_PER_SEC * drain * dt);
    else this.stamina = clamp(this.stamina + STAMINA_REGEN_PER_SEC * (this.hunger > 0 && this.thirst > 0 ? 1 : 0.3) * dt);

    const empty = (this.hunger <= 0 ? 1 : 0) + (this.thirst <= 0 ? 1 : 0);
    let change = 0;
    if (empty) change -= STARVE_DAMAGE_PER_SEC * empty;
    else if (this.hunger > WELL_FED && this.thirst > WELL_FED && !this.status.poison) change += HEAL_PER_SEC;
    if (this.status.poison > 0) change -= POISON_DAMAGE_PER_SEC;
    this.health = Math.max(0, Math.min(this.maxHealth, this.health + change * dt));
    for (const k of Object.keys(this.status) as StatusKind[]) this.status[k] = Math.max(0, this.status[k] - dt);
    return this.health <= 0;
  }

  /** Spends stamina for an effort; returns false if there was not enough. */
  spend(stamina: number): boolean {
    if (this.stamina < stamina) return false;
    this.stamina -= stamina;
    return true;
  }

  consume(effect: { hunger?: number; thirst?: number; health?: number }, cures?: StatusKind): void {
    this.hunger = clamp(this.hunger + (effect.hunger ?? 0));
    this.thirst = clamp(this.thirst + (effect.thirst ?? 0));
    this.health = Math.min(this.maxHealth, this.health + (effect.health ?? 0));
    if (cures) this.status[cures] = 0;
  }

  /** Takes damage; returns true if it was fatal. */
  hurt(amount: number): boolean {
    // A NaN blow would leave health NaN: never fatal, and saved that way.
    if (amount > 0) this.health = Math.max(0, this.health - amount);
    return this.health <= 0;
  }

  afflict(kind: StatusKind, seconds: number): void {
    this.status[kind] = Math.max(this.status[kind], seconds);
  }

  /** Waking up after a collapse. */
  revive(): void {
    this.health = this.maxHealth * 0.6;
    this.status.poison = this.status.slow = 0;
    this.stamina = VITAL_MAX;
    this.hunger = Math.max(this.hunger, 50);
    this.thirst = Math.max(this.thirst, 50);
  }

  save(): VitalValues {
    return { health: this.health, stamina: this.stamina, hunger: this.hunger, thirst: this.thirst };
  }

  /** Restores saved bars, each kept in range (a missing or broken value is full). */
  load(v: VitalValues): void {
    const bar = (x: number, max: number) => (Number.isFinite(x) ? Math.max(0, Math.min(max, x)) : max);
    this.health = bar(v.health, this.maxHealth);
    this.stamina = bar(v.stamina, VITAL_MAX);
    this.hunger = bar(v.hunger, VITAL_MAX);
    this.thirst = bar(v.thirst, VITAL_MAX);
  }
}

function clamp(v: number): number {
  return Math.max(0, Math.min(VITAL_MAX, v));
}
