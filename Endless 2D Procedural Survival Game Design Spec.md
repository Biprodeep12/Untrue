# Endless 2D Procedural Survival Game: Design Spec

## 1. Overview

An endless 2D survival and exploration game whose world is generated on demand and discarded once the player leaves. Because discarded areas are not stored, they can regenerate differently on a later visit. The world is memory-efficient and evolving rather than infinitely saved. Its look, UI and feel follow Stardew Valley: top-down pixel art with a warm, cozy tone.

The game's story, The World That Forgets, lives in its own document: [docs/story.md](docs/story.md). It turns the world's regeneration into the story's central mystery.

### Design pillars

- **Endless world.** No map boundary. Only chunks near the player exist in memory.
- **Fully procedural.** Terrain, biomes, structures, resources and enemies come from rules and seeded randomness, not stored maps.
- **Multi-chunk objects.** A castle, lake or mountain can span many chunks and still behave as one object.
- **Temporary world state.** An object lives while any chunk it occupies is active, then is discarded.
- **Evolving world.** Discarded areas can regenerate differently. Only objects marked persistent are guaranteed to remain.
- **The player is an adventurer.** They explore, fight and gather, but never build houses or place building blocks.

## 2. World streaming

The world is a grid of fixed-size chunks with coordinates that extend indefinitely. Chunks are generated around the player and disposed of behind them.

### 2.1 Radii

The render area is derived from the screen. The simulation and cache radii are configurable. Current values: chunks are 32 × 32 tiles of 16 px, the simulation radius is 2 chunks around the player's chunk, and the cache radius is the render area plus 2 chunks on every side.

| Radius | What happens inside it |
| --- | --- |
| Render | Chunks are drawn |
| Simulation | Entities, AI and world events are updated |
| Cache | Chunks stay in memory but are not simulated |

### 2.2 Render margin

The render area is always the visible area plus a one-chunk margin on every side. A screen that shows 4 × 4 chunks renders 6 × 6. The render area scales the same way with screen size and zoom, so the player never sees a chunk appear at the screen edge. The cache radius must always cover the render area.

### 2.3 Chunk lifecycle

1. **Predict.** Queue chunks ahead of the player, based on direction of travel.
2. **Generate.** Build queued chunks in the background, nearest and most likely first.
3. **Activate.** Start rendering and simulating a chunk when it enters the relevant radius.
4. **Deactivate.** Stop simulating a chunk when it leaves the simulation radius.
5. **Dispose.** Destroy a chunk when it leaves the cache radius and return it to the pool.

## 3. Procedural generation

Everything in the world is computed from rules and a seed. Nothing is authored as a fixed map.

### 3.1 Terrain

Terrain is shaped by layered noise fields. The same fields pick a biome's type when the biome is first generated (section 3.2):

```text
Height + Moisture + Temperature + Erosion + Randomness  →  Biome
```

| Category | Features |
| --- | --- |
| Landforms | Mountains, hills, plains, valleys, cliffs, beaches |
| Water | Rivers, lakes, swamps |
| Underground | Caves, underground areas |
| Climate regions | Forests, deserts, snow regions |

### 3.2 Biomes

Each biome defines its own terrain, resources, enemies, structures and weather. Biomes blend at their borders and can have rare variants.

| Biome | Features | Enemies | Structures |
| --- | --- | --- | --- |
| Forest | Trees, mushrooms, wildlife | Wolves, bears, spiders | Ruins, cabins |
| Desert | Cactus, oases, sandstorms | Scorpions, sand creatures | Ruins |
| Snow | Snow, ice, pine trees | Wolves, ice creatures | Frozen structures |

#### Biome size and lifetime

A biome is generated once, as a single region, the first time any part of it enters the render area. Its size and shape then stay fixed for as long as it is loaded, so every chunk inside it generates consistently.

1. **Trigger.** A chunk enters the cache radius where no biome record exists. (Cache rather than render, so structures anchored next to the render area know their biome before they are drawn.)
2. **Type.** The biome type is picked from the climate noise at that point and the world-scale rules. Growth prefers chunks whose climate matches, so an area keeps its type across regenerations.
3. **Size.** A size is rolled, never below the minimum biome size.
4. **Shape.** The region grows outward from that point with noise-roughened borders. It stops where it meets a neighbouring biome that is already loaded.
5. **Store.** The biome record (type, footprint, borders) is kept in memory.
6. **Generate.** Every chunk in the footprint reads the record for its terrain, resources, enemies and structures.
7. **Discard.** The record is dropped once the player has left the biome and none of its chunks remain inside the cache radius.

Rules:

- **Minimum size.** Every biome covers at least a fixed minimum area, set by one hardcoded constant (64 chunks). This prevents slivers and tiny patches. A biome hemmed in below the minimum joins the neighbour it touches most.
- **One record, many chunks.** A biome follows the same lifetime rule as a multi-chunk object (section 4.1).
- **Temporary by default.** A discarded biome is not saved. The same area can generate with a different size, shape, variant and contents on a later visit. Its type stays fixed by climate.

### 3.3 Structures and points of interest

Structures are placed by probability plus rules. Larger ones can span multiple chunks (see section 4).

| Rarity | Examples |
| --- | --- |
| Common | Small houses, camps, trees, rocks, resource deposits |
| Uncommon | Ruins, towers, cabins, abandoned camps, caves, mines |
| Rare | Villages, temples, castles, dungeons, ancient ruins |
| Extremely rare | Giant cities, special temples, boss arenas, legendary locations, unique landmarks |

Each structure definition carries these placement inputs:

- Probability
- Biome requirement
- Terrain requirement
- Distance requirement
- Size
- Orientation

### 3.4 Randomness

- Seeded RNG with independent random streams per system
- Weighted selection from probability tables
- Rarity tiers and spawn probabilities
- Minimum-distance and maximum-density rules
- Regional variation
- Random rotation and variants for structures

Example loot table for a chest:

| Rarity | Chance |
| --- | --- |
| Common | 60% |
| Uncommon | 25% |
| Rare | 10% |
| Epic | 4% |
| Legendary | 1% |

### 3.5 World-scale rules

Global patterns sit on top of local generation. Difficulty is hardcoded. The game has no difficulty setting for the player to choose. It rises with distance from the origin in fixed bands:

| Distance from origin (tiles) | Difficulty |
| --- | --- |
| 0 to 1,000 | Easy |
| 1,000 to 5,000 | Medium |
| 5,000 to 10,000 | Hard |
| 10,000+ | Extreme |

Other world-scale rules:

- Rare structures appear farther from the origin
- Biomes and resources are distributed by region
- Special regions, dangerous zones and safe zones
- World rings

### 3.6 Rare events

Very low-probability finds give each player discoveries that others may never see.

| Find | Chance |
| --- | --- |
| Ancient temple | 0.1% |
| Legendary creature | 0.05% |
| Lost city | 0.01% |
| Extremely rare landmark | 0.001% |

## 4. Object lifetime and persistence

This is the system that defines the game. A world object is discarded only when every chunk it occupies has left the active range. In this section, active means loaded: the chunk is still inside the cache radius.

### 4.1 Multi-chunk objects

- Each object records the chunks it occupies.
- The object stays alive while any of those chunks is active.
- It is discarded only when all of them are inactive.

This applies to buildings, dungeons, lakes, forests, mountains and other terrain formations. A giant castle might cover a 3 × 3 block of chunks:

```text
┌─────────┬─────────┬─────────┐
│ Chunk 1 │ Chunk 2 │ Chunk 3 │
├─────────┼─────────┼─────────┤
│ Chunk 4 │ Chunk 5 │ Chunk 6 │
├─────────┼─────────┼─────────┤
│ Chunk 7 │ Chunk 8 │ Chunk 9 │
└─────────┴─────────┴─────────┘
```

### 4.2 Temporary world state

1. The player approaches and the area is generated.
2. Objects exist in memory.
3. The player moves away. Objects remain while partially active.
4. An object's whole footprint leaves the active area.
5. The object is discarded.
6. The area can regenerate differently on a later visit.

Example: the first visit finds a forest with a cabin. A later visit can find the forest with ruins instead, or a different biome.

### 4.3 Persistence tiers

| Tier | Behaviour |
| --- | --- |
| Temporary | Discarded and free to regenerate differently. The default for everything. |
| Semi-persistent | Between the two: once discovered, kept for 3 in-game days after the player leaves (villages, castles, mines). |
| Persistent | Saved and always restored. |

Persistent objects include:

- Important NPCs
- Quest locations and boss locations
- Major discoveries and special landmarks
- Important loot

## 5. Gameplay systems

These systems sit on top of the world technology and are built after the MVP.

| System | Features |
| --- | --- |
| Player | Walking, running, jumping, crouching. Health, stamina, hunger, thirst. Damage, death, respawn. Status effects and equipment. |
| Combat | Melee and ranged weapons, projectiles. Dodge, block, critical hits. Damage types, armor, weapon durability. Enemy drops and boss fights. |
| Enemies | Biome-based spawning and despawning. AI states: patrol, aggro, chase, attack, flee. Group behaviour, difficulty scaling, rare variants, bosses. No wild spawns within 64 tiles of the origin (safe zone). Dungeons wake skeleton guards; boss arenas wake an Arena Guardian. |
| Resources | Wood, stone, iron, coal, gold, rare minerals, herbs, food, water, biome-specific resources. |
| Crafting | Recipes, recipe discovery, crafting stations, tiers, rare recipes. Produces tools, weapons, armor and consumables. Stations are found in the world, never built: campfires in camps, anvils in villages and castles. |
| Inventory | Stacking and quantities, equipment slots, hotbar, sorting, categories, rarity, weight or capacity limits, dropping and picking up. |
| Progression | XP, levels, skills, unlockable abilities. Equipment, crafting and exploration progression. Difficulty scaling. |

One rule ties these systems back to the world:

- **Resource rarity** depends on biome, terrain, depth, distance from origin and randomness.

There is no building system: the player is an adventurer, not a settler.

## 6. Living world

Only the area near the player is simulated. Distant entities get no full simulation.

### 6.1 Time and weather

| System | Features |
| --- | --- |
| Day/night cycle | Sunrise, day, sunset, night. Darkness, torches and light sources. Night-only enemies, structures and events. NPC schedules. |
| Weather | Rain, storms, snow, fog, sandstorms. Temperature, lighting changes, environmental hazards. |

A full day lasts 16 real minutes. Players can rest by a campfire at dusk or night to skip to morning. Wraiths roam only at night, more enemies spawn after dark, and lit windows, campfires, torches and lanterns push back the darkness.

Weather depends on the biome and feeds into gameplay. Each biome type runs its own weather pattern (forest: rain, thunderstorms, fog; desert: sandstorms, heat waves; snow: snow, blizzards, fog), and the player feels the weather of the biome they stand in. Thunderstorms bring lightning strikes that can set trees burning; fire spreads unless the weather is wet.

```text
Biome  →  Weather  →  Environment  →  Gameplay
```

### 6.2 Simulation

Simulated within the simulation radius:

- NPC, animal and enemy behaviour (villagers wander by day and go indoors at night)
- Resource regeneration (berry bushes, herbs and mushrooms regrow after a day or so while their region stays loaded)
- Weather and fire
- Environmental and time-based events

### 6.3 Quests and world events

| Type | Examples |
| --- | --- |
| Generated quests | Find an NPC, explore a location, kill an enemy, find an item, escort an NPC, defend a location, discover a landmark, clear a dungeon, collect resources |
| Random world events | Meteor crash, bandit attack, monster invasion, treasure event, rare merchant, ancient structure appearing |

Quests come from villagers: each village has three villagers (one offering a new quest each day) and a trader. Quests complete on their own when the objective is met, except collect quests, which are handed in to any villager. Rewards are coins, experience and an item. Coins buy goods from traders and travelling merchants, who also buy treasure. A lost traveller is an important NPC: their position lives in the quest record, so they persist until rescued, while ordinary villagers come and go with their village.

### 6.4 Exploration

- Map with fog of war, coordinates and compass
- Discovered locations and landmarks
- Waypoints and player markers
- Rare discoveries and exploration rewards

## 7. Presentation

The theme, UI and visual design follow Stardew Valley. All art, audio and UI assets are original work made in that style, not copies of the game's own assets.

### 7.1 Visual direction

| Aspect | Direction |
| --- | --- |
| Perspective | Top-down, three-quarter view |
| Art style | 16-bit style pixel art on a square tile grid |
| Palette | Warm and saturated, with a distinct palette per biome |
| Tone | Cozy and inviting near the origin, more threatening with distance |
| Characters | Small, expressive sprites with four-direction walk animations |
| UI style | Wood-framed panels, pixel font, tabbed menus |

### 7.2 HUD layout

| Element | Position |
| --- | --- |
| Hotbar | Bottom centre |
| Health and stamina bars | Bottom right, vertical |
| Hunger and thirst bars | Bottom right, beside health and stamina |
| Clock, day and weather | Top right |
| Notifications | Bottom left |
| Main menu | Full-screen panel with tabs: inventory, crafting, map, quests, settings |

### 7.3 Features

| Area | Features |
| --- | --- |
| Rendering | 2D tiles and sprites, animated sprites, animation system. Particles, lighting, shadows, weather and screen effects. Camera movement and zoom. Parallax backgrounds. |
| Audio | Background and biome-specific music. Ambient, environmental and weather sounds. Footsteps, combat and creature sounds. Structure-specific ambience. |
| UI | Health, stamina, hunger and thirst bars. Hotbar, inventory, crafting menu, map, quest UI. Interaction prompts and notifications. Settings and pause menu. |

## 8. Technical design

The game runs in the browser. Generation happens off the main thread so streaming never stalls the frame.

### 8.1 Tech stack

The stack is chosen for frame rate first and for running on low-end phones and laptops.

| Layer | Choice | Why |
| --- | --- | --- |
| Language | TypeScript | Type safety across the main thread and worker boundary |
| Build tool | Vite | Fast rebuilds and small production bundles |
| Renderer | PixiJS v8, WebGL renderer | Batched GPU sprite drawing that runs on older devices |
| Tile drawing | One batched mesh per chunk, one texture atlas | Very few draw calls per frame |
| World generation | Web Workers, typed arrays sent as transferable buffers | Generation never blocks a frame and chunk data is not copied |
| Noise | Seeded simplex noise | Cheap to compute and repeatable per seed |
| Saves | IndexedDB | Local, asynchronous, no server needed |
| Audio | Web Audio API | Built into every browser, no extra download |
| Menus | HTML and CSS overlay | Costs nothing while closed and keeps the canvas for the world |

PixiJS is preferred over a full framework such as Phaser because the world systems here are custom anyway, and a renderer-only library is lighter. WebGPU stays off by default: the [PixiJS rendering docs](https://pixijs.download/release/docs/rendering.html) recommend the WebGL renderer for production.

Rules for low-end devices:

- Render at a low internal resolution and scale up with nearest-neighbour filtering. Pixel art loses nothing and the GPU fills far fewer pixels.
- Cap the device pixel ratio at 1.
- Give lighting, shadows, particles and weather effects a low-quality setting that turns them off.
- Offer a 30 fps cap.
- Pool chunks and entities so the garbage collector rarely runs during play.

### 8.2 Threading

As built, the worker generates terrain tiles and decorations only. Structures, lakes and events are rolled on the main thread, because they need the live object list to avoid collisions.

```text
MAIN THREAD                      WEB WORKER
├── Game loop                    ├── Terrain generation
└── Renderer (WebGL)             ├── Structure generation
                                 └── Resource generation
```

### 8.3 Performance techniques

| Area | Techniques |
| --- | --- |
| Streaming | Chunk streaming, generation prioritisation, lazy loading, render-distance and simulation-distance management |
| Concurrency | Web Workers, background generation |
| Memory | Chunk pooling, object pooling, typed arrays, asset caching |
| Rendering | WebGL, sprite batching, texture atlases, entity culling |

### 8.4 Save system

Saves stay small because most of the world is never stored. Saves live in IndexedDB.

A save contains:

- World seed
- Player state, inventory and progression
- Persistent objects
- Important discoveries

### 8.5 Project layout

The tree below was the starting plan. The code has since grown its own layout (adding `story/`, `items/`, `ui/`, `audio/` and more systems); `docs/architecture.md` describes it as built.

```text
src/
├── game/
│   ├── Game.ts
│   ├── Player.ts
│   ├── Camera.ts
│   └── Input.ts
├── world/
│   ├── WorldManager.ts
│   ├── ChunkManager.ts
│   ├── Chunk.ts
│   ├── WorldObject.ts
│   └── ObjectManager.ts
├── generation/
│   ├── TerrainGenerator.ts
│   ├── BiomeGenerator.ts
│   ├── StructureGenerator.ts
│   ├── ResourceGenerator.ts
│   ├── EnemyGenerator.ts
│   └── Random.ts
├── entities/
│   ├── Entity.ts
│   ├── Enemy.ts
│   ├── NPC.ts
│   └── Animal.ts
├── systems/
│   ├── CombatSystem.ts
│   ├── InventorySystem.ts
│   ├── CraftingSystem.ts
│   ├── WeatherSystem.ts
│   └── TimeSystem.ts
├── workers/
│   └── worldGenerator.worker.ts
├── rendering/
│   ├── TileRenderer.ts
│   ├── ParticleSystem.ts
│   └── Lighting.ts
└── save/
    └── SaveManager.ts
```

## 9. Roadmap

Build the world technology first. It is the unique part of the game and the riskiest, so it should be proven before combat, crafting or quests.

### 9.1 MVP build order

1. Player movement and camera
2. Chunk streaming
3. Procedural terrain
4. Biomes
5. Procedural structures
6. Multi-chunk object lifetime
7. Regeneration of discarded areas

The MVP is done when a multi-chunk structure survives a partial unload and the area regenerates differently after a full unload.

### 9.2 After the MVP

The original notes only fix the MVP. The order below is a suggested grouping, not a decision. Phases 2 to 6 are now built (building was dropped: the player is an adventurer). The current behaviour of every system is documented in `docs/`.

| Phase | Goal | Systems |
| --- | --- | --- |
| 2. Persistence | The world remembers what matters | Persistence tiers, save system |
| 3. Survival loop | There is a reason to explore | Resources, inventory, crafting, player vitals |
| 4. Threat | The world pushes back | Enemies, combat, distance-based difficulty, progression |
| 5. Living world | The world feels alive | Day/night, weather, simulation, quests, world events, rare events |
| 6. Polish | The game is presentable | Map and exploration tools, audio, lighting, particles, full UI |

## 10. Open questions

These gaps surfaced while tightening the notes. The first three, plus chunk size and minimum biome size, must be settled before the MVP.

- [ ] **Side-view leftovers.** The Stardew Valley direction makes the game top-down. Jumping, crouching and parallax backgrounds do not fit that view. Drop them or redefine them? *Deferred: redefine after the MVP.*
- [x] **How regeneration differs.** A seeded RNG gives the same result for the same seed and coordinates. Regenerating differently needs an extra input, such as a per-region visit counter or world time. *Decided: a visit counter per 8 × 8-chunk region, raised when the region fully leaves the cache radius. Rivers and mountains stay fixed; biomes, ground detail, decorations, lakes and structures vary.*
- [x] **Biome regeneration.** A discarded biome can currently return as a different type. Confirm this, or fix the type per area and vary only size, shape and contents. *Decided: the type is fixed per area; size, shape, variant and contents vary.*
- [x] **Semi-persistent tier.** What does it keep, and for how long? *Decided: villages, castles and mines are semi-persistent. Once discovered, one is kept unchanged for 3 in-game days after the player last left it, then forgotten like a temporary place.*
- [x] **Player changes to temporary objects.** Does a looted chest or cleared dungeon reset when its area regenerates? *Decided: chests never refill. A looted chest stays open, and chests that later regenerate from the same anchor start empty. Gathered trees, rocks and plants come back only when their region regenerates. Cleared dungeons, defeated arena bosses and slain legendary creatures stay cleared the same way.*
- [x] **Map and waypoints.** What does the map show for a discovered location that has since regenerated? *Decided by the story: the lantern remembers it. Forgotten places are listed in the Lantern tab and show as ghosts in the lantern's light.*
- [ ] **Rare event odds.** Are the percentages per chunk, per region or per structure roll? *Rolled per chunk for now, including the legendary creature (per chunk, per region visit).*
- [x] **Chunk size, simulation radius and cache radius.** No values are set yet. *Decided: 32 × 32 tiles, simulation radius 2 chunks, cache radius = render area + 2 chunks.*
- [x] **Minimum biome size.** The value of the constant is not set yet. *Decided: 64 chunks.*
- [x] **Persistent objects in a regenerated biome.** A persistent landmark is saved but its biome is not. What happens if the area comes back as a different biome? *Resolved: biome types are fixed per area, and there is no player building.*
