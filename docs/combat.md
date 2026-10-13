# Combat

Attacks, defence, weapons, enemies and their AI, spawning, guarded places, and progression.

Code: `src/systems/CombatSystem.ts`, `src/entities/Enemy.ts`, `src/entities/Species.ts`, `src/generation/EnemyGenerator.ts`, `src/game/Player.ts`, `src/systems/Progression.ts`.

## Controls

| Action | Keyboard and mouse | Touch |
| --- | --- | --- |
| Attack | Left click (toward the mouse) or J (the way you face) | Hit |
| Block | Hold right click or K | Hold Block |
| Dodge roll | Space | Roll |
| Choose weapon | 1–8 selects the hotbar slot | Tap a slot |

Attacking with the mouse turns the player toward the cursor. The weapon is whatever sits in the selected hotbar slot; anything else counts as fists.

## Damage

### Dealing damage

`playerHitDamage(base, levelBonus, crit) = round(base × levelBonus × (crit ? 2 : 1))`

- **Crit chance:** 10% per hit (`CRIT_CHANCE`). A crit doubles the damage.
- **Level bonus:** see [Progression](#progression).
- **Melee arc:** a swing hits every enemy within `reach + 0.4` tiles and within 60° either side of the swing direction. Enemies closer than 0.3 tiles are always hit.
- **Knockback:** each hit pushes the enemy 0.35 tiles along the swing, unless that spot is solid.
- **Burrowed enemies** can't be hit.

### Taking damage

`incomingDamage(raw, armor, blocked, pass) = max(1, round(raw × (1 − armor) × (blocked ? pass : 1)))`

- **Armor:** the pieces worn add up (see [survival.md](survival.md#equipment)), to at most 60%. A full leather set gives 20%, a full iron set 40%.
- **Blocking:** without a shield, absorbs 70% of a hit (`pass` 0.3) and costs 8 stamina. A **Wooden Shield** in the off hand absorbs 85% for 6 stamina; an **Iron Shield** 95% for 4. While blocking, the shield is raised in front of the player. It only works if the player faces the attacker and has the stamina. Blocking also halves movement speed and stops running, and a blocked hit inflicts no status effect.
- **After a hit:** the player is knocked back 0.45 tiles and can't be hit again for 0.6 s (the sprite blinks).
- **Dodge roll:** a 0.18 s dash at 15 tiles/s, during which the player can't be hit. It costs 20 stamina and has a 0.7 s cooldown.
- **Projectiles:** enemy projectiles deal 80% of the enemy's damage.

## Weapons

| Weapon | Kind | Damage | Reach / range | Cooldown | Durability |
| --- | --- | --- | --- | --- | --- |
| Fists | melee | 5 | 1.1 | 0.45 s | – |
| Wooden Sword | melee | 9 | 1.4 | 0.45 s | 60 |
| Iron Sword | melee | 20 | 1.6 | 0.4 s | 220 |
| Hunting Bow | bow | 12 | 9 | 0.65 s | 140 |

- **Durability:** each attack with a weapon costs one point. At 0 it breaks and a notice says so.
- **Bows:** each shot uses one Arrow from the bag. Without arrows the attack fails with "No arrows". Arrows fly at 14 tiles/s and stop at their range or at anything solid. They can crit like melee hits.

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
| Wraith | All | 28 | 10 | 3.6 | 8 | Night only, fades at dawn; flies over water and walls | Spirit Essence 1 (80%), Coin 1–4 (50%) | 18 |
| Bandit | Event only | 45 | 11 | 3.9 | 10 | Groups of 3–4 from the ambush event; human sprite | Coin 5–15, Arrow 2–6 (40%), Bandage 1 (30%) | 20 |
| Skeleton | Guard only | 40 | 10 | 3.2 | 9 | Dungeon and archive guard | Bone 1–2, Arrow 2–5 (40%) | 16 |
| Elder Stag | Legend only | 420 | 24 | 4.6 | 8 | Legendary creature, boss | Hide 3–5, Gemstone 1, Crystal 1–2, plus a chest roll | 300 |
| Arena Guardian | Arena only | 900 | 30 | 2.6 | 14 | Boss; also throws boulders (range 8) | Golden Idol 1, Iron Ingot 3–6, plus a chest roll | 600 |

Spawn weights within a biome: Wolf 4, Bear 1.5, Spider 3, Scorpion 4, Sand Lurker 2, Frost Golem 3, Wraith 3.

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

Drops go straight into the bag.

### AI states

`Enemy.update()` runs a small state machine.

| State | Behaviour | Leaves when |
| --- | --- | --- |
| `burrowed` | Hidden, can't be hit | Player within aggro range → `aggro` |
| `patrol` | Wanders at 35% speed: picks a direction, or stands still half the time, for 1–3 s | Player within aggro range → `aggro`, and the pack is alerted |
| `aggro` | Faces the player and shows "!" | After 0.4 s → `chase` |
| `chase` | Runs at the player. Ranged enemies hold position within 60% of their range. | Player farther than 2.5× aggro → `patrol`. In melee reach, or in ranged range but more than twice melee reach, with the attack ready → `attack`. |
| `attack` | Flickers during a 0.3 s wind-up, then hits if the player is within `attackRange + 0.4`, or else fires a projectile if in range | After 0.5 s → `chase` |
| `flee` | Runs away at 110% speed | After 3 s → `patrol` |

- Taking a hit provokes an enemy (patrol or burrowed → aggro).
- A wolf that drops below 20% health flees instead.
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
| Dungeon | 3–5 Skeletons on open floor tiles |
| Boss Arena | 1 Arena Guardian at the centre |
| Sunken Archive (story) | 6 Skeletons |

Killing every guard clears the place:
- the player gets 60 XP and a "cleared!" notice
- the place's anchor goes into `WorldManager.clearedAnchors`, which is saved

**Cleared stays cleared:** a cleared anchor never wakes guards again, even after its region regenerates. If the player leaves before clearing it, the guards despawn and the place resets for the next visit.

**Elder Stag:** every chunk in the simulation area gets one roll per region visit, with a 0.05% chance (`LEGEND_CHANCE`) of an Elder Stag at the chunk's centre. Killing it records `legend@cx,cy` in `clearedAnchors`, so that spot never spawns another.

**Event groups** (bandit ambush, village defence) are tracked the same way, without persistence. Clearing them reports to quests; clearing a village defence also pays 30 coins.

## Progression

`src/systems/Progression.ts`:
- **XP to level up:** going from level `L` to `L + 1` takes `round(40 × L^1.5)` XP.
- **Level cap:** 50.
- **Per level:** each level adds 8 max health and 5% damage, and a skill point. When you level up, current health rises by the same amount as max health.

### Skills

Skill points are spent in the menu's Skills tab. Each skill has 3 ranks; points left = level − 1 − ranks learned.

| Skill | Per rank |
| --- | --- |
| Warrior | +8% damage (multiplies the level bonus) |
| Hunter | +35% chance of one extra of each drop from animals |
| Gatherer | Chopping, mining and picking 15% faster |
| Forager | +30% chance of one extra from plants (berries, herbs, mushrooms, cactus fruit) |
| Swimmer | Swim 10% faster; deep water tires 25% slower |
| Pack Mule | Carry 25 more weight |
| Survivalist | Hunger and thirst drain 10% slower |

Ranks are saved with progression; older saves load with none.

| XP source | Amount |
| --- | --- |
| Killing an enemy | Species XP, scaled by band and elite |
| Clearing a guarded place or event group | 60 |
| Discovering a structure | 15 |
| Quests | 32–150, see [living-world.md](living-world.md#quests) |
| Story milestones | 80 (graves, revision, astronomer), 160 (Hall of Lanterns), 400 (ending) |

See also: [README.md](README.md) · [survival.md](survival.md) · [living-world.md](living-world.md) · [story.md](story.md) · [objects-and-structures.md](objects-and-structures.md)
