// Site tiles of an outer dimension: the parts of its challenges that change as
// they are played (gates, crumbling and glitching slabs, plates, mural stones,
// a tide hall's flooding floor and valves, the portal and the vault's chest). They lie over the dimension's land, which
// is ordinary world tiles (`Tile`); everywhere else the land alone decides.

export const DimTile = {
  /** No site tile: the land decides. */
  None: 0,
  /** A site's gate: sealed while its site holds the player, or until the site may be entered. */
  Gate: 1,
  /** Flickers in and out on a timer. */
  Glitch: 2,
  /** Falls a moment after it is stepped on, then reforms. */
  Crumble: 3,
  /** Pressure plate with a glyph; pressed in the order the mural shows. */
  Plate: 4,
  /** A standing stone of the mural, showing one glyph of the order. */
  Glyph: 5,
  /** The way home; wakes once the boss falls. */
  Portal: 6,
  Chest: 7,
  /** Floor a tide hall's water covers while it stands high enough (its depth
   *  is in the layout's `phase`); flooded, nothing can walk it. */
  Flood: 8,
  /** A sluice valve in the floor: stepped on in turn, it lowers the water a stage. */
  Valve: 9,
} as const;
export type DimTile = (typeof DimTile)[keyof typeof DimTile];
export const DIM_TILE_COUNT = 10;

/** Blocks the player whatever the run's state (gates depend on it). */
const SOLID = new Uint8Array(DIM_TILE_COUNT);
for (const t of [DimTile.Glyph, DimTile.Chest]) SOLID[t] = 1;

export function isSolidDim(t: number): boolean {
  return SOLID[t] === 1;
}

/** No glyph on this tile. */
export const NO_GLYPH = 255;
