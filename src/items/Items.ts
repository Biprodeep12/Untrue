// Item catalogue (spec 5): resources, food, medicine, tools, weapons, armor
// and treasure.

export const ItemRarity = { Common: 0, Uncommon: 1, Rare: 2, Epic: 3, Legendary: 4 } as const;
export type ItemRarity = (typeof ItemRarity)[keyof typeof ItemRarity];
export const RARITY_NAMES = ['Common', 'Uncommon', 'Rare', 'Epic', 'Legendary'];

export type ToolKind = 'axe' | 'pickaxe';

/** Where a piece of equipment goes. */
export type EquipSlot = 'head' | 'chest' | 'legs' | 'feet' | 'offhand';
export const EQUIP_SLOTS: readonly EquipSlot[] = ['head', 'chest', 'legs', 'feet', 'offhand'];
/** Armour sets drawn on the player: 0 leather, 1 iron, 2 starforged. */
export const ARMOR_SETS = 3;

/** Damage types beyond plain blows. Some creatures take more from one
 *  (weak) or less (resist); see Species. */
export type Element = 'frost' | 'venom' | 'spirit';
export const ELEMENT_NAMES: Record<Element, string> = { frost: 'Frost', venom: 'Venom', spirit: 'Spirit' };

export interface WeaponStats {
  kind: 'melee' | 'bow';
  damage: number;
  /** Uses before it breaks. */
  durability: number;
  /** Melee reach, or arrow range, in tiles. */
  reach: number;
  /** Seconds between attacks. */
  cooldown: number;
  /** Its damage type, if not plain. */
  element?: Element;
}

export interface ItemDef {
  id: string;
  name: string;
  description: string;
  rarity: ItemRarity;
  /** Atlas icon index. */
  icon: number;
  stack: number;
  /** Restored when consumed. */
  food?: { hunger?: number; thirst?: number; health?: number };
  /** Status effect removed when consumed. */
  cures?: 'poison';
  tool?: { kind: ToolKind; tier: number };
  weapon?: WeaponStats;
  /** Share of incoming damage absorbed while carried. */
  armor?: number;
  /** Light radius in tiles while carried at night. */
  light?: number;
  /** Carry weight of one; see `weightOf` for the defaults. */
  weight?: number;
  /** The equipment slot it is worn or held in. */
  equip?: EquipSlot;
  /** Which armour set it is drawn as on the player (see ARMOR_SETS). */
  look?: number;
  /** A shield: share of damage that gets through a block, and its stamina cost. */
  shield?: { pass: number; stamina: number };
}

const list: ItemDef[] = [];
const item = (d: Omit<ItemDef, 'icon' | 'stack'> & { stack?: number }): ItemDef => {
  const def = { stack: 99, ...d, icon: list.length };
  list.push(def);
  return def;
};

export const Items = {
  wood: item({ id: 'wood', name: 'Wood', description: 'Sturdy timber from a tree.', rarity: ItemRarity.Common, weight: 0.5 }),
  stone: item({ id: 'stone', name: 'Stone', description: 'A rough chunk of rock.', rarity: ItemRarity.Common, weight: 0.8 }),
  coal: item({ id: 'coal', name: 'Coal', description: 'Burns hot. Used for smelting.', rarity: ItemRarity.Common, weight: 0.6 }),
  ironOre: item({ id: 'iron-ore', name: 'Iron Ore', description: 'Smelt it into ingots at an anvil.', rarity: ItemRarity.Uncommon, weight: 1 }),
  goldOre: item({ id: 'gold-ore', name: 'Gold Ore', description: 'Glitters. Valuable.', rarity: ItemRarity.Rare, weight: 1 }),
  crystal: item({ id: 'crystal', name: 'Crystal', description: 'A rare mineral that hums faintly.', rarity: ItemRarity.Epic }),
  herb: item({ id: 'herb', name: 'Herb', description: 'A fragrant wild herb.', rarity: ItemRarity.Common, weight: 0.1 }),
  berries: item({ id: 'berries', name: 'Berries', description: 'Sweet and juicy.', rarity: ItemRarity.Common, food: { hunger: 12, thirst: 4 } }),
  mushroom: item({ id: 'mushroom', name: 'Mushroom', description: 'Edible, if a little bland raw.', rarity: ItemRarity.Common, food: { hunger: 10 } }),
  cactusFruit: item({ id: 'cactus-fruit', name: 'Cactus Fruit', description: 'Full of water.', rarity: ItemRarity.Common, food: { hunger: 6, thirst: 20 } }),
  roastMushroom: item({ id: 'roast-mushroom', name: 'Roast Mushroom', description: 'Cooked over a campfire.', rarity: ItemRarity.Uncommon, food: { hunger: 28 } }),
  stew: item({ id: 'stew', name: 'Forest Stew', description: 'Hearty and warming.', rarity: ItemRarity.Uncommon, food: { hunger: 45, thirst: 15 } }),
  bandage: item({ id: 'bandage', name: 'Herbal Bandage', description: 'Restores a little health.', rarity: ItemRarity.Uncommon, food: { health: 25 } }),
  potion: item({ id: 'potion', name: 'Health Potion', description: 'Restores a lot of health.', rarity: ItemRarity.Rare, food: { health: 60 } }),
  ironIngot: item({ id: 'iron-ingot', name: 'Iron Ingot', description: 'Worked metal for better tools.', rarity: ItemRarity.Uncommon, weight: 1 }),
  stoneAxe: item({ id: 'stone-axe', name: 'Stone Axe', description: 'Chops trees faster.', rarity: ItemRarity.Common, stack: 1, tool: { kind: 'axe', tier: 1 } }),
  stonePickaxe: item({ id: 'stone-pickaxe', name: 'Stone Pickaxe', description: 'Breaks rock and mines iron and coal.', rarity: ItemRarity.Common, stack: 1, tool: { kind: 'pickaxe', tier: 1 } }),
  ironAxe: item({ id: 'iron-axe', name: 'Iron Axe', description: 'Fells trees in a few swings.', rarity: ItemRarity.Uncommon, stack: 1, tool: { kind: 'axe', tier: 2 } }),
  ironPickaxe: item({ id: 'iron-pickaxe', name: 'Iron Pickaxe', description: 'Mines gold and crystal.', rarity: ItemRarity.Rare, stack: 1, tool: { kind: 'pickaxe', tier: 2 } }),
  gem: item({ id: 'gem', name: 'Gemstone', description: 'Treasure. Worth a fortune to the right trader.', rarity: ItemRarity.Epic }),
  idol: item({ id: 'idol', name: 'Golden Idol', description: 'Legendary treasure from a forgotten age.', rarity: ItemRarity.Legendary, weight: 2 }),
  woodenSword: item({ id: 'wooden-sword', name: 'Wooden Sword', description: 'Better than bare fists.', rarity: ItemRarity.Common, stack: 1, weapon: { kind: 'melee', damage: 9, durability: 60, reach: 1.4, cooldown: 0.45 } }),
  ironSword: item({ id: 'iron-sword', name: 'Iron Sword', description: 'A keen, balanced blade.', rarity: ItemRarity.Rare, stack: 1, weapon: { kind: 'melee', damage: 20, durability: 220, reach: 1.6, cooldown: 0.4 } }),
  bow: item({ id: 'bow', name: 'Hunting Bow', description: 'Fires arrows. Keep some in your bag.', rarity: ItemRarity.Uncommon, stack: 1, weapon: { kind: 'bow', damage: 12, durability: 140, reach: 9, cooldown: 0.65 } }),
  arrow: item({ id: 'arrow', name: 'Arrow', description: 'Ammunition for a bow.', rarity: ItemRarity.Common, weight: 0.1 }),
  leatherArmor: item({ id: 'leather-armor', name: 'Leather Tunic', description: 'A stitched hide tunic. Wear it on your chest.', rarity: ItemRarity.Uncommon, stack: 1, armor: 0.08, equip: 'chest', look: 0, weight: 2 }),
  ironArmor: item({ id: 'iron-armor', name: 'Iron Chestplate', description: 'Heavy plate for the chest.', rarity: ItemRarity.Epic, stack: 1, armor: 0.16, equip: 'chest', look: 1, weight: 10 }),
  leatherCap: item({ id: 'leather-cap', name: 'Leather Cap', description: 'A snug hide cap.', rarity: ItemRarity.Common, stack: 1, armor: 0.04, equip: 'head', look: 0, weight: 1 }),
  leatherPants: item({ id: 'leather-pants', name: 'Leather Trousers', description: 'Tough hide trousers.', rarity: ItemRarity.Uncommon, stack: 1, armor: 0.05, equip: 'legs', look: 0, weight: 2 }),
  leatherBoots: item({ id: 'leather-boots', name: 'Leather Boots', description: 'Good for long roads.', rarity: ItemRarity.Common, stack: 1, armor: 0.03, equip: 'feet', look: 0, weight: 1 }),
  ironHelmet: item({ id: 'iron-helmet', name: 'Iron Helmet', description: 'A visored helm.', rarity: ItemRarity.Rare, stack: 1, armor: 0.08, equip: 'head', look: 1, weight: 4 }),
  ironGreaves: item({ id: 'iron-greaves', name: 'Iron Greaves', description: 'Plate for the legs.', rarity: ItemRarity.Rare, stack: 1, armor: 0.1, equip: 'legs', look: 1, weight: 6 }),
  ironBoots: item({ id: 'iron-boots', name: 'Iron Boots', description: 'Heavy, but nothing bites through them.', rarity: ItemRarity.Rare, stack: 1, armor: 0.06, equip: 'feet', look: 1, weight: 3 }),
  woodenShield: item({ id: 'wooden-shield', name: 'Wooden Shield', description: 'Hold it in your off hand. Blocks most of a blow.', rarity: ItemRarity.Common, stack: 1, equip: 'offhand', shield: { pass: 0.15, stamina: 6 }, weight: 3 }),
  ironShield: item({ id: 'iron-shield', name: 'Iron Shield', description: 'Hold it in your off hand. Blocks nearly anything.', rarity: ItemRarity.Rare, stack: 1, equip: 'offhand', shield: { pass: 0.05, stamina: 4 }, weight: 7 }),
  rawMeat: item({ id: 'raw-meat', name: 'Raw Meat', description: 'Better cooked.', rarity: ItemRarity.Common, food: { hunger: 8 } }),
  vegetables: item({ id: 'vegetables', name: 'Vegetables', description: 'Fresh from a village garden.', rarity: ItemRarity.Common, food: { hunger: 14, thirst: 4 } }),
  cookedMeat: item({ id: 'cooked-meat', name: 'Cooked Meat', description: 'Filling and warm.', rarity: ItemRarity.Uncommon, food: { hunger: 35, health: 5 } }),
  hide: item({ id: 'hide', name: 'Hide', description: 'Tough animal skin for leather.', rarity: ItemRarity.Common }),
  silk: item({ id: 'silk', name: 'Spider Silk', description: 'Strong, light thread.', rarity: ItemRarity.Common }),
  chitin: item({ id: 'chitin', name: 'Chitin', description: 'A hard desert shell.', rarity: ItemRarity.Common }),
  venom: item({ id: 'venom', name: 'Venom Sac', description: 'Handle with care.', rarity: ItemRarity.Uncommon }),
  iceShard: item({ id: 'ice-shard', name: 'Ice Shard', description: 'Never quite melts.', rarity: ItemRarity.Uncommon }),
  bone: item({ id: 'bone', name: 'Bone', description: 'Old and brittle.', rarity: ItemRarity.Common }),
  antidote: item({ id: 'antidote', name: 'Antidote', description: 'Cures poison.', rarity: ItemRarity.Uncommon, food: { health: 5 }, cures: 'poison' }),
  coin: item({ id: 'coin', name: 'Coin', description: 'Traders take these.', rarity: ItemRarity.Common, stack: 999, weight: 0.01 }),
  torch: item({ id: 'torch', name: 'Torch', description: 'Lights the dark while carried. Burns out over the night.', rarity: ItemRarity.Common, light: 5, equip: 'offhand' }),
  lantern: item({ id: 'lantern', name: 'Lantern', description: 'A steady light that never burns out.', rarity: ItemRarity.Rare, stack: 1, light: 7, weight: 1, equip: 'offhand' }),
  spiritEssence: item({ id: 'spirit-essence', name: 'Spirit Essence', description: 'A wisp of something that walked at night.', rarity: ItemRarity.Uncommon }),
  // Unused: the old story's lantern. Kept so the atlas still draws its icon and
  // later icons keep their places; saves swap it for an ordinary lantern.
  wanderersLantern: item({ id: 'wanderers-lantern', name: "Wanderer's Lantern", description: 'A faint blue flame. It remembers places the world has forgotten.', rarity: ItemRarity.Legendary, stack: 1, light: 6, weight: 0, equip: 'offhand' }),
  starMetal: item({ id: 'star-metal', name: 'Star Metal', description: 'Fell from the sky. Forge it with gold into star ingots.', rarity: ItemRarity.Epic, weight: 1.5 }),
  // The tier above iron, for the far, hard lands, and blades that use rare drops.
  starIngot: item({ id: 'star-ingot', name: 'Star Ingot', description: 'Star metal forged with gold. Light, and harder than anything.', rarity: ItemRarity.Epic, weight: 1 }),
  starAxe: item({ id: 'star-axe', name: 'Starforged Axe', description: 'Trees fall almost at a touch.', rarity: ItemRarity.Epic, stack: 1, tool: { kind: 'axe', tier: 3 } }),
  starPickaxe: item({ id: 'star-pickaxe', name: 'Starforged Pickaxe', description: 'Mines anything, quickly.', rarity: ItemRarity.Epic, stack: 1, tool: { kind: 'pickaxe', tier: 3 } }),
  starSword: item({ id: 'star-sword', name: 'Starforged Sword', description: 'Forged from the sky. The finest blade there is.', rarity: ItemRarity.Legendary, stack: 1, weapon: { kind: 'melee', damage: 32, durability: 420, reach: 1.7, cooldown: 0.38 } }),
  frostBlade: item({ id: 'frost-blade', name: 'Frost Blade', description: 'Cold to the touch. Desert creatures fear it; snow creatures shrug it off.', rarity: ItemRarity.Epic, stack: 1, weapon: { kind: 'melee', damage: 22, durability: 260, reach: 1.6, cooldown: 0.4, element: 'frost' } }),
  venomBlade: item({ id: 'venom-blade', name: 'Venom Blade', description: 'Its edge weeps poison. Deadly to beasts; useless on stone and bone.', rarity: ItemRarity.Epic, stack: 1, weapon: { kind: 'melee', damage: 22, durability: 260, reach: 1.6, cooldown: 0.4, element: 'venom' } }),
  spiritBlade: item({ id: 'spirit-blade', name: 'Spirit Blade', description: 'It glows near the dead. Wraiths and skeletons come apart under it.', rarity: ItemRarity.Epic, stack: 1, weapon: { kind: 'melee', damage: 22, durability: 260, reach: 1.6, cooldown: 0.4, element: 'spirit' } }),
  crystalBow: item({ id: 'crystal-bow', name: 'Crystal Bow', description: 'Strung with silk, braced with crystal. Shoots far and hard.', rarity: ItemRarity.Epic, stack: 1, weapon: { kind: 'bow', damage: 20, durability: 260, reach: 11, cooldown: 0.55 } }),
  starHelmet: item({ id: 'star-helmet', name: 'Starforged Helm', description: 'Light as leather, hard as nothing else.', rarity: ItemRarity.Epic, stack: 1, armor: 0.11, equip: 'head', look: 2, weight: 3 }),
  starArmor: item({ id: 'star-armor', name: 'Starforged Plate', description: 'Plate forged from fallen stars.', rarity: ItemRarity.Legendary, stack: 1, armor: 0.22, equip: 'chest', look: 2, weight: 7 }),
  starGreaves: item({ id: 'star-greaves', name: 'Starforged Greaves', description: 'Starforged plate for the legs.', rarity: ItemRarity.Epic, stack: 1, armor: 0.14, equip: 'legs', look: 2, weight: 4 }),
  starBoots: item({ id: 'star-boots', name: 'Starforged Boots', description: 'They barely weigh a thing.', rarity: ItemRarity.Epic, stack: 1, armor: 0.09, equip: 'feet', look: 2, weight: 2 }),
  chitinShield: item({ id: 'chitin-shield', name: 'Chitin Shield', description: 'A desert shell on a wooden frame. Blocks well and weighs little.', rarity: ItemRarity.Uncommon, stack: 1, equip: 'offhand', shield: { pass: 0.1, stamina: 5 }, weight: 2 }),
  schematic: item({ id: 'schematic', name: 'Forgotten Schematic', description: 'Plans for something the world forgot how to make. Use it to learn a rare recipe.', rarity: ItemRarity.Epic, weight: 0.1 }),
  frostDraught: item({ id: 'frost-draught', name: 'Frost Draught', description: 'Melted ice and herbs. Quenches the worst thirst.', rarity: ItemRarity.Uncommon, food: { thirst: 45, health: 10 } }),
  // From behind the rifts (see src/dimension), and what they make.
  riftShard: item({ id: 'rift-shard', name: 'Rift Shard', description: 'A splinter of an outer dimension. It flickers, as if it cannot decide to exist.', rarity: ItemRarity.Epic, weight: 0.2 }),
  riftBlade: item({ id: 'rift-blade', name: 'Rift Blade', description: 'An iron blade set with rift shards. It flickers between here and elsewhere; rift creatures come apart under it.', rarity: ItemRarity.Epic, stack: 1, weapon: { kind: 'melee', damage: 24, durability: 280, reach: 1.7, cooldown: 0.4, element: 'spirit' } }),
  riftTonic: item({ id: 'rift-tonic', name: 'Rift Tonic', description: 'A shard dissolved in herb water. Mends wounds and clears poison; it tastes of static.', rarity: ItemRarity.Rare, food: { health: 45, thirst: 10 }, cures: 'poison' }),
} as const;

export const ITEM_LIST: readonly ItemDef[] = list;

/** Carry weight of one item. */
export function weightOf(item: ItemDef): number {
  if (item.weight !== undefined) return item.weight;
  if (item.armor) return item.armor > 0.25 ? 12 : 5;
  if (item.weapon) return item.weapon.kind === 'bow' ? 2 : 3;
  if (item.tool) return 3;
  if (item.food) return 0.3;
  return 0.5;
}
const byId = new Map(list.map((d) => [d.id, d]));

export function itemById(id: string): ItemDef | undefined {
  return byId.get(id);
}
