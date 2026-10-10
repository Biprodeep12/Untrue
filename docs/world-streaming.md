# World streaming

How chunks are generated around the player, kept while nearby, and thrown away behind them.

## Chunks

The world is a grid of chunks that extends in every direction.

| Constant | Value | Where |
| --- | --- | --- |
| `TILE_SIZE` | 16 px | `src/config.ts` |
| `CHUNK_SIZE` | 32 × 32 tiles | `src/config.ts` |
| `CHUNK_PIXELS` | 512 px | `src/config.ts` |

A chunk key packs `(cx, cy)` into one safe integer: `(cx + 2^23) × 2^24 + (cy + 2^23)` (`chunkKey` in `src/coords.ts`). That allows about ±8 million chunks on each axis. `keyX` and `keyY` unpack it, and `tileToChunk` floors a tile coordinate to its chunk.

## Areas

`ChunkManager.update(view)` works out four rectangles of chunks from the camera's view (in tiles) and the player's position:

| Area | Rule | Constant |
| --- | --- | --- |
| Visible | Chunks the view touches | |
| Render | Visible, plus a margin on every side | `RENDER_MARGIN` = 1 |
| Cache | Render, plus a margin on every side | `CACHE_MARGIN` = 2 |
| Simulation | The player's chunk, plus a radius | `SIM_RADIUS` = 2 |

The render area grows and shrinks with the screen size and zoom, so the player never sees a chunk appear at the edge. The cache area always covers the render area. A cache margin of at least 1 is required: structures can reach one chunk out from their anchor, so every object that touches the render area has its anchor chunk inside the cache area and is rolled before it is drawn.

## Lifecycle

| Step | What happens | Where |
| --- | --- | --- |
| Predict | The render area is extended by one chunk in the direction of travel. | `ChunkManager.schedule` |
| Generate | Missing chunks in that area are queued and sent to the generator. | `ChunkManager.schedule` |
| Activate | A finished chunk inside the render area is shown; inside the simulation area it is marked `simulated`. | `ChunkManager.receive`, `syncShown` |
| Deactivate | Leaving the render area hides it; leaving the simulation area clears `simulated`. | `ChunkManager.update` |
| Dispose | Leaving the cache area removes it and returns it to the pool. | `ChunkManager.setCache` |

When the cache rectangle changes, `setCache` reports the chunks that left (`cacheLeave`) and the chunks that entered (`cacheEnter`). `WorldManager` uses these to keep biome records, objects and region visit counters up to date (see [World generation](world-generation.md) and [Objects and structures](objects-and-structures.md)). Only chunks in the render area plus the predicted strip are generated; the rest of the cache area is tracked (biomes, objects, regions) without terrain.

## The generation queue

Each frame, `schedule()` collects the chunks in the predicted area that have no `Chunk` yet and scores them:

`score = distance from the player's chunk − 0.5 × (offset · direction of travel) + (100 if outside the render area)`

Lower scores go first, so chunks inside the render area come before the predicted strip, nearer chunks before farther ones, and chunks ahead before chunks behind. At most `MAX_IN_FLIGHT` (6) requests are outstanding at once.

## Stale results

Each request carries a `token` from a running counter, also stored on the `Chunk`. When a result arrives, `receive()` always decrements the in-flight count, then drops the result if the chunk was disposed or reused in the meantime (`chunk.token !== res.token`).

## Pooling

`ChunkPool` keeps disposed `Chunk` objects and their four 1,024-byte buffers for reuse, so streaming rarely allocates. The renderer pools its meshes and decoration sprites the same way (see [Rendering](rendering.md)).

## Composition

A chunk keeps two copies of its data:

- `baseTiles` and `baseDecos`: what the worker generated.
- `tiles` and `decos`: what the game shows and collides with.

`WorldManager`'s `compose` hook rebuilds the shown copy:

1. Copy the base terrain.
2. Stamp every live object that overlaps the chunk, in the order they were added (`WorldObject.stamp`).
3. Remove decorations the player harvested, if the harvest record is from the current region visit and the plant has not grown back.

`ChunkManager.refresh(chunk)` re-runs composition and tells the renderer when an object is added, removed or changed, a chest is opened, or something is harvested.

`WorldManager.tileAt(gx, gy)` reads the composed data. It returns `null` for chunks that are not generated, and `isSolidAt` treats those as solid so the player cannot walk into unloaded ground.

See also: [World generation](world-generation.md), [Objects and structures](objects-and-structures.md), [Architecture](architecture.md)
