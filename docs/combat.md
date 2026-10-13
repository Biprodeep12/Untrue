# Combat

Attacks, defence, weapons, enemies and their AI, spawning, guarded places, and progression.

Code: `src/systems/CombatSystem.ts`, `src/entities/Enemy.ts`, `src/entities/Species.ts`, `src/generation/EnemyGenerator.ts`, `src/game/Player.ts`, `src/systems/Progression.ts`.

## Controls

| Action | Keyboard and mouse | Touch |
| --- | --- | --- |
| Attack | Left click (toward the mouse) or J (the way you face) | Hit (aims at the nearest enemy in reach) |
| Block | Hold right click or K | Hold Block |
| Dodge roll | Space | Roll |
| Choose weapon | 1–8 selects the hotbar slot | Tap a slot |

Attacking with the mouse turns the player toward the cursor. On touch screens, Hit turns the player toward the nearest enemy within the weapon's reach plus 1.5 tiles (animals and burrowed lurkers are skipped), or the way they face if there is none. The weapon is whatever sits in the selected hotbar slot; anything else counts as fists. J and K are the default keys; both can be changed in Settings ([README.md](README.md#controls)).

There is no fighting indoors (enemies stay outside) or while swimming ("You can't fight while swimming").

## Damage

### Dealing damage

`playerHitDamage(base, levelBonus, crit) = round(base × levelBonus × (crit ? 2 : 1))`

- **Crit chance:** 10% per hit (`CRIT_CHANCE`). A crit doubles the damage.
- **Level bonus:** see [Progression](#progression).
- **Melee arc:** a swing hits every enemy within `reach + 0.4` tiles and within 60° either side of the swing direction. Enemies closer than 0.3 tiles are always hit.
- **Knockback:** each hit pushes the enemy 0.35 tiles along the swing, unless that spot is solid.
- **Burrowed enemies** can't be hit.
- **Damage types:** see [below](#damage-types). The type's factor is applied last, and a hit always does at least 1.

### Taking damage

`incomingDamage(raw, armor, blocked, pass) = max(1, round(raw × (1 − armor) × (blocked ? pass : 1)))`

- **Armor:** the pieces worn add up (see [survival.md](survival.md#equipment)), to at most 60%. A full leather set gives 20%, a full iron set 40%, a full starforged set 56%.
- **Blocking:** without a shield, absorbs 70% of a hit (`pass` 0.3) and costs 8 stamina. A **Wooden Shield** in the off hand absorbs 85% for 6 stamina; a **Chitin Shield** 90% for 5; an **Iron Shield** 95% for 4. While blocking, the shield is raised in front of the player. It only works if the player faces the attacker and has the stamina. Blocking also halves movement speed and stops running, and a blocked hit inflicts no status effect.
- **After a hit:** the player is knocked back 0.45 tiles and can't be hit again for 0.6 s (the sprite blinks).
- **Dodge roll:** a 0.18 s dash at 15 tiles/s, during which the player can't be hit. It costs 20 stamina (12% less per Nimble rank) and has a 0.7 s cooldown.
- **Projectiles:** enemy projectiles deal 80% of the enemy's damage.

## Weapons

| Weapon | Kind | Damage | Type | Reach / range | Cooldown | Durability |
| --- | --- | --- | --- | --- | --- | --- |
| Fists | melee | 5 | – | 1.1 | 0.45 s | – |
| Wooden Sword | melee | 9 | – | 1.4 | 0.45 s | 60 |
| Iron Sword | melee | 20 | – | 1.6 | 0.4 s | 220 |
| Frost Blade | melee | 22 | frost | 1.6 | 0.4 s | 260 |
| Venom Blade | melee | 22 | venom | 1.6 | 0.4 s | 260 |
| Spirit Blade | melee | 22 | spirit | 1.6 | 0.4 s | 260 |
| Starforged Sword | melee | 32 | – | 1.7 | 0.38 s | 420 |
| Hunting Bow | bow | 12 | – | 9 | 0.65 s | 140 |
| Crystal Bow | bow | 20 | – | 11 | 0.55 s | 260 |

The three elemental blades, the Starforged Sword and the Crystal Bow are rare recipes, learned from Forgotten Schematics ([survival.md](survival.md#rare-recipes)).

- **Durability:** each attack with a weapon costs one point. At 0 it breaks and a notice says so. A worn weapon shows a bar along the bottom of its slot (red below 25%).
- **Stats on screen:** the bag's item details list a weapon's damage and type, reach or range, hits per second and durability. Selecting a hotbar slot briefly shows the item's name, and a weapon's durability, above the bar.
- **Bows:** each shot uses one Arrow from the bag. Without arrows the attack fails with "No arrows". Arrows fly at 14 tiles/s and stop at their range or at anything solid. They can crit like melee hits.

## Damage types

A weapon can carry a damage type (`Element` in `src/items/Items.ts`): `frost`, `venom` or `spirit`. Species list the types they are weak to (`weak`, ×1.5 damage) or resist (`resist`, ×0.5), in `src/entities/Species.ts`; `elementFactor` applies them. Arrows from a typed bow would carry its type too, but no bow has one yet.

| Type | Weak to it | Resist it |
| --- | --- | --- |
| Frost | Scorpion, Sand Lurker, Jackal, Emperor Scorpion, Dune Tyrant, Thorn Spider | Frost Golem, Ancient Golem, Frost Wolf, Tundra Bear |
| Venom | Wolf, Bear, Frost Wolf, Tundra Bear, Jackal, Alpha Wolf, Elder Stag | Spider, Thorn Spider, Scorpion, Emperor Scorpion, Dune Tyrant, Frost Golem, Ancient Golem, Wraith, Skeleton, Skeleton Archer, Ghoul |
| Spirit | Wraith, Skeleton, Skeleton Archer, Ghoul | – |

The Jackal is weak to both frost and venom. Bandits, wildlife and the Arena Guardian have no weakness or resistance.

## Enemies

Stats below are at band 0. "Aggro" is the distance at which the enemy notices the player; "drops" are (count, chance).

| Species | Biomes | HP | Dmg | Speed | Aggro | Behaviour | Drops | XP |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Wolf | Forest, Snow | 30 | 8 | 4.4 | 7 | Packs of 2–3 that alert each other; flees below 20% HP | Raw Meat 1–2 (100%), Hide 1 (70%) | 12 |
| Bear | Forest | 85 | 18 | 3.1 | 5 | Slow, heavy hitter | Raw Meat 2–3, Hide 1–2 | 30 |
| Spider | Forest | 22 | 6 | 3.7 | 6.5 | Ranged web (range 5); hits slow you for 2.5 s | Silk 1–2, Venom 1 (15%) | 10 |
| Scorpion | Desert | 35 | 9 | 3.4 | 6 | Hits poison you for 4 s | Chitin 1, Venom 1 (50%) | 14 |
| Sand Lurker | Desert | 45 | 14 | 3.8 | 3.5 | Ambush: hides underground until close | Chitin 1–2, Bone 1 (50%) | 18 |
| Frost Golem | Snow | 60 | 12 | 2.4 | 7 | Ranged ice (range 6); hits slow you for 2 s | Ice Shard 1–2, Crystal 1 (5%) | 22 |
| Thorn Spider | Forest | 48 | 11 | 3.9 | 7 | Ranged web (range 5); hits poison you for 4 s | Silk 2–3, Venom 1 (60%) | 20 |
| Jackal | Desert | 26 | 7 | 4.8 | 7 | Packs of 2–4; flees below 25% HP | Raw Meat 1, Hide 1 (50%), Bone 1 (30%) | 11 |
| Emperor Scorpion | Desert | 110 | 18 | 3 | 6 | Hits poison you for 6 s | Chitin 2–3, Venom 1–2, Gemstone 1 (5%) | 38 |
| Frost Wolf | Snow | 42 | 10 | 4.5 | 7.5 | Packs of 2–4; flees below 15% HP | Raw Meat 1–2, Hide 1–2 (80%), Ice Shard 1 (30%) | 16 |
| Tundra Bear | Snow | 120 | 22 | 3 | 5 | Slow, heavy hitter | Raw Meat 2–4, Hide 2–3 | 40 |
| Wraith | All | 28 | 10 | 3.6 | 8 | Night only, fades at dawn; flies over water and walls | Spirit Essence 1 (80%), Coin 1–4 (50%) | 18 |
| Bandit | Event only | 45 | 11 | 3.9 | 10 | Groups of 3–4 from the ambush event; human sprite | Coin 5–15, Arrow 2–6 (40%), Bandage 1 (30%) | 20 |
| Skeleton | Guard only | 40 | 10 | 3.2 | 9 | Dungeon and archive guard | Bone 1–2, Arrow 2–5 (40%) | 16 |
| Skeleton Archer | Guard only | 30 | 8 | 2.8 | 10 | Dungeon and archive guard; shoots arrows (range 7) | Bone 1–2, Arrow 3–6 (70%) | 18 |
| Ghoul | Guard only | 70 | 15 | 3.6 | 9 | Dungeon guard from band 2; hits poison you for 3 s | Bone 2–3, Spirit Essence 1 (40%) | 28 |
| Elder Stag | Legend only | 420 | 24 | 4.6 | 8 | Legendary creature, boss | Hide 3–5, Gemstone 1, Crystal 1–2, Forgotten Schematic 1, plus a chest roll | 300 |
| Alpha Wolf | Legend only | 380 | 22 | 4.8 | 9 | Legendary creature, boss | Hide 3–5, Gemstone 1, Star Metal 1, Forgotten Schematic 1, plus a chest roll | 280 |
| Dune Tyrant | Legend only | 520 | 26 | 3.2 | 8 | Legendary creature, boss; hits poison you for 6 s | Chitin 4–6, Venom 2–3, Gemstone 1, Star Metal 1–2, Forgotten Schematic 1, plus a chest roll | 360 |
| Ancient Golem | Legend only | 620 | 28 | 2.2 | 10 | Legendary creature, boss; throws boulders (range 7) | Crystal 2–3, Ice Shard 3–5, Star Metal 2, Forgotten Schematic 1, plus a chest roll | 400 |
| Arena Guardian | Arena only | 900 | 30 | 2.6 | 14 | Boss; also throws boulders (range 8) | Golden Idol 1, Iron Ingot 3–6, Forgotten Schematic 1–2, plus a chest roll | 600 |

Spawn weights within a biome: Wolf 4, Bear 1.5, Spider 3, Thorn Spider 1, Scorpion 4, Sand Lurker 2, Jackal 3, Emperor Scorpion 0.8, Frost Golem 3, Frost Wolf 3, Tundra Bear 1.2, Wraith 3.

**Variants.** The newer species borrow an existing creature's sprites (`art` on the species), with their own `tint` and `size`: the Frost Wolf, Jackal and Alpha Wolf are wolves; the Tundra Bear a bear; the Emperor Scorpion and Dune Tyrant scorpions; the Thorn Spider a spider; the Ancient Golem a golem; the Skeleton Archer and Ghoul skeletons. Bosses and elites get a chest roll; a boss's is 3 bands richer.

## Wildlife

Animals (`passive` species in `src/entities/Species.ts`) share the enemy code but never start a fight. Skittish animals bolt when the player comes within their range (and warn their herd); defensive ones ignore the player until hurt, then fight back like an enemy.

| Animal | Biomes | HP | Dmg | Speed | Range | Temper | Drops | XP |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Rabbit | Forest | 8 | 0 | 5 | 4 | Skittish | Raw Meat 1 | 3 |
| Deer | Forest | 24 | 0 | 5.2 | 6 | Skittish, herds of 2–3 | Raw Meat 1–2, Hide 1 (80%) | 7 |
| Boar | Forest | 38 | 7 | 3.8 | — | Defensive | Raw Meat 2–3, Hide 1 (60%) | 10 |
| Sand Lizard | Desert | 10 | 0 | 5.4 | 3.5 | Skittish | Raw Meat 1, Chitin 1 (30%) | 3 |
| Snow Hare | Snow | 8 | 0 | 5 | 4 | Skittish | Raw Meat 1, Hide 1 (30%) | 3 |
| Mountain Goat | Snow, Desert | 30 | 6 | 4 | — | Defensive, 1–3 | Raw Meat 1–2, Hide 1–2 (80%) | 9 |

Weights within a biome: Rabbit 4, Deer 3, Boar 2, Sand Lizard 4, Snow Hare 4, Mountain Goat 2. Hunting an animal says "Hunted a …"; the Hunter skill adds to its drops. Animals never block resting by a campfire.

Drops go straight into the bag. What does not fit is left on the ground where the enemy fell, with a notice.

### AI states

`Enemy.update()` runs a small state machine.

| State | Behaviour | Leaves when |
| --- | --- | --- |
| `burrowed` | Hidden, can't be hit | Player within aggro range → `aggro` |
| `patrol` | Wanders at 35% speed: picks a direction, or stands still half the time, for 1–3 s | Player within aggro range → `aggro`, and the pack is alerted |
| `aggro` | Faces the player and shows "!" | After 0.4 s → `chase` |
| `chase` | Runs at the player. Ranged enemies hold position within 60% of their range. | Player farther than 2.5× aggro → `patrol`. In melee reach, or in ranged range but more than twice melee reach, with the attack ready → `attack`. |
| `attack` | Flickers and shows a red "!" during a 0.3 s wind-up, then hits if the player is within `attackRange + 0.4`, or else fires a projectile if in range | After 0.5 s → `chase` |
| `flee` | Runs away at 110% speed | After 3 s → `patrol` |

- Taking a hit provokes an enemy (patrol or burrowed → aggro).
- A species with `fleeBelow` flees instead once its health drops below that share: wolves 20%, frost wolves 15%, jackals 25%.
- Every enemy except a flier collides with solid tiles, sliding along walls.

### Difficulty scaling and elites

Bands come from distance to the origin (`src/generation/WorldRules.ts`):

| Band | Distance |
| --- | --- |
| 0 Easy | 0–1,000 tiles |
| 1 Medium | 1,000–5,000 tiles |
| 2 Hard | 5,000–10,000 tiles |
| 3 Extreme | 10,000+ tiles |

Per band:
- **Health:** `round(hp × (1 + 0.6 × band))`
- **Damage:** `damage × (1 + 0.5 × band)`
- **XP:** `round(xp × (1 + 0.5 × band))`

Elites appear with chance `0.04 + 0.03 × band`. Only one member of a spawned group can be elite. An elite has:
- ×2.5 health and ×1.5 damage, with XP tripled
- a gold tint and a sprite 1.25× larger
- doubled drop counts, plus a chest roll at its band

## Spawning

Wild enemies spawn inside the simulation radius; tries happen every 2.5 s.

- **Safe zone:** nothing spawns while the player is within 64 tiles of the origin (`SAFE_RADIUS`), and no spawn point may be within 64 tiles of it.
- **Population cap:** `round((3 + 2 × band) × (night ? 1.5 : 1))` wild enemies. Guards and event groups don't count toward it.
- **Spawn point:** a random open tile in the simulation area, at least 12 tiles from the player (`MIN_SPAWN_DISTANCE`). The species is a weighted pick from the biome at that tile; wraiths are added at night.
- **Despawn:** enemies that leave the simulation area are removed. Night-only enemies are removed at dawn.
- **Wildlife:** animals spawn on the same timer, separately: up to 6 by day and 3 at night, anywhere in the simulation area (the safe zone included), at least 12 tiles from the player. They never count toward the enemy cap.

## Guarded places

Walking into some places wakes their guards (`GUARDED_KINDS`):

| Place | Guards |
| --- | --- |
| Dungeon | 2–3 Skeletons and 1–2 Skeleton Archers on open floor tiles, plus 1 Ghoul at band 2 or 2 at band 3 |
| Boss Arena | 1 Arena Guardian at the centre |
| Sunken Archive (story) | 4 Skeletons and 2 Skeleton Archers |

Killing every guard clears the place:
- the player gets 60 XP and a "cleared!" notice
- the place's anchor goes into `WorldManager.clearedAnchors`, which is saved

**Cleared stays cleared:** a cleared anchor never wakes guards again, even after its region regenerates. If the player leaves before clearing it, the guards despawn and the place resets for the next visit.

### Legends

Every chunk in the simulation area gets one roll per region visit, with a chance of `LEGEND_CHANCE × (1 + band)` (0.05% at band 0, 0.2% at band 3) of a legendary creature at the chunk's centre. Rolls only run when the simulated area moves. Which legend depends on the land (`legendFor` in `src/systems/CombatSystem.ts`):

| Land | Legend |
| --- | --- |
| Desert, band 1 or more | Dune Tyrant |
| Snow, band 1 or more | Ancient Golem or Alpha Wolf, half each |
| Elsewhere, band 2 or more | Alpha Wolf or Elder Stag, half each |
| Anywhere else (near home) | Elder Stag |

Killing a legend records `legend@cx,cy` in `clearedAnchors`, so that spot never spawns another. Every boss killed (legends and the Arena Guardian) counts as a trophy, by species, in progression (`trophies`). The Quests tab lists them under "Legends of the land" (found out of 5), with a tick and a count for each one defeated.

**Event groups** (bandit ambush, village defence) are tracked the same way, without persistence. Clearing them reports to quests; clearing a village defence also pays 30 coins.

## Progression

`src/systems/Progression.ts`:
- **XP to level up:** going from level `L` to `L + 1` takes `round(40 × L^1.5)` XP.
- **Level cap:** 50.
- **Per level:** each level adds 8 max health and 5% damage, and a skill point. When you level up, current health rises by the same amount as max health.

### Skills

Skill points are spent in the menu's Skills tab. Each skill has 5 ranks (`MAX_RANK`); points left = level − 1 − ranks learned. Nine skills × 5 ranks is 45 points, so every level up to 46 buys something. Once every skill is at rank 5, the tab says so.

| Skill | Per rank |
| --- | --- |
| Warrior | +8% damage (multiplies the level bonus) |
| Hunter | +35% chance of one extra of each drop from animals |
| Gatherer | Chopping, mining and picking 15% faster |
| Forager | +30% chance of one extra from plants (berries, herbs, mushrooms, cactus fruit) |
| Swimmer | Swim 10% faster; deep water tires 15% slower |
| Pack Mule | Carry 25 more weight |
| Survivalist | Hunger and thirst drain 10% slower |
| Toughness | +6% max health (multiplies the level's max health) |
| Nimble | Dodge rolls cost 12% less stamina |

Ranks are saved with progression; older saves load with none.

| XP source | Amount |
| --- | --- |
| Killing an enemy | Species XP, scaled by band and elite |
| Clearing a guarded place or event group | 60 |
| Discovering a structure | 15 |
| Quests | 32–150, see [living-world.md](living-world.md#quests) |
| Story milestones | 80 (graves, revision, astronomer), 160 (Hall of Lanterns), 400 (ending) |

See also: [README.md](README.md) · [survival.md](survival.md) · [living-world.md](living-world.md) · [story.md](story.md) · [objects-and-structures.md](objects-and-structures.md)
