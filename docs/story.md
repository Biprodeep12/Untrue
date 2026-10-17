# Story

The world has started to forget itself. Paths lead somewhere else from one day to the next, wells move in the night, valleys are not where the old maps put them. It began when rifts tore open all over the land: tears hanging in the air, burning violet at the edges, each one onto an outer dimension. Around them the land stutters and glitches. Something on the other side is calling.

Why any of it is happening is left for later: the story hints and explains nothing. For now the player's thread is simple: find a rift, step through, survive what waits inside, and close it. The world is still open to explore around it.

## In play

| Objective (HUD tracker) | Shown when | Arrow |
| --- | --- | --- |
| Find a rift | No rift closed yet, and none within 14 tiles | Toward the nearest open rift loaded, if any |
| Enter the rift | No rift closed yet, and an open rift within 14 tiles | Toward it |
| Survive The Hollow: *k*/4 chambers | Inside a dimension, its way home still shut | None |
| Close the rift: step through the portal | Inside, once its boss has fallen | None |
| Rifts closed: *N* | Once a rift has been closed, in the overworld | Toward the nearest open rift loaded, if any |

The objective is always the tracker's first line, and the compass needle points where its arrow does unless a map marker is tracked ([exploration.md](exploration.md#compass)). "Loaded" means a live rift object, within the cache area around the player; rifts further out are not known.

- **A new world** opens with a vision of three pages, *Rifts*, once the opening screen has cleared (`RiftStory.intro`).
- **Closing the first rift** shows a one-page vision, *The Tear Seals*: the land holds still for a moment, and the call comes again from further off. Every rift closed counts toward "Rifts closed", and is worth 150 XP.
- **Leaving without closing** (stepping back onto the rift, or dying inside) leaves the rift open; the objective goes back to "Enter the rift".

Where rifts come from, how often, and what closing one does to the world: [objects-and-structures.md](objects-and-structures.md#rifts). What is behind them: [dimensions.md](dimensions.md).

## Implementation

`RiftStory` (`src/story/RiftStory.ts`) holds the story's state: rifts closed and whether the player has ever entered one. It is built in `LivingWorld`'s constructor (the seam where a story plugs in) with a function that shows a `Vision`.

| Seam | What the story does |
| --- | --- |
| `LivingWorld.tracker()` | `objective(at, rift, run)` puts the objective first. `at` is the player's spot in the overworld, `rift` the centre of `WorldManager.nearestRift` (live, open rifts only), and `run` the trip in progress (`LivingWorld.trip`, set by `Game`; chambers done, chambers in all, whether the portal is open) |
| `Game.loaded()` | On a new world (not a loaded save, not the playground), `intro()` after the opening screen |
| `Game.enterRift` / `exitRift` | `onEnter()`; `onClosed()` when the portal closed the rift |
| `LivingWorld.save()` / `load()` | `rift: { version: 1, closed, entered }` in the living save; a save without it (from before the rifts) starts at "Find a rift", without the intro |

Nothing in the story runs per frame: the tracker is refreshed with the HUD, four times a second.

**Testing.** The story playground (`?playground`, development builds; [README.md](README.md#url-parameters)) has the rift tools: "Rift nearby" tears one open beside the player, "Enter the Hollow" jumps straight into a dimension (through the nearest rift, opening one if need be), and "→ Combat", "→ Path", "→ Puzzle", "→ Boss" and "→ Vault" skip to that chamber with the ones before it done (`DimensionRun.skipTo`). The playground shows no intro vision and never saves.

See also: [README.md](README.md) · [dimensions.md](dimensions.md) · [living-world.md](living-world.md) · [exploration.md](exploration.md)
