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
  /** Scorched, violet-veined ground around a rift. */
  RiftGround: 56,
  // The outer dimensions (The Hollow). Never generated in the overworld.
  /** Violet moss, the Hollow's ground. */
  HollowMoss: 57,
  HollowMossDark: 58,
  /** Grey ash with embers. */
  Ash: 59,
  /** Pale shard sand along the void's edge. */
  ShardSand: 60,
  /** Nothing: open to walk onto, and walking onto it is a fall. */
  Void: 61,
  /** The void just below land: the land's cliff face hanging into it. A fall too. */
  VoidCliff: 62,
  /** Old flagstones of the ruins and their causeways. */
  RuinFloor: 63,
  RuinWall: 64,
  RuinWallFace: 65,
  /** A safe pad on a crumbling path: falls return to the last one touched. */
  RunePad: 66,
  /** Flagstones with a rune inlay. */
  Rune: 67,
  /** Moss with a small, perfectly round absence in it: where the Null has touched. */
  NullMark: 68,
  // The Drowned Archive.
  /** Pale, cold marble of the archive's halls. */
  ArchiveFloor: 69,
  /** The same marble, wet, with standing puddles. */
  ArchiveWet: 70,
  /** A worn reading-room carpet. */
  ArchiveCarpet: 71,
  /** Shelves stacked to the ceiling: the archive's walls. */
  BookWall: 72,
  BookWallFace: 73,
  /** Black, still ink-water: too deep to wade. */
  InkWater: 74,
  /** Ankle-deep water over the floor: wadeable. */
  Shallows: 75,
} as const;
export const TILE_COUNT = 76;

/** Nothing to stand on: the void of an outer dimension. */
export function isVoid(tile: number): boolean {
  return tile === Tile.Void || tile === Tile.VoidCliff;
}

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
  // Unused since the old story was removed, except the bookshelf. The ids stay
  // so saved layouts and the atlas keep their numbers.
  Monument: 28,
  Gravestone: 29,
  Telescope: 30,
  Bookshelf: 31,
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
  /** A tear in the air onto an outer dimension; E enters it. */
  Rift: 57,
  /** Where a rift was closed: a faint scar on the ground. */
  RiftScar: 58,
  // The outer dimensions (The Hollow).
  /** A twisted tree with glowing leaves; chopped for wood. */
  HollowTree: 59,
  /** A bare, ash-grey tree. */
  AshTree: 60,
  /** Glowing shard grass; picked for herbs. */
  ShardGrass: 61,
  /** Glowing mushrooms; picked. */
  GlowCap: 62,
  /** A cyan crystal cluster; mined like a crystal. */
  RiftCrystal: 63,
  /** A ruined pillar with a crystal band. */
  RuinPillar: 64,
  /** A standing stone carved with a clue to what is happening; E reads it. */
  LoreStone: 65,
  /** A lost piece of something, glowing faintly: what an outer world's plot
   *  asks the player to find; E takes it. */
  Relic: 66,
  /** A bell frame with no bell in it. */
  BellFrame: 67,
  /** A drift of sodden books. */
  BookPile: 68,
  /** A reading lectern with a book chained to it. */
  Lectern: 69,
  /** Layout-only: remove whatever decoration the terrain placed. */
  Clear: 255,
} as const;
export const DECO_COUNT = 70;

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
  Tile.RuinWall,
  Tile.RuinWallFace,
  Tile.BookWall,
  Tile.BookWallFace,
  Tile.InkWater,
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
  Deco.Rift,
  Deco.HollowTree,
  Deco.AshTree,
  Deco.RiftCrystal,
  Deco.RuinPillar,
  Deco.LoreStone,
  Deco.Relic,
  Deco.BellFrame,
  Deco.Lectern,
]);

export function isSolid(tile: number, deco: number): boolean {
  return SOLID_TILES.has(tile) || SOLID_DECOS.has(deco);
}
