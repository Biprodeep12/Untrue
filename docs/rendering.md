# Rendering

How the world is drawn: a procedural atlas, one mesh per chunk, y-sorted sprites, night lighting, weather and an HTML UI.

## Pixel scaling

The canvas renders at a low internal resolution and is scaled up with nearest-neighbour filtering (`Game.resize` in `src/game/Game.ts`):

- Scale = `max(1, floor(window height / TARGET_HEIGHT))`, with `TARGET_HEIGHT` = 270. A 1080-pixel window renders at 480 × 270 internally, scaled ×4.
- The renderer resolution is 1 (device pixel ratio is ignored), `roundPixels` is on, and `TextureStyle.defaultOptions.scaleMode` is `'nearest'`.
- The CSS sets `image-rendering: pixelated` on the canvas.

The camera zoom (0.25 to 2, steps of ×0.8, snapping to exactly 1 near 1) scales the world layer, and the render area grows or shrinks to match.

The frame rate is capped at 60 (`app.ticker.maxFPS`), or 30 with the setting, so 120 Hz screens do not do twice the work.

## Scene

- **Render groups.** The ground (chunk meshes) and the y-sorted entities are separate Pixi render groups (`isRenderGroup`), so the entities re-sorting every frame never makes Pixi rebuild the ground's draw list, and the other way round.
- **No Pixi pointer events.** Input is plain DOM events (`src/game/Input.ts`), so Pixi's event system is off: `eventFeatures` are all false and the stage's `eventMode` is `'none'`. Pixi would otherwise hit-test the whole scene on every pointer move.

## The atlas

Every image is painted in code at startup by `buildAtlas()` (`src/rendering/Atlas.ts`) into one 256-pixel-wide canvas. No image files ship.

| Region | Contents | Layout |
| --- | --- | --- |
| Tiles | 41 tile types × 4 variants | 16 × 16 cells, `cell = tileId × 4 + variant` |
| Decorations | 36 decoration types | Shelf-packed frames from `DECO_Y`; most are 16 × 32, plants and trees larger (oaks and palms 32 × 48, pines 24 × 48, cacti 24 × 40, crystals 24 × 32, bushes 24 × 24, flowers, mushrooms and dead bushes 16 × 16, the Anchor core 32 × 48) |
| Humans | 11 outfits × 4 directions × 4 walk frames | 16 × 32 cells from `PLAYER_Y`, one row per outfit |
| Items | One icon per item | 16 × 16 cells from `ITEM_Y` |
| Creatures and projectiles | Two walk frames per species with its own art, the buried sand lurker, and four projectiles | Shelf-packed frames from `CREATURE_Y` |
| Armour | 3 sets (`ARMOR_SETS`: leather, iron, starforged) × parts × 16 frames | One row of 16 frames per set and part, from `ARMOR_Y` |

The armour region starts at `ARMOR_Y`, below the creatures, with 32-pixel rows. `ATLAS_H` is its bottom.

**Painters.** A small `Painter` class draws into an `ImageData`: pixels with alpha blending, rectangles, ellipses, speckles, soft shadows, and `outline()`, which adds a dark one-pixel outline around opaque pixels for the Stardew look. Ground tiles use per-palette colour sets and speckle styles (grass, sand, snow, dirt). Foliage uses `foliage()`, which shades a leafy cluster from the top left with noise and ragged edges, then adds random leaf flecks.

**People.** `OUTFITS` describes each look: skin, hair colour and style (spiky, short, long, bun, curly, ponytail, bald, messy), shirt and trousers, and optional skirt, boots, beard, hat (straw, wide-brimmed, hood), scarf, belt, apron, vest, long coat, worn cloak, pack (small or big), mask and freckles. Looks: `player` (an adventurer: blue tunic, red scarf, belt, tall boots), `villager-a` to `villager-f` (picked at random per villager), `trader` (apron, moustache, small pack), `merchant` (wide hat with a feather, beard, long coat, big pack with a bedroll), `lost` (worn, patched cloak) and `bandit` (hood and mask). `paintHuman` draws them in a 16 × 32 cell with the feet on row 29: hair from row 5, a ten-wide head on rows 7-16 with eyes and cheeks, torso 17-23, hips 24, legs 25-28, shoes 29, then the shared one-pixel outline. Frames 0 and 2 are the passing pose (0 is also standing); the stride frames 1 and 3 bob everything above the hips down a pixel and swing the arms against the legs. Facing left is facing right, mirrored (`Painter.mirror`). `playerCell(dir, frame, outfit)` returns a frame, and `humanHand(dir, frame, off?)` where a hand is, which the player uses for what it holds. Armour overlays (`paintArmor`) use the same geometry, bob, swing and mirroring.

Lookup helpers: `tileCell`, `decoFrame`, `itemCell`, `playerCell`, `creatureFrame` (keys such as `wolf:1`, `lurker:buried` or `projectile:arrow`), and for the outer dimensions `dimCell` (16 × 16 tiles from `DIM_Y`: void, floor, wall tops and faces, crumbling and glitching slabs, plates, safe pads, runes) and `dimFrame` (props: pillars, crystals, gates, the vault chest, the portal, mural stones, and the rifts' art).

**Rifts.** Painted by `src/rendering/RiftArt.ts` into the dimension props, and used in the overworld and the dimensions alike:

| Key | Size | What |
| --- | --- | --- |
| `tear:0` to `tear:7` | 48 × 64 | The tear, one frame each (`riftFrame(f)`, `RIFT_FRAMES` 8 at `RIFT_FPS` 10): a jagged rip with barbed edges and a crackling white and cyan rim, inside it a tunnel of light rings (white heart, cyan, violet, then dark void with stars) twisted by a swirl that turns a step each frame, thin spiral streaks, a dithered violet glow around it, sparks jumping off the edges, shards and embers spiralling in, and bits of ground bobbing under it |
| `rift-halo` | 64 × 80 | A dithered glow drawn additively behind the tear |
| `rift-ground:0`, `:1` | 112 × 96 | The ground around a rift, open (charred earth, cracks glowing violet near the middle and going dark further out, a burn under the tear) and closed (cooled ash, dark cracks). The middle is solid; the edge is ragged (noise) and fades out through an ordered dither, so it blends into any biome |

`Deco.Rift`'s own cell is left empty (the tear is bigger than it). `Tile.RiftGround` is the same charred earth, in case it shows. A closed rift's `Deco.RiftScar` (16 × 16) is a short healed seam of pale light, stitched shut.

## Chunk meshes

`TileRenderer` (`src/rendering/TileRenderer.ts`) implements `ChunkListener`:

- Each shown chunk is one `Mesh` of 1,024 quads over the atlas texture, so a chunk is one draw call. All meshes share the same positions and indices; only UVs change.
- The tile variant is `hash3(gx, gy, 17) % 4`, so ground tiles do not repeat visibly.
- Stone and wood walls draw their top or their front face depending on the tile below; see [buildings-and-interiors.md](buildings-and-interiors.md#walls-with-height).
- UVs are pulled in by 0.02 pixels (`INSET`) so neighbouring atlas cells never bleed when zoomed out.
- Meshes and decoration sprites are pooled and reused when chunks are hidden.
- **Culling.** Chunks are shown a chunk beyond the screen (the render area), but `cull()` hides those outside the camera's view, padded by 6 tiles (`CULL_PAD`) for tall decorations and light glow. A culled chunk's mesh is hidden and its decoration sprites are taken out of the sorted `entities` container, so they cost nothing to sort. `Game` calls `cull` every frame with the camera's view.
- **Drawn a few at a time.** Drawing a chunk is costly (a mesh, hundreds of sprites, lights), so `ChunkManager` queues ready chunks (`pendingShow`) and shows at most 2 per frame (`SHOW_PER_FRAME`), nearest to the player first. Without a renderer (tests) chunks show at once.

**Decorations** are sprites anchored at their bottom centre, positioned on their tile and added to the shared `entities` container with `zIndex` = their foot position, so they sort with the player, NPCs and enemies.

**Tree fading.** `fadeAround(px, py)` checks sprites in the 3 × 3 chunks around the player. Any sprite at least 24 pixels tall whose foot is below the player's and whose box overlaps the player's body is drawn at 45% opacity, so the player is never lost behind a tree.

**Lights.** While collecting a chunk's sprites, `collectLights` also records light sources in world pixels: campfires (radius 5 tiles, warm), fireplaces, lamps, meteorites, Moonwells, and windowed facade tiles (radius 1.8 tiles). `lights(out)` returns them for chunks in view only.

## Rifts and their glitches

`TileRenderer` keeps the rift sprites of drawn chunks in a list as decorations are added and released (usually empty) and `animate(dt)` swaps their texture between the eight frames at 10 frames a second, and pulses each halo's alpha and scale: textures swapped and sprites transformed, never redrawn, and nothing at all without a rift. Each rift (and each scar) also gets its ground decal, a sprite in the entities layer sorted below everything that stands (`zIndex` −10⁹), and an open rift its additive halo just behind the tear; both are pooled apart from the decorations, shown and hidden with their chunk, and never faded, jolted or reused as decorations. At night the rift is a light (5 tiles) hung at its tear, with a violet glow (`Light.color`; the warm glow is otherwise a fire's orange), and a scar a faint cyan one.

`TileRenderer.flare` (0 to 1) swells every tear and brightens its halo while the player passes through a rift ([below](#passing-through-a-rift)).

Near an open rift the world glitches (`src/rendering/RiftGlitch.ts`). The game finds the nearest open rift four times a second, with the HUD; only while one is within 12 tiles, and the game is not paused, does `RiftGlitch.update` run each frame. Every 0.7 to 4.5 seconds (sooner nearer the rift) one of:

- **Jolt:** one to three decorations near the rift jump 2 to 5 pixels sideways, tinted violet, cyan or pink, for 0.08 to 0.2 s (`TileRenderer.jolt`, put back by `settle`; a chunk released or redrawn meanwhile settles first, so pooled sprites never keep a jolt).
- **Colour slip:** the world layer is tinted and torn 2 pixels sideways for 0.06 to 0.14 s.
- **HUD stutter:** the HUD's panels jump and shift hue for 0.18 s (`Hud.stutter`, a CSS animation).

Colour slips and HUD stutters follow the "Screen flashes" setting, and reduced motion stops the stutter. Out of range everything is put back once and nothing runs. The rift's hum is in [audio.md](audio.md#ambience).

## Passing through a rift

Entering a rift, stepping back out, closing it through the portal and being thrown out on dying are short passages, not cuts. `RiftTransition` (`src/game/RiftTransition.ts`) is the clock: three phases, each hook fired once and in order even on one long frame; `Game.updatePassage` draws from its progress, and `RiftPassageView` (`src/rendering/RiftPassageView.ts`) owns the screen cover and the collapsing tear.

| Phase | Enter | Leave / close | Thrown out (dying) |
| --- | --- | --- | --- |
| Pulled in | 0.7 s | 0.6 s | 0.45 s |
| Revealed | 0.6 s | 0.6 s (0.55 closing) | 0.6 s |
| The tear collapses | | 0.6 s (closing only) | |

- **Pulled in.** The player's sprite (pivoted on the body) slides into the tear, or the arrival rift, or the portal, spinning twice, shrinking and fading (on dying it spins away where it stands); the overworld's tear flares; the camera leans in (zoom ×1.25); a violet vignette closes in, and the screen whitens under it. With "Screen flashes" on, the colours slip twice (world tint and a 2-pixel tear, as the glitches do); off, the cover is the void's dark instead of a flash.
- **The switch**, under full cover: `enterRift` or `exitRift` (dying also empties the bag and revives the player there). The camera snaps to the far rift.
- **Revealed.** The cover lifts on the player emerging from the far rift, growing and unspinning as they slide to where they stand; the rift they came out of flares and settles.
- **Closing.** The tear is closed (the scar and its decal appear) and a ghost of it folds in on itself, then bursts (particles, a short flash if flashes are on); then the rewards and the story's beat.
- **Reduced motion** (`prefers-reduced-motion`): 0.25 s out and 0.3 s in, a plain dark fade, no slide, spin, zoom or slip.

While a passage runs, the game counts as paused (`Game.paused`): no input but F3 and F4, no world update, no combat, so no damage; the scene still renders. Saving is refused (an autosave waits), as during a vision. Nothing of it allocates per frame; the vignette's texture is made the first time a rift is crossed. The playground's jumps stay instant.

## Outer dimensions

`DimensionRenderer` (`src/rendering/DimensionRenderer.ts`) draws a dimension into the overworld's own ground and entities layers, while the overworld's sprites are hidden: the chunk meshes culled to nowhere (`TileRenderer.hideAll`), buildings and ground items cleared, NPCs not passed to the entity renderer. Its static floor is one batched mesh per 16 × 16 block over the atlas (as chunks are); tiles that change (crumbling and glitching slabs, plates) are flat overlay sprites; props (pillars, crystals, mural stones, gates, the chest, the portal, the rift) are y-sorted among the player and enemies. Everything is built in `open()`; frames only cull blocks to the camera and swap textures of slots in view whose look changed. Meshes, sprites and lights are pooled across trips. Crystals, the rift, safe pads and the portal light the dark in view only. See [dimensions.md](dimensions.md).

## Buildings and interiors

Buildings are painted once per building into cached canvas textures and drawn as y-sorted sprites (`src/rendering/Buildings.ts`); their windows are night lights. Which buildings to show is rescanned only when the render area changes, or every 30 frames (`RESCAN_FRAMES`); in between, only the fade of a building the player walks behind is updated. Interiors have their own view (`src/rendering/InteriorRenderer.ts`): a sprite per tile, furniture and residents y-sorted with the player, and fireplace and lamp lights. Details are in [buildings-and-interiors.md](buildings-and-interiors.md).

## The player

The player (`src/game/Player.ts`) is a container: the body sprite, the item in hand, and a two-pixel fist drawn over the grip. The hand position follows the arms in the human sprite (`humanHand` in the atlas), including the bob and arm swing; actions keep the bob but not the swing.

- **Holding:** the selected hotbar item is shown if it is a weapon, tool or light. Weapons, tools and torches are carried upright, tipped away from the body; lanterns hang from their handle and sway while walking; a bow is held at the side. Facing away, the item is drawn behind the body. Nothing is held while swimming or rolling.
- **Actions** (`act()`): a **swing** (0.28 s) winds the item up behind and sweeps it through the facing, with a 2-pixel lunge; a **punch** (0.2 s) is a lunge with empty hands; a **shot** (0.3 s) holds the bow out in front; a **pick** (0.4 s) is a stoop. Attacks play a swing, shot or punch; chopping and mining swing the best axe or pickaxe carried (or punch bare-handed) on every strike; gathering plants stoops.
- **Armour and off hand:** worn armour is drawn as overlays (`armorCell()` in the atlas: one row of 16 frames per set and part) over the body, legs and feet first, then chest and head, matching every direction and walk frame. The off-hand item sits in the other hand, or in front of the body when the shield is raised. `layer()` orders everything back to front each frame: what is held on the far side, the body and its armour, then what is held on the near side.
- **Swimming:** only the top 24 pixels of the body show, sunk 4 pixels and bobbing; leg and foot armour are hidden.

## Entities

`EntityRenderer` (`src/rendering/EntityRenderer.ts`) draws what moves:

- **Enemies and animals.** Creature frames with two walk frames, mirrored by facing (rabbits, hares, deer, boars, lizards and goats included). Humanoid species (bandits) use the four-direction human sprites instead. Variants draw another species' frames (`art`), tinted (`tint`) and scaled (`size`), such as the pale Frost Wolf or the large dark-red Dune Tyrant. Elites are drawn 1.25 times larger and tinted gold. A hit flashes red; the attack wind-up flickers pink. A health bar shows once an enemy is hurt (bosses use the HUD bar instead); it is drawn around its own origin and moved, and redrawn only when the shown health changes. A yellow "!" marks enemies that have just noticed the player, and a red "!" one winding up a blow.
- **NPCs.** Human sprites by outfit, with the walk cycle while moving, hidden while indoors, scaled (children are smaller) and translucent if they are a ghost. A floating symbol marks them: "!" for news or work, "$" for trade, "?" for the lost, "✓" for a quest hand-in.
- **Projectiles.** Pooled sprites; arrows and ice shards point along their flight, webs and boulders spin.
- **Damage numbers.** Text that floats up and fades over 0.8 seconds: white, yellow for critical hits, red for damage to the player.
- **Swings.** A white arc in front of the player for 0.14 seconds.
- **Pooling.** Enemy sprites with their bars and marks, damage numbers (by style) and swing arcs are hidden and kept for reuse instead of destroyed, since making a `Text` costs a texture upload.

## Lighting

`Lighting` (`src/rendering/Lighting.ts`) adds darkness without a custom shader:

1. A `RenderTexture` the size of the internal canvas is cleared and filled with a dark colour: deep blue (`0x080c22`) when darkness is above 0.6, purple dusk (`0x2a1430`) otherwise, at `darkness × 0.8` opacity. The fill is a tinted white sprite, cheaper to change each frame than a `Graphics`.
2. For each light, a soft radial gradient sprite is drawn with the `erase` blend mode, cutting a hole in the darkness. Warm lights flicker slightly.
3. The texture is shown above the world. A second set of the same gradient sprites, tinted orange with the `add` blend mode at `warmth × 0.35 × darkness`, gives fires and windows a warm glow.

Darkness comes from the clock, plus up to 0.45 during a thunderstorm, plus a faint gloom of 0.03 per difficulty band. Inside an outer dimension it is the dimension's own (`mood.darkness`, 0.55 for The Hollow) at any hour, in its own colour (`update(..., tint)`, violet for The Hollow), with no weather. The player carries a light: 2.4 tiles with nothing, 5 with a torch and 7 with a lantern. Burning trees are lights too.

**Flat tint.** When lights would not matter (by day, where only the band's gloom darkens the screen) or the Lighting setting is off, `update(..., flat)` shows a single tinted sprite over the screen instead (at 85% of the strength), with no light holes and no render pass. Lights are not even gathered then.

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

Particle counts scale with the screen area (relative to 480 × 270) and fade in and out as the weather changes. Particles no longer needed are hidden and kept for later. Lightning draws a white flash that fades over 0.25 seconds, unless the "Screen flashes" setting is off. The veil and the flash are tinted white sprites.

## Effects

`Effects` (`src/rendering/Effects.ts`) draws world-space effects. Fires, lightning warnings and meteors are rare, so they share one `Graphics`, cleared only when something was or is to be drawn. Particles and fireflies are pooled tinted square sprites, cheap to move every frame.

- **Fires.** Flickering flame circles and rising smoke over burning trees.
- **Lightning warnings.** A circle that fills in over the 1.2 seconds before a strike lands.
- **Meteors.** A streak falling toward the impact point, then an expanding shock ring.
- **Particle bursts.** `burst(x, y, kind)` throws small squares with their own speed, gravity and lifetime: `wood` and `stone` chips while gathering, `leaf` for plants, `dust` for running, dodging and defeated enemies, `hit` sparks on damage, `magic` for crystals, `gold` for chests and level-ups. At most 400 live at once. The "Hit and dust particles" setting turns bursts off.
- **Ambient life.** Fireflies drift around the player on calm forest nights and add small glowing lights to the lighting layer. Falling leaves drift and sway in autumn forests by day. Both follow the weather particles setting.

**Ground items** (`src/rendering/GroundItemRenderer.ts`) are drawn only within 2 tiles of the screen, and every item shares one shadow shape (`GraphicsContext`).

## HTML UI

The interface is HTML and CSS over the canvas (`src/ui/`, styled in `src/style.css`), so it costs nothing while closed:

| Component | Shows |
| --- | --- |
| `Hud` | Compass, location panel (clock, weather, biome, difficulty, position), quest tracker with direction arrows, notifications, tips, alerts, action prompt, vitals, level and XP, status effects, boss bar, hurt flash, controls bar (naming the player's keys), touch buttons, loading screen |
| `Hotbar` | The first 8 inventory slots, with counts and weapon durability bars; the selected item's name shows above the bar for 1.6 s |
| `Menu` | Tabs: Inventory (with Sort bag), Crafting (with ×N), Skills, Quests (with Abandon and the legends), Map (hidden where maps don't work), Settings (with key bindings on desktop), About (privacy, credits, licenses; `About.ts`) |
| `MapView` | The overworld map canvas, kept for if maps ever work there; see [exploration.md](exploration.md) |
| `DimensionMap` | The map inside an outer dimension: seen tiles, chambers, the rift, the portal, the player; see [dimensions.md](dimensions.md#the-map) |
| `PauseMenu` | Esc or the touch Pause button: Resume, Save, Settings, Full screen (where supported), New world, and the controls table (touch controls on touch screens, else the player's keys) |
| `Dialog` | NPC conversation and trade |
| `Vision` | Full-screen story text, one page at a time, with queued visions |
| `DebugOverlay` | F3: seed, frame rate, chunk counts, biomes, objects, enemies, regions, and a minimap of the cache area |
| `TouchStick` | The virtual stick on touch screens |
| `Hints` | First-time tips (`Hints.ts`); see below |
| `Intro` | The opening screen (`Intro.ts`, markup in `index.html`): the title over darkness from the first paint; once the player is placed, the darkness breaks into 40px squares that clear outward from the centre in a ragged ring (about 1.3 s), then it is removed. A low-resolution canvas (8 pixels per square) scaled up with `image-rendering: pixelated`; reduced motion gets a 0.4 s fade. Later trips (death, travel) use the HUD's loading screen. |
| `Fullscreen` | Full screen helpers for the Full button and the pause menu (`Fullscreen.ts`) |
| `SleepOverlay`, `Playground` | The sleep transition; the story playground panel (development builds), with the rift tools |

Item icons are copied from the atlas canvas into small canvases (`ItemIcon.ts`). Panels use a wood-framed style and the Pixelify Sans font.

**Messages.** `notify` shows a short note bottom left. `tip` shows a "Tip:" note that stays 9 seconds. `alert` shows a message in the middle of the screen that stays until the player presses OK; the same text is never shown twice at once. Alerts carry what must not be missed: a collapse, a save that could not be read, another tab holding the save, a learned recipe.

**First-time tips** (`src/ui/Hints.ts`) show once per browser, one at a time, the first time each applies: start (how to move and interact), an enemy hunting the player, hungry, thirsty, night, near a campfire, near an anvil, a skill point to spend, a heavy bag, near a rift (how to enter, and what dying there costs), and inside a dimension (the map works there). Shown ids are kept in `localStorage` under `untrue.hints` (once per session if storage is blocked). The story playground shows none. Tips name the player's own keys, or the touch buttons on touch screens.

**Cheap updates.** The HUD refreshes several times a second but writes to the page only when a value changed (`Hud.changed`). The vitals, XP and boss bars move with `transform: scale` instead of resizing. The touch stick caches its resting spot and moves by transform. Under the system's reduced-motion setting, all HUD and menu animation stops.

**Text and HUD size.** The setting (0.8 to 1.5) sets `--ui-scale`, which zooms `#ui` with CSS `zoom`.

## Low-quality settings

The Settings tab (stored in `localStorage`) can switch off:

| Setting | Effect when off |
| --- | --- |
| Lighting | No lights: night is a plain tint (see [Lighting](#lighting)) |
| Weather particles | The weather layer (particles and veil) is hidden |
| Hit and dust particles | No particle bursts |
| Cap at 30 frames per second | Sets the ticker's `maxFPS` to 30 when on (60 when off) |
| Screen flashes | No lightning flash, no red hurt flash, and no colour slips or HUD stutters near a rift; off by default under reduced motion |
| Show the controls bar | Hides the controls bar |

The same tab has music and sound effects volume sliders; see [audio.md](audio.md).

See also: [Architecture](architecture.md), [World streaming](world-streaming.md)
