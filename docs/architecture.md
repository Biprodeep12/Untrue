# Architecture

How the source is organised, what runs each frame, and how the parts talk to each other.

## Source layout

| Path | Contents |
| --- | --- |
| `src/main.ts` | Entry point. Creates `Game`; dev builds expose it as `window.game`. |
| `src/config.ts` | World constants: tile and chunk size, margins, minimum biome size, region size, speeds. |
| `src/coords.ts` | Chunk keys, region keys and chunk rectangles. |
| `src/style.css` | All HTML UI styling. |
| **`src/game/`** | The game shell. |
| `Game.ts` | Boots PixiJS, owns the frame loop, wires every system together, spawning and saving. |
| `LivingWorld.ts` | Owns time, weather, hazards, NPCs, quests, events, visions, lighting and weather rendering, and the story (`RiftStory`), which plugs in here. |
| `Place.ts` | `Place`: where the player is (the overworld, an `Interior`, or a `RiftTrip`): the player's collision, the combat `Arena`, and the player's spot in the overworld. |
| `RiftTrip.ts` | One trip into an outer dimension: its land, the run, the enemies it asked for and those roaming, the map's fog, and the dimension as a `Place` and combat `Arena`. |
| `Player.ts` | Movement, collision, dodge roll, knockback and invulnerability. |
| `Camera.ts` | Smooth follow and zoom (0.25 to 2). |
| `Input.ts` | Keyboard, mouse, wheel, the touch stick (left half), pinch zoom and tap-to-interact. Game code asks for actions (`act`, `holding`), not keys. |
| `Keys.ts` | Key bindings: each action's main key (`DEFAULT_KEYS`, changeable in Settings), fixed extras such as the arrow keys, `RESERVED_KEYS` (Esc, F3, F4, 1–8) and key names for the screen. |
| `Settings.ts` | Player settings kept in `localStorage`. |
| **`src/world/`** | The streamed world, independent of rendering. |
| `WorldManager.ts` | Ties streaming, biomes, objects, regions and the harvest log together. |
| `ChunkManager.ts` | Visible, render, cache and simulation areas; generation queue; chunk lifecycle. |
| `Chunk.ts` | Chunk buffers and the chunk pool. |
| `GroundItems.ts` | Items lying on the ground, picked up by walking over them, saved with the world. |
| `Interior.ts` | Building interiors, mine caves and the keep's floors, generated from the building's seed; the bookshelves' books. |
| `BiomeManager.ts` | Biome records and chunk ownership. |
| `ObjectManager.ts` | Live world objects indexed by chunk and by kind. |
| `WorldObject.ts` | One object spanning one or more chunks, and how it stamps onto a chunk. |
| `Regions.ts` | Per-region visit counters that drive regeneration. |
| `SyncGenerator.ts` | Main-thread chunk generator for tests. |
| **`src/generation/`** | Pure, seeded generation code. Runs in workers and on the main thread. |
| `TerrainGenerator.ts` | Noise fields (`TerrainFields`) and `generateChunk`. |
| `BiomeGenerator.ts` | Biome footprint growth. |
| `StructureGenerator.ts` | `Layout`, structure layouts, the structure catalogue and the per-chunk roll. |
| `EnemyGenerator.ts` | Enemy spawn rules. |
| `Noise.ts` | Seeded 2D simplex noise. |
| `Random.ts` | Hashing, the `Rng` class and named random streams. |
| `Tiles.ts` | Tile, decoration and biome ids; solidity. |
| `WorldRules.ts` | Difficulty bands by distance. |
| **`src/workers/`** | `worldGenerator.worker.ts` (runs `generateChunk`) and `WorkerGenerator.ts` (the worker pool). |
| **`src/dimension/`** | The outer dimensions behind the rifts, with no rendering: `Dimension.ts` (what a dimension is, and the registry), `DimensionData.ts` (the map's data format, encoding and checking), `DimensionSource.ts` (where maps come from, and the cache), `DimensionWorld.ts` (a dimension's land on the overworld's engine), `DimTile.ts` (site tiles), `Hollow.ts` (how The Hollow plays), `Challenges.ts` (the challenge state machines and `DimensionRun`), `Contribution.ts` (who did what in a run, and each player's share), `bake/hollowMap.ts` (The Hollow's baker). The baked maps are in `public/dimensions/`. See [dimensions.md](dimensions.md). |
| **`src/net/`** | Multiplayer with no server of our own: binary messages, WebRTC links, signaling over Nostr relays (or a BroadcastChannel, or copy-paste codes), the board of open instances, sessions with host migration. Engine-agnostic. See [networking.md](networking.md). |
| **`src/coop/`** | Playing a dimension with others, over `src/net`: `Coop` (find, join or open an instance), `InstanceLink` (one player's part: replication, requests, rewards, host migration), `runSync.ts` (a run on the wire), `interp.ts` (smooth motion), `ids.ts` (what things are called on the wire), `localRelay.ts` (`?net=local`). Loaded lazily, with `src/net`, as one separate file. See [dimensions.md](dimensions.md#playing-with-others). |
| **`src/story/`** | `RiftStory.ts`: the main story, its visions, objective and save. See [story.md](story.md). |
| **`src/entities/`** | `Enemy.ts` (enemy AI), `Species.ts` (enemy roster, damage-type weaknesses and resistances, variants), `NPC.ts` (NPC schedules and following). |
| **`src/items/`** | `Items.ts`: the item catalogue. |
| **`src/systems/`** | Gameplay systems: inventory, crafting, gathering, loot, vitals, progression, combat, NPCs, quests, trade, time, weather, hazards, world events, exploration. |
| **`src/rendering/`** | `Atlas.ts`, `TileRenderer.ts`, `EntityRenderer.ts`, `Buildings.ts`, `InteriorRenderer.ts`, `SiteRenderer.ts` (what changes on a dimension's sites), `GroundItemRenderer.ts`, `Lighting.ts`, `ParticleSystem.ts`, `Effects.ts`, `RiftGlitch.ts` (the world's glitches near a rift). |
| **`src/ui/`** | HTML UI: `Hud`, `Hotbar`, `Menu` (tabs: Inventory, Crafting, Skills, Quests, Map (only inside an outer dimension), Settings, About), `MapView`, `DimensionMap`, `PauseMenu`, `Dialog`, `Vision`, `SleepOverlay`, `DebugOverlay`, `TouchStick`, `ItemIcon`, `Hints` (first-time tips), `Fullscreen` (the Fullscreen API), `About` (privacy, credits, licenses), `Playground` (the story playground panel), `Beacon` (the Drift Beacon's panel). |
| **`src/audio/`** | `AudioSystem.ts`: synthesised sound effects, generated music and weather ambience; see [audio.md](audio.md). |
| **`src/save/`** | `SaveManager.ts`: IndexedDB saves and migration. |

Tests sit next to the code they cover as `*.test.ts`.

## The frame

`Game.tick(dt)` runs once per frame, with `dt` capped at 0.1 seconds:

1. `handleKeys()`: debug overlay, menu, vision paging, Escape, save, zoom, hotbar, use, interact, attack, dodge and the debug far trip.
2. If the player is waiting to be placed (`spawnTarget`), `trySpawn()` looks for open ground once the chunks around the target have loaded.
3. Indoors, `tickIndoors`; in an outer dimension, `tickDimension` (the clock, needs and villagers run as indoors; the player moves on the dimension, combat fights on it, and the run is stepped and its events acted on; see [dimensions.md](dimensions.md)). Otherwise, unless a menu, dialog or vision pauses the world:
   - `LivingWorld.update(dt)`: clock and hourly events, hazards, NPCs, lost travellers and escorts.
   - Blocking state and movement speed (slow status, blocking, weather).
   - `Player.update`, then gathering, then `CombatSystem.update` with the player's body.
   - The camera follows the player.
   - `Vitals.update`; a collapse sends the player to their waking spot (the last rest or Moonwell; the origin before any).
4. `WorldManager.update(view)` with the camera's view in tiles (indoors and in a dimension, a view around the place's `spot` outside, so the world there stays loaded): streaming, biome and object bookkeeping, discovery. `ChunkManager` draws at most 2 waiting chunks, nearest first.
5. The world layer is positioned and scaled for the camera.
6. Indoors, the room renders; in a dimension, its land streams around the camera and its `TileRenderer` culls and animates, the `SiteRenderer` updates the sites in view, then the interaction prompt, entities and the dimension's lighting. Outdoors, `TileRenderer.cull()` hides chunks outside the camera's view, rifts animate, the glitches run near an open rift, and buildings and ground items near the screen update.
7. `updateTarget()`: the interaction prompt and target outline.
8. Rendering updates: tree fading, `EntityRenderer.update`, then `LivingWorld.render` (weather particles, effects, lighting), and the music mood (biome, band, indoors or cave, what is hunting the player).
9. Touch stick, hotbar and menu refresh.
10. Autosave every 30 seconds; every 0.25 seconds, the HUD refresh and first-time tips.
11. `Input.endFrame()` clears one-frame inputs.

The ticker is capped at 60 frames per second (30 with the setting).

## Threads

Terrain generation runs off the main thread so streaming never stalls a frame.

- `ChunkManager` talks to a `ChunkGenerator`: `request(req)` and `onResult(handler)`.
- `WorkerGenerator` runs between 1 and 3 web workers (one fewer than `navigator.hardwareConcurrency`, capped at 3) and hands out requests round-robin. Each worker builds its own `TerrainFields` for the seed and returns tiles and decorations as transferable `Uint8Array` buffers, so nothing is copied.
- `SyncGenerator` runs `generateChunk` on the calling thread and answers immediately. Tests use it.

Only terrain tiles and decorations come from the workers. Biome records, structure rolls, object stamping, enemies and everything else run on the main thread. Structure rolls use the same `TerrainFields` (for flat-ground checks), built on the main thread.

## How systems talk

Systems hold references to what they need and report back through callbacks:

| Hook | Raised by | Used for |
| --- | --- | --- |
| `WorldManager.onDiscover(o)` | The player first stands inside an object | Discovery toast, XP, quest discovery objectives |
| `ChunkListener.show / hide / changed` | `ChunkManager` | `TileRenderer` builds, removes and refreshes chunk meshes |
| `CombatSystem.onKill(enemy)` | An enemy dies | Quest slay objectives |
| `CombatSystem.onCleared(kind)` | A guarded group is wiped out | Quest clear objectives, village defence reward |
| `Arena.killed(enemy)` | An enemy dies on an arena (a dimension) | `DimensionRun.enemyKilled` |
| `DimensionRun.takeEvents()` | Each frame of a trip | `RiftTrip` spawns and removes enemies and scales the boss; `Game.tripEvent` moves the player after a fall, grants rewards, shows notices, closes the rift or leaves |
| `QuestSystem.onComplete(q)` | A quest finishes | Rewards |
| `CombatEvents`, `HazardHooks`, `EventHooks` | Their systems | Damage numbers, swings, hurt flashes, notifications, visions, dialogs |

`WorldManager.now` is a function the game clock provides; the world uses it to timestamp harvests for regrowth.

## Testing

Vitest runs headless. `WorldManager` does not touch the renderer, so tests build a world with a `SyncGenerator` and drive it with `world.update(view)` and hand-made views. The suites cover:

| File | Covers |
| --- | --- |
| `src/world/WorldManager.test.ts` | Streaming, minimum biome size, bounded memory, determinism, multi-chunk lifetime, regeneration |
| `src/world/Buildings.test.ts` | Buildings, interiors, castles, discovery and forgetting, saves that keep the world as it was |
| `src/world/Rivers.test.ts` | Rivers and bridges, the spawn, mines |
| `src/save/SaveManager.test.ts` | Save round trips, migrating older saves, and the Drift (items on the ground, looted chests and cleared lairs forgotten with their region) |
| `src/entities/NPC.test.ts` | NPCs at night |
| `src/systems/Survival.test.ts` | Inventory, crafting, vitals, gathering, chests that stay looted until their region drifts |
| `src/systems/Adventurer.test.ts` | Carrying, skills, places forgetting and the object indexes, the Moonwell, equipment |
| `src/systems/Progress.test.ts` | Sorting the bag, selling a stack, damage types, legends and trophies, rare recipes and the star tier, abandoning and defending in quests, key bindings |
| `src/systems/Combat.test.ts` | Damage, enemy AI, spawning, weapons, dungeons, progression |
| `src/systems/LivingWorld.test.ts` | Time, weather, regrowth, NPCs, quests, trade, events, hazards |
| `src/systems/Exploration.test.ts` | Fog of war, milestones, markers |
| `src/dimension/Dimension.test.ts`, `Challenges.test.ts`, `Contribution.test.ts`, `DimensionWorld.test.ts` | The registry (rift destinations in story order, retuning), the data format (run lengths, checking, refusals), The Hollow's map (baked as shipped, finishable, the vault guarded, the drifted fragments and the Null's marks), every challenge and the run, contribution, attunement and shared instances, the land on the engine (slicing chunks, gathering, letting go), the site renderer's culling and pooling |
| `src/game/RiftTrip.test.ts` | Rift structures (placement, determinism, closing, their dimension), trips (stashing and restoring the overworld's fights, kills and boss phases, closing through the portal), roaming creatures, saving inside, dying inside, the story's objectives, clues, cleared dimensions and its save versions |

See also: [World streaming](world-streaming.md), [Rendering](rendering.md)
