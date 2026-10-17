// The rifts' art, painted into the atlas at startup like everything else: the
// tear (a loop of frames swapped on a timer, never redrawn), its soft halo
// (an additive sprite whose alpha and scale pulse), the scorched ground
// around it (a decal with a ragged, dithered edge, so it fades into whatever
// biome it opened in), and the cooled scar a closed rift leaves.

import { SimplexNoise } from '../generation/Noise';
import { Rng } from '../generation/Random';
import type { Painter } from './Atlas';

/** The tear: frame size and how many frames loop. */
export const TEAR_W = 48;
export const TEAR_H = 64;
export const TEAR_FRAMES = 8;
/** The halo behind the tear. */
export const HALO_W = 64;
export const HALO_H = 80;
/** The scorched ground decal, centred on the tear's tile. */
export const SCORCH_W = 112;
export const SCORCH_H = 96;
/** Where the tear's opening is centred in its frame, from the frame's bottom. */
export const TEAR_MID_UP = 34;

const C = {
  white: 0xffffff,
  core: 0xd8fffa,
  cyanLt: 0x9ff8f2,
  cyan: 0x4ad8e4,
  cyanDk: 0x2a8aa8,
  violetLt: 0xd6a8ff,
  violet: 0xb07aff,
  violetMd: 0x8a4ad8,
  violetDk: 0x5a2a98,
  pink: 0xff6ab8,
  voidLt: 0x2a1450,
  void: 0x1a0d33,
  voidDk: 0x10081f,
  star: 0x8a6ad0,
};

/** Ordered dither: soft edges in hard pixels. */
const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];
function bayer(x: number, y: number): number {
  return (BAYER[(x & 3) + (y & 3) * 4] + 0.5) / 16;
}

function hash2(x: number, y: number): number {
  let h = Math.imul(x | 0, 374761393) ^ Math.imul(y | 0, 668265263);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

// The opening, from TOP to BOTTOM rows, centred on CX.
const CX = 24;
const TOP = 6;
const BOTTOM = 54;
const MID = TEAR_H - TEAR_MID_UP;
const HALF_H = (BOTTOM - TOP) / 2;
const MAX_W = 8.5;

/** Ragged edges, fixed per row so the tear keeps its shape as it breathes. */
const JAG_L: number[] = [];
const JAG_R: number[] = [];
{
  const rng = new Rng(0x7ea2);
  for (let y = 0; y < TEAR_H; y++) {
    JAG_L.push(rng.chance(0.45) ? rng.int(-1, 1) : 0);
    JAG_R.push(rng.chance(0.45) ? rng.int(-1, 1) : 0);
  }
  // A few sharp barbs where the air tore further, two rows each.
  for (const [y, side, n] of [[13, -1, 3], [22, 1, 3], [31, -1, 2], [37, 1, 2], [44, -1, 2]]) {
    const jag = side < 0 ? JAG_L : JAG_R;
    jag[y] = side * n;
    jag[y + 1] = side * (n - 1);
  }
}

/** One frame of the tear, 48 x 64, standing on its tile: a jagged rip in the
 *  air with crackling edges, a swirling violet-to-cyan vortex inside around a
 *  white core, a dithered glow around it, and shards and embers spiralling in. */
export function paintTear(p: Painter, f: number): void {
  const phase = (f / TEAR_FRAMES) * Math.PI * 2;
  const breath = 1 + 0.06 * Math.sin(phase);

  // Light pooled on the ground under it.
  p.ellipse(CX, 59, 14, 3.2, C.violetDk, 70);
  p.ellipse(CX, 59, 9 + (f % 2), 2.2, C.violetMd, 110);
  p.ellipse(CX, 59, 4, 1.2, C.cyanLt, 150);

  // A dithered glow around the whole tear, breathing with it.
  for (let y = 0; y < TEAR_H - 6; y++) {
    for (let x = 0; x < TEAR_W; x++) {
      const e = Math.hypot((x - CX) / (16 * breath), (y - MID) / (32 * breath));
      if (e >= 1) continue;
      const lvl = Math.floor((1 - e) * 3.2 + bayer(x, y));
      if (lvl <= 0) continue;
      p.set(x, y, lvl >= 3 ? C.violet : lvl === 2 ? C.violetMd : C.violetDk, lvl >= 3 ? 120 : lvl === 2 ? 90 : 60);
    }
  }

  // Bits of ground lifted toward it, bobbing.
  for (let k = 0; k < 3; k++) {
    const x = [13, 35, 30][k];
    const y = Math.round(55 - k * 3 - 2 * Math.sin(phase + k * 2.1));
    p.rect(x, y, 2, 2, 0x4a3a4a);
    p.set(x, y, 0x8a7a8a);
    p.set(x + 1, y + 2, C.violetDk, 120);
  }

  // The opening, row by row.
  const left: number[] = [];
  const right: number[] = [];
  for (let y = TOP; y <= BOTTOM; y++) {
    const t = (y - TOP) / (BOTTOM - TOP);
    const xc = CX + Math.sin(y * 0.15 + 0.6) * 1.3 + Math.sin(phase + y * 0.45) * 0.45;
    const w = MAX_W * Math.pow(Math.sin(Math.PI * t), 0.75) * (1 + 0.05 * Math.sin(phase * 2 + y * 0.3));
    const l = Math.round(xc - w) + (w > 2 ? JAG_L[y] : 0);
    const r = Math.round(xc + w) + (w > 2 ? JAG_R[y] : 0);
    left.push(l);
    right.push(r);
    // Edge glow just outside, then the crackling rim, then the vortex.
    p.set(l - 1, y, (y + f) % 7 === 0 ? C.pink : C.violetLt, 200);
    p.set(r + 1, y, (y + f * 3) % 9 === 0 ? C.pink : C.violetLt, 200);
    for (let x = l + 1; x < r; x++) p.set(x, y, vortex(x, y, xc, Math.min(x - l, r - x), phase, f));
    const flick = (y + f) % 4 < 2;
    p.set(l, y, flick ? C.white : C.cyanLt);
    p.set(r, y, flick ? C.cyanLt : C.white);
  }

  // Now and then a row of it slips sideways, fringed pink and cyan.
  if (f === 2 || f === 5) {
    const y = 16 + f * 4;
    const i = y - TOP;
    p.rect(left[i] - 3, y, right[i] - left[i] + 4, 1, C.pink, 210);
    p.rect(left[i] + 2, y + 1, right[i] - left[i] + 2, 1, C.cyanLt, 190);
  }

  // Crackles of light jumping off the edges, different every frame.
  const rng = new Rng(911 + f * 37);
  const bolts = 2 + (f % 2);
  for (let b = 0; b < bolts; b++) {
    let y = rng.int(TOP + 8, BOTTOM - 8);
    const side = rng.chance(0.5) ? -1 : 1;
    let x = side < 0 ? left[y - TOP] - 1 : right[y - TOP] + 1;
    const n = rng.int(4, 7);
    for (let k = 0; k < n; k++) {
      x += side;
      y += rng.int(-1, 1);
      p.set(x, y, k < n / 2 ? C.cyanLt : C.violetLt, 240 - k * 15);
      if (k === 2 && rng.chance(0.5)) p.set(x + side, y - 1, C.violet, 170);
    }
    p.set(x + side, y, C.pink, 200);
  }

  // Shards and embers spiralling into it: each a step further along every frame.
  const K = 12;
  for (let k = 0; k < K; k++) {
    const prog = (f / TEAR_FRAMES + k / K) % 1;
    const rr = 1.15 * Math.pow(1 - prog, 0.9);
    if (rr < 0.42) continue;
    const a = k * 2.39996 + prog * 2.4;
    const x = Math.round(CX + Math.cos(a) * rr * 20);
    const y = Math.round(MID + Math.sin(a) * rr * 28);
    const color = k % 3 === 0 ? C.pink : k % 3 === 1 ? C.cyanLt : 0xe8d0ff;
    const alpha = Math.round(140 + 115 * Math.min(1, prog * 2));
    p.set(x, y, color, alpha);
    if (k % 2 === 0) p.set(x + 1, y - 1, color, alpha - 60);
    // A faint trail behind it.
    const a2 = a - 0.25;
    const r2 = rr + 0.08;
    p.set(Math.round(CX + Math.cos(a2) * r2 * 20), Math.round(MID + Math.sin(a2) * r2 * 28), C.violet, 90);
  }
}

/** The vortex inside the tear at a pixel: a tunnel of light rings, white at
 *  its heart, cyan, then violet, sinking into dark void toward the rim, all
 *  twisted by the swirl, with thin spiral streaks and stars in the dark. */
function vortex(x: number, y: number, xc: number, edge: number, phase: number, f: number): number {
  if (edge === 1) return (y + f) % 5 === 0 ? C.violet : C.voidDk;
  const ex = (x - xc) / (MAX_W + 0.5);
  const ey = (y - MID) / HALF_H;
  const r = Math.hypot(ex, ey);
  const a = Math.atan2(ey, ex);
  // The rings, wound round by the swirl.
  const q = r * (1 + 0.22 * Math.sin(2 * a + 6 * r - phase)) - 0.02 * Math.sin(phase * 2);
  if (q < 0.12) return C.white;
  if (q < 0.22) return C.core;
  if (q < 0.32) return C.cyanLt;
  if (q < 0.42) return C.cyan;
  if (q < 0.5) return C.cyanDk;
  if (q < 0.58) return C.violet;
  if (q < 0.68) return C.violetMd;
  // Thin streaks spiralling in through the dark.
  const s = Math.sin(2 * a + 9 * r - phase * 2);
  if (s > 0.9) return r < 0.8 ? C.violetLt : C.violet;
  if (s > 0.6) return C.violetDk;
  if (hash2(x * 7 + (f >> 1), y) < 0.06) return C.star;
  return q > 0.85 ? C.voidDk : q > 0.76 ? C.void : C.voidLt;
}

/** The halo behind the tear: a soft, dithered glow drawn additively. */
export function paintHalo(p: Painter): void {
  const cx = HALO_W / 2;
  const cy = HALO_H / 2;
  for (let y = 0; y < HALO_H; y++) {
    for (let x = 0; x < HALO_W; x++) {
      const e = Math.hypot((x - cx + 0.5) / (cx - 1), (y - cy + 0.5) / (cy - 1));
      if (e >= 1) continue;
      const v = (1 - e) * (1 - e);
      const lvl = Math.floor(v * 6 + bayer(x, y));
      if (lvl <= 0) continue;
      p.set(x, y, lvl >= 4 ? 0xa8f0ff : lvl >= 2 ? 0xc090ff : 0x9a60e8, Math.min(255, 40 + lvl * 34));
    }
  }
}

/** The ground around a rift, as a decal centred on the tear's tile: charred
 *  earth cracked by glowing veins (`closed`: cooled ash and dark cracks),
 *  fading out through a dithered, ragged edge. Its middle is solid over the
 *  rift's own tiles (a plus of five around the tear), hiding their edges. */
export function paintScorch(p: Painter, closed: boolean): void {
  const cx = SCORCH_W / 2;
  const cy = SCORCH_H / 2;
  const noise = new SimplexNoise(closed ? 0x5ca2 : 0x5ca1);
  const rx = closed ? 42 : 48;
  const ry = closed ? 38 : 44;
  const shade = closed ? [0x6e6258, 0x645850, 0x7a6e62] : [0x42343a, 0x382c32, 0x4e3e40];
  const mid = closed ? [0x7e7064, 0x74675c] : [0x6a5446, 0x765e4c];
  const ash = closed ? 0x7a6a5a : 0x5e4434;
  for (let y = 0; y < SCORCH_H; y++) {
    for (let x = 0; x < SCORCH_W; x++) {
      const d0 = Math.hypot((x - cx + 0.5) / rx, (y - cy + 0.5) / ry);
      // Ragged only away from the middle, which must stay solid.
      const wob = Math.min(1, Math.max(0, (d0 - 0.4) / 0.4));
      const d = d0 + 0.2 * noise.fbm(x * 0.07, y * 0.07, 3) * wob;
      const n = noise.noise2(x * 0.25 + 40, y * 0.25);
      if (d0 + 0.12 * noise.fbm(x * 0.12 + 9, y * 0.12, 2) < 0.4) p.set(x, y, n > 0.35 ? shade[2] : n < -0.3 ? shade[1] : shade[0]);
      else if (d < 0.68) p.set(x, y, n > 0.2 ? mid[1] : mid[0]);
      else if (d < 1) {
        const lvl = Math.floor(((1 - d) / 0.32) * 3 + bayer(x, y));
        if (lvl > 0) p.set(x, y, ash, [0, 55, 95, 140][Math.min(3, lvl)]);
      } else if (d < 1.15 && hash2(x, y) < 0.06) p.set(x, y, ash, 90);
    }
  }

  // Cracks running out from the middle: glowing while the rift is open.
  const rng = new Rng(closed ? 0x51ca : 0x51c0);
  const veins = closed ? 5 : 7;
  for (let v = 0; v < veins; v++) {
    const a0 = (v / veins) * Math.PI * 2 + rng.range(-0.3, 0.3);
    let x = cx + Math.cos(a0) * 5;
    let y = cy + Math.sin(a0) * 4;
    let a = a0;
    const len = rng.int(20, 36);
    for (let k = 0; k < len; k++) {
      a += rng.range(-0.45, 0.45);
      a = a0 + Math.max(-0.7, Math.min(0.7, a - a0));
      x += Math.cos(a);
      y += Math.sin(a) * 0.85;
      const d = Math.hypot((x - cx) / rx, (y - cy) / ry);
      if (d > 0.98) break;
      if (closed) {
        p.set(x, y, 0x3a3236, d < 0.7 ? 230 : 150);
        continue;
      }
      const c = d < 0.24 ? 0xe8d0ff : d < 0.34 ? C.violetLt : d < 0.44 ? C.violet : d < 0.56 ? C.violetDk : 0x30242a;
      p.set(x, y, c, d < 0.56 ? 255 : 150);
      // A dim glow beside the bright part.
      if (d < 0.32) p.set(x + 1, y + 1, C.violetMd, 80);
      // A fork now and then.
      if (k === 12 && rng.chance(0.5)) {
        let bx = x;
        let by = y;
        const ba = a + (rng.chance(0.5) ? 0.9 : -0.9);
        for (let j = 0; j < 6; j++) {
          bx += Math.cos(ba);
          by += Math.sin(ba) * 0.85;
          p.set(bx, by, j < 3 ? C.violetDk : 0x2a1e24, 200 - j * 15);
        }
      }
    }
  }

  if (closed) {
    // A pale, healed seam where the tear was, and the last few glints.
    p.ellipse(cx, cy + 2, 8, 3, 0x8a8090, 160);
    for (const [x, y] of [[cx - 12, cy - 6], [cx + 15, cy + 5], [cx - 4, cy + 12]]) p.set(x, y, C.cyanLt, 150);
    return;
  }
  // The burn where the tear meets the ground, and embers in the char.
  p.ellipse(cx, cy + 2, 11, 5, 0x1c1222);
  p.ellipse(cx, cy + 2, 7, 3, 0x2a1440);
  p.ellipse(cx, cy + 2, 3, 1.4, C.violetMd);
  for (let k = 0; k < 14; k++) {
    const x = cx + rng.int(-26, 26);
    const y = cy + rng.int(-20, 20);
    if (Math.hypot((x - cx) / rx, (y - cy) / ry) > 0.6) continue;
    p.set(x, y, k % 3 ? C.violetLt : C.cyanLt, 220);
  }
  // Pebbles knocked loose.
  for (let k = 0; k < 6; k++) {
    const x = cx + rng.int(-34, 34);
    const y = cy + rng.int(-26, 26);
    if (Math.hypot((x - cx) / rx, (y - cy) / ry) < 0.35) continue;
    p.rect(x, y, 2, 1, 0x5a4a4e);
    p.set(x, y - 1, 0x7a6a6a);
  }
}

/** A closed rift's own mark, 16 x 16 on its tile: a short healed seam of
 *  pale light hanging over the ash, stitched shut, with a glint or two. */
export function paintScar(p: Painter): void {
  p.ellipse(8, 14, 4, 1.2, 0x2a1e38, 110);
  for (let y = 3; y <= 12; y++) {
    const x = 8 + (y % 5 === 0 ? 1 : 0);
    p.set(x, y, y < 5 || y > 10 ? 0xb8a8d8 : 0xe8e0ff, 220);
    p.set(x - 1, y, C.violet, 70);
    p.set(x + 1, y, C.violet, 70);
  }
  for (const y of [5, 8, 11]) {
    p.set(7, y, 0x8a74a0, 230);
    p.set(9, y - 1, 0x8a74a0, 230);
  }
  p.set(5, 4, C.cyanLt, 170);
  p.set(11, 9, C.cyanLt, 140);
  p.set(4, 11, C.violetLt, 120);
}

/** The scorched tile under the decal: the same charred earth, in case it shows. */
export function paintRiftGround(p: Painter, rng: Rng, variant: number): void {
  p.rect(0, 0, 16, 16, 0x4e3e3e);
  p.speckle(rng, 12, 0x3a2c34);
  p.speckle(rng, 8, 0x5a4842);
  if (variant % 2) {
    let x = rng.int(3, 12);
    for (let y = rng.int(0, 6), n = rng.int(5, 9); n > 0 && y < 16; y++, n--) {
      x = Math.max(0, Math.min(15, x + rng.int(-1, 1)));
      p.set(x, y, n % 3 ? C.violetDk : C.violet);
    }
  }
}
