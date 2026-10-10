// Tile, decoration and biome identifiers shared by the generators, the worker and the renderer.

export const BiomeType = { Forest: 0, Desert: 1, Snow: 2 } as const;
export type BiomeType = (typeof BiomeType)[keyof typeof BiomeType];
export const BIOME_TYPES: readonly BiomeType[] = [BiomeType.Forest, BiomeType.Desert, BiomeType.Snow];

/** Display names indexed by palette (type * 2 + variant). Variant 1 is the rare one. */
export const BIOME_NAMES = ['Forest', 'Autumn Forest', 'Desert', 'Red Desert', 'Snowfield', 'Crystal Tundra'];

export function paletteOf(type: number, variant: number): number {
  return type * 2 + variant;
}

/** Each palette owns four ground tiles: palette * 4 + kind. */
export const Ground = { Base: 0, Alt: 1, Detail: 2, Shore: 3 } as const;
export const PALETTE_COUNT = 6;

export function groundTile(palette: number, kind: number): number {
  return palette * 4 + kind;
}

export const Tile = {
  Water: 24,
  WaterDeep: 25,
  Rock: 26,
  RockDark: 27,
  Path: 28,
  StoneFloor: 29,
  WoodFloor: 30,
  StoneWall: 31,
  WoodWall: 32,
  Rubble: 33,
  Ice: 34,
  TempleFloor: 35,
  DarkFloor: 36,
  Cave: 37,
  /** Old flat-roof buildings, kept so older saves still draw. */
  Roof: 38,
  Facade: 39,
  Door: 40,
  /** Ground under a building sprite: solid, hidden by the building. */
  Building: 41,
  // Interiors.
  InteriorWall: 42,
  WallTop: 43,
  Rug: 44,
  /** Front faces for walls with open ground below them. */
  StoneWallFace: 45,
  WoodWallFace: 46,
  /** Plank bridges over rivers. `BridgeH` runs east–west (its two rows have
   *  the rail on the north and south side); `BridgeV` runs north–south. */
  BridgeH: 47,
  BridgeH2: 48,
  BridgeV: 49,
  BridgeV2: 50,
  // Mines.
  CaveWall: 51,
  MineFloor: 52,
  /** Mine-cart rails running north–south. */
  Rail: 53,
  /** Solid rock deep in a mine, away from the open floor. */
  CaveRoof: 54,
  /** Tilled garden soil in rows. */
  Farmland: 55,
} as const;
export const TILE_COUNT = 56;

/** Water the player can swim in. */
export function isWater(tile: number): boolean {
  return tile === Tile.Water || tile === Tile.WaterDeep;
}

export const Deco = {
  None: 0,
  Oak: 1,
  OakAutumn: 2,
  Pine: 3,
  PineSnow: 4,
  Bush: 5,
  Flowers: 6,
  Mushroom: 7,
  Stone: 8,
  Cactus: 9,
  DeadBush: 10,
  Crystal: 11,
  SnowRock: 12,
  Palm: 13,
  Ore: 14,
  Campfire: 15,
  Chest: 16,
  Barrel: 17,
  Pillar: 18,
  Statue: 19,
  Bones: 20,
  RedRock: 21,
  Banner: 22,
  Well: 23,
  /** Smithing station found in villages and castles. */
  Anvil: 24,
  /** A chest that has been looted. */
  ChestOpen: 25,
  /** X marks the spot: dig for treasure. */
  Treasure: 26,
  /** A fallen star, mined for star metal. */
  Meteorite: 27,
  // Story pieces (The World That Forgets).
  Monument: 28,
  Gravestone: 29,
  Telescope: 30,
  Bookshelf: 31,
  /** Holds a memory the lantern can read. */
  Pedestal: 32,
  LanternRack: 33,
  AnchorCore: 34,
  /** A table with an open book. */
  Book: 35,
  // Furniture, for interiors.
  Bed: 36,
  Table: 37,
  Chair: 38,
  Fireplace: 39,
  PottedPlant: 40,
  Crate: 41,
  Lamp: 42,
  Tent: 43,
  Minecart: 44,
  /** Timber props holding up a mine's roof. */
  SupportBeam: 45,
  /** A glowing spring that rises only at night. */
  Moonwell: 46,
  /** A picket fence section. */
  Fence: 47,
  /** Garden vegetables, picked for food; they regrow. */
  Crop: 48,
  Bench: 49,
  // Castles.
  Throne: 50,
  ArmorStand: 51,
  WeaponRack: 52,
  /** Stairs between a building's floors. */
  StairsUp: 53,
  StairsDown: 54,
  Dummy: 55,
  /** Invisible and solid: the ground under a building sprite, which keeps the
   *  terrain's own tile so nothing shows around the sprite's edges. */
  Footprint: 56,
  /** Layout-only: remove whatever decoration the terrain placed. */
  Clear: 255,
} as const;
export const DECO_COUNT = 57;

const SOLID_TILES = new Set<number>([
  Tile.Water,
  Tile.WaterDeep,
  Tile.Rock,
  Tile.RockDark,
  Tile.StoneWall,
  Tile.WoodWall,
  Tile.Roof,
  Tile.Facade,
  Tile.Building,
  Tile.InteriorWall,
  Tile.WallTop,
  Tile.StoneWallFace,
  Tile.WoodWallFace,
  Tile.CaveWall,
  Tile.CaveRoof,
]);

const SOLID_DECOS = new Set<number>([
  Deco.Oak,
  Deco.OakAutumn,
  Deco.Pine,
  Deco.PineSnow,
  Deco.Stone,
  Deco.Cactus,
  Deco.Crystal,
  Deco.SnowRock,
  Deco.Palm,
  Deco.Ore,
  Deco.Campfire,
  Deco.Chest,
  Deco.Barrel,
  Deco.Pillar,
  Deco.Statue,
  Deco.RedRock,
  Deco.Well,
  Deco.Anvil,
  Deco.ChestOpen,
  Deco.Meteorite,
  Deco.Monument,
  Deco.Gravestone,
  Deco.Telescope,
  Deco.Bookshelf,
  Deco.Pedestal,
  Deco.LanternRack,
  Deco.AnchorCore,
  Deco.Book,
  Deco.Bed,
  Deco.Table,
  Deco.Fireplace,
  Deco.PottedPlant,
  Deco.Crate,
  Deco.Lamp,
  Deco.Tent,
  Deco.Minecart,
  Deco.SupportBeam,
  Deco.Moonwell,
  Deco.Fence,
  Deco.Bench,
  Deco.Throne,
  Deco.ArmorStand,
  Deco.WeaponRack,
  Deco.StairsUp,
  Deco.StairsDown,
  Deco.Dummy,
  Deco.Footprint,
]);

export function isSolid(tile: number, deco: number): boolean {
  return SOLID_TILES.has(tile) || SOLID_DECOS.has(deco);
}
