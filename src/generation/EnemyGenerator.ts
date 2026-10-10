// Enemy spawn rules (spec 5): biome-based species, pack sizes, elites, and
// population that rises with distance from the origin.

import type { Rng } from './Random';
import type { BiomeType } from './Tiles';
import { SPECIES_LIST, type Species } from '../entities/Species';

/** No wild enemies within this many tiles of the origin: the safe zone. */
export const SAFE_RADIUS = 64;
/** Chance per chunk, per region visit, of a legendary creature (spec 3.6). */
export const LEGEND_CHANCE = 0.0005;
/** Wild enemies are never placed closer to the player than this, in tiles. */
export const MIN_SPAWN_DISTANCE = 12;

/** Wild enemies kept alive around the player in a difficulty band; more at night. */
export function populationCap(band: number, night = false): number {
  return Math.round((3 + band * 2) * (night ? 1.5 : 1));
}

export function eliteChance(band: number): number {
  return 0.04 + 0.03 * band;
}

/** A wild enemy for a biome, or with `wildlife` an animal. */
export function pickSpecies(rng: Rng, biome: BiomeType, night = false, wildlife = false): Species | undefined {
  return rng.weighted(
    SPECIES_LIST.filter((s) => s.biomes.includes(biome) && (night || !s.nightOnly) && !!s.passive === wildlife),
    (s) => s.spawnWeight,
  );
}

export function groupSize(rng: Rng, s: Species): number {
  return s.pack ? rng.int(s.pack[0], s.pack[1]) : 1;
}
