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
| `LivingWorld.ts` | Owns time, weather, hazards, NPCs, quests, events, the story, lighting and weather rendering. |
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
| `Interior.ts` | Building interiors, mine caves and the keep's floors, generated from the building's seed. |
| `BiomeManager.ts` | Biome records and chunk ownership. |
| `ObjectManager.ts` | Live world objects indexed by chunk. |
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
| **`src/entities/`** | `Enemy.ts` (enemy AI), `Species.ts` (enemy roster, damage-type weaknesses and resistances, variants), `NPC.ts` (NPC schedules and following). |
| **`src/items/`** | `Items.ts`: the item catalogue. |
| **`src/systems/`** | Gameplay systems: inventory, crafting, gathering, loot, vitals, progression, combat, NPCs, quests, trade, time, weather, hazards, world events, exploration. |
| **`src/story/`** | `StorySystem.ts`, `StoryPlaces.ts` (story landmarks), `StoryScript.ts` (all story text). |
| **`src/rendering/`** | `Atlas.ts`, `TileRenderer.ts`, `EntityRenderer.ts`, `Buildings.ts`, `InteriorRenderer.ts`, `GroundItemRenderer.ts`, `Lighting.ts`, `ParticleSystem.ts`, `Effects.ts`. |
| **`src/ui/`** | HTML UI: `Hud`, `Hotbar`, `Menu` (tabs: Inventory, Crafting, Skills, Quests, Map, Lantern, Settings, About), `MapView`, `PauseMenu`, `Dialog`, `Vision`, `SleepOverlay`, `DebugOverlay`, `TouchStick`, `ItemIcon`, `Hints` (first-time tips), `Fullscreen` (the Fullscreen API), `About` (privacy, credits, licenses), `Playground` (the story playground panel). |
| **`src/audio/`** | `AudioSystem.ts`: synthesised sound effects, generated music and weather ambience; see [audio.md](audio.md). |
| **`src/save/`** | `SaveManager.ts`: IndexedDB saves and migration. |

Tests sit next to the code they cover as `*.test.ts`.

## The frame

`Game.tick(dt)` runs once per frame, with `dt` capped at 0.1 seconds:

1. `handleKeys()`: debug overlay, menu, vision paging, Escape, save, zoom, hotbar, use, interact, attack, dodge and the debug far trip.
2. If the player is waiting to be placed (`spawnTarget`), `trySpawn()` looks for open ground once the chunks around the target have loaded.
3. Otherwise, unless a menu, dialog or vision pauses the world:
   - `LivingWorld.update(dt)`: clock and hourly events, hazards, NPCs, the story, lost travellers and escorts.
   - Blocking state and movement speed (slow status, blocking, weather).
   - `Player.update`, then gathering, then `CombatSystem.update` with the player's body.
   - The camera follows the player.
   - `Vitals.update`; a collapse sends the player to their waking spot (the last rest, Moonwell or story stage; the origin before any).
4. `WorldManager.update(view)` with the camera's view in tiles: streaming, biome and object bookkeeping, discovery. `ChunkManager` draws at most 2 waiting chunks, nearest first.
5. The world layer is positioned and scaled for the camera.
6. `TileRenderer.cull()` hides chunks outside the camera's view; buildings and ground items near the screen update.
7. `updateTarget()`: the interaction prompt and target outline.
8. Rendering updates: tree fading, `EntityRenderer.update`, then `LivingWorld.render` (weather particles, effects, lighting), and the music mood (biome, band, indoors or cave, what is hunting the player).
9. Touch stick, hotbar and menu refresh.
10. Autosave every 30 seconds; every 0.25 seconds, the HUD refresh, first-time tips and the check for a new story stage (which moves the waking spot).
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
| `WorldManager.onDiscover(o)` | The player first stands inside an object | Discovery toast, XP, quest discovery objectives, lantern whispers |
| `WorldManager.onForget(o)` | A discovered object is discarded | The story's lantern memories (`StorySystem` sets it) |
| `ObjectManager.onDiscard(o)` | Any object is discarded | Forwarded by `WorldManager` to `onForget` |
| `ChunkListener.show / hide / changed` | `ChunkManager` | `TileRenderer` builds, removes and refreshes chunk meshes |
| `CombatSystem.onKill(enemy)` | An enemy dies | Quest slay objectives |
| `CombatSystem.onCleared(kind)` | A guarded group is wiped out | Quest clear objectives, village defence reward |
| `QuestSystem.onComplete(q)` | A quest finishes | Rewards |
| `CombatEvents`, `HazardHooks`, `EventHooks`, `StoryHooks` | Their systems | Damage numbers, swings, hurt flashes, notifications, visions, dialogs |

`WorldManager.now` is a function the game clock provides; the world uses it to timestamp harvests for regrowth.

## Testing

Vitest runs headless. `WorldManager` does not touch the renderer, so tests build a world with a `SyncGenerator` and drive it with `world.update(view)` and hand-made views. The suites cover:

| File | Covers |
| --- | --- |
| `src/world/WorldManager.test.ts` | Streaming, minimum biome size, bounded memory, determinism, multi-chunk lifetime, regeneration |
| `src/world/Buildings.test.ts` | Buildings, interiors, castles, discovered places, saves that keep the world as it was |
| `src/world/Rivers.test.ts` | Rivers and bridges, the spawn, mines |
| `src/save/SaveManager.test.ts` | Persistent finds and save round trips |
| `src/entities/NPC.test.ts` | NPCs at night |
| `src/systems/Survival.test.ts` | Inventory, crafting, vitals, gathering, chests that never refill |
| `src/systems/Adventurer.test.ts` | Carrying, skills, semi-persistent places, the Moonwell, equipment |
| `src/systems/Progress.test.ts` | Sorting the bag, selling a stack, damage types, legends and trophies, rare recipes and the star tier, abandoning and defending in quests, key bindings |
| `src/systems/Combat.test.ts` | Damage, enemy AI, spawning, weapons, dungeons, progression |
| `src/systems/LivingWorld.test.ts` | Time, weather, regrowth, NPCs, quests, trade, events, hazards |
| `src/systems/Exploration.test.ts` | Fog of war, milestones, markers |
| `src/story/Story.test.ts` | Story places and a full playthrough to an ending |

See also: [World streaming](world-streaming.md), [Rendering](rendering.md)
