# Rendering

How the world is drawn: a procedural atlas, one mesh per chunk, y-sorted sprites, night lighting, weather and an HTML UI.

## Pixel scaling

The canvas renders at a low internal resolution and is scaled up with nearest-neighbour filtering (`Game.resize` in `src/game/Game.ts`):

- Scale = `max(1, floor(window height / TARGET_HEIGHT))`, with `TARGET_HEIGHT` = 270. A 1080-pixel window renders at 480 × 270 internally, scaled ×4.
- The renderer resolution is 1 (device pixel ratio is ignored), `roundPixels` is on, and `TextureStyle.defaultOptions.scaleMode` is `'nearest'`.
- The CSS sets `image-rendering: pixelated` on the canvas.

The camera zoom (0.25 to 2, steps of ×0.8, snapping to exactly 1 near 1) scales the world layer, and the render area grows or shrinks to match.

## The atlas

Every image is painted in code at startup by `buildAtlas()` (`src/rendering/Atlas.ts`) into one 256-pixel-wide canvas. No image files ship.

| Region | Contents | Layout |
| --- | --- | --- |
| Tiles | 41 tile types × 4 variants | 16 × 16 cells, `cell = tileId × 4 + variant` |
| Decorations | 36 decoration types | Shelf-packed frames from `DECO_Y`; most are 16 × 32, plants and trees larger (oaks and palms 32 × 48, pines 24 × 48, cacti 24 × 40, crystals 24 × 32, bushes 24 × 24, flowers, mushrooms and dead bushes 16 × 16, the Anchor core 32 × 48) |
| Humans | 8 outfits × 4 directions × 4 walk frames | 16 × 32 cells from `PLAYER_Y`, one row per outfit |
| Items | One icon per item | 16 × 16 cells from `ITEM_Y` |
| Creatures and projectiles | Two walk frames per species, the buried sand lurker, and four projectiles | Shelf-packed frames from `CREATURE_Y` |

`ATLAS_H` is the bottom of the creature region.

**Painters.** A small `Painter` class draws into an `ImageData`: pixels with alpha blending, rectangles, ellipses, speckles, soft shadows, and `outline()`, which adds a dark one-pixel outline around opaque pixels for the Stardew look. Ground tiles use per-palette colour sets and speckle styles (grass, sand, snow, dirt). Foliage uses `foliage()`, which shades a leafy cluster from the top left with noise and ragged edges, then adds random leaf flecks.

**Outfits.** `OUTFITS` holds skin, hair, shirt and trouser colours, plus an optional apron, robe, mask or rags: `player`, `villager-a`, `villager-b`, `villager-c`, `trader`, `merchant`, `lost` and `bandit`. `playerCell(dir, frame, outfit)` returns a frame.

Lookup helpers: `tileCell`, `decoFrame`, `itemCell`, `playerCell`, `creatureFrame` (keys such as `wolf:1`, `lurker:buried` or `projectile:arrow`).

## Chunk meshes

`TileRenderer` (`src/rendering/TileRenderer.ts`) implements `ChunkListener`:

- Each shown chunk is one `Mesh` of 1,024 quads over the atlas texture, so a chunk is one draw call. All meshes share the same positions and indices; only UVs change.
- The tile variant is `hash3(gx, gy, 17) % 4`, so ground tiles do not repeat visibly.
- Stone and wood walls draw their top or their front face depending on the tile below; see [buildings-and-interiors.md](buildings-and-interiors.md#walls-with-height).
- UVs are pulled in by 0.02 pixels (`INSET`) so neighbouring atlas cells never bleed when zoomed out.
- Meshes and decoration sprites are pooled and reused when chunks are hidden.

**Decorations** are sprites anchored at their bottom centre, positioned on their tile and added to the shared `entities` container with `zIndex` = their foot position, so they sort with the player, NPCs and enemies.

**Tree fading.** `fadeAround(px, py)` checks sprites in the 3 × 3 chunks around the player. Any sprite at least 24 pixels tall whose foot is below the player's and whose box overlaps the player's body is drawn at 45% opacity, so the player is never lost behind a tree.

**Lights.** While collecting a chunk's sprites, `collectLights` also records light sources in world pixels: campfires (radius 5 tiles, warm), meteorites, memory pedestals, the Anchor core, monuments, story books, and windowed facade tiles (radius 1.8 tiles). `lights(out)` returns them for every shown chunk.

## Buildings and interiors

Buildings are painted once per building into cached canvas textures and drawn as y-sorted sprites (`src/rendering/Buildings.ts`); their windows are night lights. Interiors have their own view (`src/rendering/InteriorRenderer.ts`): a sprite per tile, furniture and residents y-sorted with the player, and fireplace and lamp lights. Details are in [buildings-and-interiors.md](buildings-and-interiors.md).

## The player

The player (`src/game/Player.ts`) is a container: the body sprite, the item in hand, and a two-pixel fist drawn over the grip. The hand position follows the arms in the human sprite (`handAt`), including the walk sway.

- **Holding:** the selected hotbar item is shown if it is a weapon, tool or light. Weapons, tools and torches are carried upright, tipped away from the body; lanterns hang from their handle and sway while walking; a bow is held at the side. Facing away, the item is drawn behind the body. Nothing is held while swimming or rolling.
- **Actions** (`act()`): a **swing** (0.28 s) winds the item up behind and sweeps it through the facing, with a 2-pixel lunge; a **punch** (0.2 s) is a lunge with empty hands; a **shot** (0.3 s) holds the bow out in front; a **pick** (0.4 s) is a stoop. Attacks play a swing, shot or punch; chopping and mining swing the best axe or pickaxe carried (or punch bare-handed) on every strike; gathering plants stoops.
- **Armour and off hand:** worn armour is drawn as overlays (`armorCell()` in the atlas: one row of 16 frames per set and part) over the body, legs and feet first, then chest and head, matching every direction and walk frame. The off-hand item sits in the other hand, or in front of the body when the shield is raised. `layer()` orders everything back to front each frame: what is held on the far side, the body and its armour, then what is held on the near side.
- **Swimming:** only the top 24 pixels of the body show, sunk 4 pixels and bobbing; leg and foot armour are hidden.

## Entities

`EntityRenderer` (`src/rendering/EntityRenderer.ts`) draws what moves:

- **Enemies and animals.** Creature frames with two walk frames, mirrored by facing (rabbits, hares, deer, boars, lizards and goats included). Humanoid species (bandits) use the four-direction human sprites instead. Elites are drawn 1.25 times larger and tinted gold. A hit flashes red; the attack wind-up flickers pink. A health bar shows once an enemy is hurt (bosses use the HUD bar instead), and a "!" marks enemies that have just noticed the player.
- **NPCs.** Human sprites by outfit, with the walk cycle while moving, hidden while indoors, scaled (children are smaller) and translucent if they are a ghost. A floating symbol marks them: "!" for news or work, "$" for trade, "?" for the lost, "✓" for a quest hand-in.
- **Projectiles.** Pooled sprites; arrows and ice shards point along their flight, webs and boulders spin.
- **Damage numbers.** Text that floats up and fades over 0.8 seconds: white, yellow for critical hits, red for damage to the player.
- **Swings.** A white arc in front of the player for 0.14 seconds.

## Lighting

`Lighting` (`src/rendering/Lighting.ts`) adds darkness without a custom shader:

1. A `RenderTexture` the size of the internal canvas is cleared and filled with a dark colour: deep blue (`0x080c22`) when darkness is above 0.6, purple dusk (`0x2a1430`) otherwise, at `darkness × 0.8` opacity.
2. For each light, a soft radial gradient sprite is drawn with the `erase` blend mode, cutting a hole in the darkness. Warm lights flicker slightly.
3. The texture is shown above the world. A second set of the same gradient sprites, tinted orange with the `add` blend mode at `warmth × 0.35 × darkness`, gives fires and windows a warm glow.

Darkness comes from the clock, plus up to 0.45 during a thunderstorm. The player carries a light: 2.4 tiles with nothing, 5 with a torch, 6 with the Wanderer's Lantern (unless the story has darkened it), and 7 with a lantern. Burning trees are lights too.

## Weather

`ParticleSystem` (`src/rendering/ParticleSystem.ts`) draws weather in screen space, above the lighting:

| Weather | Particles | Veil |
| --- | --- | --- |
| Rain | 140 rain streaks | Grey-blue |
| Thunderstorm | 220 faster, slanted streaks | Dark blue |
| Snow | 110 slow flakes | White |
| Blizzard | 240 fast sideways flakes | White |
| Sandstorm | 180 sand streaks blowing in from the right | Tan |
| Fog | None | Pale grey |
| Heat wave | None | Faint yellow |

Particle counts scale with the screen area (relative to 480 × 270) and fade in and out as the weather changes. Lightning draws a white flash that fades over 0.25 seconds.

## Effects

`Effects` (`src/rendering/Effects.ts`) draws world-space effects with one `Graphics` object:

- **Fires.** Flickering flame circles and rising smoke over burning trees.
- **Lightning warnings.** A circle that fills in over the 1.2 seconds before a strike lands.
- **Meteors.** A streak falling toward the impact point, then an expanding shock ring.
- **Memory ghosts.** Places the world has forgotten, drawn on the ground (`Effects.floor`, a layer between the tiles and everything standing) as a faint blue glow outlined along the place's edge, within the Wanderer's Lantern's light, pulsing gently and fading with distance.
- **Particle bursts.** `burst(x, y, kind)` throws small squares with their own speed, gravity and lifetime: `wood` and `stone` chips while gathering, `leaf` for plants, `dust` for running, dodging and defeated enemies, `hit` sparks on damage, `magic` for crystals, `gold` for chests and level-ups. At most 400 live at once.
- **Ambient life.** Fireflies drift around the player on calm forest nights and add small glowing lights to the lighting layer. Falling leaves drift and sway in autumn forests by day. Both follow the weather particles setting.

## HTML UI

The interface is HTML and CSS over the canvas (`src/ui/`, styled in `src/style.css`), so it costs nothing while closed:

| Component | Shows |
| --- | --- |
| `Hud` | Compass, location panel (clock, weather, biome, difficulty, position), quest tracker with direction arrows, notifications, action prompt, vitals, level and XP, status effects, boss bar, hurt flash, controls bar, touch buttons, loading screen |
| `Hotbar` | The first 8 inventory slots, with counts |
| `Menu` | Tabs: Inventory, Crafting, Skills, Quests, Map, Lantern, Settings, About (privacy, credits, licenses) |
| `MapView` | The world map canvas; see [exploration.md](exploration.md) |
| `PauseMenu` | Esc: Resume, Save, Settings, Full screen (where supported), New world, and the controls table |
| `Dialog` | NPC conversation and trade |
| `Vision` | Full-screen story text, one page at a time, with queued visions |
| `DebugOverlay` | F3: seed, frame rate, chunk counts, biomes, objects, enemies, regions, and a minimap of the cache area |
| `TouchStick` | The virtual stick on touch screens |

Item icons are copied from the atlas canvas into small canvases (`ItemIcon.ts`). Panels use a wood-framed style and the Pixelify Sans font.

## Low-quality settings

The Settings tab (stored in `localStorage`) can switch off:

| Setting | Effect when off |
| --- | --- |
| Lighting and night darkness | Darkness is 0; the lighting layer is hidden |
| Weather particles | The weather layer (particles and veil) is hidden |
| Cap at 30 frames per second | Sets the ticker's `maxFPS` to 30 when on |
| Show the controls bar | Hides the controls bar |

The same tab has music and sound effects volume sliders; see [audio.md](audio.md).

See also: [Architecture](architecture.md), [World streaming](world-streaming.md)
