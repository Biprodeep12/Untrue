// Chunk coordinate helpers. Keys pack (cx, cy) into one safe integer.

import { CHUNK_SIZE, REGION_SIZE } from './config';

const OFFSET = 2 ** 23;
const SPAN = 2 ** 24;

/** Keys hold chunk coordinates in [-2^23, 2^23), about ±268 million tiles.
 *  Player positions stay within half of that (±134 million tiles), leaving
 *  room for the areas loaded around them. Far beyond any walk: rendering
 *  loses float precision long before. */
export const WORLD_LIMIT = (OFFSET / 2) * CHUNK_SIZE;

/** A tile coordinate kept inside the world the keys can hold; NaN becomes 0. */
export function clampTile(t: number): number {
  return Number.isFinite(t) ? Math.max(-WORLD_LIMIT, Math.min(WORLD_LIMIT, t)) : 0;
}

export function chunkKey(cx: number, cy: number): number {
  return (cx + OFFSET) * SPAN + (cy + OFFSET);
}

export function keyX(key: number): number {
  return Math.floor(key / SPAN) - OFFSET;
}

export function keyY(key: number): number {
  return (key % SPAN) - OFFSET;
}

export function tileToChunk(t: number): number {
  return Math.floor(t / CHUNK_SIZE);
}

export function regionKey(cx: number, cy: number): number {
  return chunkKey(Math.floor(cx / REGION_SIZE), Math.floor(cy / REGION_SIZE));
}

/** Inclusive rectangle of chunk coordinates. */
export interface ChunkRect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export function inRect(r: ChunkRect, cx: number, cy: number): boolean {
  return cx >= r.x0 && cx <= r.x1 && cy >= r.y0 && cy <= r.y1;
}

export function expandRect(r: ChunkRect, n: number): ChunkRect {
  return { x0: r.x0 - n, y0: r.y0 - n, x1: r.x1 + n, y1: r.y1 + n };
}

export function sameRect(a: ChunkRect | null, b: ChunkRect): boolean {
  return !!a && a.x0 === b.x0 && a.y0 === b.y0 && a.x1 === b.x1 && a.y1 === b.y1;
}
