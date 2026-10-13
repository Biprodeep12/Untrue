# Exploration

The world map with fog of war, map markers, the compass, and rewards for exploring (spec 6.4).

## Fog of war

`ExplorationSystem` (`src/systems/ExplorationSystem.ts`) remembers every chunk the player has seen. Each frame it walks the render area (`ChunkManager.renderRect`) and records any chunk not yet seen, keyed by its chunk key, with the biome palette it had at that moment (`paletteOf(type, variant) + 1`).

Seen chunks stay on the map after the world unloads them. Biome types are fixed per area (see [world-generation.md](world-generation.md)), so the recorded colours stay accurate even when the area regenerates.

Every `EXPLORE_STEP` (50) newly seen chunks grants `EXPLORE_XP` (20) experience and a notification.

## The map

The menu's Map tab (`src/ui/MapView.ts`), also opened with **M**, draws on a canvas:

| Layer | Drawn as |
| --- | --- |
| Unexplored | Dark background |
| Explored chunks | A square per chunk in its biome colour |
| Forgotten places (lantern memories) | Dashed blue outlines |
| Discovered places still standing | Cream dots, labelled when zoomed in |
| Story places | Larger gold dots, always labelled |
| The story's next destination | A gold star, even before it is explored |
| Markers | Red pins; the tracked one is brighter |
| The player | A white dot |

Discovered places come from `WorldManager.known`, a register of every place the player has found that is still standing, loaded or not. It is saved, so the map keeps every dot across reloads. When a known place regenerates after a reload (same region visit), it comes back already discovered, with no second "Discovered" notice or XP. When it is discarded, it leaves the register and the lantern remembers it. A known place that never comes back once its whole neighbourhood is loaded (its area changed while the game was closed) is also turned into a lantern memory.

Drag to pan. Zoom with the + and − buttons, the mouse wheel, or a two-finger pinch on the map (2 to 40 pixels per chunk, opening at 16). The tile coordinates under the cursor show below the map. "Centre on me" recentres on the player.

Pointer positions are measured against the canvas's shown size, so taps and markers land in the right place when a small screen shows the map scaled down. Redraws are batched: however many pointer or wheel events arrive, the map draws at most once per frame (`requestDraw`).

## Markers

Clicking or tapping the map without dragging drops a marker there, named "Marker N". The list beside the map tracks or removes each one. A tracked marker gets a line with a direction arrow in the quest tracker.

## Compass

The compass sits at the top left of the HUD. North is always up (the view never rotates). The needle points toward the story's current objective, or, if there is none, the tracked marker. Next to it are the player's tile coordinates and the destination's name.

## Saving

Explored chunks (as flat key/value pairs), markers and the tracked marker are saved with the game; see [saves.md](saves.md).

See also: [README.md](README.md) · [story.md](story.md) · [living-world.md](living-world.md) · [rendering.md](rendering.md)
