// Weather (spec 6.1): each biome type runs its own weather pattern, and the
// player feels whichever biome they stand in. Biome, weather, environment,
// gameplay.

import { Rng } from '../generation/Random';
import { BIOME_TYPES, BiomeType } from '../generation/Tiles';

export type WeatherKind = 'clear' | 'rain' | 'storm' | 'fog' | 'sandstorm' | 'heat' | 'snow' | 'blizzard';

export interface WeatherEffect {
  label: string;
  /** Multipliers on hunger and thirst drain. */
  hunger: number;
  thirst: number;
  /** Multiplier on movement speed. */
  speed: number;
  /** 0 to 1: how much the view is veiled. */
  veil: number;
  /** Puts out fires and slows their spread. */
  wet: boolean;
}

export const WEATHER: Record<WeatherKind, WeatherEffect> = {
  clear: { label: 'Clear', hunger: 1, thirst: 1, speed: 1, veil: 0, wet: false },
  rain: { label: 'Rain', hunger: 1, thirst: 0.7, speed: 1, veil: 0.1, wet: true },
  storm: { label: 'Thunderstorm', hunger: 1.1, thirst: 0.7, speed: 0.95, veil: 0.2, wet: true },
  fog: { label: 'Fog', hunger: 1, thirst: 1, speed: 1, veil: 0.45, wet: false },
  sandstorm: { label: 'Sandstorm', hunger: 1, thirst: 1.3, speed: 0.8, veil: 0.5, wet: false },
  heat: { label: 'Heat wave', hunger: 1, thirst: 1.6, speed: 1, veil: 0.05, wet: false },
  snow: { label: 'Snow', hunger: 1.15, thirst: 1, speed: 0.95, veil: 0.1, wet: true },
  blizzard: { label: 'Blizzard', hunger: 1.35, thirst: 1, speed: 0.8, veil: 0.5, wet: true },
};

const PATTERNS: Record<BiomeType, ReadonlyArray<[WeatherKind, number]>> = {
  [BiomeType.Forest]: [['clear', 6], ['rain', 3], ['storm', 1], ['fog', 1.5]],
  [BiomeType.Desert]: [['clear', 6], ['sandstorm', 1.5], ['heat', 2]],
  [BiomeType.Snow]: [['clear', 4], ['snow', 4], ['blizzard', 1.2], ['fog', 1]],
};

interface Spell {
  kind: WeatherKind;
  hoursLeft: number;
}

export type WeatherSave = Record<number, Spell>;

export class WeatherSystem {
  private readonly spells = new Map<BiomeType, Spell>();

  constructor(private readonly rng: Rng) {
    for (const b of BIOME_TYPES) this.spells.set(b, { kind: 'clear', hoursLeft: rng.int(2, 6) });
  }

  /** Weather where the player stands. Heat waves only bite in daylight. */
  current(biome: BiomeType | undefined, night: boolean): WeatherKind {
    const kind = this.spells.get(biome ?? BiomeType.Forest)!.kind;
    return kind === 'heat' && night ? 'clear' : kind;
  }

  /** Called once per in-game hour. */
  onHour(): void {
    for (const [biome, spell] of this.spells) {
      if (--spell.hoursLeft > 0) continue;
      spell.kind = this.rng.weighted(PATTERNS[biome], ([, w]) => w)![0];
      spell.hoursLeft = spell.kind === 'clear' ? this.rng.int(4, 10) : this.rng.int(2, 6);
    }
  }

  /** Forces a biome's weather, for tests and debugging. */
  set(biome: BiomeType, kind: WeatherKind, hours = 4): void {
    this.spells.set(biome, { kind, hoursLeft: hours });
  }

  save(): WeatherSave {
    return Object.fromEntries([...this.spells].map(([b, s]) => [b, { ...s }]));
  }

  load(s: WeatherSave): void {
    for (const b of BIOME_TYPES) if (s[b]) this.spells.set(b, { ...s[b] });
  }
}
