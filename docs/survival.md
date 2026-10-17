# Survival

How the player stays alive: vitals, stamina, gathering, items, the inventory, crafting, loot and light.

## Vitals

`src/systems/Vitals.ts` keeps four bars: health, stamina, hunger and thirst. Hunger, thirst and stamina run from 0 to 100. Health runs from 0 to `maxHealth`, which starts at 100 and grows with level and the Toughness skill (see [combat.md](combat.md#progression)).

### Drain

| Bar | Full drain at rest | Multipliers |
| --- | --- | --- |
| Hunger | 600 s | ×1.5 while running, biome, weather |
| Thirst | 420 s | ×1.5 while running, biome, weather |

Biome multipliers (`BIOME_HUNGER`, `BIOME_THIRST`):

| Biome | Hunger | Thirst |
| --- | --- | --- |
| Forest | 1 | 1 |
| Desert | 1 | 1.6 |
| Snow | 1.4 | 0.9 |

Weather multiplies these again; the table is in [living-world.md](living-world.md#weather).

### Health

Health changes once per frame from the sum of these rates:

| Condition | Effect |
| --- | --- |
| Hunger or thirst at 0 | −1.2 HP/s for each empty bar |
| Hunger and thirst both above 40, not poisoned | +0.6 HP/s |
| Poisoned | −2.5 HP/s |

Starvation and healing never apply at the same time: any empty bar stops healing.

### Low warnings

The HUD (`src/ui/Hud.ts`) warns when a bar runs low. Each bar is low or critical below a share of its maximum, and clears 3% above it, so warnings do not flicker:

| Bar | Low | Critical |
| --- | --- | --- |
| Health | 30% ("Low health") | 12% ("Near death!") |
| Hunger | 20% ("Hungry") | empty ("Starving!") |
| Thirst | 20% ("Thirsty") | empty ("Dehydrated!") |
| Stamina | – | 12% ("Exhausted") |

- A banner at the top centre lists the warnings, worst first; critical ones are red and blink.
- The bar's frame glows and pulses, its label turns red, and a critical bar shakes.
- Low health tints the screen edges red; critical health makes them throb like a heartbeat.
- Each time a bar gets worse an alarm sounds (`warn`; not for stamina, which runs out often).
- Animations stop under the system's reduced-motion setting.

### Status effects

| Status | Effect | Source | Cure |
| --- | --- | --- | --- |
| `poison` | −2.5 HP/s, stops healing | Hits from scorpions, Emperor Scorpions, Thorn Spiders (their webs), Ghouls and the Dune Tyrant | Antidote, a Moonwell, or wait it out |
| `slow` | Movement speed ×0.55 (`SLOW_FACTOR`) | Spider webs, Frost Golem ice | Wait it out |

Each status lasts a set number of seconds. A new hit refreshes it to whichever is longer.

### Collapse

When health reaches 0 the player collapses. `Game.collapse()` leaves any building, cancels gathering, calls `Vitals.revive()` and sends the player to their waking spot, with an alert that stays until dismissed. The waking spot (`Game.respawn`) is the start (0, 0) until the player:

- rests at a campfire or in a bed (the spot outside the door, if indoors), or
- drinks from a Moonwell.

Each of these moves it to where the player stands (`Game.setRespawn`). It is saved as `player.respawn` ([saves.md](saves.md)). Revival sets:

- health to 60% of `maxHealth`
- stamina to 100
- hunger and thirst to at least 50
- poison and slow to 0

The player keeps everything they carry, except behind a rift: dying in an outer dimension loses everything in the bag and the hotbar (worn equipment stays), and the rift throws the player back out at its doorstep instead of the waking spot ([dimensions.md](dimensions.md#dying)).

## Stamina

| Use | Cost | Notes |
| --- | --- | --- |
| Running | 18/s | Needs stamina above 1. Blocking also stops running. |
| Dodge roll | 20, 12% less per Nimble rank | Needs the full cost. |
| Blocking a hit | 8 per blocked hit | No stamina means the block fails. |
| Gathering | 4 per completed gather | Below 4 stamina, gathering takes twice as long. |

Stamina recovers at 22/s while not running, or at 30% of that rate while hunger or thirst is empty.

Movement speed is 5 tiles/s walking and 9 running (`WALK_SPEED`, `RUN_SPEED` in `src/config.ts`).

## Gathering

Press E facing a decoration, or standing on one. `src/systems/GatheringSystem.ts` checks the tile in front first, then the tile under the feet. Gathering runs while the player stands still; moving, taking a hit, attacking or dodging cancels it.

Time is `seconds ÷ (1 + tool tier)`, doubled when stamina is below 4. Tools work automatically: the highest tier of the right kind anywhere in the bag counts.

| Decoration | Base time | Tool | Min tier | Drops |
| --- | --- | --- | --- | --- |
| Oak, autumn oak, pine, snowy pine, palm | 4 s | axe | 0 | Wood ×(1–2 + tier) |
| Dead bush | 0.7 s | – | 0 | Wood ×1 |
| Bush | 0.7 s | – | 0 | Berries ×1–3, 30% chance of 1 Herb |
| Flowers | 0.7 s | – | 0 | Herb ×1–2 |
| Mushroom | 0.7 s | – | 0 | Mushroom ×1 |
| Garden vegetables (villages) | 0.7 s | – | 0 | Vegetables ×1–2, Herb (20%) |
| Cactus | 1.2 s | – | 0 | Cactus Fruit ×1–2 |
| Stone, red rock, snowy rock | 3.5 s | pickaxe | 0 | Stone ×(1–2 + tier) |
| Ore | 4 s | pickaxe | 1 | 1–2 of: Gold Ore (12% + 5% per band, with tier 2 or more), Coal (the next 40%, plus the gold share below tier 2), else Iron Ore |
| Crystal | 5 s | pickaxe | 2 | Crystal ×1 (×2 with a 15% chance per band); a Gemstone too, 6% + 3% per band |
| Barrel | 0.8 s | – | 0 | Barrel loot (below) |
| Buried treasure (X mark) | 1.6 s | – | 0 | Coin ×10–40 plus a chest roll at band 2 |
| Meteorite | 5 s | pickaxe | 1 | Star Metal ×(2–3 + tier) |

Below the minimum tier the prompt reads "Needs a pickaxe" or "Needs an iron pickaxe". Tiers run from stone (1) through iron (2) to starforged (3).

Rare finds get likelier further out: the band is the difficulty band where the rock stands. In a mine it is the band of the mine's door outside (`GatheringSystem.bandAt`).

Drops are seeded by the tile and the region's visit counter, so the same plant gives the same drop until its region regenerates. Gathered decorations are removed through `WorldManager.harvest()`. They stay gone until the region regenerates, except plants that regrow ([living-world.md](living-world.md#regrowth)).

If the bag is full, what does not fit is left on the ground at the player's feet (outside the door, if indoors) and a notice says so. The same goes for enemy drops (where the enemy fell), quest rewards and the village defence reward.

### Drinking

Facing water with nothing on it, E drinks:

| Tile | Thirst |
| --- | --- |
| Water, deep water | +25 |
| Ice | +12 |

## Swimming

Rivers and lakes can be swum (`Game.walker` lets the player through water tiles with nothing on them; enemies, villagers and the world's own collision still treat water as solid).

| Water | Speed | Stamina |
| --- | --- | --- |
| Shallow (`Water`) | 55% | Recovers as normal |
| Deep (`WaterDeep`) | 42% | Drains as if running (18/s), and hunger and thirst drain 1.5× |

- No running, dodging or blocking while swimming.
- Out of stamina in deep water, the player starts to drown: 4 health a second, with a warning every 4 seconds, until they reach shallow water or land.
- Only the head and shoulders show, bobbing, with splashes while moving.
- Arrows and other shots fly over water.
- Bridges cross rivers every so often; see [world-generation.md](world-generation.md#bridges).

## Items

`src/items/Items.ts`. The default stack is 99. Food effects apply through `Vitals.consume()` when used.

| Item | Rarity | Stack | Use |
| --- | --- | --- | --- |
| Wood | Common | 99 | Crafting |
| Stone | Common | 99 | Crafting |
| Coal | Common | 99 | Iron ingots, torches |
| Iron Ore | Uncommon | 99 | Iron ingots |
| Gold Ore | Rare | 99 | Star ingots; sell (12c) |
| Crystal | Epic | 99 | Crystal Bow, Frost and Spirit Blades; sell (35c) |
| Herb | Common | 99 | Bandages, stew, antidote, Health Potion, Frost Draught |
| Berries | Common | 99 | Food: +12 hunger, +4 thirst |
| Mushroom | Common | 99 | Food: +10 hunger |
| Vegetables | Common | 99 | Food: +14 hunger, +4 thirst; sells for 2c |
| Cactus Fruit | Common | 99 | Food: +6 hunger, +20 thirst |
| Roast Mushroom | Uncommon | 99 | Food: +28 hunger |
| Forest Stew | Uncommon | 99 | Food: +45 hunger, +15 thirst |
| Herbal Bandage | Uncommon | 99 | +25 health |
| Health Potion | Rare | 99 | +60 health |
| Frost Draught | Uncommon | 99 | +45 thirst, +10 health |
| Iron Ingot | Uncommon | 99 | Iron tools, weapons, armor, lantern |
| Star Ingot | Epic | 99 | Starforged tools, weapons and armour; sell (120c) |
| Stone Axe | Common | 1 | Axe tier 1 |
| Stone Pickaxe | Common | 1 | Pickaxe tier 1 |
| Iron Axe | Uncommon | 1 | Axe tier 2 |
| Iron Pickaxe | Rare | 1 | Pickaxe tier 2 |
| Starforged Axe | Epic | 1 | Axe tier 3 |
| Starforged Pickaxe | Epic | 1 | Pickaxe tier 3 |
| Gemstone | Epic | 99 | Starforged Sword; sell (60c) |
| Golden Idol | Legendary | 99 | Sell (250c) |
| Wooden Sword | Common | 1 | Weapon (see [combat.md](combat.md#weapons)) |
| Iron Sword | Rare | 1 | Weapon |
| Frost Blade, Venom Blade, Spirit Blade | Epic | 1 | Weapons with a damage type |
| Starforged Sword | Legendary | 1 | Weapon |
| Hunting Bow | Uncommon | 1 | Weapon, uses arrows |
| Crystal Bow | Epic | 1 | Weapon, uses arrows |
| Arrow | Common | 99 | Bow ammunition |
| Leather Cap | Common | 1 | Head armour, 4% |
| Leather Tunic | Uncommon | 1 | Chest armour, 8% |
| Leather Trousers | Uncommon | 1 | Leg armour, 5% |
| Leather Boots | Common | 1 | Foot armour, 3% |
| Iron Helmet | Rare | 1 | Head armour, 8% |
| Iron Chestplate | Epic | 1 | Chest armour, 16% |
| Iron Greaves | Rare | 1 | Leg armour, 10% |
| Iron Boots | Rare | 1 | Foot armour, 6% |
| Starforged Helm | Epic | 1 | Head armour, 11% |
| Starforged Plate | Legendary | 1 | Chest armour, 22% |
| Starforged Greaves | Epic | 1 | Leg armour, 14% |
| Starforged Boots | Epic | 1 | Foot armour, 9% |
| Wooden Shield | Common | 1 | Off hand: blocks 85% of a blow for 6 stamina |
| Chitin Shield | Uncommon | 1 | Off hand: blocks 90% of a blow for 5 stamina |
| Iron Shield | Rare | 1 | Off hand: blocks 95% of a blow for 4 stamina |
| Raw Meat | Common | 99 | Food: +8 hunger |
| Cooked Meat | Uncommon | 99 | Food: +35 hunger, +5 health |
| Hide | Common | 99 | Leather, iron and starforged armour |
| Spider Silk | Common | 99 | Bows |
| Chitin | Common | 99 | Chitin Shield, Starforged Plate; sell (3c) |
| Venom Sac | Uncommon | 99 | Venom Blade; sell (6c) |
| Ice Shard | Uncommon | 99 | Frost Draught, Frost Blade; sell (6c) |
| Bone | Common | 99 | Arrows; sell (1c) |
| Antidote | Uncommon | 99 | +5 health, cures poison |
| Coin | Common | 999 | Currency |
| Torch | Common | 99 | Light, radius 5 |
| Lantern | Rare | 1 | Light, radius 7, never burns out |
| Spirit Essence | Uncommon | 99 | Lantern, Health Potion, Spirit Blade; sell (8c) |
| Star Metal | Epic | 99 | Star ingots; sell (45c) |
| Forgotten Schematic | Epic | 99 | Use it to learn a rare recipe |
| Rift Shard | Epic | 99 | From the vaults behind the rifts: Rift Blade, Rift Tonic, arrows; sell (30c) |
| Rift Blade | Epic | 1 | Melee 24, spirit, reach 1.7; see [combat.md](combat.md#weapons) |
| Rift Tonic | Rare | 99 | +45 health, +10 thirst, cures poison |

Every rare material now has a use in a recipe. Sell prices come from `SELL_PRICES` in `src/systems/TradeSystem.ts`. Items without a price can't be sold.

## Inventory and hotbar

`src/systems/InventorySystem.ts` has 24 slots (`INVENTORY_SIZE`). The first 8 (`HOTBAR_SIZE`) form the hotbar.

- `add()` tops up existing stacks first, then fills empty slots, and returns what didn't fit.
- `remove()` takes from the last slots first, and only if the whole amount is there.
- In the menu, click a slot and then another to move it. Equal stacks merge; anything else swaps.
- Weapons carry `durability`, which drops by one per attack. At 0 the weapon breaks and its slot empties. A worn weapon shows a durability bar in its slot.
- **Sort bag** (beside the load line) tidies every slot below the hotbar (`Inventory.sort()`): like items merge into full stacks (worn weapons never stack), then weapons, tools, armour, food, materials and treasure (Epic and above) follow in that order, rarest first, then by name. The hotbar is left alone.

### Weight

Every item has a carry weight (`weightOf` in `src/items/Items.ts`): set per item for some (coin 0.01, arrow 0.1, herb 0.1, schematic 0.1, wood 0.5, coal 0.6, stone 0.8, ores and ingots 1, star ingot 1, lantern 1, star metal 1.5, idol 2), set per piece for armour (leather cap and boots 1, tunic and trousers 2; iron boots 3, helmet 4, greaves 6, chestplate 10; starforged boots 2, helm 3, greaves 4, plate 7) and shields (chitin 2, wooden 3, iron 7), otherwise by kind: melee weapons and tools 3, bows 2, food 0.3, everything else 0.5.

The player can carry 100, plus 25 per Pack Mule rank. Over that the player is **overloaded**: 60% speed and no running, with an "overloaded" badge on the HUD. The bag shows the load under the grid.

### Dropping and picking up

- **Q** drops the selected hotbar stack in front of the player; the bag's **Drop** button drops the selected stack. Nothing can be dropped indoors.
- Dropped items lie on the ground as bobbing icons (`src/world/GroundItems.ts`). Walking over one picks it up, once the player has first stepped 1.4 tiles away from it, so a drop isn't picked straight back up. A full bag leaves the rest on the ground.
- Weapons keep their durability on the ground. Up to 300 dropped stacks are kept (the oldest go first), and they are saved with the world.
- Tools are never equipped: the best one carried applies (`toolTier()`).

### Equipment

The bag's left panel holds the **equipment**: head, chest, legs and feet down one side, the off hand on the other, and between them a preview of the player wearing it all, with the armour total underneath (`Inventory.equipment`).

- **Equip:** select an item in the bag and press **Equip** (or **Hold in off hand**), or select it and click its slot. Whatever was there goes back to the bag. Click a filled slot to take it off.
- **Armour** only protects while worn: every piece adds its share, up to 60% in all (`armor()`). Equipped items still count toward carry weight.
- **Off hand:** a shield (stronger blocks, see [combat.md](combat.md#taking-damage)), or a torch or lantern. A whole stack of torches goes into the off hand, and burns down from there.
- **On the player:** each worn piece is drawn over the figure in every direction and walk frame: leather in browns, iron in steel with a red crest, starforged in violet plate with gold trim (`ARMOR_SETS` = 3). The off-hand item is held in the other hand (a shield at the side, a torch up, a lantern hanging), and the shield comes up in front while blocking.
- Saves keep what is worn. Older saves put on the best armour carried for each slot.

Keys 1–8 select a hotbar slot, and its name (and a weapon's durability) shows above the bar for a moment. F, or tapping the selected slot again, uses it. Food is eaten, a Forgotten Schematic is read; tools and other items just show a notice. The selected slot is also the weapon used for attacks.

## Crafting

`src/systems/CraftingSystem.ts`. The player never builds, so stations are found in the world instead:

- **Campfire:** found in camps and nomad camps.
- **Anvil:** found in villages, castles and nomad camps.

A station counts if its decoration is within 3 tiles of the player (`STATION_RANGE`). Indoors, only the room's own furniture counts, not the world outside the door. "By hand" recipes work anywhere. The menu's Crafting tab lists every known recipe, what you have against what you need, and the station each requires.

Crafting removes the inputs, then adds the output. If the output doesn't fit, everything is put back and the result is `full`. Next to Craft, a ×N button crafts as many as the bag's materials allow, up to 20, when that is more than one.

| Output | Count | Station | Inputs |
| --- | --- | --- | --- |
| Stone Axe | 1 | By hand | 3 Wood, 2 Stone |
| Stone Pickaxe | 1 | By hand | 3 Wood, 3 Stone |
| Herbal Bandage | 1 | By hand | 2 Herb |
| Roast Mushroom | 1 | Campfire | 2 Mushroom |
| Forest Stew | 1 | Campfire | 2 Mushroom, 1 Herb, 1 Berries |
| Iron Ingot | 1 | Anvil | 2 Iron Ore, 1 Coal |
| Iron Axe | 1 | Anvil | 2 Iron Ingot, 2 Wood |
| Iron Pickaxe | 1 | Anvil | 3 Iron Ingot, 2 Wood |
| Wooden Sword | 1 | By hand | 5 Wood |
| Hunting Bow | 1 | By hand | 3 Wood, 2 Spider Silk |
| Arrow | 6 | By hand | 1 Wood, 1 Stone |
| Leather Tunic | 1 | By hand | 5 Hide |
| Leather Cap | 1 | By hand | 2 Hide |
| Leather Trousers | 1 | By hand | 3 Hide |
| Leather Boots | 1 | By hand | 2 Hide |
| Wooden Shield | 1 | By hand | 6 Wood |
| Antidote | 1 | By hand | 2 Herb, 1 Berries |
| Cooked Meat | 1 | Campfire | 1 Raw Meat |
| Iron Sword | 1 | Anvil | 3 Iron Ingot, 1 Wood |
| Iron Chestplate | 1 | Anvil | 5 Iron Ingot, 2 Hide |
| Iron Helmet | 1 | Anvil | 2 Iron Ingot |
| Iron Greaves | 1 | Anvil | 3 Iron Ingot, 1 Hide |
| Iron Boots | 1 | Anvil | 2 Iron Ingot |
| Iron Shield | 1 | Anvil | 3 Iron Ingot, 2 Wood |
| Torch | 3 | By hand | 1 Wood, 1 Coal |
| Lantern | 1 | Anvil | 1 Iron Ingot, 2 Spirit Essence |
| Health Potion | 1 | By hand | 2 Herb, 1 Spirit Essence, 1 Berries |
| Frost Draught | 1 | By hand | 2 Ice Shard, 1 Herb |
| Arrow | 8 | By hand | 1 Bone, 1 Wood |
| Chitin Shield | 1 | By hand | 4 Chitin, 2 Wood |
| Star Ingot | 1 | Anvil | 1 Star Metal, 2 Gold Ore, 1 Coal |
| Starforged Axe | 1 | Anvil | 2 Star Ingot, 2 Wood |
| Starforged Pickaxe | 1 | Anvil | 2 Star Ingot, 2 Wood |
| Starforged Helm | 1 | Anvil | 2 Star Ingot |
| Starforged Greaves | 1 | Anvil | 3 Star Ingot, 1 Hide |
| Starforged Boots | 1 | Anvil | 2 Star Ingot |
| Rift Tonic | 1 | By hand | 1 Rift Shard, 2 Herb |
| Arrow | 10 | By hand | 1 Rift Shard, 2 Wood |
| Rift Blade | 1 | Anvil | 1 Iron Sword, 4 Rift Shard, 1 Crystal |

Star metal comes from meteorites (and some legends), so the starforged tier is for the far lands. Rift shards come only from the vaults of the outer dimensions ([dimensions.md](dimensions.md#rewards)). Nothing can be crafted at a station inside a dimension: only by hand.

### Rare recipes

Recipes marked `rare` in `RECIPES` stay hidden until learned. The Crafting tab says how many are still to discover. Using a **Forgotten Schematic** (from the hotbar or the bag) teaches one unknown rare recipe at random and says where to make it; with none left to learn, the schematic is kept. Schematics are in the Epic chest pool and are dropped by every legend and the Arena Guardian. Learned recipes are saved in progression (`recipes`).

| Output | Count | Station | Inputs |
| --- | --- | --- | --- |
| Crystal Bow | 1 | Anvil | 2 Crystal, 3 Spider Silk, 2 Wood |
| Frost Blade | 1 | Anvil | 1 Iron Sword, 4 Ice Shard, 1 Crystal |
| Venom Blade | 1 | Anvil | 1 Iron Sword, 4 Venom Sac |
| Spirit Blade | 1 | Anvil | 1 Iron Sword, 4 Spirit Essence, 1 Crystal |
| Starforged Sword | 1 | Anvil | 3 Star Ingot, 1 Gemstone |
| Starforged Plate | 1 | Anvil | 4 Star Ingot, 2 Chitin |

## Loot

`src/systems/Loot.ts`.

### Chests

A chest makes 2–4 rolls, plus one more per two difficulty bands (`floor(band / 2)`). Each roll picks a rarity from the spec's chest table, then an item from that rarity's pool.

| Rarity | Chance |
| --- | --- |
| Common | 60% |
| Uncommon | 25% |
| Rare | 10% |
| Epic | 4% |
| Legendary | 1% |

| Rarity | Pool (count range) |
| --- | --- |
| Common | Wood 2–5, Stone 2–5, Berries 2–4, Herb 1–3, Coal 1–3, Mushroom 1–3, Arrow 3–8 |
| Uncommon | Iron Ore 1–3, Herbal Bandage 1–2, Roast Mushroom 1–2, Iron Ingot 1–2, Stone Axe, Wooden Sword, Antidote 1–2, Leather Tunic, Leather Cap, Leather Boots, Wooden Shield |
| Rare | Gold Ore 1–2, Health Potion, Forest Stew 1–2, Stone Pickaxe, Hunting Bow, Leather Trousers, Iron Helmet, Iron Boots |
| Epic | Forgotten Schematic, Crystal, Gemstone, Iron Pickaxe, Iron Axe, Iron Sword, Iron Chestplate, Iron Greaves, Iron Shield |
| Legendary | Golden Idol |

Chest contents are seeded by the chest's object id and layout index, so a chest always holds the same loot.

**Chests never refill.** Opening one marks its object's anchor in `WorldManager.lootedAnchors`. Every chest that later regenerates from that anchor starts open and empty (`emptyChests`). An open chest shows as `ChestOpen` and answers "Already looted".

### Barrels

Breaking a barrel gives nothing 35% of the time. Otherwise it gives one roll: Common (85%) or Uncommon (15%).

### Buried treasure

Digging up an X gives 10–40 coins plus a chest roll at band 2. Treasure comes from the treasure world event ([living-world.md](living-world.md#world-events)).

### Enemy drops

See [combat.md](combat.md#enemies).

## Light

At night the player carries a light radius (`LivingWorld.playerLight()`):

| Source | Radius (tiles) |
| --- | --- |
| Nothing (night eyes) | 2.4 |
| Torch | 5 |
| Lantern | 7 |

The largest radius applies. A new world starts with a Lantern in the bag.

**Torches burn down:** for every 2 in-game hours with darkness above 0.5, one torch is used up, unless a Lantern is already lighting the way.

See also: [README.md](README.md) · [combat.md](combat.md) · [living-world.md](living-world.md) · [objects-and-structures.md](objects-and-structures.md)
