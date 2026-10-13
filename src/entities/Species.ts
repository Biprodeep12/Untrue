// Creature species (spec 3.2 and 5): biome-based enemies, wildlife to hunt,
// dungeon guards, the legendary creature and the arena boss.

import { BiomeType } from '../generation/Tiles';
import { Items, type Element, type ItemDef } from '../items/Items';

export type ProjectileKind = 'arrow' | 'web' | 'ice' | 'boulder';

export interface Species {
  id: string;
  name: string;
  /** Biomes it roams; empty for guards and bosses, which spawn by trigger. */
  biomes: readonly BiomeType[];
  spawnWeight: number;
  hp: number;
  damage: number;
  /** Tiles per second. */
  speed: number;
  /** Tiles at which it notices the player. */
  aggroRange: number;
  /** Melee reach in tiles. */
  attackRange: number;
  attackCooldown: number;
  xp: number;
  drops: ReadonlyArray<[ItemDef, number, number, number]>;
  /** Spawns in groups of this size, and alerts its group. */
  pack?: [number, number];
  /** Fires projectiles from this far. */
  ranged?: { kind: ProjectileKind; range: number; speed: number };
  /** Status inflicted on a hit. */
  inflicts?: { kind: 'poison' | 'slow'; seconds: number };
  /** Hides until the player is close. */
  ambush?: boolean;
  /** Runs off below this share of health. */
  fleeBelow?: number;
  /** Only roams at night, and fades at dawn. */
  nightOnly?: boolean;
  /** Floats over water and walls. */
  flying?: boolean;
  /** Drawn with the humanoid sprites, in this outfit. */
  outfit?: string;
  boss?: boolean;
  /** Wildlife: never starts a fight. Skittish animals run from the player
   *  (within `aggroRange`); defensive ones fight back once hurt. */
  passive?: 'skittish' | 'defensive';
  /** Damage types that hurt it half again as much, or only half. */
  weak?: readonly Element[];
  resist?: readonly Element[];
  /** Variants: drawn with another species' sprites (`art`), tinted and sized. */
  art?: string;
  tint?: number;
  size?: number;
}

/** How much of a blow of `element` gets through to a species. */
export function elementFactor(species: Species, element: Element | undefined): number {
  if (!element) return 1;
  if (species.weak?.includes(element)) return 1.5;
  if (species.resist?.includes(element)) return 0.5;
  return 1;
}

const s = (d: Species): Species => d;

export const SPECIES = {
  wolf: s({
    id: 'wolf', name: 'Wolf', biomes: [BiomeType.Forest, BiomeType.Snow], spawnWeight: 4,
    hp: 30, damage: 8, speed: 4.4, aggroRange: 7, attackRange: 1, attackCooldown: 1.1, xp: 12,
    drops: [[Items.rawMeat, 1, 2, 1], [Items.hide, 1, 1, 0.7]], pack: [2, 3], fleeBelow: 0.2, weak: ['venom'],
  }),
  bear: s({
    id: 'bear', name: 'Bear', biomes: [BiomeType.Forest], spawnWeight: 1.5,
    hp: 85, damage: 18, speed: 3.1, aggroRange: 5, attackRange: 1.2, attackCooldown: 1.8, xp: 30,
    drops: [[Items.rawMeat, 2, 3, 1], [Items.hide, 1, 2, 1]], weak: ['venom'],
  }),
  spider: s({
    id: 'spider', name: 'Spider', biomes: [BiomeType.Forest], spawnWeight: 3,
    hp: 22, damage: 6, speed: 3.7, aggroRange: 6.5, attackRange: 0.9, attackCooldown: 2, xp: 10,
    drops: [[Items.silk, 1, 2, 1], [Items.venom, 1, 1, 0.15]],
    ranged: { kind: 'web', range: 5, speed: 7 }, inflicts: { kind: 'slow', seconds: 2.5 }, resist: ['venom'],
  }),
  scorpion: s({
    id: 'scorpion', name: 'Scorpion', biomes: [BiomeType.Desert], spawnWeight: 4,
    hp: 35, damage: 9, speed: 3.4, aggroRange: 6, attackRange: 1, attackCooldown: 1.3, xp: 14,
    drops: [[Items.chitin, 1, 1, 1], [Items.venom, 1, 1, 0.5]], inflicts: { kind: 'poison', seconds: 4 },
    weak: ['frost'], resist: ['venom'],
  }),
  lurker: s({
    id: 'lurker', name: 'Sand Lurker', biomes: [BiomeType.Desert], spawnWeight: 2,
    hp: 45, damage: 14, speed: 3.8, aggroRange: 3.5, attackRange: 1.1, attackCooldown: 1.5, xp: 18,
    drops: [[Items.chitin, 1, 2, 1], [Items.bone, 1, 1, 0.5]], ambush: true, weak: ['frost'],
  }),
  golem: s({
    id: 'golem', name: 'Frost Golem', biomes: [BiomeType.Snow], spawnWeight: 3,
    hp: 60, damage: 12, speed: 2.4, aggroRange: 7, attackRange: 1.1, attackCooldown: 2.2, xp: 22,
    drops: [[Items.iceShard, 1, 2, 1], [Items.crystal, 1, 1, 0.05]],
    ranged: { kind: 'ice', range: 6, speed: 6 }, inflicts: { kind: 'slow', seconds: 2 },
    resist: ['frost', 'venom'],
  }),
  wraith: s({
    id: 'wraith', name: 'Wraith', biomes: [BiomeType.Forest, BiomeType.Desert, BiomeType.Snow], spawnWeight: 3,
    hp: 28, damage: 10, speed: 3.6, aggroRange: 8, attackRange: 1, attackCooldown: 1.4, xp: 18,
    drops: [[Items.spiritEssence, 1, 1, 0.8], [Items.coin, 1, 4, 0.5]], nightOnly: true, flying: true,
    weak: ['spirit'], resist: ['venom'],
  }),
  bandit: s({
    id: 'bandit', name: 'Bandit', biomes: [], spawnWeight: 0,
    hp: 45, damage: 11, speed: 3.9, aggroRange: 10, attackRange: 1.1, attackCooldown: 1.2, xp: 20,
    drops: [[Items.coin, 5, 15, 1], [Items.arrow, 2, 6, 0.4], [Items.bandage, 1, 1, 0.3]], pack: [3, 4], outfit: 'bandit',
  }),
  skeleton: s({
    id: 'skeleton', name: 'Skeleton', biomes: [], spawnWeight: 0,
    hp: 40, damage: 10, speed: 3.2, aggroRange: 9, attackRange: 1.1, attackCooldown: 1.2, xp: 16,
    drops: [[Items.bone, 1, 2, 1], [Items.arrow, 2, 5, 0.4]], weak: ['spirit'], resist: ['venom'],
  }),
  skeletonArcher: s({
    id: 'skeleton-archer', name: 'Skeleton Archer', biomes: [], spawnWeight: 0,
    hp: 30, damage: 8, speed: 2.8, aggroRange: 10, attackRange: 1, attackCooldown: 1.6, xp: 18,
    drops: [[Items.bone, 1, 2, 1], [Items.arrow, 3, 6, 0.7]], weak: ['spirit'], resist: ['venom'],
    ranged: { kind: 'arrow', range: 7, speed: 9 }, art: 'skeleton', tint: 0xd8d0b8,
  }),
  ghoul: s({
    id: 'ghoul', name: 'Ghoul', biomes: [], spawnWeight: 0,
    hp: 70, damage: 15, speed: 3.6, aggroRange: 9, attackRange: 1.1, attackCooldown: 1.3, xp: 28,
    drops: [[Items.bone, 2, 3, 1], [Items.spiritEssence, 1, 1, 0.4]], weak: ['spirit'], resist: ['venom'],
    inflicts: { kind: 'poison', seconds: 3 }, art: 'skeleton', tint: 0x9ad08a, size: 1.15,
  }),
  stag: s({
    id: 'stag', name: 'Elder Stag', biomes: [], spawnWeight: 0,
    hp: 420, damage: 24, speed: 4.6, aggroRange: 8, attackRange: 1.6, attackCooldown: 1.6, xp: 300,
    drops: [[Items.hide, 3, 5, 1], [Items.gem, 1, 1, 1], [Items.crystal, 1, 2, 1], [Items.schematic, 1, 1, 1]], boss: true, weak: ['venom'],
  }),
  guardian: s({
    id: 'guardian', name: 'Arena Guardian', biomes: [], spawnWeight: 0,
    hp: 900, damage: 30, speed: 2.6, aggroRange: 14, attackRange: 1.8, attackCooldown: 1.4, xp: 600,
    drops: [[Items.idol, 1, 1, 1], [Items.ironIngot, 3, 6, 1], [Items.schematic, 1, 2, 1]],
    ranged: { kind: 'boulder', range: 8, speed: 6 }, boss: true,
  }),
  // Wildlife ---------------------------------------------------------------
  rabbit: s({
    id: 'rabbit', name: 'Rabbit', biomes: [BiomeType.Forest], spawnWeight: 4,
    hp: 8, damage: 0, speed: 5, aggroRange: 4, attackRange: 0, attackCooldown: 1, xp: 3,
    drops: [[Items.rawMeat, 1, 1, 1]], passive: 'skittish',
  }),
  deer: s({
    id: 'deer', name: 'Deer', biomes: [BiomeType.Forest], spawnWeight: 3,
    hp: 24, damage: 0, speed: 5.2, aggroRange: 6, attackRange: 0, attackCooldown: 1, xp: 7,
    drops: [[Items.rawMeat, 1, 2, 1], [Items.hide, 1, 1, 0.8]], pack: [2, 3], passive: 'skittish',
  }),
  boar: s({
    id: 'boar', name: 'Boar', biomes: [BiomeType.Forest], spawnWeight: 2,
    hp: 38, damage: 7, speed: 3.8, aggroRange: 6, attackRange: 1, attackCooldown: 1.4, xp: 10,
    drops: [[Items.rawMeat, 2, 3, 1], [Items.hide, 1, 1, 0.6]], passive: 'defensive',
  }),
  lizard: s({
    id: 'lizard', name: 'Sand Lizard', biomes: [BiomeType.Desert], spawnWeight: 4,
    hp: 10, damage: 0, speed: 5.4, aggroRange: 3.5, attackRange: 0, attackCooldown: 1, xp: 3,
    drops: [[Items.rawMeat, 1, 1, 1], [Items.chitin, 1, 1, 0.3]], passive: 'skittish',
  }),
  hare: s({
    id: 'hare', name: 'Snow Hare', biomes: [BiomeType.Snow], spawnWeight: 4,
    hp: 8, damage: 0, speed: 5, aggroRange: 4, attackRange: 0, attackCooldown: 1, xp: 3,
    drops: [[Items.rawMeat, 1, 1, 1], [Items.hide, 1, 1, 0.3]], passive: 'skittish',
  }),
  goat: s({
    id: 'goat', name: 'Mountain Goat', biomes: [BiomeType.Snow, BiomeType.Desert], spawnWeight: 2,
    hp: 30, damage: 6, speed: 4, aggroRange: 5, attackRange: 1, attackCooldown: 1.3, xp: 9,
    drops: [[Items.rawMeat, 1, 2, 1], [Items.hide, 1, 2, 0.8]], pack: [1, 3], passive: 'defensive',
  }),
  // Legends of the far lands: rare bosses, one kind per land ---------------
  alphaWolf: s({
    id: 'alpha-wolf', name: 'Alpha Wolf', biomes: [], spawnWeight: 0,
    hp: 380, damage: 22, speed: 4.8, aggroRange: 9, attackRange: 1.4, attackCooldown: 1.2, xp: 280,
    drops: [[Items.hide, 3, 5, 1], [Items.gem, 1, 1, 1], [Items.starMetal, 1, 1, 1], [Items.schematic, 1, 1, 1]], boss: true,
    weak: ['venom'], art: 'wolf', tint: 0x8a96b0, size: 1.6,
  }),
  duneTyrant: s({
    id: 'dune-tyrant', name: 'Dune Tyrant', biomes: [], spawnWeight: 0,
    hp: 520, damage: 26, speed: 3.2, aggroRange: 8, attackRange: 1.6, attackCooldown: 1.7, xp: 360,
    drops: [[Items.chitin, 4, 6, 1], [Items.venom, 2, 3, 1], [Items.gem, 1, 1, 1], [Items.starMetal, 1, 2, 1], [Items.schematic, 1, 1, 1]],
    inflicts: { kind: 'poison', seconds: 6 }, boss: true, weak: ['frost'], resist: ['venom'], art: 'scorpion', tint: 0x7a3024, size: 1.9,
  }),
  ancientGolem: s({
    id: 'ancient-golem', name: 'Ancient Golem', biomes: [], spawnWeight: 0,
    hp: 620, damage: 28, speed: 2.2, aggroRange: 10, attackRange: 1.5, attackCooldown: 2, xp: 400,
    drops: [[Items.crystal, 2, 3, 1], [Items.iceShard, 3, 5, 1], [Items.starMetal, 2, 2, 1], [Items.schematic, 1, 1, 1]],
    ranged: { kind: 'boulder', range: 7, speed: 6 }, boss: true, resist: ['frost', 'venom'], art: 'golem', tint: 0x9a9ab8, size: 1.7,
  }),
  // Variants: more to meet in each land, drawn from existing sprites -------
  frostWolf: s({
    id: 'frost-wolf', name: 'Frost Wolf', biomes: [BiomeType.Snow], spawnWeight: 3,
    hp: 42, damage: 10, speed: 4.5, aggroRange: 7.5, attackRange: 1, attackCooldown: 1.1, xp: 16,
    drops: [[Items.rawMeat, 1, 2, 1], [Items.hide, 1, 2, 0.8], [Items.iceShard, 1, 1, 0.3]], pack: [2, 4], fleeBelow: 0.15,
    weak: ['venom'], resist: ['frost'], art: 'wolf', tint: 0xd0e4ff,
  }),
  tundraBear: s({
    id: 'tundra-bear', name: 'Tundra Bear', biomes: [BiomeType.Snow], spawnWeight: 1.2,
    hp: 120, damage: 22, speed: 3, aggroRange: 5, attackRange: 1.3, attackCooldown: 1.9, xp: 40,
    drops: [[Items.rawMeat, 2, 4, 1], [Items.hide, 2, 3, 1]], weak: ['venom'], resist: ['frost'],
    art: 'bear', tint: 0xc4c6d4, size: 1.15,
  }),
  jackal: s({
    id: 'jackal', name: 'Jackal', biomes: [BiomeType.Desert], spawnWeight: 3,
    hp: 26, damage: 7, speed: 4.8, aggroRange: 7, attackRange: 1, attackCooldown: 1, xp: 11,
    drops: [[Items.rawMeat, 1, 1, 1], [Items.hide, 1, 1, 0.5], [Items.bone, 1, 1, 0.3]], pack: [2, 4], fleeBelow: 0.25,
    weak: ['venom', 'frost'], art: 'wolf', tint: 0xe8c080, size: 0.85,
  }),
  emperorScorpion: s({
    id: 'emperor-scorpion', name: 'Emperor Scorpion', biomes: [BiomeType.Desert], spawnWeight: 0.8,
    hp: 110, damage: 18, speed: 3, aggroRange: 6, attackRange: 1.2, attackCooldown: 1.6, xp: 38,
    drops: [[Items.chitin, 2, 3, 1], [Items.venom, 1, 2, 1], [Items.gem, 1, 1, 0.05]], inflicts: { kind: 'poison', seconds: 6 },
    weak: ['frost'], resist: ['venom'], art: 'scorpion', tint: 0xb04a3a, size: 1.4,
  }),
  thornSpider: s({
    id: 'thorn-spider', name: 'Thorn Spider', biomes: [BiomeType.Forest], spawnWeight: 1,
    hp: 48, damage: 11, speed: 3.9, aggroRange: 7, attackRange: 1, attackCooldown: 1.6, xp: 20,
    drops: [[Items.silk, 2, 3, 1], [Items.venom, 1, 1, 0.6]], inflicts: { kind: 'poison', seconds: 4 },
    ranged: { kind: 'web', range: 5, speed: 7 }, resist: ['venom'], weak: ['frost'], art: 'spider', tint: 0x8ac860, size: 1.25,
  }),
} as const;

export const SPECIES_LIST: readonly Species[] = Object.values(SPECIES);
