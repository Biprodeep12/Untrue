// Buildings drawn as single sprites (houses, cabins, keeps, barracks, city
// houses): a shaded roof, real walls with windows and a door, painted once
// per building and cached.

import { Container, Sprite, Texture } from 'pixi.js';
import { CHUNK_SIZE, TILE_SIZE } from '../config';
import { type ChunkRect } from '../coords';
import { Rng } from '../generation/Random';
import type { BuildingSpec, BuildingStyle } from '../generation/StructureGenerator';
import type { WorldObject } from '../world/WorldObject';
import { Painter, shade } from './Atlas';
import type { Light } from './Lighting';

type RGB = number;

/** Roof overhang past the walls on each side, and how far the roof and
 *  chimney rise above the footprint, in pixels. */
const OVERHANG = 4;
const RISE = 18;

interface Art {
  texture: Texture;
  width: number;
  height: number;
  /** Window centres, in pixels from the sprite's top-left. */
  windows: Array<[number, number]>;
  /** Pixels the art reaches left of the footprint (OVERHANG if not set). */
  offset?: number;
}

/** How a building looks: picked once from its seed. */
interface Look {
  wall: RGB;
  trim: RGB;
  roof: RGB;
  /** Shutters and painted doors. */
  accent: RGB;
  material: 'siding' | 'brick' | 'logs' | 'plaster' | 'timber' | 'stone' | 'cottage';
  /** Hip: slopes at both ends. Gable: straight across between bargeboards.
   *  A-frame: a peaked roof with its gable facing the viewer and its slopes
   *  running back, so the building's outline is peaked, not boxy. */
  roofKind: 'hip' | 'gable' | 'aframe';
  /** Share of the roof's height that is the gable triangle; the rest is the
   *  roof surface seen sloping back above it. Higher is steeper. */
  pitch: number;
  /** Minimum wall height in pixels. */
  wallHeight: number;
  porch: boolean;
  shutters: boolean;
  boxes: boolean;
  lamp: boolean;
  moss: boolean;
  vane: boolean;
}

const ROOFS = [0xc8442c, 0xd0603a, 0xb4543b, 0x4a6a9a, 0x5a8a4a, 0x8a5a3a, 0x9a4a6a];
const SIDING = [0xd09858, 0xc88a4a, 0xd8b07a, 0xe8dcc0, 0xb8cfe0, 0xc8d8a8, 0xf0e0a8];
const ACCENTS = [0x4a7a5a, 0x3a5a8a, 0x8a3a3a, 0x5a4a8a, 0x2a6a6a];
const FLOWERS = [0xf26a8c, 0xf4d03f, 0xffffff, 0xb07ae0, 0xff8a3a];

function lookOf(style: BuildingStyle, rng: Rng): Look {
  const accent = rng.pick(ACCENTS);
  switch (style) {
    case 'cabin':
      return { wall: 0x9a6a3a, trim: 0x5a3a1d, roof: 0x6a4a2a, accent: 0x6b4423, material: 'logs', roofKind: 'aframe', pitch: rng.range(0.42, 0.52), wallHeight: 30, porch: rng.chance(0.5), shutters: rng.chance(0.4), boxes: false, lamp: rng.chance(0.5), moss: rng.chance(0.6), vane: false };
    case 'stone':
      return { wall: 0xa9a39a, trim: 0x5e5850, roof: 0x4a5468, accent: 0x5a3a1d, material: 'stone', roofKind: 'hip', pitch: 0.6, wallHeight: 32, porch: false, shutters: false, boxes: false, lamp: true, moss: rng.chance(0.3), vane: false };
    case 'keep':
      return { wall: 0x9a948a, trim: 0x5e5850, roof: 0x4a5060, accent: 0x5a3a1d, material: 'stone', roofKind: 'hip', pitch: 0.6, wallHeight: 44, porch: false, shutters: false, boxes: false, lamp: true, moss: false, vane: false };
    case 'city':
      return { wall: 0xeee2c8, trim: 0x5a3a1d, roof: rng.chance(0.6) ? 0xb8583a : 0x4a5468, accent, material: 'timber', roofKind: rng.chance(0.5) ? 'aframe' : rng.chance(0.5) ? 'hip' : 'gable', pitch: rng.range(0.42, 0.5), wallHeight: 34, porch: false, shutters: rng.chance(0.5), boxes: rng.chance(0.4), lamp: rng.chance(0.6), moss: false, vane: rng.chance(0.1) };
    default: {
      const materials: Array<[Look['material'], number]> = [['siding', 50], ['brick', 18], ['cottage', 18], ['plaster', 14]];
      const material = rng.weighted(materials, ([, w]) => w)![0];
      const roofKind: Look['roofKind'] = 'aframe';
      const wall = material === 'brick' ? rng.pick([0xa8503a, 0x9a5a48, 0xb86a4a]) : material === 'siding' ? rng.pick(SIDING) : rng.pick([0xeee2c8, 0xf0e8d8, 0xe8d8b8]);
      return { wall, trim: material === 'siding' ? 0xf0e8d8 : 0x6b4423, roof: rng.pick(ROOFS), accent, material, roofKind, pitch: rng.range(0.4, 0.52), wallHeight: 30, porch: rng.chance(0.45), shutters: rng.chance(0.6), boxes: rng.chance(0.6), lamp: rng.chance(0.5), moss: rng.chance(0.2), vane: rng.chance(0.15) };
    }
  }
}

/** Fills the wall rectangle with its material. */
function walls(p: Painter, rng: Rng, look: Look, x0: number, y0: number, w: number, h: number): void {
  const x1 = x0 + w;
  const y1 = y0 + h;
  const c = look.wall;
  switch (look.material) {
    case 'siding': {
      // Clapboards: each board lit along its top and shadowed under its lip.
      for (let y = y0, row = 0; y < y1; y += 4, row++) {
        const tone = rng.range(0.96, 1.03);
        p.rect(x0, y, w, 4, shade(c, tone));
        p.rect(x0, y, w, 1, shade(c, tone * 1.1));
        p.rect(x0, y + 3, w, 1, shade(c, 0.74));
        for (let x = x0 + rng.int(6, 20); x < x1 - 3; x += rng.int(18, 30)) p.rect(x, y, 1, 3, shade(c, 0.82));
        if (row % 3 === 1) p.set(rng.int(x0 + 4, x1 - 4), y + 2, shade(c, 0.88));
      }
      // Corner boards.
      for (const x of [x0, x1 - 3]) {
        p.rect(x, y0, 3, h, look.trim);
        p.rect(x, y0, 1, h, shade(look.trim, 1.08));
        p.rect(x + 2, y0, 1, h, shade(look.trim, 0.8));
      }
      break;
    }
    case 'brick':
      for (let y = y0, row = 0; y < y1; y += 3, row++) {
        p.rect(x0, y + 2, w, 1, 0xc8b8a0);
        for (let x = x0 - (row % 2 ? 3 : 0); x < x1; x += 6) {
          const bx = Math.max(x0, x);
          const bw = Math.min(x + 5, x1) - bx;
          if (bw > 0) p.rect(bx, y, bw, 2, shade(c, rng.range(0.88, 1.08)));
          if (x + 5 < x1 && x + 5 >= x0) p.rect(x + 5, y, 1, 2, 0xc8b8a0);
        }
      }
      // Pale stone quoins at the corners.
      for (let y = y0; y < y1; y += 6) {
        for (const x of [x0, x1 - 4]) {
          p.rect(x, y, 4, 5, 0xd8d0c0);
          p.rect(x, y + 5, 4, 1, 0x9a948a);
        }
      }
      break;
    case 'logs':
      for (let y = y0; y < y1; y += 5) {
        p.rect(x0, y, w, 5, c);
        p.rect(x0, y, w, 1, shade(c, 1.25));
        p.rect(x0, y + 1, w, 1, shade(c, 1.1));
        p.rect(x0, y + 4, w, 1, shade(c, 0.6));
        for (let k = 0; k < w / 10; k++) p.set(rng.int(x0, x1 - 1), y + rng.int(1, 3), shade(c, 0.8));
        // Round log ends past the corners, with growth rings.
        for (const x of [x0 - 2, x1 - 1]) {
          p.ellipse(x + 1.5, y + 2.5, 2.2, 2.3, shade(c, 1.2));
          p.ellipse(x + 1.5, y + 2.5, 1, 1, shade(c, 0.95));
        }
      }
      break;
    case 'stone':
      for (let y = y0, row = 0; y < y1; y += 5, row++) {
        p.rect(x0, y + 4, w, 1, shade(c, 0.62));
        let x = x0 - (row % 2 ? rng.int(2, 5) : 0);
        while (x < x1) {
          const bw = rng.int(6, 10);
          const bx = Math.max(x0, x);
          const right = Math.min(x + bw, x1);
          p.rect(bx, y, right - bx, 4, shade(c, rng.range(0.86, 1.1)));
          p.rect(bx, y, right - bx, 1, shade(c, 1.15));
          if (right < x1) p.rect(right - 1, y, 1, 4, shade(c, 0.62));
          x += bw;
        }
      }
      break;
    case 'plaster':
    case 'timber':
    case 'cottage': {
      p.rect(x0, y0, w, h, c);
      for (let k = 0; k < (w * h) / 40; k++) p.set(rng.int(x0, x1 - 1), rng.int(y0, y1 - 1), shade(c, rng.chance(0.5) ? 0.94 : 1.04));
      if (look.material === 'cottage') {
        // Fieldstone below, under a beam.
        const sy = y0 + Math.round(h * 0.55);
        p.rect(x0, sy, w, y1 - sy, 0x8a8478);
        for (let k = 0; k < (w * (y1 - sy)) / 14; k++) {
          const sx = rng.int(x0, x1 - 2);
          const yy = rng.int(sy + 1, y1 - 2);
          p.ellipse(sx, yy, rng.range(1.6, 3), rng.range(1.2, 2), shade(0xa9a39a, rng.range(0.85, 1.12)));
        }
        p.rect(x0, sy - 2, w, 2, 0x6b4423);
        p.rect(x0, sy - 2, w, 1, 0x8a5a2b);
      }
      if (look.material === 'timber') {
        // Exposed timber frame: plates, a rail, posts, and braces in the end bays.
        const t = look.trim;
        const mid = y0 + Math.floor(h / 2);
        p.rect(x0, y0, w, 2, t);
        p.rect(x0, mid, w, 2, t);
        const posts: number[] = [];
        for (let x = x0; x < x1 - 2; x += 16) posts.push(x);
        posts.push(x1 - 2);
        for (const x of posts) p.rect(x, y0, 2, h, t);
        for (const [a, b] of [[posts[0], posts[1]], [posts[posts.length - 2], posts[posts.length - 1]]]) {
          if (b === undefined || b - a < 8) continue;
          for (let k = 0; k < mid - y0; k++) {
            const fx = a + 2 + Math.round(((b - a - 3) * k) / (mid - y0));
            p.rect(fx, y0 + 2 + k, 2, 1, t);
          }
        }
      }
      break;
    }
  }
  // Light from the left: the far end of the wall is a little darker.
  for (let x = x1 - 5; x < x1; x++) for (let y = y0; y < y1; y++) p.set(x, y, 0x000000, 18 + (x - (x1 - 5)) * 6);
}

function window_(p: Painter, look: Look, rng: Rng, wx: number, wy: number, arched: boolean): void {
  const frame = look.material === 'siding' || look.material === 'plaster' || look.material === 'cottage' ? 0xf0e8d8 : shade(look.trim, 0.85);
  if (look.shutters) {
    for (const sx of [wx - 5, wx + 11]) {
      p.rect(sx, wy - 1, 4, 12, look.accent);
      p.rect(sx, wy - 1, 1, 12, shade(look.accent, 1.2));
      for (let y = wy + 1; y < wy + 11; y += 2) p.rect(sx + 1, y, 3, 1, shade(look.accent, 0.75));
    }
  }
  p.rect(wx - 1, wy - 1, 12, 12, frame);
  if (arched) p.ellipse(wx + 4.5, wy, 6, 3, frame);
  // Glass: brighter at the top, with a glint.
  for (let y = 0; y < 10; y++) p.rect(wx, wy + y, 10, 1, shade(0x86bde3, 1.12 - y * 0.035));
  if (arched) p.ellipse(wx + 4.5, wy + 0.5, 4.8, 2.2, 0x9ccbe8);
  p.rect(wx + 1, wy + 1, 2, 1, 0xe6f6fc);
  p.set(wx + 1, wy + 2, 0xe6f6fc);
  // Curtains in the corners.
  if (look.material !== 'stone' && rng.chance(0.6)) {
    const curtain = shade(look.accent, 1.6);
    p.rect(wx, wy, 2, 6, curtain);
    p.rect(wx + 8, wy, 2, 6, curtain);
  }
  p.rect(wx + 4, wy, 2, 10, frame);
  p.rect(wx, wy + 4, 10, 2, frame);
  // Sill.
  p.rect(wx - 2, wy + 11, 14, 1, shade(frame, 1.05));
  p.rect(wx - 2, wy + 12, 14, 1, 0x000000, 60);
  if (look.boxes) {
    p.rect(wx - 1, wy + 12, 12, 3, 0x8a5a2b);
    p.rect(wx - 1, wy + 12, 12, 1, 0xa87442);
    for (let k = 0; k < 6; k++) {
      p.set(wx + k * 2, wy + 11, 0x4f9a4a);
      p.set(wx + k * 2 + 1, wy + 10, rng.pick(FLOWERS));
    }
  }
}

function door(p: Painter, look: Look, x: number, bottom: number, w: number, h: number): void {
  const y = bottom - h;
  const painted = look.material !== 'logs' && look.material !== 'stone';
  const wood = painted ? look.accent : 0x6b4423;
  const frame = look.material === 'siding' || look.material === 'plaster' ? 0xf0e8d8 : shade(look.trim, 0.8);
  p.rect(x - 2, y - 2, w + 4, h + 2, frame);
  p.ellipse(x + w / 2 - 0.5, y + 2, w / 2 + 2, 4, frame);
  p.rect(x, y + 3, w, h - 3, wood);
  p.ellipse(x + w / 2 - 0.5, y + 3, w / 2, 4, wood);
  for (let k = x + 3; k < x + w; k += 3) p.rect(k, y + 1, 1, h - 1, shade(wood, 0.78));
  p.rect(x, y + 3, 1, h - 3, shade(wood, 1.2));
  // Iron hinges, a brass knob, and a little window.
  for (const hy of [y + 5, bottom - 5]) p.rect(x, hy, 4, 1, 0x3a3a42);
  p.set(x + w - 3, y + Math.round(h * 0.55), 0xe8c050);
  if (painted) {
    p.rect(x + w / 2 - 2, y + 3, 4, 3, 0x86bde3);
    p.set(x + w / 2 - 2, y + 3, 0xe6f6fc);
  }
  // A stone step.
  p.rect(x - 3, bottom - 1, w + 6, 2, 0xb8b2a6);
  p.rect(x - 3, bottom - 1, w + 6, 1, 0xd0cabe);
}

/** A covered porch: a little A-frame roof over the door on two posts. */
function porchFrame(p: Painter, rng: Rng, look: Look, x: number, doorTop: number, w: number, bottom: number, windows: Array<[number, number]>, snowy: boolean): void {
  const x0 = x - 8;
  const x1 = x + w + 8;
  const top = doorTop - 15;
  const base = doorTop - 1;
  // Posts down to the step, lit on their left.
  for (const px of [x0 + 2, x1 - 4]) {
    p.rect(px, base, 2, bottom - base, 0x8a5a2b);
    p.set(px, base, 0xb07a44);
    p.rect(px, base + 1, 1, bottom - base - 1, 0xa87442);
    p.rect(px, bottom - 1, 2, 1, 0x5c3a1c);
  }
  aFrame(p, rng, { ...look, pitch: 0.5 }, x0, x1, top, base, windows, snowy, false);
}

/** A small roof on brackets over the door. */
function porch(p: Painter, look: Look, x: number, y: number, w: number): void {
  const pw = w + 10;
  const px = x - 5;
  for (let k = 0; k < 6; k++) p.rect(px + k, y + k, pw - k * 2, 1, shade(look.roof, 1.15 - k * 0.06));
  p.rect(px, y + 5, pw, 2, shade(look.roof, 0.62));
  p.rect(px, y + 7, pw, 1, 0x000000, 70);
  for (const bx of [px + 1, px + pw - 3]) {
    for (let k = 0; k < 4; k++) p.set(bx + (bx < x ? k * 0.5 : -k * 0.5), y + 7 + k, 0x5c3a1c);
  }
}

/** A wall lantern on a bracket; returns where its light is. */
function wallLamp(p: Painter, x: number, y: number): [number, number] {
  p.rect(x, y, 3, 1, 0x3a3a42);
  p.rect(x + 2, y + 1, 1, 1, 0x3a3a42);
  p.rect(x + 1, y + 2, 4, 5, 0x3a3a42);
  p.rect(x + 2, y + 3, 2, 3, 0xf6d070);
  p.set(x + 2, y + 3, 0xfff0b0);
  return [x + 3, y + 4];
}

/** Ground shadow cast to the right of the building, as if lit from the left. */
const SHADOW = 6;

function paint(spec: BuildingSpec, snowy = false): Art {
  if (spec.style === 'mine') return paintMine(spec);
  if (spec.style === 'keep') return paintKeep(spec, snowy);
  const rng = new Rng(spec.seed);
  const look = lookOf(spec.style, rng);
  const fw = spec.w * TILE_SIZE;
  const W = fw + OVERHANG * 2 + SHADOW;
  const H = spec.h * TILE_SIZE + RISE;
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d')!;
  const img = ctx.createImageData(W, H);
  const p = new Painter(img).cell(0, 0, W, H);
  const RW = W - SHADOW;

  // Deeper buildings get taller walls, so the roof never swallows the house.
  const wallHeight = Math.min(52, Math.max(look.wallHeight, Math.round(spec.h * TILE_SIZE * 0.46)));
  const wallTop = H - wallHeight;
  const roofBottom = wallTop + 3;
  const left = OVERHANG;
  const right = OVERHANG + fw;
  const windows: Array<[number, number]> = [];

  walls(p, rng, look, left, wallTop, fw, wallHeight - 3);
  // Shade under the eaves.
  // (An A-frame's gable wall runs on down into the wall, so it has none.)
  if (look.roofKind !== 'aframe') for (let k = 0; k < 7; k++) p.rect(left, roofBottom + k, fw, 1, 0x000000, 120 - k * 17);
  // Foundation: a plinth of fitted stones.
  for (let x = left - 1; x < right + 1; ) {
    const sw = rng.int(4, 7);
    p.rect(x, H - 4, Math.min(sw, right + 1 - x), 4, shade(0x8d877c, rng.range(0.88, 1.08)));
    p.rect(x, H - 4, Math.min(sw, right + 1 - x), 1, 0xaaa499);
    if (x + sw < right + 1) p.rect(x + sw - 1, H - 4, 1, 4, 0x5e5953);
    x += sw;
  }

  // Door.
  const doorW = 12;
  const doorH = Math.min(wallHeight - 8, 21);
  const doorX = left + spec.door * TILE_SIZE + 2;
  door(p, look, doorX, H - 2, doorW, doorH);
  const porchFramed = look.porch && look.roofKind === 'aframe';
  if (look.porch && !porchFramed) porch(p, look, doorX, H - 2 - doorH - 9, doorW);

  // Windows on both sides of the door, never crowding it.
  const winY = wallTop + Math.max(7, Math.round((wallHeight - 16) / 2));
  const arched = look.material === 'stone';
  // Every other column out from the door, on both sides.
  const cols: number[] = [];
  for (let col = spec.door - 2; col >= 1; col -= 2) cols.push(col);
  for (let col = spec.door + 2; col <= spec.w - 2; col += 2) cols.push(col);
  for (const col of cols) {
    const wx = left + col * TILE_SIZE + 3;
    window_(p, look, rng, wx, winY, arched);
    windows.push([wx + 5, winY + 5]);
  }
  if (look.lamp) {
    const side = spec.door < spec.w / 2 ? doorX + doorW + 3 : doorX - 8;
    windows.push(wallLamp(p, side, H - 2 - doorH + 2));
  }

  // Roof.
  if (look.roofKind === 'aframe') {
    aFrame(p, rng, look, 0, RW, 1, roofBottom, windows, snowy, true, spec);
  } else {
    roof(p, rng, spec, look, RW, RISE - 2, roofBottom, windows, snowy);
    chimney(p, rng, spec, look, RW, RISE - 2, roofBottom, snowy);
  }
  // The porch goes on last, in front of the wall and over the door.
  if (porchFramed) porchFrame(p, rng, look, doorX, H - 2 - doorH - 2, doorW, H - 2, windows, snowy);
  p.outline(0x2a1d14);
  // The cast shadow goes on last, outside the outline.
  for (let y = wallTop + 2; y < H; y++) {
    const reach = Math.min(SHADOW, Math.floor((y - wallTop) / 3));
    for (let x = right; x < right + reach; x++) if (p.alpha(x, y) === 0) p.set(x, y, 0x000000, 70);
  }
  ctx.putImageData(img, 0, 0);
  return { texture: Texture.from(canvas), width: W, height: H, windows };
}

/** Roof tiles: staggered courses of chunky tiles, each lit along its top lip,
 *  seamed at its sides, rounded at its lower corners and shadowed where the
 *  next course overlaps it. Returns a brightness factor for pixel (x, y),
 *  measured from the roof's top-left. */
const TILE_W = 7;
const COURSE = 6;

function makeShingles(rng: Rng): (x: number, y: number) => number {
  const jitter = new Map<number, number>();
  return (x, y) => {
    const row = Math.floor(y / COURSE);
    const r = y % COURSE;
    const off = row % 2 ? 3 : 0;
    const col = Math.floor((x + off) / TILE_W);
    const c = (x + off) % TILE_W;
    const k = row * 4096 + col;
    let f = jitter.get(k);
    if (f === undefined) jitter.set(k, (f = rng.range(0.9, 1.07)));
    if (r === 0) f *= 1.24;
    else if (r === 1) f *= 1.09;
    else if (r === COURSE - 1) f *= 0.5;
    else if (r === COURSE - 2) f *= c === 0 || c === TILE_W - 1 ? 0.56 : 0.8;
    if (r < COURSE - 2) {
      if (c === 0) f *= 0.7;
      else if (c === 1) f *= 1.1;
    }
    return f;
  };
}

/** The roof's thickness along an eave: tile ends over a dark underside. */
function eaveEdge(p: Painter, base: RGB, x: number, y: number, w: number): void {
  p.rect(x, y, w, 1, shade(base, 0.95));
  p.rect(x, y + 1, w, 2, shade(base, 0.6));
  for (let k = x + 1; k < x + w; k += TILE_W) p.rect(k, y + 1, 1, 2, shade(base, 0.45));
  p.rect(x, y + 3, w, 1, shade(base, 0.38));
}

/** A roof seen from the front and above. Hipped roofs slope at both ends;
 *  gabled ones run straight across between bargeboards. Rows of overlapping
 *  shingles darken toward the eaves, over a wooden fascia. Big roofs get a
 *  dormer; houses and cabins a chimney; some a weathervane or moss; and in the
 *  snow, a white cover with icicles. */
function roof(p: Painter, rng: Rng, spec: BuildingSpec, look: Look, W: number, top: number, bottom: number, windows: Array<[number, number]>, snowy: boolean, dormer = true): void {
  const h = bottom - top;
  const hip = look.roofKind === 'hip' ? Math.min(14, Math.round(W * 0.16)) : 0;
  const base = look.roof;
  const shingle = makeShingles(rng);
  for (let y = top; y < bottom; y++) {
    const t = (y - top) / h;
    const inset = Math.round(hip * (1 - t));
    for (let x = 0; x < W; x++) {
      // The front slope faces the sun; the hips turn toward and away from it.
      const plane = x < inset ? 1.2 : x >= W - inset ? 0.6 : 1;
      p.set(x, y, shade(base, shingle(x, y - top) * plane * (1.12 - t * 0.28)));
    }
    if (inset > 0) {
      // Hip seams: a lit edge on one side, a shadow on the other.
      p.set(inset, y, shade(base, 1.35));
      p.set(inset + 1, y, shade(base, 0.62));
      p.set(W - 1 - inset, y, shade(base, 0.45));
    }
  }
  if (look.roofKind === 'gable') {
    // Bargeboards down both ends.
    for (const x of [0, W - 3]) {
      p.rect(x, top, 3, h - 2, shade(look.trim, 1.05));
      p.rect(x + (x ? 2 : 0), top, 1, h - 2, shade(look.trim, 0.7));
    }
  }
  // A rounded ridge cap: lit on top, shadowed underneath, in short tiles.
  const rw = W - hip * 2;
  [1.45, 1.2, 0.9, 0.55].forEach((f, k) => p.rect(hip, top + k, rw, 1, shade(base, f)));
  for (let x = hip + 3; x < hip + rw; x += 6) p.rect(x, top, 1, 3, shade(base, 0.7));
  p.rect(hip, top + 4, rw, 1, 0x000000, 60);
  // Moss creeping over old shingles.
  if (look.moss) {
    for (let k = 0; k < W / 10; k++) {
      const mx = rng.int(hip + 2, W - hip - 3);
      const my = rng.int(top + 6, bottom - 6);
      p.ellipse(mx, my, rng.range(1.5, 3.5), rng.range(1, 2), rng.chance(0.5) ? 0x5a7a3a : 0x6a8a44, 200);
    }
  }
  // The roof's thickness along the eave.
  eaveEdge(p, base, 0, bottom - 4, W);

  if (dormer && h >= 44 && spec.w >= 6 && spec.style !== 'stone' && rng.chance(0.65)) {
    const dw = 16;
    const dx = Math.round(W / 2 + (rng.chance(0.5) ? -1 : 1) * W * 0.18 - dw / 2);
    const dy = top + Math.round(h * 0.35);
    p.rect(dx, dy + 6, dw, 12, look.material === 'brick' || look.material === 'logs' ? 0xe8dcc0 : look.wall);
    p.rect(dx + 4, dy + 8, 8, 8, 0xf0e8d8);
    p.rect(dx + 5, dy + 9, 6, 6, 0x86bde3);
    p.rect(dx + 5, dy + 9, 2, 2, 0xd6eefa);
    p.rect(dx + 7, dy + 9, 1, 6, 0xf0e8d8);
    for (let k = 0; k <= dw / 2 + 1; k++) p.rect(dx - 1 + k, dy + 7 - Math.round(k * 0.8), dw + 2 - k * 2, 1, shade(base, 1.05 - k * 0.02));
    p.rect(dx - 1, dy + 7, dw + 2, 1, shade(base, 0.6));
    p.rect(dx, dy + 18, dw, 1, 0x000000, 70);
    if (snowy) {
      for (let k = 0; k <= dw / 2; k++) {
        p.set(dx + k, dy + 6 - Math.round(k * 0.8), 0xf4f8fc);
        p.set(dx + dw - k, dy + 6 - Math.round(k * 0.8), 0xf4f8fc);
      }
    }
    windows.push([dx + 8, dy + 12]);
  }

  if (snowy) {
    // Snow lies thick near the ridge and thins toward the eaves, with icicles.
    let depth = h * 0.5;
    for (let x = 0; x < W; x++) {
      depth = Math.max(h * 0.3, Math.min(h * 0.65, depth + rng.range(-1.5, 1.5)));
      for (let y = top; y < top + depth; y++) {
        const t = (y - top) / depth;
        p.set(x, y, t > 0.85 ? 0xd8e8f4 : rng.chance(0.03) ? 0xffffff : 0xf0f6fb);
      }
    }
    for (let x = rng.int(3, 8); x < W - 3; x += rng.int(7, 13)) p.rect(x, bottom, 1, rng.int(1, 3), 0xd8f0ff);
    p.rect(0, bottom - 3, W, 1, 0xf4f8fc);
  }

  if (look.vane) {
    const vx = Math.round(W / 2) + rng.int(-6, 6);
    p.rect(vx, top - 9, 1, 9, 0x3a3a42);
    p.rect(vx - 3, top - 8, 7, 1, 0x3a3a42);
    p.rect(vx - 1, top - 10, 3, 2, 0x3a3a42);
    p.set(vx + 3, top - 9, 0x3a3a42);
  }
}

/** A peaked A-frame roof between x0 and x1, its gable facing the viewer.
 *  Below the gable edge is the gable wall (a triangle, with a round attic
 *  window) or, for a porch, open shade; above it, the roof surface slopes
 *  back to a ridge, so the outline is peaked. Shingle courses run parallel
 *  to the slopes; the left slope is lit and the right one in shade. */
function aFrame(p: Painter, rng: Rng, look: Look, x0: number, x1: number, top: number, base: number, windows: Array<[number, number]>, snowy: boolean, wall: boolean, spec?: BuildingSpec): void {
  const w = x1 - x0;
  const cx = x0 + w / 2;
  const half = w / 2;
  const avail = base - top;
  const gh = Math.max(6, Math.round(avail * look.pitch));
  const depth = avail - gh;
  const edge = (x: number) => Math.round(base - gh * (1 - Math.abs(x + 0.5 - cx) / half));
  if (wall) {
    // The gable wall, cut to the triangle under the edge.
    walls(p, rng, look.material === 'cottage' ? { ...look, material: 'plaster' } : look, x0 + 3, base - gh, w - 6, gh + 1);
    for (let x = x0; x < x1; x++) for (let y = base - gh; y < edge(x); y++) p.clear(x, y);
  } else {
    // Open: deep shade under the porch roof.
    for (let x = x0 + 4; x < x1 - 4; x++) for (let y = edge(x); y < base + 3; y++) p.set(x, y, 0x000000, 90);
  }
  if (spec && (spec.style === 'house' || spec.style === 'cabin')) chimneyOn(p, rng, look, x0, x1, edge, depth, snowy);
  const shingle = makeShingles(rng);
  for (let x = x0; x < x1; x++) {
    const e = edge(x);
    const u = Math.round(Math.abs(x + 0.5 - cx));
    const lit = x + 0.5 < cx;
    // Bright on the sunny slope, dark on the other, darker toward the eaves.
    const across = Math.abs(x + 0.5 - cx) / half;
    const plane = lit ? 1.18 - across * 0.14 : 0.72 - across * 0.1;
    for (let y = e - depth; y < e - 5; y++) {
      const d = e - y;
      // Courses run along the slope: measured back from the rim.
      const f = shingle(u + (lit ? 0 : 3), depth - d) * plane * (0.9 + (d / depth) * 0.18);
      const snow = snowy && d > depth * 0.58;
      p.set(x, y, snow ? (rng.chance(0.03) ? 0xffffff : d > depth * 0.64 ? 0xf0f6fb : 0xd8e8f4) : shade(look.roof, f));
    }
    // The roof's thickness at the rim, the bargeboard, and its shadow below.
    p.set(x, e - 5, shade(look.roof, lit ? 1.05 : 0.72));
    p.set(x, e - 4, shade(look.roof, 0.48));
    p.rect(x, e - 3, 1, 3, shade(look.trim, lit ? 1.12 : 0.88));
    p.set(x, e - 3, shade(look.trim, 1.3));
    if (wall) {
      p.set(x, e, 0x000000, 120);
      p.set(x, e + 1, 0x000000, 70);
      p.set(x, e + 2, 0x000000, 30);
    }
  }
  // A rounded ridge running back from the apex.
  const apex = edge(Math.floor(cx));
  const rx = Math.round(cx) - 2;
  const colors = snowy ? [0xffffff, 0xf4f8fc, 0xe0ecf6, 0xc8d8e8] : [1.45, 1.2, 0.88, 0.55].map((f) => shade(look.roof, f));
  colors.forEach((c, k) => p.rect(rx + k, apex - depth, 1, depth - 4, c));
  for (let y = apex - depth + 3; y < apex - 4; y += 6) p.rect(rx, y, 4, 1, snowy ? 0xd8e8f4 : shade(look.roof, 0.6));
  // A round attic window in a big enough gable.
  if (wall && gh >= 16) {
    const wy = base - Math.round(gh * 0.42);
    const wx = Math.round(cx) - 0.5;
    p.ellipse(wx, wy, 4, 4, look.material === 'siding' || look.material === 'plaster' ? 0xf0e8d8 : shade(look.trim, 0.85));
    p.ellipse(wx, wy, 2.6, 2.6, 0x86bde3);
    p.rect(Math.round(wx) - 1, wy - 2, 1, 2, 0xe6f6fc);
    p.rect(Math.round(wx), wy - 3, 1, 6, 0xf0e8d8);
    windows.push([Math.round(wx), wy]);
  }
  if (look.moss && wall) {
    for (let k = 0; k < w / 14; k++) {
      const mx = rng.int(x0 + 6, x1 - 7);
      const my = edge(mx) - rng.int(7, Math.max(8, depth - 3));
      p.ellipse(mx, my, rng.range(1.5, 3), rng.range(1, 1.8), rng.chance(0.5) ? 0x5a7a3a : 0x6a8a44, 200);
    }
  }
}

/** A chimney rising from one slope of an A-frame, behind the roof surface. */
function chimneyOn(p: Painter, rng: Rng, look: Look, x0: number, x1: number, edge: (x: number) => number, depth: number, snowy: boolean): void {
  const w = x1 - x0;
  const cx = rng.chance(0.5) ? Math.round(x0 + w * 0.24) : Math.round(x1 - w * 0.24 - 10);
  const foot = edge(cx + 5) - Math.round(depth * 0.4);
  const cy = Math.max(1, foot - Math.round(depth * 0.6) - 12);
  brickStack(p, look, cx, cy, foot - cy, snowy);
}

/** A capped chimney stack: front face, darker side face and a lit top. */
function brickStack(p: Painter, look: Look, cx: number, cy: number, ch: number, snowy: boolean): void {
  const brick = look.material === 'logs' ? 0x8a8478 : 0x9a5a3a;
  p.rect(cx, cy, 7, ch, brick);
  p.rect(cx, cy, 1, ch, shade(brick, 1.2));
  p.rect(cx + 7, cy + 1, 3, ch - 1, shade(brick, 0.68));
  for (let y = cy + 4; y < cy + ch; y += 4) {
    p.rect(cx, y, 7, 1, shade(brick, 0.78));
    p.rect(cx + 7, y, 3, 1, shade(brick, 0.55));
  }
  p.rect(cx - 1, cy - 2, 12, 2, snowy ? 0xf4f8fc : 0x7a6a62);
  p.rect(cx - 1, cy, 12, 1, snowy ? 0xd8e8f4 : 0x4a3a32);
  p.rect(cx + 1, cy - 3, 6, 1, 0x2a1d14);
}

/** A brick (or fieldstone) chimney with a cap, standing on a side roof. */
function chimney(p: Painter, rng: Rng, spec: BuildingSpec, look: Look, W: number, top: number, bottom: number, snowy: boolean): void {
  if (spec.style !== 'house' && spec.style !== 'cabin') return;
  const cx = rng.chance(0.5) ? 10 : W - 20;
  brickStack(p, look, cx, 3, top + Math.round((bottom - top) * 0.3) - 3, snowy);
}

/** How far the keep rises above its footprint, for its turrets. */
const KEEP_RISE = 50;

/** A castle keep: a two-storey stone hall behind a battlement walkway, round
 *  corner turrets with slate cones and pennants, a great arched double door
 *  under a raised portcullis, hanging banners, arched windows on both floors,
 *  and ivy on old stone. */
function paintKeep(spec: BuildingSpec, snowy: boolean): Art {
  const rng = new Rng(spec.seed);
  const look = lookOf('keep', rng);
  const fw = spec.w * TILE_SIZE;
  const OUT = 6;
  const W = fw + OUT * 2 + SHADOW;
  const H = spec.h * TILE_SIZE + KEEP_RISE;
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d')!;
  const img = ctx.createImageData(W, H);
  const p = new Painter(img).cell(0, 0, W, H);
  const left = OUT;
  const right = OUT + fw;
  const stone = look.wall;
  const slate = look.roof;
  const windows: Array<[number, number]> = [];
  const wallH = Math.round(spec.h * TILE_SIZE * 0.78);
  const wallTop = H - wallH;
  const mid = wallTop + Math.round(wallH * 0.48);

  // The roof walk behind the battlements: flagstones, with the back parapet.
  const walkTop = wallTop - 22;
  for (let y = walkTop; y < wallTop; y++) {
    for (let x = left; x < right; x++) {
      const f = ((x + (Math.floor((y - walkTop) / 5) % 2) * 4) % 9 === 0 || (y - walkTop) % 5 === 4 ? 0.78 : 1) * (0.86 + ((y - walkTop) / 22) * 0.18);
      p.set(x, y, snowy && (y - walkTop) % 5 < 3 ? 0xeef4fa : shade(0x8d877c, f));
    }
  }
  for (let x = left; x < right; x += 8) {
    p.rect(x, walkTop - 5, 5, 5, shade(stone, 0.8));
    p.rect(x, walkTop - 5, 5, 1, snowy ? 0xf4f8fc : shade(stone, 0.95));
  }
  p.rect(left, walkTop, fw, 2, shade(stone, 0.7));

  // The hall's front wall.
  walls(p, rng, look, left, wallTop, fw, wallH - 4);
  // A plinth that splays out at the foot.
  for (let k = 0; k < 4; k++) p.rect(left - k, H - 4 + k, fw + k * 2, 1, shade(0x8d877c, 1 - k * 0.06));
  // String course between the floors.
  p.rect(left, mid, fw, 2, shade(stone, 1.25));
  p.rect(left, mid + 2, fw, 1, shade(stone, 0.55));
  // Battlements along the top of the wall, with their shadow.
  p.rect(left - 2, wallTop - 2, fw + 4, 4, shade(stone, 1.05));
  for (let x = left - 2; x < right + 2; x += 8) {
    p.rect(x, wallTop - 9, 6, 7, stone);
    p.rect(x, wallTop - 9, 6, 1, snowy ? 0xf4f8fc : shade(stone, 1.25));
    p.rect(x + 5, wallTop - 8, 1, 6, shade(stone, 0.7));
  }
  for (let k = 0; k < 5; k++) p.rect(left, wallTop + 2 + k, fw, 1, 0x000000, 90 - k * 18);

  // The great door: an arch of voussoirs, a raised portcullis, and studded doors.
  const dw = 26;
  const dh = Math.min(40, wallH - (wallH - (H - mid)) - 4);
  const dx = left + Math.round(fw / 2 - dw / 2);
  const dy = H - 4 - dh;
  p.ellipse(dx + dw / 2 - 0.5, dy + 6, dw / 2 + 4, 10, shade(stone, 1.15));
  for (let k = -5; k <= 5; k++) {
    const a = Math.PI / 2 + (k / 5) * 1.2;
    p.rect(Math.round(dx + dw / 2 - 0.5 - Math.cos(a) * (dw / 2 + 2)), Math.round(dy + 6 - Math.sin(a) * 8), 1, 2, shade(stone, 0.6));
  }
  p.rect(dx - 4, dy + 6, dw + 8, dh - 6, shade(stone, 1.15));
  p.rect(dx, dy + 6, dw, dh - 6, 0x6b4423);
  p.ellipse(dx + dw / 2 - 0.5, dy + 6, dw / 2, 7, 0x6b4423);
  for (let x = dx + 3; x < dx + dw; x += 3) p.rect(x, dy, 1, dh, 0x553418);
  p.rect(dx + dw / 2 - 1, dy, 2, dh, 0x3a2414);
  for (let y = dy + 10; y < dy + dh - 2; y += 6) for (let x = dx + 2; x < dx + dw - 1; x += 4) p.set(x, y, 0x3a3a42);
  for (const kx of [dx + dw / 2 - 4, dx + dw / 2 + 3]) p.rect(kx, dy + dh / 2 + 2, 1, 3, 0xe8c050);
  // Portcullis teeth showing under the arch.
  p.rect(dx, dy, dw, 6, 0x1a1410);
  for (let x = dx + 1; x < dx + dw; x += 4) p.rect(x, dy, 2, 8, 0x4a4a52);
  p.rect(dx, dy + 3, dw, 1, 0x4a4a52);
  p.rect(dx - 6, H - 4, dw + 12, 2, 0xb8b2a6);

  // Banners hanging from the string course on both sides of the door.
  for (const bx of [dx - 16, dx + dw + 8]) {
    p.rect(bx - 1, mid + 3, 10, 2, 0x5c3a1c);
    for (let y = mid + 5; y < mid + 34; y++) {
      const narrow = y > mid + 28 ? (y - (mid + 28)) : 0;
      p.rect(bx + narrow, y, 8 - narrow * 2, 1, y % 2 ? 0xb8323a : 0xa82a32);
    }
    p.rect(bx, mid + 5, 2, 24, 0xd04a52);
    p.ellipse(bx + 4, mid + 15, 2.5, 2.5, 0xe8c050);
    p.set(bx + 4, mid + 15, 0xb8323a);
  }

  // Windows: tall and arched below, smaller above; lit at night.
  const winCols: number[] = [];
  for (let x = left + 14; x < right - 14; x += 22) if (x + 12 < dx - 20 || x > dx + dw + 18) winCols.push(x);
  for (const wx of winCols) {
    for (const [wy, ww, wh] of [[mid + 10, 10, 18], [wallTop + 10, 8, 12]] as const) {
      if (wy === mid + 10 && wy + wh > H - 8) continue;
      p.rect(wx - 2, wy - 2, ww + 4, wh + 3, shade(stone, 1.2));
      p.ellipse(wx + ww / 2 - 0.5, wy, ww / 2 + 2, 4, shade(stone, 1.2));
      p.rect(wx, wy, ww, wh, 0x2a3a5a);
      p.ellipse(wx + ww / 2 - 0.5, wy, ww / 2, 3, 0x2a3a5a);
      p.rect(wx + ww / 2 - 1, wy - 2, 1, wh + 2, shade(stone, 0.8));
      p.rect(wx, wy + Math.round(wh / 2), ww, 1, shade(stone, 0.8));
      p.rect(wx + 1, wy, 2, 2, 0x86bde3);
      p.rect(wx - 3, wy + wh + 1, ww + 6, 1, shade(stone, 1.3));
      windows.push([wx + ww / 2, wy + wh / 2]);
    }
  }

  // Ivy climbing the old stone.
  for (let k = 0; k < fw / 30; k++) {
    let x = rng.int(left + 4, right - 6);
    if (x > dx - 18 && x < dx + dw + 18) continue;
    for (let y = H - 5; y > H - 5 - rng.int(14, 40); y -= 1) {
      x += rng.int(-1, 1);
      p.set(x, y, rng.chance(0.5) ? 0x4a7a3a : 0x5a8a44);
      if (rng.chance(0.4)) p.set(x + 1, y, 0x3a6a2a);
    }
  }

  // Round turrets at both ends, taller than the hall, with cones and pennants.
  const tw = 30;
  for (const tx of [left - OUT, right + OUT - tw]) {
    const tTop = walkTop - 6;
    for (let x = 0; x < tw; x++) {
      // Cylinder shading: lit on the left, round into shadow on the right.
      const a = (x + 0.5) / tw;
      const f = 0.68 + Math.sin(a * Math.PI) * 0.32 + (0.5 - a) * 0.3;
      for (let y = tTop; y < H - 2; y++) {
        const row = Math.floor((y - tTop) / 5);
        const mortar = (y - tTop) % 5 === 4 || (x + (row % 2) * 4) % 8 === 0;
        p.set(tx + x, y, shade(stone, f * (mortar ? 0.78 : rng.range(0.96, 1.04))));
      }
    }
    // Arrow slits.
    for (const sy of [tTop + 16, mid + 6]) {
      p.rect(tx + tw / 2 - 1, sy, 2, 8, 0x1a1410);
      p.rect(tx + tw / 2 - 3, sy + 3, 6, 1, 0x1a1410);
    }
    // A ring of corbels, then the cone.
    p.rect(tx - 2, tTop - 3, tw + 4, 4, shade(stone, 1.1));
    for (let x = tx - 2; x < tx + tw + 2; x += 4) p.rect(x, tTop + 1, 2, 2, shade(stone, 0.7));
    const coneH = 38;
    const cBase = tTop - 3;
    const cx = tx + tw / 2;
    for (let y = cBase - coneH; y < cBase; y++) {
      const t = (y - (cBase - coneH)) / coneH;
      const halfW = (tw / 2 + 3) * t;
      for (let x = Math.floor(cx - halfW); x < Math.ceil(cx + halfW); x++) {
        const a = halfW ? (x - (cx - halfW)) / (halfW * 2) : 0.5;
        const course = Math.floor((cBase - y) / 4);
        let f = (0.62 + Math.sin(a * Math.PI) * 0.4 + (0.5 - a) * 0.35) * (y % 4 === 0 ? 0.75 : 1);
        if ((Math.round((x - cx) / Math.max(1, t)) + course * 3) % 7 === 0) f *= 0.85;
        const snow = snowy && t < 0.6;
        p.set(x, y, snow ? (a < 0.6 ? 0xf4f8fc : 0xd8e8f4) : shade(slate, f));
      }
    }
    p.rect(cx - (tw / 2 + 3), cBase - 1, tw + 6, 2, shade(slate, 0.5));
    // A pennant on a pole.
    p.rect(cx, cBase - coneH - 10, 1, 11, 0x3a3a42);
    for (let k = 0; k < 6; k++) p.rect(cx + 1, cBase - coneH - 10 + Math.floor(k / 2), 7 - k, 1, 0xb8323a);
    p.set(cx, cBase - coneH - 11, 0xe8c050);
  }
  p.outline(0x2a1d14);
  for (let y = wallTop; y < H; y++) {
    const reach = Math.min(SHADOW, Math.floor((y - wallTop) / 3));
    for (let x = right + OUT; x < right + OUT + reach; x++) if (p.alpha(x, y) === 0) p.set(x, y, 0x000000, 70);
  }
  ctx.putImageData(img, 0, 0);
  return { texture: Texture.from(canvas), width: W, height: H, windows, offset: OUT };
}

/** A mine entrance: a rock face with a timber-framed tunnel mouth, rails
 *  running into the dark, a hanging lantern and a sign. */
function paintMine(spec: BuildingSpec): Art {
  const rng = new Rng(spec.seed);
  const fw = spec.w * TILE_SIZE;
  const W = fw + OVERHANG * 2;
  const H = spec.h * TILE_SIZE + RISE;
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d')!;
  const img = ctx.createImageData(W, H);
  const p = new Painter(img).cell(0, 0, W, H);
  const rock = 0x7d756b;

  // The rock face, with a ragged top and boulders, darker toward the ground.
  let top = rng.int(6, 10);
  for (let x = 0; x < W; x++) {
    top = Math.max(3, Math.min(14, top + rng.int(-1, 1)));
    const edge = Math.min(x, W - 1 - x);
    const t = edge < 6 ? top + (6 - edge) * 2 : top;
    for (let y = t; y < H; y++) p.set(x, y, shade(rock, 1.1 - (y / H) * 0.3));
    p.set(x, t, shade(rock, 1.3));
  }
  for (let k = 0; k < 22; k++) {
    const x = rng.int(4, W - 5);
    const y = rng.int(14, H - 4);
    const r = rng.range(2.5, 5);
    if (p.alpha(x, y - r) === 0) continue;
    p.ellipse(x, y, r + 0.8, r * 0.7 + 0.8, shade(rock, 0.72));
    p.ellipse(x, y, r, r * 0.7, shade(rock, rng.range(0.92, 1.12)));
    p.ellipse(x - r * 0.3, y - r * 0.25, r * 0.4, r * 0.25, shade(rock, 1.25));
  }
  // Moss and grass tufts on top.
  for (let k = 0; k < 14; k++) {
    const x = rng.int(2, W - 3);
    let y = 0;
    while (y < H && p.alpha(x, y) === 0) y++;
    p.rect(x, y, rng.int(2, 4), 1, 0x5a9a44);
    p.set(x + 1, y - 1, 0x7cc860);
  }

  // The tunnel mouth.
  const cx = OVERHANG + spec.door * TILE_SIZE + 8;
  const half = 14;
  const mouthTop = H - 36;
  p.rect(cx - half, mouthTop, half * 2, H - mouthTop, 0x2a211b);
  p.rect(cx - half + 3, mouthTop + 3, half * 2 - 6, H - mouthTop - 3, 0x17110d);
  p.rect(cx - half + 7, mouthTop + 8, half * 2 - 14, H - mouthTop - 8, 0x0b0806);
  // Rails running into the dark.
  for (let y = mouthTop + 10; y < H; y++) {
    const spread = 2 + ((y - mouthTop - 10) / (H - mouthTop - 10)) * 4;
    if ((H - y) % 4 === 0) p.rect(Math.round(cx - spread - 2), y, Math.round(spread * 2 + 4), 1, 0x4a2e16);
    p.set(Math.round(cx - spread), y, 0x8a8a96);
    p.set(Math.round(cx + spread), y, 0x8a8a96);
  }
  // Timber frame: posts, a lintel and corner braces.
  const wood = 0x8a5a2b;
  for (const x of [cx - half - 2, cx + half - 2]) {
    p.rect(x, mouthTop - 2, 4, H - mouthTop + 2, wood);
    p.rect(x, mouthTop - 2, 1, H - mouthTop + 2, 0xa87442);
    p.rect(x + 3, mouthTop - 2, 1, H - mouthTop + 2, 0x5c3a1c);
  }
  p.rect(cx - half - 5, mouthTop - 7, half * 2 + 10, 6, 0x9a6634);
  p.rect(cx - half - 5, mouthTop - 7, half * 2 + 10, 1, 0xb88850);
  p.rect(cx - half - 5, mouthTop - 2, half * 2 + 10, 1, 0x5c3a1c);
  for (const x of [cx - half - 3, cx + half - 2]) p.set(x + 1, mouthTop - 5, 0x3a2414);
  for (let k = 0; k < 5; k++) {
    p.rect(cx - half + 2 + k, mouthTop - 1 + k, 1, 1, wood);
    p.rect(cx + half - 3 - k, mouthTop - 1 + k, 1, 1, wood);
  }
  // A sign over the entrance: a pick and a hammer.
  p.rect(cx - 8, mouthTop - 16, 16, 8, 0xb88850);
  p.rect(cx - 8, mouthTop - 16, 16, 1, 0xd8a868);
  p.rect(cx - 8, mouthTop - 9, 16, 1, 0x6b4423);
  for (let k = 0; k < 6; k++) {
    p.set(cx - 3 + k, mouthTop - 15 + k, 0x3a2414);
    p.set(cx + 2 - k, mouthTop - 15 + k, 0x3a2414);
  }
  p.rect(cx - 5, mouthTop - 8, 1, 2, 0x5c3a1c);
  p.rect(cx + 4, mouthTop - 8, 1, 2, 0x5c3a1c);
  // A lantern hanging from the lintel.
  const lx = cx + half - 6;
  const ly = mouthTop + 2;
  p.rect(lx, mouthTop - 1, 1, 3, 0x3a3a42);
  p.rect(lx - 2, ly, 5, 6, 0x3a3a42);
  p.rect(lx - 1, ly + 1, 3, 4, 0xf6d070);
  p.set(lx - 1, ly + 1, 0xfff0b0);
  // Rubble at the foot.
  for (let k = 0; k < 6; k++) {
    const x = rng.chance(0.5) ? rng.int(2, cx - half - 4) : rng.int(cx + half + 3, W - 3);
    p.ellipse(x, H - 2, rng.range(1.5, 2.5), 1.5, shade(rock, rng.range(0.8, 1.05)));
  }
  p.outline(0x2a1d14);
  ctx.putImageData(img, 0, 0);
  return { texture: Texture.from(canvas), width: W, height: H, windows: [[lx, ly + 3]] };
}

/** Painted buildings kept for reuse; older ones not on screen are freed. */
const ART_CACHE = 48;
/** New buildings painted per frame, so entering a village never stutters. */
const PAINT_BUDGET = 2;
/** Frames between full rescans of which buildings to show. */
const RESCAN_FRAMES = 30;

/** Buildings of live objects that touch the render area, as y-sorted sprites. */
export class BuildingRenderer {
  private readonly art = new Map<string, Art>();
  private readonly shown = new Map<string, { sprite: Sprite; art: Art }>();
  private readonly live = new Set<string>();
  private scannedRect = '';
  private rescanIn = 0;

  constructor(
    private readonly entities: Container,
    /** Whether a building at this tile stands in the snow. */
    private readonly snowAt: (gx: number, gy: number) => boolean = () => false,
  ) {}

  update(objects: Iterable<WorldObject>, render: ChunkRect | null, px: number, py: number): void {
    // Which buildings are shown only changes with the render area (or the odd
    // object coming and going): rescan then, and every half second; otherwise
    // only fade the ones the player walks behind.
    const rect = render ? `${render.x0},${render.y0},${render.x1},${render.y1}` : '';
    if (rect === this.scannedRect && --this.rescanIn > 0) {
      for (const { sprite, art } of this.shown.values()) {
        const behind = px > sprite.x && px < sprite.x + art.width && py < sprite.y && py > sprite.y - art.height;
        sprite.alpha = behind ? 0.5 : 1;
      }
      return;
    }
    this.scannedRect = rect;
    this.rescanIn = RESCAN_FRAMES;
    const live = this.live;
    live.clear();
    let budget = PAINT_BUDGET;
    if (render) {
      const x0 = render.x0 * CHUNK_SIZE;
      const y0 = render.y0 * CHUNK_SIZE;
      const x1 = (render.x1 + 1) * CHUNK_SIZE;
      const y1 = (render.y1 + 1) * CHUNK_SIZE;
      for (const o of objects) {
        o.layout.buildings.forEach((b, i) => {
          const bx = o.x + b.x;
          const by = o.y + b.y;
          if (bx + b.w < x0 || by + b.h < y0 || bx > x1 || by > y1) return;
          const key = `${o.id}:${i}`;
          let s = this.shown.get(key);
          if (!s) {
            const artKey = `${b.seed}:${this.snowAt(bx, by) ? 1 : 0}`;
            let art = this.art.get(artKey);
            if (!art) {
              if (budget-- <= 0) {
                // Painting is spread over frames: look again next frame.
                this.rescanIn = 1;
                return;
              }
              art = paint(b, artKey.endsWith(':1'));
            }
            // Most recently used last.
            this.art.delete(artKey);
            this.art.set(artKey, art);
            const sprite = new Sprite({ texture: art.texture, anchor: { x: 0, y: 1 } });
            sprite.position.set(bx * TILE_SIZE - (art.offset ?? OVERHANG), (by + b.h) * TILE_SIZE);
            sprite.zIndex = (by + b.h) * TILE_SIZE;
            this.entities.addChild(sprite);
            this.shown.set(key, (s = { sprite, art }));
          }
          live.add(key);
          // See-through while the player walks behind it.
          const { sprite, art } = s;
          const behind = px > sprite.x && px < sprite.x + art.width && py < sprite.y && py > sprite.y - art.height;
          sprite.alpha = behind ? 0.5 : 1;
        });
      }
    }
    for (const [key, s] of this.shown) {
      if (live.has(key)) continue;
      s.sprite.destroy();
      this.shown.delete(key);
    }
    this.evict();
  }

  /** Frees the least recently used paintings that are not on screen. */
  private evict(): void {
    if (this.art.size <= ART_CACHE) return;
    const inUse = new Set<Art>();
    for (const s of this.shown.values()) inUse.add(s.art);
    for (const [key, art] of this.art) {
      if (this.art.size <= ART_CACHE) break;
      if (inUse.has(art)) continue;
      art.texture.destroy(true);
      this.art.delete(key);
    }
  }

  /** Lit windows and lamps, for the night. */
  lights(out: Light[]): void {
    for (const { sprite, art } of this.shown.values()) {
      for (const [wx, wy] of art.windows) {
        out.push({ x: sprite.x + wx, y: sprite.y - art.height + wy, radius: 1.8 * TILE_SIZE, warmth: 0.5 });
      }
    }
  }
}

/** Paints one building's sprite art; exported for previews and tests. */
export { paint as paintBuilding };
