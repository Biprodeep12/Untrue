# Exploration

The map with fog of war, map markers, the compass, and rewards for exploring (spec 6.4).

## Fog of war

`ExplorationSystem` (`src/systems/ExplorationSystem.ts`) remembers every chunk the player has seen. Each frame it walks the render area (`ChunkManager.renderRect`) and records any chunk not yet seen, keyed by its chunk key, with the biome palette it had at that moment (`paletteOf(type, variant) + 1`).

Seen chunks stay on the map after the world unloads them. Biome types are fixed per area (see [world-generation.md](world-generation.md)), so the recorded colours stay accurate even when the area regenerates.

Every `EXPLORE_STEP` (50) newly seen chunks grants `EXPLORE_XP` (20) experience and a notification.

## The map

Maps only work inside the outer dimensions behind the rifts. In the overworld the Map tab is hidden and **M** only says "Maps don't work here: the world won't hold still." (`Game.mapAvailable` is true only on a trip into a dimension). Fog of war, exploration XP and markers are still recorded for the overworld.

**Inside a dimension** the Map tab and **M** show that space instead (`src/ui/DimensionMap.ts`): the tiles the player has seen, one colour per kind of tile, framed on what has been seen so far; each chamber seen into by name, ticked once done; the rift home (pink), the portal (pale cyan once open) and the player (white). Fog is a byte per tile (`RiftTrip.seen`): when the player reaches a new tile, every tile within 6 is marked seen, and a version number rises only if something new was seen. The seen tiles are painted one pixel each into a small canvas only when that version changed, and the map is drawn when the tab opens, never per frame (the menu pauses the game). See [dimensions.md](dimensions.md#the-map).

The overworld map (`src/ui/MapView.ts`), kept for if maps ever work there, draws on a canvas:

| Layer | Drawn as |
| --- | --- |
| Unexplored | Dark background |
| Explored chunks | A square per chunk in its biome colour |
| Markers | Red pins; the tracked one is brighter |
| The player | A white dot |

Drag to pan. Zoom with the + and − buttons, the mouse wheel, or a two-finger pinch on the map (2 to 40 pixels per chunk, opening at 16). The tile coordinates under the cursor show below the map. "Centre on me" recentres on the player.

Pointer positions are measured against the canvas's shown size, so taps and markers land in the right place when a small screen shows the map scaled down. Redraws are batched: however many pointer or wheel events arrive, the map draws at most once per frame (`requestDraw`).

## Markers

Clicking or tapping the map without dragging drops a marker there, named "Marker N". The list beside the map tracks or removes each one. A tracked marker gets a line with a direction arrow in the quest tracker.

## Compass

The compass sits at the top left of the HUD. North is always up (the view never rotates). The needle points toward the tracked marker, if there is one, or else toward the story's objective: the nearest open rift loaded ([story.md](story.md)). Next to it are the player's tile coordinates and the marker's name.

## Saving

Explored chunks (as flat key/value pairs), markers and the tracked marker are saved with the game; see [saves.md](saves.md).

See also: [README.md](README.md) · [story.md](story.md) · [living-world.md](living-world.md) · [rendering.md](rendering.md)
