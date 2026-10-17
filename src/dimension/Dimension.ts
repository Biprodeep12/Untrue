// Outer dimensions behind the rifts: what a dimension is, and the registry the
// game picks from. Each one generates a finite space from the rift's seed and
// lists the creatures, challenges and rewards met inside. Only The Hollow
// exists so far.

import type { Species } from '../entities/Species';
import { hash } from '../generation/Random';
import { HOLLOW } from './Hollow';

export interface Point {
  x: number;
  y: number;
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export type ChamberKind = 'arrival' | 'combat' | 'hazard' | 'puzzle' | 'boss' | 'vault';

/** One room of the chain. Positions are in tiles; feet positions are centred
 *  on a tile, near its bottom (as enemies are placed in the world). */
export interface Chamber {
  kind: ChamberKind;
  /** Outer rectangle, walls included. */
  rect: Rect;
  /** Feet position in the corridor just outside the door in; the arrival's
   *  own spawn for the first chamber. */
  entry: Point;
  /** Where enemies appear (feet). */
  spawns: Point[];
  /** Hazard: safe pads (feet); the first is the ledge by the door in. */
  checkpoints: Point[];
  /** Hazard: tile indices of the path, crumbling and glitching tiles in walking order. */
  path: number[];
  /** Hazard: the far ledge; standing on it finishes the path. */
  goal: Rect | null;
  /** Puzzle: tile index of the plate for each glyph. */
  plates: number[];
  /** Puzzle: the glyphs in the order they must be pressed. */
  order: number[];
  /** Puzzle: tile indices of the mural stones, in reading order (stone k shows `order[k]`). */
  mural: number[];
  /** The middle of the floor (feet): the boss's spot. */
  center: Point;
}

/** A generated dimension. Grids are row-major, `y * w + x`. */
export interface DimensionLayout {
  w: number;
  h: number;
  tiles: Uint8Array;
  /** Glyph per tile for plates and mural stones; `NO_GLYPH` elsewhere. */
  glyphs: Uint8Array;
  /** Glitch tiles: phase offset, 0–255 of one cycle; tiles in a run share it. */
  phase: Uint8Array;
  /** Chambers in the order they are met; the first is the arrival. */
  chambers: Chamber[];
  /** `doors[k]` (tile indices) leads into chamber `k + 1`. */
  doors: number[][];
  /** Where the player stands on arrival (feet). */
  arrival: Point;
  rift: number;
  portal: number;
  chest: number;
}

/** Enemies of one wave: species and how many. */
export type WaveSpec = ReadonlyArray<readonly [Species, number]>;

export interface BossPhase {
  /** Starts once the boss's health share drops to this. */
  below: number;
  /** Summoned when the phase starts. */
  adds: WaveSpec;
  /** Suggested multipliers for the boss's attack cooldown and speed. */
  cooldownScale: number;
  speedScale: number;
  text: string;
}

export interface RewardSpec {
  /** Item id, e.g. 'rift-shard'. */
  item: string;
  min: number;
  max: number;
  chance: number;
}

export interface HazardTuning {
  /** Seconds from stepping on a crumbling tile to its fall. */
  crumbleDelay: number;
  /** Seconds a fallen tile stays gone. */
  reform: number;
  /** Glitch cycle: seconds there, then gone; it flickers for `glitchWarn` before going. */
  glitchOn: number;
  glitchOff: number;
  glitchWarn: number;
  /** Health lost by a fall. */
  fallDamage: number;
}

export interface DimensionDef {
  id: string;
  name: string;
  /** Hints for the integrator: lighting darkness (0–1) and tint, music mood,
   *  and the palette the art uses. */
  mood: { darkness: number; tint: number; music: string; palette: readonly number[] };
  size: { w: number; h: number };
  generate(seed: number): DimensionLayout;
  /** Every species met inside. */
  roster: readonly Species[];
  waves: readonly WaveSpec[];
  boss: { species: Species; phases: readonly BossPhase[]; addCap: number };
  hazard: HazardTuning;
  rewards: readonly RewardSpec[];
}

export const DIMENSIONS: readonly DimensionDef[] = [HOLLOW];

export function dimensionById(id: string): DimensionDef | undefined {
  return DIMENSIONS.find((d) => d.id === id);
}

/** The dimension behind a rift, from its seed. */
export function pickDimension(seed: number): DimensionDef {
  return DIMENSIONS[hash(seed, 0xd1) % DIMENSIONS.length];
}
