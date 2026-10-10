// World constants. Values settled in the design spec, section 10.

/** Tile edge in pixels. */
export const TILE_SIZE = 16;
/** Chunk edge in tiles. */
export const CHUNK_SIZE = 32;
export const CHUNK_AREA = CHUNK_SIZE * CHUNK_SIZE;
export const CHUNK_PIXELS = TILE_SIZE * CHUNK_SIZE;

/** Chunks drawn beyond the visible area on every side (spec 2.2). */
export const RENDER_MARGIN = 1;
/** Chunks kept in memory beyond the render area on every side. Must be >= 1 so
 *  every object touching the render area has its anchor chunk resolved. */
export const CACHE_MARGIN = 2;
/** Chunks around the player's chunk that are simulated. */
export const SIM_RADIUS = 2;

/** Smallest biome, in chunks. Hardcoded by design (spec 3.2). */
export const MIN_BIOME_CHUNKS = 64;

/** Edge of a visit-counter region, in chunks. A region's counter goes up each
 *  time it fully leaves the cache radius, so the next visit rolls differently. */
export const REGION_SIZE = 8;

/** Max chunk generation jobs in flight across all workers. */
export const MAX_IN_FLIGHT = 6;

/** Player speed in tiles per second. */
export const WALK_SPEED = 5;
export const RUN_SPEED = 9;

/** Player collision box around the feet, in tiles. */
export const PLAYER_HALF_W = 0.3;
export const PLAYER_DEPTH = 0.25;

/** Enemy collision box half-width, in tiles. */
export const ENEMY_HALF_W = 0.3;
