# Objects and structures

How structures, lakes and other placed things are built, rolled, kept alive and forgotten.

## Layouts

A `Layout` (`src/generation/StructureGenerator.ts`) is a rectangle of two byte arrays stamped over the terrain:

| Array | Value | Meaning |
| --- | --- | --- |
| `tiles` | 0 | Keep the terrain's tile |
| `tiles` | `id + 1` | Replace the tile with `id` |
| `decos` | 0 | Keep the terrain's decoration, unless the tile is replaced (then the cell has no decoration) |
| `decos` | `Deco.Clear` (255) | Remove the terrain's decoration |
| `decos` | any other id | Place that decoration |

Helpers (`tile`, `deco`, `fill`, `border`, `disc`, `clearDecos`, `blit`) build layouts. `rotated(quarters)` and `mirrored()` return turned and flipped copies.

A layout can also carry **buildings**: footprints drawn as single building sprites that the player can walk into. See [buildings-and-interiors.md](buildings-and-interiors.md).

## World objects

A `WorldObject` (`src/world/WorldObject.ts`) is a placed layout: id, kind, name, top-left tile position and layout. On creation it lists every chunk its footprint touches. `stamp(chunk)` writes its part of the layout into a chunk's composed tiles; chests that are opened, or whose anchor was looted before, are drawn as `ChestOpen`.

`ObjectManager` (`src/world/ObjectManager.ts`) keeps live objects in a map and indexes them by chunk (every chunk an object covers) and by kind. Placement checks use the indexes: `collides` looks only at the chunks under the padded rectangle, and `crowded` only at live objects of the same kind.

**Multi-chunk lifetime.** `activeChunks` counts how many of an object's chunks are in the cache area. It rises and falls as chunks enter and leave. When it reaches 0, the object is discarded. So a castle covering 3 × 3 chunks survives while any one of those chunks is still loaded, and only goes once all nine have unloaded.

**Every structure forgets.** There are no persistent or kept objects: villages, castles, mines, nomad camps, the extremely rare structures and the rare events are all discarded when their chunks fully unload, like everything else, and may come back different. Nothing about them is saved. What the player did there still counts where it is keyed by the anchor rather than the object: looted chests stay looted and cleared places stay cleared (below).

## The roll

When a chunk enters the cache area, `WorldManager.resolveAnchor` calls `rollAnchor` for that chunk. Everything rolled there is "anchored" in it. Four independent rolls run, each with its own stream and the region's visit counter:

1. **Rare event.** For each entry in `RARE_EVENTS`, in order, roll against its `chance`; the first hit is placed.
2. **Structure.** With probability `STRUCTURE_CHANCE` (0.22):
   - Candidates are structures whose `minDistance` the chunk's centre has reached and whose biome list (if any) includes the anchor chunk's biome.
   - A tier is picked by weight `TIER_WEIGHTS[t] × (1 + TIER_GROWTH[t] × band)`, with weights 70, 22, 6, 1 and growth 0, 0.3, 1, 2 for common, uncommon, rare and extremely rare.
   - A structure in that tier is picked by its `weight`.
3. **Rift.** From `RIFT.minDistance` (96 tiles) out, a chance by difficulty band (`RIFT_CHANCE`): 1.4%, 2%, 2.8% and 3.6% per chunk from Easy to Extreme. See [Rifts](#rifts).
4. **Lake.** Chance by biome: Forest 6% (Lake), Desert 2.5% (Oasis), Snow 5% (Frozen Lake).

## Placement

`place()` builds the layout with its own `Stream.Layout` generator, rotates it a random number of quarter turns if the structure allows rotation, and mirrors it half the time. It then picks a random tile in the anchor chunk and positions the layout so it covers that tile and stays within one chunk of the anchor on every side. Structures marked `flatGround` are dropped unless their footprint is buildable (no mountain, no river) at every point of a grid over it: 3 × 3 points, or 5 × 5 for layouts over 400 tiles.

`resolveAnchor` then rejects a placement if:

- an object with the same id is already live,
- it comes within 2 tiles of any live object, or
- a live object of the same kind has its centre within the structure's `spacing`.

Ids have the form `kind@cx,cy#visit/slot`. The anchor key `cx,cy/slot` stays the same across visits.

## Structure catalogue

From `STRUCTURES`. Rotation "free" means any quarter turn; "mirror" means flipped only, so building fronts keep facing the camera. Sizes are in tiles.

| Kind | Name | Rarity | Weight | Biomes | Min distance | Spacing | Flat ground | Rotation | Size |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `camp` | Camp | Common | 3 | All | 0 | 60 | Yes | Free | 7–9 |
| `house` | Small House | Common | 3 | All | 0 | 40 | Yes | Mirror | 9–11 × 7–8 |
| `deposit` | Ore Deposit | Common | 2 | All | 0 | 30 | No | Free | 6–8 |
| `ruins` | Ruins | Uncommon | 3 | All | 0 | 100 | Yes | Free | 12–18 × 10–15 |
| `tower` | Tower | Uncommon | 2 | All | 0 | 150 | Yes | Mirror | 9–11 × 10–12 |
| `cabin` | Cabin | Uncommon | 2 | Forest, Snow | 0 | 100 | Yes | Mirror | 14–16 × 8–9 |
| `abandoned-camp` | Abandoned Camp | Uncommon | 2 | All | 0 | 80 | Yes | Free | 8–10 |
| `nomad-camp` | Nomad Camp | Uncommon | 3 | Desert | 120 | 260 | Yes | Mirror | 11 |
| `mine` | Mine | Uncommon | 1 | All | 0 | 150 | No | Mirror | 17 × 14 |
| `village` | Village | Rare | 3 | Forest, Snow | 150 | 500 | Yes | Mirror | 46–56 |
| `temple` | Temple | Rare | 2 | All | 300 | 400 | Yes | Mirror | 20–28 × 22–30 |
| `castle` | Castle | Rare | 2 | Forest, Snow | 400 | 800 | Yes | Mirror | 66–76 |
| `dungeon` | Dungeon | Rare | 2 | All | 250 | 300 | No | Free | 12–16 |
| `giant-city` | Giant City | Extremely rare | 2 | All | 2,500 | 3,000 | Yes | Mirror | 84–94 |
| `sun-temple` | Sun Temple | Extremely rare | 1 | Desert | 2,500 | 3,000 | Yes | Mirror | 32–40 |
| `boss-arena` | Boss Arena | Extremely rare | 2 | All | 2,500 | 3,000 | Yes | Free | 37–45 |
| `standing-stones` | Standing Stones | Extremely rare | 2 | All | 2,500 | 3,000 | No | Free | 19–23 |

Rare events (`RARE_EVENTS`), rolled per anchor chunk before the structure roll:

| Kind | Name | Chance per chunk | Rotation |
| --- | --- | --- | --- |
| `ancient-temple` | Ancient Temple | 0.1% | Mirror |
| `lost-city` | Lost City | 0.01% | Mirror |
| `crystal-monolith` | Crystal Monolith | 0.001% | Free |

**Mines** are cut into a ragged rocky hill (dark rock at its heart, lighter at the edges). A timber-framed entrance (a `mine` building) sits at the foot of the hill, with lamps either side. In front is a dirt yard with rails running out of the entrance to a mine cart, ore heaps, a crate, a barrel and a stone. The entrance leads into a cave; see [buildings-and-interiors.md](buildings-and-interiors.md#mines).

**Nomad camps** (`nomadCamp()`, 11 tiles square) are the desert's travellers, since the desert has no villages: a round patch of path cleared of plants, a campfire in the middle, three tents, an anvil and two barrels. Two people live there: a quest giver and a trader by the fire ([living-world.md](living-world.md#npcs)).

**Villages** (`village()`, 46–56 tiles square) are laid out along streets: a main street right across, through a cobbled square with the well, an anvil, two benches and four lamps; a cross street north to south; and back lanes 12–13 tiles above and below the main street. Houses (6–8 × 5–6) stand in rows on the north side of each street with 2–4 tiles between them, each with a path from its door to the street, flowers or a barrel by the door, and room cleared around it. Lamps line the main and cross streets. Three to five fenced gardens of tilled soil with rows of vegetables fill open ground. Trees are cleared only on the streets, the square and around houses, so the village sits among trees.

**Castles** (`castle()`) stand in a moat (shallow at the banks, deep in the middle) crossed by a two-tile drawbridge. Inside it, a curtain wall two tiles thick has round towers at the corners and midway along the east and west walls, and two towers flank the gatehouse. A paved road runs from the gate past lamps to a square before the keep, with a well, a statue and banners. The keep (a `keep` building, 18–22 × 7) stands at the head of the courtyard, with banners along the north wall and a fenced kitchen garden on each side. Two barracks (`stone`) face the road with paths to it; below them are a training yard (three dummies, a weapon rack and an armour stand), a smithy (an anvil, a crate and a barrel) and a stable (a `cabin`). The paved parts are cleared of trees; the rest of the courtyard keeps its own.

Building footprints keep the ground they stand on: `building()` marks the footprint with an invisible solid decoration (`Deco.Footprint`) instead of a tile, so nothing but the sprite and its own ground ever shows around a building's outline. `clearDecos()` only clears where the layout has not placed anything, and `areaFree()` treats footprints as taken.

Villages, castles and nomad camps hold an anvil, a crafting station. Camps and nomad camps have a campfire, the other station and a place to rest, beside a canvas tent (abandoned camps keep the tent but not the fire). Villages have lamp posts along their roads that light up at night.

**Ruins** are the shell of an old stone hall: outer walls that stand in runs and collapse in others (switching about every six tiles, with fallen stones spilling inward), a gap in the south wall, an inner wall with a doorway, a colonnade with some pillars fallen to rubble, overgrown patches where the floor has given way, and bushes and flowers creeping in. Chests are always found in castles, dungeons, the Sun Temple, ancient temples and lost cities, and sometimes in villages, temples, towers, ruins, cabins and abandoned camps.

## Rifts

Tears in the air onto an outer dimension, the heart of the [story](story.md). `rift()` builds a 7 × 7 layout: decorations cleared, a disc of scorched, violet-veined ground (`Tile.RiftGround`) and the tear (`Deco.Rift`, solid) in the middle. The definition is `RIFT` in `StructureGenerator.ts` (kind `rift`, flat ground, spacing 160, mirror only); it is rolled on its own rather than through the tiers, so rifts grow commoner with distance however many other structures there are. A world event can also tear one open near the player ("A rift tears open nearby.", see [living-world.md](living-world.md)).

Like every structure a rift is temporary. Its object id (which includes the region's visit) seeds the dimension behind it, so the same rift always leads to the same space. Facing the tear, E enters it ([dimensions.md](dimensions.md)).

**Closed rifts.** Closing a rift calls `WorldManager.closeRift`: the object is marked `closed`, so it stamps a faint scar (`Deco.RiftScar`, not solid) instead of the tear, and its id goes into `clearedAnchors`, so a re-roll of the same object (its chunks came back before its region regenerated) is closed too. Since the id changes with the region's visit, a regenerated region may open a new rift in the same place. `WorldManager.nearestRift` finds the nearest open rift among live objects (through `ObjectManager.ofKind`) for the story's arrow and the glitches around it.

## Lakes

`lake()` builds a natural-looking lake rather than an ellipse:

1. Two to four overlapping elliptical lobes, with positions and radii scaled to a rolled size of 18 to 58 tiles.
2. The sample position is warped by noise (±4 tiles) and a little fractal noise is added, so the edge has bays and points.
3. Two smoothing passes remove single-tile notches; water patches under 20 tiles and land patches under 6 tiles (islands not touching the edge) are flipped.
4. A two-pass chamfer distance transform measures distance from the shore, inward and outward.
5. Water more than about 3 tiles from shore (wobbling with noise) is deep. The beach is patchy: mostly one ring of shore tiles, with a second ring where noise allows.
6. Desert lakes (oases) get palms on the outer beach ring. Snow lakes are ice with a few open-water holes in the deep middle.
7. The layout is cropped to its contents so its collision box stays tight.

## Chests, cleared places and harvesting

**Chests never refill.** Opening a chest marks it opened on its object and adds the object's anchor key to `WorldManager.lootedAnchors`. If the region later regenerates and a new structure rolls at the same anchor, every chest in it starts open and empty. Chest loot is seeded by the object id and chest position.

**Cleared places stay cleared.** Dungeons, boss arenas and legendary creatures record a key in `WorldManager.clearedAnchors` when their guards fall, and never wake again. Closed rifts are recorded by object id instead, so they stay closed only while their region stands (above).

**Harvest log.** Gathering a decoration records the cell, its decoration and the in-game minute, per chunk, tagged with the region's visit counter. Composition removes those decorations while the record's visit matches. When the region regenerates, the record no longer applies and is deleted. Bushes and flowers grow back after 1,440 in-game minutes and mushrooms after 2,160 (`REGROW_MINUTES`), checked once per in-game hour by `WorldManager.regrow()`.

## Other placed objects

Some objects are not rolled with the terrain: **world events** (`src/systems/WorldEvents.ts`) place a meteor crater, buried treasure, a risen obelisk, a rift or a Moonwell on open, loaded ground near the player. They go through `WorldManager.addObject`, so they stamp, stream and are forgotten like any other object.

See also: [World generation](world-generation.md), [World streaming](world-streaming.md), [Saves](saves.md)
