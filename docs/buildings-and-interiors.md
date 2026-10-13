# Buildings and interiors

How houses, cabins, keeps and city buildings are drawn, and how the player walks inside them.

## Building specs

A structure layout can carry buildings (`Layout.buildings`, `BuildingSpec` in `src/generation/StructureGenerator.ts`):

| Field | Meaning |
| --- | --- |
| `x`, `y`, `w`, `h` | The footprint, in tiles from the layout's top-left |
| `door` | The door's column, counted from the footprint's left edge; the door is in the bottom row |
| `style` | `house`, `cabin`, `stone`, `keep`, `city` or `mine` |
| `seed` | Seeds the building's look and its interior |

`building()` fills the footprint with `Tile.Building` (solid, hidden under the sprite), puts a `Path` doorstep below the door, and records the spec.

| Structure | Buildings and style |
| --- | --- |
| Small House | One `house` |
| Cabin | One `cabin` |
| Village (and the Village of Graves) | Rows of `house`s along the streets |
| Castle | The keep (`keep`), two barracks (`stone`) and a stable (`cabin`) |
| Giant City, Lost City | One `city` building per block, except under the central plaza. In a Lost City about 30% have fallen to rubble. |
| Quiet Cabin | One `cabin` |
| Mine | One `mine` entrance (5 × 3, door in the middle) |

Buildings always face the camera, so layouts with buildings never rotate (`rotated()` refuses them); they can still mirror, and `mirrored()` flips each spec and its door. `blit()` copies a layout into a bigger one, buildings included.

## Drawing

`BuildingRenderer` (`src/rendering/Buildings.ts`) paints each building once into a canvas texture. Everything about its look comes from the building's seed (`lookOf()`), so a house always looks the same:

| Style | Walls | Roofs | Extras |
| --- | --- | --- | --- |
| `house` | Clapboard siding in one of seven colours with white corner boards (50%), red brick with stone quoins (18%), a plastered cottage on a fieldstone footing (18%), or plaster (14%) | A-frame; seven roof colours | Shutters (60%), flower boxes (60%), a covered porch on posts (45%), wall lamp (50%), moss (20%) |
| `cabin` | Stacked logs with round, ringed ends | A-frame | Covered porch, shutters, lamp, moss on the roof (60%) |
| `city` | Plaster with an exposed timber frame and corner braces | A-frame (50%), hip or side gable; terracotta or slate | Shutters, flower boxes, lamp, weathervane |
| `stone` | Fitted stone blocks | Slate hip | Arched windows, wall lamp |
| `keep` | Fitted stone blocks, two storeys | Battlements over a flagstone roof walk; round corner turrets with slate cones and pennants | See below |

**The keep** (`paintKeep()`) rises 50 pixels above its footprint and reaches 6 pixels past it on each side. Its two-storey wall has a string course between the floors, a splayed plinth, battlements with their shadow, and a roof walk behind them with a back parapet. In the middle is a great arched double door (voussoirs, studs, a raised portcullis showing its teeth) on a wide step, flanked by long red banners with a gold emblem. Windows are tall and arched on the ground floor and smaller above, all lit at night. Ivy climbs the old stone. At each end stands a round turret, shaded like a cylinder, with arrow slits, a ring of corbels, a slate cone (snow-capped in the snow) and a red pennant.

- **Roofs.** All roofs are staggered courses of chunky clay tiles (`makeShingles()`, 7 × 6 pixels): each tile has a lit top lip, a seam and highlight at its side, rounded lower corners, and a shadow where the next course overlaps it, and each varies a little in tone. Roofs are lighter at the top and darker toward the eaves; slopes facing the light (the front, the left hip, the left side of a gable) are bright and the others much darker. The roof's thickness shows along every eave (`eaveEdge()`: tile ends over a dark underside) and above every bargeboard, the ridge is a rounded cap of short tiles, and the eaves cast a deep shadow onto the walls below. Chimneys show a front face, a darker side face and a capped top. An **A-frame** (`aFrame()`, every house and cabin) is a peaked roof with its gable facing the viewer: below the white bargeboards is the gable wall, a triangle with a round attic window; above them the roof surface slopes back to a rounded ridge, so the building's outline is peaked, not a box. Its pitch (40–52% of the roof's height is gable, the rest roof surface) varies by seed, its tile courses run parallel to the slopes, and the left slope is lit while the right is in shade. A chimney rises from one slope. A **covered porch** is a small A-frame over the door on two wooden posts, open and shaded underneath. A **hip** roof (barracks, some city buildings) slopes at both ends; a **side gable** runs straight across between bargeboards; both may get a dormer and a chimney.
- **Snow.** Buildings standing in a snow biome are painted with snow on the roof (thick near the ridge, a ragged edge), on the chimney cap and dormer, and a few icicles along the eave.
- **Wall height:** at least the style's base (30–34 pixels), growing to 46% of the footprint's depth (up to 52), so deep buildings never turn into all roof. Windows sit halfway up the wall, every other column out from the door, with framed glass, a glint, curtains, a sill, and (by look) shutters in the house's accent colour and flower boxes.
- **Door:** an arched door in a frame, painted in the accent colour (plain wood on cabins and stone), with planks, iron hinges, a brass knob and a little window, on a stone step; sometimes under a small porch roof, with a wall lamp beside it.
- **Light and shade:** shade under the eaves, a darker far end of the wall, a plinth of fitted stones, a dark outline, and a soft shadow cast on the ground to the right.

**Performance.** Painting a house takes about 3 ms. At most two new buildings are painted per frame (the rest appear on the next frames), and up to 48 paintings are cached; older ones that are off screen are freed. Each building is one sprite, so a village costs a handful of draw calls.

A `mine` is drawn differently: a rock face with a ragged, mossy top and boulders, a tunnel mouth that darkens inward with rails running into it, a timber frame (posts, lintel and corner braces), a sign with a pick and hammer, a hanging lantern (its night light) and rubble at the foot.

The sprite overhangs the footprint by 4 pixels on each side (plus 6 for the cast shadow) and rises 18 pixels above it for the roof and chimney.

Sprites are created for buildings that touch the render area, sorted by their footprint's bottom edge so the player walks in front of and behind them, and drawn at 50% opacity while the player is behind one. At night every window, attic window, dormer and wall lamp is a warm light (radius 1.8 tiles).

## Walls with height

Outside of buildings, stone and wood walls (castle walls, towers, ruins, city walls, the observatory, the archive) are tiles. `TileRenderer` draws a wall with a matching wall below it as its top (capstones, or log ends) and a wall with anything else below it as its front face (`StoneWallFace`, `WoodWallFace`: bricks or planks, a lit lip and a shadow at the foot). Walls two tiles thick therefore read as raised walls. A chunk's bottom row looks at the chunk below, and the chunk above is redrawn when its lower neighbour appears.

## Entering

Facing a building's door outdoors shows **E Enter**. Pressing E builds an `Interior` (`src/world/Interior.ts`) and switches the view:

- The world view hides and the interior view shows; the player sprite moves into the room.
- The world keeps streaming around the door outside, so nothing unloads.
- The clock, events, NPC schedules and vitals keep running (`LivingWorld.updateIndoors`). Weather does not reach indoors, and enemies outside wait.
- Lighting is dimmer than outdoors at night (60% of the night's darkness), lit by the room's fireplace and lamps.
- There is no fighting indoors: attacks do nothing, since combat still runs at the door outside.
- Crafting stations count only if the room itself has them, not the world outside the door.
- What does not fit in the bag (loot, rewards) is left on the ground outside the door.
- Walking out over the doormat leaves, onto the doorstep outside.
- Saving indoors records the spot outside the door, so a reload starts outside.

## Rooms

Interiors are generated from the building's seed, so a room is the same every visit:

| Part | Rule |
| --- | --- |
| Size | Building size plus 4, between 9 × 8 and 16 × 12 tiles |
| Walls | A dark ceiling edge around the room, and two rows of wallpaper over wainscot at the back |
| Floor | Wood for houses and cabins; stone for stone buildings, keeps and city buildings |
| Rug | A 4 × 3 rug in the middle, and a doormat at the exit |
| Back wall | A fireplace, a bed, and one or two bookshelves (three in a keep, plus a banner) |
| Middle | A table with a chair on each side |
| Corners | Potted plants, crates and barrels; sometimes a lamp |
| Chest | Chance by style: house 50%, cabin 60%, stone 40%, keep 80%, city 50% |

The walk from the door is always kept clear.

| Thing | E does |
| --- | --- |
| Bed | Sleep until morning, at dusk or night (or during the story's night in the village); otherwise "too early". The spot outside the door becomes the waking spot after a collapse. |
| Bookshelf | Read a line from one of the books (`BOOKS` in `src/story/StoryScript.ts`) |
| Chest | Loot it once. Interior chests use ids from 1,000,000 up in the object's opened set, and follow the never-refill rule with the rest. |
| Resident | Talk to them |

## Mines

A `mine` entrance leads into a cave instead of a room (`Interior.dig`):

| Part | Rule |
| --- | --- |
| Size | 20 × 16 tiles |
| Shape | A main chamber (an ellipse with ragged edges) and four random side pockets, plus a three-wide tunnel from the entrance |
| Rock | `CaveWall` (a rock face) where rock has floor below it, `RockDark` beside the floor, `CaveRoof` (near black) deeper in |
| Floor | `MineFloor` (dirt and gravel), 8% `Rubble`; `Rail` up the tunnel to a mine cart |
| Props | A timber `SupportBeam` at every fourth spot along the back walls |
| Against the walls | 3 lamps, 6–9 ore, 1–3 crystals (55% of mines), 3–5 stones, a crate, a barrel, and a chest 55% of the time; never next to each other |

Anything the player could not walk up to from the entrance is removed. Caves are always dark (at least 75% darkness, more at night), lit by the lamps, the player's light, and daylight from the entrance.

Ore, crystals and stones are mined as outdoors (same tools, times and drops; see [survival.md](survival.md#gathering)), with a progress bar over the rock. `GatheringSystem.ground` is the `Interior` while inside, so drops are seeded per mine and tile. Rarer finds depend on the difficulty band of the mine's door outside (`GatheringSystem.bandAt`). Mined rock is recorded in the object's opened set (ids from 2,000,000 up) and stays gone for as long as the mine stands.

## Castle keeps

A keep's door leads into a building of three floors, 22 × 16 tiles each, joined by stairs (`Interior.keepFloor()`). Facing stairs, E goes up or down (**E Go up to the upper floor**); the HUD shows the floor's name, and the player arrives by the stairs on the other floor. Only the great hall has the way out.

| Floor | Name | What is there |
| --- | --- | --- |
| 1 | Upper Floor | Wooden floors and papered walls; a corridor with a runner, lamps and a banner, off which open a library (four bookshelves, a reading table), a bedchamber (two beds, a fireplace, a rug, a chest) and an armory (weapon racks, an armour stand, a training dummy, and the stairs down) |
| 0 | Great Hall | A red carpet from the door to a gilded throne on a dais between banners; two rows of pillars; feast tables with chairs on both sides; fireplaces; armour stands; lamps; stairs up and down |
| −1 | Cellar | Dark (like a mine); rows of barrels and crates, pillars, scattered rubble, lamps, and two treasure chests |

Floors are generated from the building's seed and the floor number, so each is the same every visit. Chests and mined rock on each floor have their own ids in the object's opened set (floor 0 keeps the old ids, so saves still work). Anything that cannot be walked up to from the stairs or door is removed.

**Barracks** have a row of bunks along the back wall, a weapon rack and an armour stand, a table with chairs, a barrel, a crate, a lamp, and sometimes a chest.

## Residents

Villagers who went home for the night (see [living-world.md](living-world.md)) are inside the building whose door they went through. They stand at spots around the table and can be talked to as usual: quests, hand-ins and trade all work indoors.

## Saving

Building specs are saved with persistent objects (version 6); see [saves.md](saves.md).

See also: [README.md](README.md) · [objects-and-structures.md](objects-and-structures.md) · [rendering.md](rendering.md) · [living-world.md](living-world.md)
