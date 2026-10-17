# World generation

How terrain, decorations and biomes are made from a seed, and how areas regenerate differently.

## Seeds and streams

Everything comes from the world seed. `src/generation/Random.ts` provides:

- `hash(...values)` and `hash3(a, b, c)`: integer mixing hashes. `hash3` is allocation-free for per-tile loops.
- `Rng`: a Mulberry32 generator with `int`, `range`, `chance`, `pick`, `weighted` and `uint`.
- `Stream`: named streams (`Noise`, `Biome`, `Decoration`, `Structure`, `Lake`, `RareEvent`, `Layout`, `Loot`). `streamRng(stream, ...values)` seeds an `Rng` from the stream id plus the values, so each system rolls independently and changing one never shifts another.

Generation is deterministic: the same seed and the same visit counters give the same world (see `is repeatable for the same seed and path` in `src/world/WorldManager.test.ts`).

## Noise fields

`TerrainFields` (`src/generation/TerrainGenerator.ts`) builds eleven seeded simplex noise fields (`src/generation/Noise.ts`), each seeded with `hash(Stream.Noise, seed, n)`. Each field is also shifted by a seeded offset, so the origin is not a noise grid point (there simplex noise is always 0 and its contours run in straight lines):

| Field | Used for |
| --- | --- |
| `height` | Hills and mountains: `fbm(gx/200, gy/200, 4 octaves)` |
| `erosion` | Lowers high ground: `heightAt` subtracts `max(0, erosion(gx/600)) × 0.35`; also adds to moisture. Near the spawn `heightAt` also subtracts up to 0.6 (fully within 48 tiles of the origin, fading out by 88), so no mountain ever boxes the player in. |
| `river` | River centrelines: the zero line of `fbm(wx/450, wy/450, 2)` at a warped position |
| `riverGate` | Where rivers exist at all (scale 900) and their width (scale 260) |
| `temperature` | Climate, per chunk (scale 26 chunks) |
| `moisture` | Climate, per chunk (scale 22 chunks) |
| `warp` | Biome border blending, roughening biome footprints, river meanders and trail bends |
| `detail` | Ground patches, decoration density, per-biome offsets |
| `trail` | Trail centrelines: the zero lines of two warped fields (see [Trails](#trails)) |
| `trailGate` | Where each trail network exists |
| `zone` | Landscape zones (scale 80): meadows, deep woods, dune seas, open snowfields; marshes (scale 150); and rock fields (scale 22) |

The same class runs in the workers (tile generation) and on the main thread (biome climate and structure ground checks).

## Tiles

`generateChunk` picks one tile per cell, in this order:

| Test | Tile |
| --- | --- |
| On a river (`dist < width`) and below `MOUNTAIN_HIGH` (0.62) | Snow biomes: `Ice` (frozen, walkable). Otherwise `WaterDeep` near the centreline (`dist < width × 0.45`), else `Water`. |
| On a trail, and not above `MOUNTAIN_HIGH` | `Path` (so trails cross low rock as passes, but go round peaks) |
| Height above `MOUNTAIN` (0.52) | `RockDark` above 0.62, else `Rock` |
| Within `width + 1.2` tiles of a river | The palette's shore tile |
| Otherwise | A ground tile from the biome palette |

Rivers (`riverAt`):

- **Meanders:** the river field is sampled at a warped position (warp noise at scale 170, ±46 tiles, plus scale 50, ±6 tiles), so rivers bend instead of following the noise grid.
- **Even width:** `dist` is the field's value divided by its slope (one-tile finite differences), which is roughly the distance in tiles to the centreline. The half-width is `2.6 + 1.2 × riverGate(gx/260)` tiles, so rivers are about 3–8 tiles wide.
- **Ends:** width is scaled by a fade that rises smoothly as the gate noise goes from −0.15 to 0.15, so rivers narrow to a point instead of stopping square. Below 0.8 tiles there is no water.
- **Dry spawn:** the fade is also 0 within 36 tiles of the origin and rises over the next 40, so the player always wakes on dry land.

### Trails

Two trail networks wind across the world, each the zero line of its own `trail` field, found the same way as river centrelines (value over slope):

| Network | Field scale | Half-width | Exists where `trailGate` is above |
| --- | --- | --- | --- |
| Main trails | 260 | 1.05 tiles | −0.3 (scale 700) |
| Footpaths | 140 | 0.55 tiles | 0.2 (scale 420) |

- **Bends:** the field is sampled at a position warped by `warp` at scale 90 (±14 tiles).
- **Spawn:** within 150 tiles of the origin the main field is shifted by its own value at the origin (fading out over the next 250), and its gate is held open, so a main trail always runs through the spawn.
- **Worn edges:** a tile within 0.6 tiles of a trail's edge is also `Path` 30% of the time (hashed from the seed and position).
- **Clear of trees:** no tall decoration within a tile of a trail.
- Trails depend only on the seed, like rivers.

Cost: `generateChunk` samples the river and trail fields once per tile corner (shared between neighbouring tiles), checks trail fields first on a 4-tile grid, and skips the slope where the value shows the trail is far away. Trail widths are blended from the chunk's corners. The biome border warp is skipped where no neighbouring chunk within reach has a different biome.

### Bridges

Plank bridges cross rivers (`TerrainFields.bridgeAt`). The world is split into cells of 80 × 80 tiles, and each cell has an 85% chance of a bridge:

1. The cell's middle (8 tiles in from each edge) is sampled every 3 tiles for river centreline points (`dist` < 1.2, half-width at least 1.5, not near mountains).
2. The point where the river runs closest to straight north–south or east–west wins (the river's slope direction is at least 85% along one axis), so the bridge crosses square. Points where a trail crosses (within about a tile) score 0.6 higher and need only 72%, so the bridge carries the trail; a cell with a trail crossing always gets a bridge.
3. The bridge is two tiles wide and runs across the river: from the site it walks out along both rows until it reaches dry ground (anything that is not water or shore). Bridges longer than 22 tiles are dropped.
4. `generateChunk` turns water, ice and shore tiles under a bridge into `BridgeH`/`BridgeH2` (running east–west, rails on the north and south sides) or `BridgeV`/`BridgeV2` (running north–south, rails on the west and east sides).

Bridges are worked out per cell and cached (up to 4096 cells), and a tile checks the cells around its own, so a bridge can reach past its cell. Like rivers, they depend only on the seed.

Players can also swim; see [survival.md](survival.md#swimming).

Each palette (biome type × variant) has four ground kinds: `Base`, `Alt`, `Detail` and `Shore`. Tile id = `palette × 4 + kind`; shared tiles (water, rock, floors, walls, roofs and so on) start at id 24. Ground kind comes from `detail` noise at scale 11, offset by the biome's seed:

- Forest and snow: `Alt` where the noise is above `0.38 − open × 0.3`, `Detail` below −0.64, else `Base`.
- Desert: dune stripes (`sin(gx × 0.11 + gy × 0.04 + d × 3) > 0.8 − deep × 0.35`) are `Alt`, `Detail` below −0.6, else `Base`.

`open` and `deep` come from the `zone` field `z` at scale 80: `open = smooth((−z − 0.25) / 0.25)`, `deep = smooth((z − 0.3) / 0.25)`.

### Marshes

Marshes are a forest landscape zone, kept more than 200 tiles from the start (`MARSH_MIN_DISTANCE`). `marsh = smooth((z − 0.4) / 0.15)`, with `z` the `zone` field at scale 150 (sampled at its own offset). Where `marsh` is above 0, on forest ground:

- **Pools:** a tile becomes shallow `Water` where `detail` at scale 6 is above `0.8 − marsh × 0.62`, so pools grow thicker toward the marsh's heart. No pool forms within the river's width + 8 tiles, so bridges always land on dry ground.
- **Darker ground:** elsewhere, the `Detail` ground kind is used where the ground noise is below `−0.3 + marsh × 0.4`.
- **Plants:** see the forest row under [Decorations](#decorations).

The six palettes are Forest, Autumn Forest, Desert, Red Desert, Snowfield and Crystal Tundra (`BIOME_NAMES` in `src/generation/Tiles.ts`).

## Decorations

Decorations are rolled per tile on ground tiles only (not water, rock, shared tiles or shore), with `unit(hash3(decoSeed, lx, ly))`. `decoSeed = hash(Stream.Decoration, seed, cx, cy, visit)`, so a regenerated region gets new decorations. A smooth density field (`detail` at scale 45, offset by the biome seed, clamped at 0) clusters trees into groves.

| Biome | Roll thresholds (cumulative) |
| --- | --- |
| Forest | Trees `((0.01 + density × 0.17) × (1 − open × 0.95) + deep × 0.22) × (1 − marsh × 0.75)`, × 0.4 in rock fields (`18% + deep × 30%` pines, none in marshes, otherwise oaks or autumn oaks), then bush `+0.02 + marsh × 0.06` (+0.05 instead of 0.02 near rivers), dead bush `+marsh × 0.05`, flowers `+0.015 + open × 0.07` (+0.02 near rivers), mushroom `+0.007 + deep × 0.025 + marsh × 0.03`, stone +0.004 (+0.05 in rock fields), ore +0.0015 (+0.006 in rock fields) |
| Desert | Palms +0.09 near rivers (oases), cactus `(0.008 + density × 0.03) × (1 + open × 3) × (1 − deep × 0.8)`, dead bush +0.012, rock +0.006 (+0.06 in rock fields; red rock in the red variant, half red in rock fields), ore +0.0015 (+0.005 in rock fields) |
| Snow | Snowy pines `(0.01 + density × 0.11) × (1 − open × 0.9) + deep × 0.14`, snow rock +0.008 (+0.05 in rock fields), crystal +0.012 in the crystal variant or +0.0015 otherwise, ore +0.0015 (+0.005 in rock fields) |

So forests have flowery meadows, dark deep woods and, further out, marshes thick with bushes, reeds (dead brush) and mushrooms but few trees; deserts have cactus stands, bare dune seas and palm oases, and snow has open snowfields between stands of taiga. Rock fields (`zone` at scale 22 above 0.5) are scattered in every biome. "Near rivers" means within `width + 5` tiles.

Tall decorations (oaks, pines, palms, cacti) are wider than a tile, so one is dropped if another tall one already sits left, above, above-left or above-right of it.

## Biomes

A biome is a record that owns many chunks (`BiomeRecord` in `src/world/BiomeManager.ts`): type, variant, a seed, its chunk keys and how many of them are in the cache area.

**Type.** `TerrainFields.climateAt(cx, cy)` reads temperature (with a north-south latitude bias of up to ±0.4, lower on high ground, plus a little per-chunk randomness) and moisture. Below −0.28 is Snow; above 0.15 with moisture below 0.05 is Desert; everything else is Forest. Chunks within 6 of the origin on both axes are always Forest: the safe starting zone. Climate depends only on the seed, so an area keeps its type when it regenerates.

**Creation.** When a chunk enters the cache area with no owner, `BiomeManager.ensure` makes a new biome there. It rolls a seed and a variant (8% chance of the rare variant: Autumn Forest, Red Desert or Crystal Tundra) from `streamRng(Stream.Biome, seed, cx, cy, visit)`, then grows a footprint with `growBiome`:

- A target size between `MIN_BIOME_CHUNKS` (64) and 192 chunks.
- A rotated, stretched ellipse around the trigger chunk, roughened by `warp` noise, sets each candidate's priority.
- Free chunks are claimed nearest-first through a min-heap. Chunks whose climate disagrees with the type are pushed to the back and only taken to reach the minimum size.

**Merging.** If loaded neighbours hem the new biome in below 64 chunks, its chunks join the neighbouring biome it touches most, so there are no slivers.

**Lifetime.** A biome is dropped when none of its chunks remain in the cache area. A later visit grows a new one, usually with different borders, size, variant and seed.

**Border blending.** `generateChunk` receives the type, variant and seed of the 3 × 3 chunks around it. Each tile looks up its biome at a warped position (two octaves of `warp` noise, up to about 14 tiles of offset), so borders are irregular rather than chunk-aligned.

## Regions and regeneration

The world is divided into regions of 8 × 8 chunks (`REGION_SIZE`). `RegionTracker` (`src/world/Regions.ts`) counts each region's chunks in the cache area and keeps a visit counter.

- When a region's last cached chunk leaves, its visit counter goes up, if the current rules allow it (see below).
- Every roll that should change on a new visit includes the region's visit counter: biome records, decorations and structures.
- Chunks that unload while other chunks of their region are still cached regenerate identically, so nothing changes under the player's feet.

Rivers, mountains and climate use only the seed, so landforms stay put while the biomes, plants and structures on them change.

Every region that fully unloads regenerates: its visit counter always rises.

## World-scale rules

`src/generation/WorldRules.ts` sets difficulty by straight-line distance from the origin, in tiles:

| Band | Distance |
| --- | --- |
| Easy | 0 to 1,000 |
| Medium | 1,000 to 5,000 |
| Hard | 5,000 to 10,000 |
| Extreme | 10,000 and beyond |

The band raises the odds of rarer structure tiers (see [Objects and structures](objects-and-structures.md)), and rare structures have minimum distances, so rarer things appear farther out. Enemies and legendary creatures scale with the band too (see [Combat](combat.md)), ore and crystal give rarer finds ([Survival](survival.md#gathering)), and the light and music grow grimmer ([Living world](living-world.md#light), [Audio](audio.md#music)).

See also: [World streaming](world-streaming.md), [Objects and structures](objects-and-structures.md)
