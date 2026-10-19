// The Drowned Archive's art, and the outer worlds' plot props, painted into
// the atlas at startup like everything else: cold marble halls, shelves to
// the ceiling, ink-black water and ankle-deep shallows; the relics the plots
// send the player after, the Hollow's empty bell frame, sodden books and a
// chained lectern. Also the flood overlay of the archive's sluice halls.

import type { Rng } from '../generation/Random';
import type { Painter } from './Atlas';

const A = {
  marble: 0x9aa4b0,
  marbleLt: 0xb8c2cc,
  marbleDk: 0x7a8492,
  vein: 0x6a7482,
  wet: 0x7e8c9c,
  wetLt: 0x9eb0c0,
  puddle: 0x4e6a84,
  carpet: 0x2a6a70,
  carpetDk: 0x1e4e54,
  carpetGold: 0xc8a050,
  wood: 0x5a3a26,
  woodDk: 0x3a2418,
  woodLt: 0x7a5236,
  ink: 0x0e1626,
  inkLt: 0x1c2c44,
  shallow: 0x3e6e92,
  shallowLt: 0x6ea0c4,
  foam: 0xbfe4f4,
  gold: 0xf2c96a,
  goldLt: 0xffe8a8,
  glow: 0xfff2c0,
};
const BOOKS = [0x8a2a2a, 0x2a4a8a, 0x3a6a3a, 0x8a6a2a, 0x5a2a6a, 0x2a6a6a];

/** Pale marble, flagged in large squares with dark veins. */
export function archiveFloor(p: Painter, v: number, rng: Rng): void {
  p.rect(0, 0, 16, 16, A.marble);
  p.speckle(rng, 8, A.marbleLt);
  p.speckle(rng, 5, A.marbleDk);
  p.rect(0, 0, 16, 1, A.marbleDk);
  p.rect(0, 0, 1, 16, A.marbleDk);
  // A vein across the slab.
  let y = rng.int(3, 12);
  for (let x = 1; x < 16; x++) {
    if (rng.next() < 0.3) y += rng.next() < 0.5 ? -1 : 1;
    if (v !== 1) p.set(x, Math.max(1, Math.min(14, y)), A.vein, 150);
  }
  if (v === 3) p.rect(rng.int(2, 10), rng.int(2, 10), 3, 1, A.marbleLt);
}

/** Marble the water has only just left: darker, with standing puddles. */
export function archiveWet(p: Painter, v: number, rng: Rng): void {
  p.rect(0, 0, 16, 16, A.wet);
  p.speckle(rng, 6, A.wetLt);
  p.rect(0, 0, 16, 1, A.marbleDk);
  p.rect(0, 0, 1, 16, A.marbleDk);
  const n = v === 0 ? 1 : 2;
  for (let k = 0; k < n; k++) {
    const cx = rng.int(4, 11);
    const cy = rng.int(4, 11);
    p.ellipse(cx, cy, rng.int(2, 4), rng.int(1, 2), A.puddle, 210);
    p.set(cx - 1, cy - 1, A.shallowLt);
  }
}

/** A worn reading-room carpet, gold-edged. */
export function archiveCarpet(p: Painter, v: number, rng: Rng): void {
  p.rect(0, 0, 16, 16, A.carpet);
  p.speckle(rng, 10, A.carpetDk);
  if (v & 1) for (let x = 0; x < 16; x += 4) p.set(x + 1, 7, A.carpetGold);
  if (v & 2) {
    p.rect(0, 1, 16, 1, A.carpetGold);
    p.rect(0, 14, 16, 1, A.carpetGold);
  }
}

/** Shelves seen from above: the tops of the stacks, books lying flat. */
export function bookWallTop(p: Painter, v: number, rng: Rng): void {
  p.rect(0, 0, 16, 16, A.woodDk);
  p.rect(0, 0, 16, 2, A.woodLt);
  p.rect(0, 8, 16, 1, A.wood);
  for (let k = 0; k < 4; k++) {
    const x = rng.int(1, 11);
    const y = rng.int(2, 12);
    p.rect(x, y, 4, 2, BOOKS[(k + v) % BOOKS.length]);
  }
}

/** The front of the shelves, rows of spines. */
export function bookWallFace(p: Painter, v: number, rng: Rng): void {
  p.rect(0, 0, 16, 16, A.wood);
  p.rect(0, 0, 16, 2, A.woodLt);
  for (const y of [2, 9]) {
    p.rect(0, y, 16, 6, A.woodDk);
    let x = 0;
    while (x < 16) {
      const w = rng.int(1, 3);
      const h = rng.int(4, 6);
      p.rect(x, y + 6 - h, w, h, BOOKS[rng.int(0, BOOKS.length - 1)]);
      if (rng.next() < 0.3) p.set(x, y + 6 - h + 1, A.gold);
      x += w;
    }
    p.rect(0, y + 6, 16, 1, A.woodLt);
  }
  // The flood's tide line.
  if (v & 1) p.rect(0, 13, 16, 3, A.inkLt, 120);
}

/** Black ink-water, too deep to wade: a slow sheen on it. */
export function inkWater(p: Painter, v: number, rng: Rng): void {
  // Blue-black, with a sheen and ripples, so it never reads as the void.
  p.rect(0, 0, 16, 16, 0x14263e);
  p.speckle(rng, 8, 0x1c3452);
  for (let k = 0; k < 2; k++) {
    const y = 2 + ((v * 5 + k * 7) % 12);
    const x = rng.int(1, 8);
    p.rect(x, y, rng.int(3, 6), 1, 0x3a5a80);
    p.set(x + 1, y - 1, 0x2a4666);
  }
  if (v === 2) p.set(rng.int(2, 13), rng.int(2, 13), 0x8ab0d0);
}

/** Ankle-deep water over the marble: the floor shows through. */
export function shallows(p: Painter, v: number, rng: Rng): void {
  p.rect(0, 0, 16, 16, A.shallow);
  p.speckle(rng, 6, A.puddle);
  p.rect(0, 0, 16, 1, 0x325a7a);
  p.rect(0, 0, 1, 16, 0x325a7a);
  for (let k = 0; k < 2; k++) {
    const x = rng.int(1, 10);
    const y = rng.int(2, 13);
    p.rect(x, y, rng.int(3, 5), 1, A.shallowLt, 200);
  }
  if (v === 3) p.set(rng.int(2, 13), rng.int(2, 13), A.foam);
}

/** The flood overlay of a sluice hall's floor: `f` 0 dry (nothing drawn),
 *  1 rising (a film of water), 2 flooded. */
export function floodOverlay(p: Painter, f: number, rng: Rng): void {
  if (f === 0) return;
  if (f === 1) {
    p.rect(0, 0, 16, 16, A.shallow, 120);
    for (let k = 0; k < 3; k++) p.rect(rng.int(1, 10), rng.int(2, 13), rng.int(3, 5), 1, A.shallowLt, 170);
    return;
  }
  // Flooded: deep water over the floor, rippling.
  p.rect(0, 0, 16, 16, 0x183a5e, 235);
  p.speckle(rng, 6, 0x24507a);
  for (let k = 0; k < 2; k++) {
    const y = 2 + ((k * 7 + rng.int(0, 3)) % 13);
    const x = rng.int(1, 8);
    p.rect(x, y, rng.int(3, 6), 1, 0x5a8ab4);
    p.set(x + 2, y - 1, 0x3e6e96);
  }
}

/** A sluice valve set in the floor, seen from above: a spoked wheel in a
 *  grate, `v` 1 once turned (gilt, the grate drained). */
export function valvePlate(p: Painter, v: number, rng: Rng): void {
  p.rect(0, 0, 16, 16, v ? A.wet : A.marbleDk);
  p.speckle(rng, 4, A.vein);
  // The grate.
  p.rect(1, 1, 14, 14, 0x3a3e48);
  for (let k = 2; k < 15; k += 3) {
    p.rect(k, 1, 1, 14, 0x24262e);
    p.rect(1, k, 14, 1, 0x24262e);
  }
  // The wheel.
  const c = v ? A.gold : 0x9a9aa6;
  p.ellipse(7.5, 7.5, 5.5, 5.5, c);
  p.ellipse(7.5, 7.5, 4, 4, v ? 0x5a4218 : 0x3a3a44);
  p.rect(7, 2, 2, 12, c);
  p.rect(2, 7, 12, 2, c);
  p.ellipse(7.5, 7.5, 1.5, 1.5, v ? A.goldLt : 0xc8c8d2);
  if (v) p.set(5, 4, 0xffffff);
}

/** A lost piece of something, on a low plinth, glowing. */
export function relic(p: Painter): void {
  p.shadow(8, 30, 5, 1.2);
  p.rect(4, 25, 8, 5, 0x6a6476);
  p.rect(4, 25, 8, 1, 0x8a849a);
  p.rect(3, 29, 10, 1, 0x4a4456);
  // The glow round it.
  p.ellipse(8, 18, 6, 6, A.glow, 60);
  p.ellipse(8, 18, 4, 4, A.glow, 90);
  // A broken shard of bronze or gilt.
  p.rect(6, 15, 4, 8, A.gold);
  p.rect(7, 13, 3, 2, A.gold);
  p.rect(6, 15, 1, 8, A.goldLt);
  p.set(9, 22, 0xa07a30);
  p.set(8, 16, 0xffffff);
  p.outline(0x2a1d17);
}

/** A bell frame of weathered timber, with no bell in it. */
export function bellFrame(p: Painter): void {
  p.shadow(16, 38, 12, 2);
  // Posts.
  p.rect(4, 8, 3, 30, A.wood);
  p.rect(25, 8, 3, 30, A.wood);
  p.rect(4, 8, 1, 30, A.woodLt);
  p.rect(25, 8, 1, 30, A.woodLt);
  // The beam and the little roof.
  p.rect(2, 7, 28, 3, A.woodDk);
  p.rect(2, 7, 28, 1, A.woodLt);
  for (let k = 0; k < 7; k++) p.rect(4 + k, 6 - k * 0.6, 24 - k * 2, 1, 0x6a3a2a);
  // The empty hook, and a snapped rope.
  p.rect(15, 10, 2, 3, 0x4a4a52);
  p.rect(15, 13, 1, 4, 0xc8b080);
  p.set(16, 17, 0xc8b080);
  // Feet.
  p.rect(2, 36, 7, 2, A.woodDk);
  p.rect(23, 36, 7, 2, A.woodDk);
  p.outline(0x24160e);
}

/** A slumped drift of sodden books. */
export function bookPile(p: Painter, rng: Rng): void {
  p.ellipse(8, 15, 7, 1.5, 0x000000, 50);
  for (let k = 0; k < 4; k++) {
    const y = 13 - k * 2;
    const x = 2 + rng.int(0, 3);
    p.rect(x, y, rng.int(7, 10), 2, BOOKS[(k * 2 + 1) % BOOKS.length]);
    p.rect(x, y, 1, 2, 0xe8dcc0);
  }
  p.set(rng.int(4, 11), rng.int(6, 12), 0xe8dcc0);
  p.outline(0x1a120c);
}

/** A reading lectern with a great book chained to it, open, faintly lit. */
export function lectern(p: Painter): void {
  p.shadow(8, 30, 6, 1.5);
  p.rect(7, 18, 2, 12, A.wood);
  p.rect(4, 28, 8, 2, A.woodDk);
  // The slanted top and the open book.
  p.rect(2, 13, 12, 5, A.woodDk);
  p.rect(2, 12, 12, 2, A.woodLt);
  p.rect(3, 9, 5, 4, 0xe8dcc0);
  p.rect(8, 9, 5, 4, 0xf2e8d0);
  p.rect(8, 9, 1, 4, 0xb8a888);
  for (const y of [10, 11]) {
    p.rect(4, y, 3, 1, 0x7a6a5a);
    p.rect(9, y, 3, 1, 0x7a6a5a);
  }
  // The chain.
  for (let k = 0; k < 4; k++) p.set(13, 14 + k * 2, 0x9a9aa4);
  p.ellipse(8, 10, 5, 3, 0x8ae8ff, 50);
  p.outline(0x1a120c);
}
