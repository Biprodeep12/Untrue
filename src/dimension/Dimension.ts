// Outer dimensions behind the rifts: what a dimension is, and the registry of
// how each one plays. A dimension is an open world with a fixed map: its land,
// sites, clues and creatures come as data (`DimensionData`, from a
// `DimensionSource`), while the registry here holds what is code: its
// creatures' waves, its boss and its phases, the hazards' tuning and the
// rewards. The registry's order is the story's: The Hollow, then The Drowned
// Archive.

import type { Species } from '../entities/Species';
import { Rng } from '../generation/Random';
import { ARCHIVE } from './Archive';
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

/** The challenges a dimension's sites hold; the vault holds the way home. */
export type SiteKind = 'combat' | 'hazard' | 'puzzle' | 'boss' | 'vault' | 'tide';

/** One landmark of a dimension's map. Positions are in tiles; feet positions
 *  are centred on a tile, near its bottom (as enemies are placed in the world). */
export interface Site {
  kind: SiteKind;
  name: string;
  /** Its area. For walled sites the walls are its edge; for the hazard, the
   *  chasm with a tile of the ledges around it. */
  rect: Rect;
  /** Feet just outside its way in (the playground's skip lands here). */
  entry: Point;
  /** Tile indices of its gate, sealed and opened by its challenge. */
  gates: number[];
  /** Where enemies appear (feet). */
  spawns: Point[];
  /** Hazard: safe pads (feet); the first is the ledge by the way in. */
  checkpoints: Point[];
  /** Hazard: tile indices of the path, crumbling and glitching tiles in walking order. */
  path: number[];
  /** Hazard: the far side; standing on it finishes the path. */
  goal: Rect | null;
  /** Puzzle: tile index of the plate for each glyph (-1 for glyphs not used). */
  plates: number[];
  /** Puzzle: the glyphs in the order they must be pressed. */
  order: number[];
  /** Puzzle: tile indices of the mural stones, in reading order (stone k shows `order[k]`). */
  mural: number[];
  /** Puzzle: how the order is given: the mural lights it up, or it is written
   *  down somewhere nearby (a lore stone) and the mural only shows what is done. */
  hint: 'mural' | 'text';
  /** Tide: tile indices of the sluice valves, in the order they lower the
   *  water. Each but the first stands in the band before it, and its depth
   *  (in the layout's `phase`) is that band's. */
  valves: number[];
  /** Tide: tile indices of the floor the water covers; each tile's depth is in
   *  the layout's `phase` (1 to the number of valves). */
  flood: number[];
  /** The middle of the floor (feet): the boss's spot. */
  center: Point;
}

/** A clue to the main story, carved on a lore stone. */
export interface Clue {
  /** Unique within its dimension. */
  id: string;
  /** The stone's tile. */
  x: number;
  y: number;
  title: string;
  pages: string[];
}

/** A piece the plot sends the player after. */
export interface PlotRelic {
  /** Unique within its dimension. */
  id: string;
  /** Its tile (a `Deco.Relic` stands on it). */
  x: number;
  y: number;
  name: string;
}

/** A short vision: a title and its pages. */
export interface PlotVision {
  title: string;
  pages: string[];
}

/** An outer world's own story: someone who lives there, what they have lost,
 *  and what it means. Progress is each player's own (`RiftStory`). */
export interface Plot {
  /** Who keeps the place, standing at their tile with this look (an outfit). */
  resident: { name: string; x: number; y: number; look: string };
  /** What the relics make whole once brought back, e.g. "the hamlet's bell". */
  goal: string;
  relics: PlotRelic[];
  /** The resident's words: on first meeting, while the relics are out there
   *  (`{found}` and `{of}` are filled in), when all are found, after the
   *  restoring, and once the world's rift has been closed. */
  talk: { first: string[]; waiting: string; ready: string[]; after: string; cleared: string };
  /** Shown when the relics are brought back and the goal is made whole. */
  restored: PlotVision;
  /** Shown the first time a rift from this world is closed. */
  closing: PlotVision;
  /** What restoring is worth. */
  reward: { xp: number; items: Array<{ item: string; count: number }> };
}

/** Where creatures roam, at most `cap` at once. */
export interface SpawnZone {
  rect: Rect;
  species: Species[];
  cap: number;
}

/** A dimension's map, decoded and checked. Grids are row-major, `y * w + x`. */
export interface DimensionLayout {
  id: string;
  name: string;
  w: number;
  h: number;
  mood: { darkness: number; tint: number; music: string };
  /** The land: world tiles and decorations as the map has them (read only). */
  ground: Uint8Array;
  decos: Uint8Array;
  /** Site tiles (`DimTile`) over the land; `None` elsewhere. */
  tiles: Uint8Array;
  /** Glyph per tile for plates and mural stones; `NO_GLYPH` elsewhere. */
  glyphs: Uint8Array;
  /** Glitch tiles: phase offset, 0–255 of one cycle; tiles in a run share it. */
  phase: Uint8Array;
  sites: Site[];
  clues: Clue[];
  zones: SpawnZone[];
  /** Region names, and the region of each chunk (row-major, `w / 32` wide). */
  regions: string[];
  regionOf: Uint8Array;
  /** The world's own story, if it has one. */
  plot: Plot | null;
  /** Where the player stands on arrival (feet), below the rift home. */
  arrival: Point;
  /** Tile indices of the rift home, the portal and the vault's chest. */
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
  /** Health lost when the ground goes from under the player (a slab gives
   *  way, the water comes in) and they scramble back to the last safe spot.
   *  Nobody falls into the void: it is a wall. */
  slipDamage: number;
  /** Tide halls: seconds the water stays down after a valve is turned before
   *  it rises a stage again, and the warning before it does. */
  tideHold: number;
  tideWarn: number;
}

/** How a dimension plays; its map comes as data with the same id. */
export interface DimensionDef {
  id: string;
  name: string;
  /** Every species met inside: spawn zones may name only these. */
  roster: readonly Species[];
  waves: readonly WaveSpec[];
  boss: { species: Species; phases: readonly BossPhase[]; addCap: number };
  hazard: HazardTuning;
  rewards: readonly RewardSpec[];
  /** Experience for closing a rift from here, shared out by contribution. */
  closeXp: number;
}

/** Every dimension, in story order. */
export const DIMENSIONS: readonly DimensionDef[] = [HOLLOW, ARCHIVE];

export function dimensionById(id: string): DimensionDef | undefined {
  return DIMENSIONS.find((d) => d.id === id);
}

/** How much likelier a rift opens onto the next dimension in the story than
 *  onto any one already cleared. */
const NEXT_WEIGHT = 6;
const NONE: ReadonlySet<string> = new Set();

/** The dimension a rift opens onto, rolled from its seed. The registry's
 *  order is the story's: rifts lean toward the first dimension the player has
 *  not cleared, sometimes open onto one already cleared, and never skip ahead
 *  (dimensions after the next wait their turn). Once all are cleared, any. */
export function dimensionForRift(seed: number, cleared: ReadonlySet<string> = NONE, registry: ReadonlyArray<{ id: string }> = DIMENSIONS): string {
  const next = registry.findIndex((d) => !cleared.has(d.id));
  const weight = (i: number) => (next < 0 || cleared.has(registry[i].id) ? 1 : i === next ? NEXT_WEIGHT : 0);
  let total = 0;
  for (let i = 0; i < registry.length; i++) total += weight(i);
  let roll = new Rng(seed).next() * total;
  for (let i = 0; i < registry.length; i++) {
    roll -= weight(i);
    if (roll < 0) return registry[i].id;
  }
  return registry[0].id;
}

/** Where a rift can be tuned to: where it opens first, then every dimension
 *  cleared, in story order. One choice means no choosing. */
export function retuneChoices(own: string, cleared: ReadonlySet<string>, registry: ReadonlyArray<{ id: string }> = DIMENSIONS): string[] {
  const out = [own];
  for (const d of registry) if (d.id !== own && cleared.has(d.id)) out.push(d.id);
  return out;
}
