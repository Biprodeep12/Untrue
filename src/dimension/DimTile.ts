// Tiles of the outer dimensions behind the rifts. Kept apart from the
// overworld's `Tile`, so dimensions never touch the world's ids or saves.

export const DimTile = {
  /** Nothing: walking onto it is a fall. */
  Void: 0,
  Floor: 1,
  Wall: 2,
  /** Seals shut while a chamber holds the player, or until the one before is done. */
  Door: 3,
  /** Flickers in and out on a timer. */
  Glitch: 4,
  /** Falls a moment after it is stepped on, then reforms. */
  Crumble: 5,
  /** Pressure plate with a glyph; pressed in the order the mural shows. */
  Plate: 6,
  /** A standing stone of the mural, showing one glyph of the order. */
  Glyph: 7,
  Pillar: 8,
  /** Light crystal. */
  Crystal: 9,
  /** The way home; wakes once the boss falls. */
  Portal: 10,
  Chest: 11,
  /** The rift the player came in through. */
  Rift: 12,
  /** A safe pad on the hazard path; falls return to the last one touched. */
  Checkpoint: 13,
  /** Floor with a rune inlay (decoration). */
  Rune: 14,
} as const;
export type DimTile = (typeof DimTile)[keyof typeof DimTile];

/** Blocks the player whatever the run's state (doors depend on it). */
const SOLID = new Uint8Array(16);
for (const t of [DimTile.Wall, DimTile.Glyph, DimTile.Pillar, DimTile.Crystal, DimTile.Chest]) SOLID[t] = 1;

export function isSolidDim(t: number): boolean {
  return SOLID[t] === 1;
}

/** No glyph on this tile. */
export const NO_GLYPH = 255;
