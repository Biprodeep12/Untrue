// Procedural pixel-art texture atlas. Every tile, decoration and player frame is
// painted at startup in a warm, Stardew-like style; no image files ship.
//
// Layout (16 px cells, 256 px wide):
//   tiles:   cell = tileId * 4 + variant, 16 x 16
//   decos:   shelf-packed frames from DECO_Y; trees and plants are larger
//   humans:  16 x 32 cells from PLAYER_Y: one row per outfit (the player is
//            outfit 0), direction * 4 + frame across
//   items:   16 x 16 icons from ITEM_Y, indexed by item icon
//   creatures and projectiles: shelf-packed frames from CREATURE_Y
//   dimensions: 16 x 16 tile cells from DIM_Y, then shelf-packed props

import { Rng } from '../generation/Random';
import { Deco, DECO_COUNT, PALETTE_COUNT, Tile, TILE_COUNT } from '../generation/Tiles';
import { ARMOR_SETS, ITEM_LIST, Items } from '../items/Items';

export const ATLAS_W = 256;
export const TILE_VARIANTS = 4;
const TILE_ROWS = Math.ceil((TILE_COUNT * TILE_VARIANTS) / 16);
export const DECO_Y = TILE_ROWS * 16;

/** Sprite size per decoration; everything else is 16 x 32. Sprites stand on
 *  the bottom-centre of their tile, so wide trees spill over neighbours. */
const DECO_SIZES: Partial<Record<number, [number, number]>> = {
  [Deco.Oak]: [32, 48],
  [Deco.OakAutumn]: [32, 48],
  [Deco.Palm]: [32, 48],
  [Deco.Pine]: [24, 48],
  [Deco.PineSnow]: [24, 48],
  [Deco.Cactus]: [24, 40],
  [Deco.Crystal]: [24, 32],
  [Deco.Bush]: [24, 24],
  [Deco.Flowers]: [16, 16],
  [Deco.Mushroom]: [16, 16],
  [Deco.DeadBush]: [16, 16],
  [Deco.AnchorCore]: [32, 48],
  [Deco.Table]: [32, 24],
  [Deco.Fireplace]: [32, 32],
  [Deco.Tent]: [32, 32],
  [Deco.Moonwell]: [24, 24],
  [Deco.Crop]: [16, 16],
  [Deco.Fence]: [16, 24],
  [Deco.Bench]: [16, 24],
  [Deco.Throne]: [24, 36],
  [Deco.StairsUp]: [16, 32],
  [Deco.StairsDown]: [16, 20],
  [Deco.Footprint]: [1, 1],
  [Deco.Rift]: [32, 48],
  [Deco.RiftScar]: [16, 16],
};

export interface Frame {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Shelf-packs frames of the given sizes into rows from `top`. */
function shelfPack(sizes: Array<[number, number]>, top: number): { frames: Frame[]; height: number } {
  const frames: Frame[] = [];
  let x = 0;
  let y = top;
  let rowH = 0;
  for (const [w, h] of sizes) {
    if (x + w > ATLAS_W) {
      x = 0;
      y += rowH;
      rowH = 0;
    }
    frames.push({ x, y, w, h });
    x += w;
    rowH = Math.max(rowH, h);
  }
  return { frames, height: y + rowH - top };
}

const DECOS = shelfPack(
  Array.from({ length: DECO_COUNT }, (_, d) => DECO_SIZES[d] ?? [16, 32]),
  DECO_Y,
);
export const PLAYER_Y = DECO_Y + DECOS.height;

interface Outfit {
  skin: RGB;
  hair: RGB;
  shirt: RGB;
  pants: RGB;
  /** Optional apron, robe, mask or rags drawn over the base figure. */
  extra?: 'apron' | 'robe' | 'mask' | 'ragged';
}

/** Index 0 is the player. */
export const OUTFITS: Record<string, Outfit> = {
  player: { skin: 0xf2c29a, hair: 0x6b3a1f, shirt: 0x3a9a8a, pants: 0x3b4a6b },
  'villager-a': { skin: 0xf2c29a, hair: 0xe8c050, shirt: 0xc8504a, pants: 0x4a3a2a },
  'villager-b': { skin: 0xc8875a, hair: 0x241a14, shirt: 0x5a9a4a, pants: 0x3b4a6b },
  'villager-c': { skin: 0xf6d2b0, hair: 0xa0522d, shirt: 0xb08ad8, pants: 0x5a4a6a },
  trader: { skin: 0xe0a87a, hair: 0x5a3a20, shirt: 0xe8c050, pants: 0x4a3a2a, extra: 'apron' },
  merchant: { skin: 0xf2c29a, hair: 0xd8d8d8, shirt: 0x6a3a9a, pants: 0x4a2a6a, extra: 'robe' },
  lost: { skin: 0xe0b08a, hair: 0x7a5a3a, shirt: 0x8a8a7a, pants: 0x5a5a4a, extra: 'ragged' },
  bandit: { skin: 0xd8a07a, hair: 0x1a1414, shirt: 0x8a2a2a, pants: 0x2a2a30, extra: 'mask' },
};
const OUTFIT_NAMES = Object.keys(OUTFITS);
export const ITEM_Y = PLAYER_Y + OUTFIT_NAMES.length * 32;
const CREATURE_Y = ITEM_Y + Math.ceil(ITEM_LIST.length / 16) * 16;

export const Dir = { Down: 0, Left: 1, Right: 2, Up: 3 } as const;

type RGB = number;
/** Starforged plate, on icons and on the player. */
const STAR_PLATE: RGB = 0x7a70c8;

export function shade(c: RGB, f: number): RGB {
  const r = Math.min(255, Math.round(((c >> 16) & 255) * f));
  const g = Math.min(255, Math.round(((c >> 8) & 255) * f));
  const b = Math.min(255, Math.round((c & 255) * f));
  return (r << 16) | (g << 8) | b;
}

export class Painter {
  private ox = 0;
  private oy = 0;
  private w = 16;
  private h = 16;

  constructor(readonly img: ImageData) {}

  cell(x: number, y: number, w: number, h: number): this {
    this.ox = x;
    this.oy = y;
    this.w = w;
    this.h = h;
    return this;
  }

  set(x: number, y: number, c: RGB, a = 255): void {
    x = Math.round(x);
    y = Math.round(y);
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return;
    const i = ((this.oy + y) * this.img.width + this.ox + x) * 4;
    const d = this.img.data;
    if (a < 255 && d[i + 3] > 0) {
      const t = a / 255;
      d[i] = d[i] * (1 - t) + ((c >> 16) & 255) * t;
      d[i + 1] = d[i + 1] * (1 - t) + ((c >> 8) & 255) * t;
      d[i + 2] = d[i + 2] * (1 - t) + (c & 255) * t;
      d[i + 3] = Math.max(d[i + 3], a);
      return;
    }
    d[i] = (c >> 16) & 255;
    d[i + 1] = (c >> 8) & 255;
    d[i + 2] = c & 255;
    d[i + 3] = a;
  }

  /** Makes a pixel fully transparent again. */
  clear(x: number, y: number): void {
    x = Math.round(x);
    y = Math.round(y);
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return;
    this.img.data[((this.oy + y) * this.img.width + this.ox + x) * 4 + 3] = 0;
  }

  alpha(x: number, y: number): number {
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return 0;
    return this.img.data[((this.oy + y) * this.img.width + this.ox + x) * 4 + 3];
  }

  rect(x: number, y: number, w: number, h: number, c: RGB, a = 255): void {
    for (let j = y; j < y + h; j++) for (let i = x; i < x + w; i++) this.set(i, j, c, a);
  }

  ellipse(cx: number, cy: number, rx: number, ry: number, c: RGB, a = 255): void {
    for (let y = Math.floor(cy - ry); y <= Math.ceil(cy + ry); y++) {
      for (let x = Math.floor(cx - rx); x <= Math.ceil(cx + rx); x++) {
        if (((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2 <= 1) this.set(x, y, c, a);
      }
    }
  }

  speckle(rng: Rng, n: number, c: RGB, a = 255): void {
    for (let k = 0; k < n; k++) this.set(rng.int(0, this.w - 1), rng.int(0, this.h - 1), c, a);
  }

  /** Dark one-pixel outline around opaque pixels, Stardew style. */
  outline(c: RGB = 0x2a1d17): void {
    const edge: Array<[number, number]> = [];
    for (let y = 0; y < this.h; y++) {
      for (let x = 0; x < this.w; x++) {
        if (this.alpha(x, y) > 0) continue;
        if (this.alpha(x - 1, y) > 200 || this.alpha(x + 1, y) > 200 || this.alpha(x, y - 1) > 200 || this.alpha(x, y + 1) > 200) {
          edge.push([x, y]);
        }
      }
    }
    for (const [x, y] of edge) this.set(x, y, c, 230);
  }

  shadow(cx = 8, cy = 30, rx = 6, ry = 2): void {
    this.ellipse(cx, cy, rx, ry, 0x000000, 60);
  }
}

// ---------------------------------------------------------------------------
// Ground tiles

interface GroundColors {
  base: RGB;
  light: RGB;
  dark: RGB;
  style: 'grass' | 'sand' | 'snow' | 'dirt';
}

const PALETTES: GroundColors[][] = [
  // Forest
  [
    { base: 0x6aa84f, light: 0x86c25e, dark: 0x548c3e, style: 'grass' },
    { base: 0x568f3f, light: 0x6aa84f, dark: 0x457533, style: 'grass' },
    { base: 0x9c7650, light: 0xb08a60, dark: 0x7f5f40, style: 'dirt' },
    { base: 0xe3cc94, light: 0xf0dcaa, dark: 0xcbb27a, style: 'sand' },
  ],
  // Autumn forest
  [
    { base: 0xb9a046, light: 0xd1b85a, dark: 0x9b8338, style: 'grass' },
    { base: 0xa8803a, light: 0xc09650, dark: 0x8a682e, style: 'grass' },
    { base: 0x8f6447, light: 0xa57756, dark: 0x744f37, style: 'dirt' },
    { base: 0xe3cc94, light: 0xf0dcaa, dark: 0xcbb27a, style: 'sand' },
  ],
  // Desert
  [
    { base: 0xe8c98b, light: 0xf3d9a3, dark: 0xd6b475, style: 'sand' },
    { base: 0xdcb677, light: 0xe8c98b, dark: 0xc9a062, style: 'sand' },
    { base: 0xc49a62, light: 0xd4ab73, dark: 0xa8814f, style: 'dirt' },
    { base: 0xc8a46c, light: 0xd8b67e, dark: 0xb08c58, style: 'sand' },
  ],
  // Red desert
  [
    { base: 0xd4875a, light: 0xe39b6c, dark: 0xbd7249, style: 'sand' },
    { base: 0xc5744a, light: 0xd4875a, dark: 0xa9603c, style: 'sand' },
    { base: 0xa75c3e, light: 0xb96c4c, dark: 0x8c4b32, style: 'dirt' },
    { base: 0xc9935f, light: 0xd9a570, dark: 0xb07e4f, style: 'sand' },
  ],
  // Snow
  [
    { base: 0xeaf1f7, light: 0xffffff, dark: 0xd2dfeb, style: 'snow' },
    { base: 0xd8e4ef, light: 0xeaf1f7, dark: 0xc2d3e3, style: 'snow' },
    { base: 0xbccbd9, light: 0xd0dce7, dark: 0xa5b6c7, style: 'dirt' },
    { base: 0xcfe5f2, light: 0xe6f3fa, dark: 0xb3d3e6, style: 'snow' },
  ],
  // Crystal tundra
  [
    { base: 0xe2e5f6, light: 0xf6f7ff, dark: 0xccd0ee, style: 'snow' },
    { base: 0xd0d3f0, light: 0xe2e5f6, dark: 0xb9bde6, style: 'snow' },
    { base: 0xb5a9e0, light: 0xc9bff0, dark: 0x9b8ecf, style: 'dirt' },
    { base: 0xcfe2f6, light: 0xe6f0fb, dark: 0xb2cbe9, style: 'snow' },
  ],
];

function paintGround(p: Painter, g: GroundColors, rng: Rng): void {
  p.rect(0, 0, 16, 16, g.base);
  switch (g.style) {
    case 'grass':
      p.speckle(rng, 14, g.dark);
      for (let k = 0; k < 5; k++) {
        const x = rng.int(1, 14);
        const y = rng.int(2, 14);
        p.set(x, y, g.light);
        p.set(x - 1, y - 1, g.light);
        p.set(x + 1, y - 1, g.light);
      }
      break;
    case 'sand':
      p.speckle(rng, 10, g.dark);
      p.speckle(rng, 8, g.light);
      break;
    case 'snow':
      p.speckle(rng, 8, g.dark);
      p.speckle(rng, 4, g.light);
      break;
    case 'dirt':
      p.speckle(rng, 12, g.dark);
      for (let k = 0; k < 2; k++) {
        const x = rng.int(1, 13);
        const y = rng.int(1, 13);
        p.rect(x, y, 2, 1, g.light);
        p.set(x, y + 1, g.dark);
      }
      break;
  }
}

// ---------------------------------------------------------------------------
// Shared tiles

function cobbles(p: Painter, rng: Rng, base: RGB): void {
  p.rect(0, 0, 16, 16, base);
  for (let k = 0; k < 6; k++) {
    const x = rng.int(0, 12);
    const y = rng.int(0, 12);
    const w = rng.int(3, 5);
    const h = rng.int(2, 4);
    p.rect(x, y, w, h, shade(base, 1.12));
    p.rect(x, y, w, 1, shade(base, 1.25));
    p.rect(x, y + h, w, 1, shade(base, 0.72));
  }
}

function paintShared(p: Painter, id: number, rng: Rng, variant: number): void {
  switch (id) {
    case Tile.Water:
    case Tile.WaterDeep: {
      const base = id === Tile.Water ? 0x4a8fcc : 0x3a72ad;
      p.rect(0, 0, 16, 16, base);
      p.speckle(rng, 10, shade(base, 0.9));
      for (let k = 0; k < (id === Tile.Water ? 3 : 2); k++) {
        const x = rng.int(0, 11);
        const y = rng.int(1, 14);
        p.rect(x, y, rng.int(3, 5), 1, 0x8cc3ec);
      }
      break;
    }
    case Tile.Rock:
      cobbles(p, rng, 0x8d8579);
      break;
    case Tile.RockDark:
      cobbles(p, rng, 0x6c645b);
      break;
    case Tile.Path:
      p.rect(0, 0, 16, 16, 0xc4a578);
      p.speckle(rng, 12, 0xab8c61);
      p.speckle(rng, 5, 0xd8bc90);
      break;
    case Tile.StoneFloor:
      p.rect(0, 0, 16, 16, 0xaaa499);
      p.speckle(rng, 6, 0x9b958a);
      p.rect(0, 0, 16, 1, 0x8a8479);
      p.rect(0, 8, 16, 1, 0x8a8479);
      p.rect(variant & 1 ? 4 : 10, 0, 1, 8, 0x8a8479);
      p.rect(variant & 2 ? 6 : 12, 8, 1, 8, 0x8a8479);
      break;
    case Tile.WoodFloor:
      p.rect(0, 0, 16, 16, 0xb5824d);
      for (let y = 0; y < 16; y += 4) {
        p.rect(0, y + 3, 16, 1, 0x8a5f34);
        p.set(rng.int(0, 15), y + 1, 0x9c6c3e);
      }
      break;
    case Tile.StoneWall:
      // The top of a wall: flat capstones seen from above.
      p.rect(0, 0, 16, 16, 0x9a948a);
      for (const [x, y, w, h] of [[0, 0, 7, 7], [7, 0, 9, 6], [0, 7, 9, 9], [9, 6, 7, 10]]) {
        p.rect(x, y, w, h, shade(0x9a948a, 0.92 + ((x + y + variant) % 3) * 0.06));
        p.rect(x, y, w, 1, 0xb8b2a6);
        p.rect(x, y + h - 1, w, 1, 0x7d776d);
      }
      p.speckle(rng, 6, 0x8a8478);
      break;
    case Tile.StoneWallFace:
      // The front of a wall: capstone lip, bricks, and a shadow at the foot.
      p.rect(0, 0, 16, 16, 0x7f7a72);
      for (let y = 3; y < 15; y += 4) {
        p.rect(0, y + 3, 16, 1, 0x5e5953);
        const off = (y / 4) % 2 ? 4 : 0;
        for (let x = off; x < 16; x += 8) p.rect(x, y, 1, 4, 0x5e5953);
      }
      p.rect(0, 0, 16, 3, 0xa29c93);
      p.rect(0, 3, 16, 1, 0x5e5953);
      p.rect(0, 14, 16, 2, 0x4a4540);
      if (variant % 2) for (let k = 0; k < 3; k++) p.set(rng.int(0, 15), rng.int(11, 13), 0x5a8a3a);
      break;
    case Tile.WoodWall:
      p.rect(0, 0, 16, 16, 0x9a6a38);
      for (let x = 0; x < 16; x += 4) {
        p.ellipse(x + 1.5, 8, 1.6, 7, 0x8b5a2b);
        p.rect(x + 1, 2, 1, 12, 0xb07a44);
      }
      break;
    case Tile.WoodWallFace:
      p.rect(0, 0, 16, 16, 0x8b5a2b);
      for (let x = 0; x < 16; x += 4) {
        p.rect(x, 0, 1, 16, 0x5c3a1c);
        p.rect(x + 1, 0, 1, 16, 0xa87442);
      }
      p.rect(0, 0, 16, 2, 0xb07a44);
      p.rect(0, 14, 16, 2, 0x4a2e16);
      break;
    case Tile.Building:
      p.rect(0, 0, 16, 16, 0x5a4632);
      break;
    case Tile.InteriorWall:
      // Wallpaper above a wooden wainscot.
      p.rect(0, 0, 16, 11, 0xe8d8b0);
      for (let x = variant % 2 ? 2 : 0; x < 16; x += 4) p.rect(x, 0, 1, 11, 0xd8c498);
      for (let x = 1; x < 16; x += 4) p.set(x, 5, 0xc89a6a);
      p.rect(0, 11, 16, 5, 0x8a5a2b);
      p.rect(0, 11, 16, 1, 0xb07a44);
      p.rect(0, 15, 16, 1, 0x5c3a1c);
      for (let x = 3; x < 16; x += 8) p.rect(x, 12, 1, 3, 0x6b4423);
      break;
    case Tile.WallTop:
      p.rect(0, 0, 16, 16, 0x3a2414);
      p.rect(0, 0, 16, 1, 0x5a3a20);
      p.speckle(rng, 4, 0x2a1a0e);
      break;
    case Tile.Rug:
      p.rect(0, 0, 16, 16, 0xa8323a);
      p.rect(0, 0, 16, 1, 0xd8b050);
      p.rect(0, 15, 16, 1, 0xd8b050);
      for (let k = 0; k < 16; k += 4) {
        p.set(k + 1, 4, 0xe8c070);
        p.set(k + 3, 8, 0xe8c070);
        p.set(k + 1, 12, 0xe8c070);
      }
      p.speckle(rng, 6, 0x902a32);
      break;
    case Tile.BridgeH:
    case Tile.BridgeH2:
    case Tile.BridgeV:
    case Tile.BridgeV2: {
      // Planks laid across the way of travel, with a rail on the outer side.
      const across = id === Tile.BridgeH || id === Tile.BridgeH2;
      const plank = (i: number, j: number, c: RGB) => (across ? p.set(i, j, c) : p.set(j, i, c));
      for (let a = 0; a < 16; a++) {
        const board = Math.floor(a / 4);
        const base = shade(0xa8763f, 0.92 + ((board + variant) % 3) * 0.06);
        for (let b = 0; b < 16; b++) plank(a, b, a % 4 === 3 ? 0x6b4423 : base);
        plank(a, 1, shade(base, 1.15));
      }
      for (let a = 1; a < 16; a += 4) {
        plank(a, 3, 0x5a3818);
        plank(a, 12, 0x5a3818);
      }
      const outer = id === Tile.BridgeH || id === Tile.BridgeV ? 0 : 13;
      for (let a = 0; a < 16; a++) {
        for (let b = outer; b < outer + 3; b++) plank(a, b, b === outer + 1 ? 0x8a5a2b : 0x5c3a1c);
        if (a % 8 === 2) for (let b = outer; b < outer + 3; b++) plank(a, b, 0x4a2e16);
      }
      if (across) p.rect(0, outer + 3 > 15 ? 12 : 3, 16, 1, 0x000000, 50);
      else p.rect(outer + 3 > 15 ? 12 : 3, 0, 1, 16, 0x000000, 50);
      break;
    }
    case Tile.CaveWall:
      // A rough rock face inside a mine, lit at the top and shadowed at the foot.
      p.rect(0, 0, 16, 16, 0x5a524a);
      for (let k = 0; k < 5; k++) {
        const x = rng.int(0, 12);
        const y = rng.int(1, 11);
        p.rect(x, y, rng.int(3, 6), rng.int(2, 4), shade(0x5a524a, rng.range(0.85, 1.15)));
        p.rect(x, y, 3, 1, 0x7a7168);
      }
      for (let k = 0; k < 2; k++) {
        const x = rng.int(2, 13);
        for (let y = rng.int(2, 6), n = 0; n < 5; n++, y++) p.set(x + (n % 2), y, 0x3a342e);
      }
      if (variant === 1) for (const [x, y] of [[5, 7], [6, 8], [10, 5]]) p.set(x, y, 0xf2c14e);
      p.rect(0, 0, 16, 2, 0x7a7168);
      p.rect(0, 13, 16, 3, 0x2e2924);
      break;
    case Tile.Farmland:
      // Dark tilled soil in furrows.
      p.rect(0, 0, 16, 16, 0x6b4a2e);
      for (let y = 1; y < 16; y += 4) {
        p.rect(0, y, 16, 2, 0x7d5836);
        p.rect(0, y + 2, 16, 1, 0x4e3420);
      }
      p.speckle(rng, 6, 0x8a6a48);
      break;
    case Tile.CaveRoof:
      p.rect(0, 0, 16, 16, 0x24201c);
      p.speckle(rng, 8, 0x302a25);
      p.speckle(rng, 3, 0x1a1714);
      break;
    case Tile.MineFloor:
    case Tile.Rail:
      p.rect(0, 0, 16, 16, 0x6e5a44);
      p.speckle(rng, 14, 0x5a4836);
      p.speckle(rng, 6, 0x857058);
      for (let k = 0; k < 2; k++) p.rect(rng.int(0, 13), rng.int(0, 14), 2, 1, 0x8a8275);
      if (id === Tile.Rail) {
        for (const y of [1, 6, 11]) {
          p.rect(1, y, 14, 3, 0x6b4423);
          p.rect(1, y, 14, 1, 0x8a5a2b);
        }
        for (const x of [3, 11]) {
          p.rect(x, 0, 2, 16, 0x6c6c74);
          p.rect(x, 0, 1, 16, 0xa8a8b4);
        }
      }
      break;
    case Tile.Rubble:
      p.rect(0, 0, 16, 16, 0xa39b8e);
      p.speckle(rng, 10, 0x8a8275);
      for (let k = 0; k < 4; k++) {
        const x = rng.int(0, 13);
        const y = rng.int(0, 13);
        p.rect(x, y, 2, 2, 0x7d776d);
        p.set(x, y, 0xbab3a7);
      }
      break;
    case Tile.Ice:
      p.rect(0, 0, 16, 16, 0xbfe3f2);
      for (let k = 0; k < 2; k++) {
        const x = rng.int(0, 10);
        const y = rng.int(2, 13);
        for (let d = 0; d < 5; d++) p.set(x + d, y - d, 0xeaf7fd);
      }
      p.speckle(rng, 4, 0x9ccbe2);
      break;
    case Tile.TempleFloor:
      p.rect(0, 0, 16, 16, 0xd9c17b);
      p.rect(0, 0, 16, 1, 0xb59b57);
      p.rect(0, 0, 1, 16, 0xb59b57);
      p.rect(0, 8, 16, 1, 0xc4ab66);
      p.rect(8, 0, 1, 16, 0xc4ab66);
      p.rect(3, 3, 2, 2, 0xf0dc9a);
      p.rect(11, 11, 2, 2, 0xf0dc9a);
      break;
    case Tile.DarkFloor:
      p.rect(0, 0, 16, 16, 0x413b49);
      p.rect(0, 0, 16, 1, 0x2f2a36);
      p.rect(0, 0, 1, 16, 0x2f2a36);
      p.speckle(rng, 6, 0x4d4656);
      break;
    case Tile.RiftGround: {
      // Scorched earth, cracked by faintly glowing violet veins.
      p.rect(0, 0, 16, 16, 0x6e5f5c);
      p.speckle(rng, 12, 0x5c4e4e);
      p.speckle(rng, 8, 0x80716c);
      if (variant % 2) {
        let x = rng.int(3, 12);
        for (let y = rng.int(0, 6), n = rng.int(5, 9); n > 0 && y < 16; y++, n--) {
          x = Math.max(0, Math.min(15, x + rng.int(-1, 1)));
          p.set(x, y, n % 3 ? 0x8a6ab0 : 0xb07aff);
        }
      }
      if (variant === 2) p.set(rng.int(2, 13), rng.int(2, 13), 0x5af0e8, 200);
      break;
    }
    case Tile.Cave:
      p.rect(0, 0, 16, 16, 0x6c645b);
      p.ellipse(7.5, 9, 7, 6, 0x1c1714);
      p.ellipse(7.5, 10, 5, 4, 0x0d0a09);
      break;
    case Tile.Roof:
      p.rect(0, 0, 16, 16, 0xb4543b);
      for (let y = 0; y < 16; y += 4) {
        p.rect(0, y + 3, 16, 1, 0x86392a);
        const off = (y / 4) % 2 ? 2 : 6;
        for (let x = off; x < 16; x += 8) p.rect(x, y, 1, 3, 0x9a4431);
        p.rect(0, y, 16, 1, 0xcc6a4d);
      }
      break;
    case Tile.Facade:
    case Tile.Door:
      p.rect(0, 0, 16, 16, 0xcca26c);
      for (let y = 0; y < 16; y += 3) p.rect(0, y, 16, 1, 0xb08654);
      p.rect(0, 0, 16, 2, 0x7a4a2a);
      if (id === Tile.Door) {
        p.rect(4, 3, 8, 13, 0x6b4423);
        p.rect(5, 4, 6, 12, 0x7f532c);
        p.set(9, 10, 0xe8c050);
      } else if (variant !== 3) {
        p.rect(4, 5, 8, 7, 0x5a3a1d);
        p.rect(5, 6, 6, 5, 0x86bde3);
        p.rect(5, 6, 2, 2, 0xd6eefa);
        p.rect(7, 6, 1, 5, 0x5a3a1d);
      }
      break;
  }
}

// ---------------------------------------------------------------------------
// Plants: leafy clusters lit from the top left, with dithered leaf texture

interface Leaves {
  dark: RGB;
  base: RGB;
  light: RGB;
  highlight: RGB;
  outline: RGB;
}

const GREEN: Leaves = { dark: 0x2b6330, base: 0x3d8a3a, light: 0x5aab48, highlight: 0x8ccf62, outline: 0x1c3a1d };
const AUTUMN: Leaves = { dark: 0xa04a1e, base: 0xd2702c, light: 0xeea044, highlight: 0xffd27a, outline: 0x4f2410 };
const BUSH: Leaves = { dark: 0x285a2c, base: 0x387a36, light: 0x529a44, highlight: 0x7cbd5a, outline: 0x1a361b };
const PINE: Leaves = { dark: 0x1d4632, base: 0x2a6446, light: 0x3c8458, highlight: 0x5aa672, outline: 0x112a1e };

function foliage(p: Painter, cx: number, cy: number, r: number, c: Leaves, rng: Rng): void {
  for (let y = Math.floor(cy - r); y <= Math.ceil(cy + r); y++) {
    for (let x = Math.floor(cx - r); x <= Math.ceil(cx + r); x++) {
      const d = Math.hypot(x - cx, y - cy);
      if (d > r || (d > r - 1.2 && rng.chance(0.35))) continue;
      const lit = -((x - cx) * 0.6 + (y - cy) * 0.8) / r + (rng.next() - 0.5) * 0.4;
      p.set(x, y, lit > 0.55 ? c.highlight : lit > 0.1 ? c.light : lit > -0.45 ? c.base : c.dark);
    }
  }
}

/** Random leaf flecks over what is already painted in a band. */
function flecks(p: Painter, rng: Rng, n: number, x0: number, y0: number, x1: number, y1: number, color: RGB): void {
  for (let k = 0; k < n; k++) {
    const x = rng.int(x0, x1);
    const y = rng.int(y0, y1);
    if (p.alpha(x, y) > 200) p.set(x, y, color);
  }
}

function trunk(p: Painter, cx: number, top: number, bottom: number, half: number): void {
  for (let y = top; y <= bottom; y++) {
    const w = y > bottom - 3 ? half + (y - (bottom - 3)) : half;
    p.rect(cx - w, y, w * 2, 1, 0x7a5232);
    p.set(cx - w, y, 0x94683f);
    p.set(cx + w - 1, y, 0x553821);
    p.set(cx + w - 2, y, 0x654428);
  }
  for (let y = top + 2; y < bottom - 2; y += 4) p.set(cx - 1 + (y % 3), y, 0x553821);
}

function oak(p: Painter, c: Leaves, rng: Rng): void {
  p.ellipse(16, 45, 11, 2.5, 0x000000, 60);
  trunk(p, 16, 26, 45, 3);
  for (const [x, y, r] of [[16, 24, 8], [8, 20, 7], [24, 20, 7], [16, 15, 11], [10, 10, 7], [22, 10, 7], [16, 6, 6]]) {
    foliage(p, x, y, r, c, rng);
  }
  flecks(p, rng, 30, 3, 2, 29, 30, c.dark);
  flecks(p, rng, 14, 3, 2, 22, 18, c.highlight);
  if (c === AUTUMN) flecks(p, rng, 10, 3, 2, 29, 30, 0xc23a2a);
  p.outline(c.outline);
}

function pineTree(p: Painter, snow: boolean, rng: Rng): void {
  const c = PINE;
  p.ellipse(12, 45, 8, 2, 0x000000, 60);
  trunk(p, 12, 37, 45, 2);
  const tiers = [
    { top: 25, h: 14, half: 11 },
    { top: 17, h: 13, half: 9 },
    { top: 9, h: 12, half: 7 },
    { top: 2, h: 10, half: 5 },
  ];
  for (const t of tiers) {
    for (let yy = 0; yy < t.h; yy++) {
      const half = 1 + (t.half - 1) * (yy / (t.h - 1));
      for (let x = Math.round(12 - half); x < Math.round(12 + half); x++) {
        if (yy === t.h - 1 && x % 2) continue; // ragged lower edge
        const rel = (x + 0.5 - 12) / half + (rng.next() - 0.5) * 0.3;
        let color = rel < -0.45 ? c.light : rel > 0.35 ? c.dark : c.base;
        if (yy >= t.h - 2) color = c.dark;
        if (rel < -0.75 && yy < t.h - 3) color = c.highlight;
        if (snow && (yy < 2 || (rel < -0.2 && rng.chance(0.18)))) color = yy < 2 ? 0xf4f8fb : 0xdfe9f1;
        p.set(x, t.top + yy, color);
      }
    }
  }
  flecks(p, rng, 18, 2, 4, 21, 38, c.dark);
  p.outline(c.outline);
}

function palm(p: Painter, rng: Rng): void {
  p.ellipse(15, 45, 9, 2, 0x000000, 60);
  // Curved, ringed trunk.
  for (let t = 0; t <= 1; t += 0.02) {
    const x = 13 + 4 * t + Math.sin(t * Math.PI) * 3;
    const y = 45 - 31 * t;
    const ring = Math.floor(y) % 3 === 0;
    p.rect(Math.round(x) - 2, Math.round(y), 4, 1, ring ? 0x7a5a36 : 0xa07a4c);
    p.set(Math.round(x) - 2, Math.round(y), ring ? 0x8a6a42 : 0xb88e5c);
  }
  const crown = { x: 18, y: 13 };
  for (const [dx, dy] of [[-14, 7], [-12, -3], [-4, -10], [6, -9], [13, -2], [14, 8]]) {
    for (let k = 0; k <= 20; k++) {
      const t = k / 20;
      const x = crown.x + dx * t;
      const y = crown.y + dy * t + 7 * t * t;
      p.set(x, y, 0x3d8a3a);
      p.set(x, y + 1, 0x2b6330);
      if (k > 3 && k % 2 === 0) {
        p.set(x, y + 2, 0x3d8a3a);
        p.set(x + (dx > 0 ? -1 : 1), y + 3, 0x2b6330);
      }
      if (t < 0.5) p.set(x, y - 1, 0x5aab48);
    }
  }
  for (const [x, y] of [[16, 15], [19, 15], [17.5, 17]]) p.ellipse(x, y, 1.6, 1.6, 0x6a4424);
  flecks(p, rng, 6, 4, 4, 30, 22, 0x8ccf62);
  p.outline(GREEN.outline);
}

function bush(p: Painter, rng: Rng): void {
  p.ellipse(12, 22, 10, 2, 0x000000, 60);
  for (const [x, y, r] of [[12, 16, 7], [6, 17, 5], [18, 17, 5], [9, 11, 5], [15, 10, 5]]) foliage(p, x, y, r, BUSH, rng);
  flecks(p, rng, 12, 2, 5, 21, 21, BUSH.dark);
  for (let k = 0; k < 6; k++) {
    const x = rng.int(4, 19);
    const y = rng.int(8, 19);
    if (p.alpha(x, y) < 200) continue;
    p.rect(x, y, 2, 2, 0xc8323e);
    p.set(x, y, 0xff8a96);
  }
  p.outline(BUSH.outline);
}

function cactus(p: Painter, rng: Rng): void {
  p.ellipse(12, 38, 8, 2, 0x000000, 60);
  const limb = (x: number, y: number, w: number, h: number, round: boolean) => {
    for (let i = 0; i < w; i++) {
      const color = i === 0 ? 0x78c068 : i === w - 1 ? 0x2f6e34 : i % 2 ? 0x468c44 : 0x58a452;
      p.rect(x + i, y + (round && (i === 0 || i === w - 1) ? 1 : 0), 1, h, color);
    }
  };
  limb(9, 6, 6, 32, true);
  limb(4, 11, 4, 12, true);
  limb(4, 20, 6, 4, false);
  limb(16, 17, 4, 12, true);
  limb(14, 26, 6, 4, false);
  for (let k = 0; k < 16; k++) {
    const x = rng.int(4, 19);
    const y = rng.int(7, 36);
    if (p.alpha(x, y) > 200) p.set(x, y, 0xf2f0d0);
  }
  p.rect(10, 4, 4, 2, 0xf06a9a);
  p.set(11, 3, 0xffb0cc);
  p.outline(GREEN.outline);
}

function crystals(p: Painter): void {
  p.ellipse(12, 30, 9, 2, 0x000000, 60);
  for (const [cx, h, hw, light, dark] of [
    [6, 13, 2.5, 0xc4b0ff, 0x7a5ad0],
    [17, 17, 3, 0xa8e6f8, 0x3a9ac8],
    [11, 25, 3.5, 0xd8c8ff, 0x8a6ae0],
    [15, 10, 2, 0xc4b0ff, 0x7a5ad0],
  ]) {
    const top = 30 - h;
    for (let y = top; y < 30; y++) {
      const half = Math.min(hw, (y - top) * 0.8 + 0.5);
      for (let x = Math.round(cx - half); x < Math.round(cx + half); x++) p.set(x, y, x < cx ? light : dark);
    }
    p.rect(Math.round(cx) - 1, top + 3, 1, Math.max(1, h - 6), 0xffffff, 170);
  }
  p.outline(0x2f2350);
}

function flowers(p: Painter, rng: Rng): void {
  const colors = [0xffffff, 0xf26a8c, 0xf4d03f, 0x8a7ae0, 0xf08a3a];
  for (const [x, y] of [[4, 8], [11, 6], [8, 11], [13, 12]]) {
    p.rect(x, y + 1, 1, 15 - y, 0x3f7a30);
    p.set(x - 1, y + 4, 0x5aab48);
    p.set(x + 1, y + 6, 0x5aab48);
    const c = rng.pick(colors);
    for (const [dx, dy] of [[0, -1], [-1, 0], [1, 0], [0, 1]]) p.set(x + dx, y + dy, c);
    p.set(x + 1, y + 1, shade(c, 0.8));
    p.set(x, y, 0xf6c445);
  }
}

function mushrooms(p: Painter): void {
  p.ellipse(8, 15, 7, 1.5, 0x000000, 60);
  p.rect(4, 9, 4, 6, 0xf1e6d0);
  p.rect(7, 9, 1, 6, 0xd8ccb4);
  p.ellipse(6, 8, 5, 3, 0xc8402f);
  p.ellipse(5, 7, 2.5, 1.2, 0xe86a50);
  for (const [x, y] of [[4, 7], [7, 6], [9, 8]]) p.set(x, y, 0xffffff);
  p.rect(11, 11, 2, 4, 0xf1e6d0);
  p.ellipse(12, 10.5, 3, 2, 0xc8402f);
  p.set(12, 10, 0xffffff);
  p.outline(0x4a1e14);
}

function deadBush(p: Painter): void {
  const twig = 0x8a6a45;
  for (const [x0, dx] of [[8, -1], [8, 1], [8, 0], [8, -0.5]]) {
    for (let k = 0; k < 9; k++) p.set(x0 + dx * k * 0.6, 15 - k, twig);
  }
  for (const [x, y] of [[4, 9], [12, 9], [6, 6], [10, 7], [3, 11]]) p.set(x, y, 0x6e5234);
}

/** Paints a plant decoration; returns false for anything else. */
function paintPlant(p: Painter, id: number, rng: Rng): boolean {
  switch (id) {
    case Deco.Oak: oak(p, GREEN, rng); return true;
    case Deco.OakAutumn: oak(p, AUTUMN, rng); return true;
    case Deco.Pine: pineTree(p, false, rng); return true;
    case Deco.PineSnow: pineTree(p, true, rng); return true;
    case Deco.Palm: palm(p, rng); return true;
    case Deco.Bush: bush(p, rng); return true;
    case Deco.Cactus: cactus(p, rng); return true;
    case Deco.Crystal: crystals(p); return true;
    case Deco.Flowers: flowers(p, rng); return true;
    case Deco.Mushroom: mushrooms(p); return true;
    case Deco.DeadBush: deadBush(p); return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Other decorations (16 x 32, feet on the bottom row)

function rock(p: Painter, base: RGB, cap?: RGB): void {
  p.shadow(8, 30, 6, 1.5);
  p.ellipse(8, 26.5, 6, 4, shade(base, 0.75));
  p.ellipse(7.5, 26, 5.5, 3.5, base);
  p.ellipse(6, 24.5, 2.5, 1.5, shade(base, 1.2));
  if (cap) p.ellipse(7.5, 24, 5, 1.8, cap);
  p.outline();
}

function paintDeco(p: Painter, id: number, rng: Rng): void {
  if (paintPlant(p, id, rng)) return;
  switch (id) {
    case Deco.Stone:
      rock(p, 0x9a9389);
      break;
    case Deco.RedRock:
      rock(p, 0xb56a45);
      break;
    case Deco.SnowRock:
      rock(p, 0x8f99a3, 0xf3f8fc);
      break;
    case Deco.Ore:
      rock(p, 0x857d74);
      for (let k = 0; k < 4; k++) p.set(rng.int(4, 11), rng.int(24, 28), k % 2 ? 0xf2c14e : 0xe07a3c);
      break;
    case Deco.Campfire:
      p.rect(3, 27, 10, 2, 0x6b4a2b);
      p.rect(5, 25, 6, 2, 0x84603a);
      p.ellipse(8, 22, 3, 4, 0xe86a2c);
      p.ellipse(8, 23, 2, 2.5, 0xf6c445);
      p.set(8, 17, 0xe86a2c);
      p.outline();
      break;
    case Deco.Chest:
      p.shadow(8, 30, 6, 1.5);
      p.rect(2, 21, 12, 9, 0x8a5a2b);
      p.rect(2, 21, 12, 3, 0xa87442);
      p.rect(2, 24, 12, 1, 0xd4a640);
      p.rect(7, 23, 2, 3, 0xf0c850);
      p.outline();
      break;
    case Deco.Barrel:
      p.shadow(8, 30, 5, 1.5);
      p.rect(4, 19, 8, 11, 0x9a6634);
      p.rect(4, 19, 2, 11, 0xb07a44);
      p.rect(4, 21, 8, 1, 0x5c5c62);
      p.rect(4, 27, 8, 1, 0x5c5c62);
      p.rect(5, 18, 6, 1, 0x7a4f28);
      p.outline();
      break;
    case Deco.Pillar:
      p.shadow(8, 30, 5, 1.5);
      p.rect(5, 8, 6, 21, 0xc9c3b7);
      p.rect(5, 8, 2, 21, 0xe0dbd0);
      p.rect(10, 8, 1, 21, 0xa39d91);
      p.rect(4, 6, 8, 2, 0xd8d2c6);
      p.rect(4, 28, 8, 2, 0xb3ada1);
      p.outline();
      break;
    case Deco.Statue:
      p.shadow(8, 30, 6, 1.5);
      p.rect(3, 25, 10, 5, 0x9d978c);
      p.rect(3, 25, 10, 1, 0xbdb7ac);
      p.rect(6, 13, 4, 12, 0xb8b2a6);
      p.ellipse(8, 10, 2.5, 2.5, 0xb8b2a6);
      p.rect(4, 15, 2, 6, 0xa39d91);
      p.rect(10, 15, 2, 6, 0xa39d91);
      p.rect(6, 13, 1, 12, 0xd0cabf);
      p.outline();
      break;
    case Deco.Bones:
      p.rect(4, 27, 8, 1, 0xefe8d8);
      p.set(3, 26, 0xefe8d8);
      p.set(3, 28, 0xefe8d8);
      p.set(12, 26, 0xefe8d8);
      p.set(12, 28, 0xefe8d8);
      p.ellipse(10, 24, 2, 1.5, 0xefe8d8);
      p.set(9, 24, 0x3a3030);
      p.outline(0x6a6050);
      break;
    case Deco.Banner:
      p.rect(7, 4, 1, 26, 0x6b4a2b);
      p.set(7, 3, 0xe8c050);
      p.rect(8, 5, 6, 9, 0xb8323a);
      p.rect(8, 14, 2, 2, 0xb8323a);
      p.rect(12, 14, 2, 2, 0xb8323a);
      p.rect(10, 8, 2, 3, 0xe8c050);
      p.outline();
      break;
    case Deco.Well:
      p.shadow(8, 30, 7, 2);
      p.ellipse(8, 26, 7, 4, 0x8d8579);
      p.ellipse(8, 25.5, 5, 2.5, 0x3a72ad);
      p.rect(1, 14, 2, 12, 0x6b4a2b);
      p.rect(13, 14, 2, 12, 0x6b4a2b);
      p.rect(0, 12, 16, 3, 0xb4543b);
      p.rect(0, 12, 16, 1, 0xcc6a4d);
      p.outline();
      break;
    case Deco.Monument:
      p.shadow(8, 30, 6, 1.5);
      p.rect(4, 13, 8, 17, 0x7d7a75);
      p.rect(4, 13, 3, 17, 0x9a968f);
      p.rect(10, 13, 2, 17, 0x5e5a55);
      for (const [x, y] of [[4, 12], [6, 11], [8, 12], [10, 10], [11, 12]]) p.rect(x, y, 2, 2, 0x7d7a75);
      for (const [x, y] of [[6, 16], [8, 18], [6, 21], [9, 23], [7, 26]]) p.rect(x, y, 2, 1, 0x7fd8ff);
      p.outline();
      break;
    case Deco.Gravestone:
      p.shadow(8, 30, 5, 1.2);
      p.rect(4, 20, 8, 10, 0x8d8a84);
      p.ellipse(8, 20, 4, 3, 0x8d8a84);
      p.rect(4, 19, 2, 11, 0xa8a49c);
      p.rect(7, 21, 2, 6, 0x5e5a55);
      p.rect(6, 22, 4, 1, 0x5e5a55);
      p.set(10, 28, 0x5a8a3a);
      p.set(5, 29, 0x5a8a3a);
      p.outline();
      break;
    case Deco.Telescope:
      p.shadow(8, 30, 6, 1.5);
      for (let k = 0; k < 10; k++) {
        p.set(8 - k * 0.5, 20 + k, 0x6b4a2b);
        p.set(8 + k * 0.5, 20 + k, 0x6b4a2b);
        p.set(8, 20 + k, 0x5a3a22);
      }
      for (let k = 0; k < 12; k++) p.rect(3 + k, 19 - k * 0.7, 3, 2, k < 3 ? 0xb88c3a : 0xd4a640);
      p.rect(14, 10, 2, 3, 0x2a2a30);
      p.outline();
      break;
    case Deco.Bookshelf:
      p.shadow(8, 30, 7, 1.5);
      p.rect(1, 10, 14, 20, 0x6b4423);
      for (const y of [11, 17, 23]) {
        p.rect(2, y, 12, 5, 0x3a2414);
        const colors = [0xc8402c, 0x3a6ab0, 0x5a9a4a, 0xd4a640, 0x8a5ad0];
        for (let x = 2; x < 14; x += 2) p.rect(x, y + (x % 4 ? 1 : 0), 2, 5 - (x % 4 ? 1 : 0), colors[(x + y) % colors.length]);
      }
      p.outline();
      break;
    case Deco.Pedestal:
      p.shadow(8, 30, 5, 1.2);
      p.rect(5, 20, 6, 10, 0x9a968f);
      p.rect(4, 19, 8, 2, 0xb8b4ac);
      p.rect(4, 28, 8, 2, 0x7d7a75);
      p.ellipse(8, 15, 3.5, 3.5, 0x4ab8f0);
      p.ellipse(7, 14, 1.5, 1.5, 0xd8f4ff);
      p.outline(0x1a2a3a);
      break;
    case Deco.LanternRack:
      p.shadow(8, 30, 6, 1.2);
      p.rect(7, 6, 2, 24, 0x6b4a2b);
      p.rect(2, 7, 12, 2, 0x6b4a2b);
      for (const [x, lit] of [[3, false], [7, true], [11, false]] as const) {
        p.rect(x, 10, 2, 1, 0x3a3a40);
        p.rect(x - 1, 11, 4, 5, 0x3a3a40);
        p.rect(x, 12, 2, 3, lit ? 0x7fd8ff : 0x242430);
      }
      for (const [x, lit] of [[3, true], [11, false]] as const) {
        p.rect(x - 1, 18, 4, 5, 0x3a3a40);
        p.rect(x, 19, 2, 3, lit ? 0x7fd8ff : 0x242430);
      }
      p.outline();
      break;
    case Deco.AnchorCore: {
      p.ellipse(16, 45, 14, 2.5, 0x000000, 70);
      p.rect(4, 36, 24, 9, 0x6c645b);
      p.rect(4, 36, 24, 2, 0x9a9389);
      p.rect(8, 30, 16, 7, 0x7d766c);
      for (const [x, h] of [[6, 14], [24, 14]]) p.rect(x, 36 - h, 3, h, 0x5a544c);
      for (let y = 4; y < 31; y++) {
        const half = y < 10 ? (y - 4) * 0.7 + 1 : Math.max(2, 5 - (y - 10) * 0.12);
        p.rect(Math.round(16 - half), y, Math.round(half * 2), 1, y % 5 ? 0x7fe8ff : 0xd8f8ff);
      }
      p.rect(14, 8, 2, 18, 0xffffff, 170);
      p.ellipse(16, 18, 9, 2, 0xe8504a, 160);
      p.outline(0x1a2a3a);
      break;
    }
    case Deco.Book:
      p.shadow(8, 30, 7, 1.5);
      p.rect(1, 22, 14, 3, 0x8a5a2b);
      p.rect(2, 25, 2, 5, 0x6b4423);
      p.rect(12, 25, 2, 5, 0x6b4423);
      p.rect(4, 19, 4, 3, 0xf2ece0);
      p.rect(8, 19, 4, 3, 0xe8e0d0);
      p.rect(8, 19, 1, 3, 0x8a7a6a);
      p.rect(13, 17, 1, 5, 0xf2ece0);
      p.set(13, 16, 0xf6c445);
      p.outline();
      break;
    case Deco.Bed:
      p.shadow(8, 31, 7, 1);
      p.rect(1, 6, 14, 4, 0x6b4423);
      p.rect(1, 6, 14, 1, 0x8a5a2b);
      p.rect(2, 10, 12, 4, 0xf2ece0);
      p.rect(2, 14, 12, 15, 0x4a7ab0);
      p.rect(2, 14, 12, 2, 0x6a9ad0);
      p.rect(2, 21, 12, 1, 0x3a5a90);
      p.rect(1, 10, 1, 20, 0x6b4423);
      p.rect(14, 10, 1, 20, 0x6b4423);
      p.rect(1, 29, 14, 2, 0x5a3818);
      p.outline();
      break;
    case Deco.Table:
      p.ellipse(16, 23, 14, 1.5, 0x000000, 50);
      p.rect(3, 15, 2, 8, 0x5a3818);
      p.rect(27, 15, 2, 8, 0x5a3818);
      p.rect(1, 8, 30, 8, 0xb07a44);
      p.rect(1, 8, 30, 2, 0xc89058);
      p.rect(1, 14, 30, 2, 0x8a5a2b);
      p.ellipse(10, 10, 3, 1.4, 0xf2ece0);
      p.rect(20, 7, 3, 3, 0xd8d0c0);
      p.outline();
      break;
    case Deco.Chair:
      p.rect(4, 16, 8, 8, 0x8a5a2b);
      p.rect(4, 16, 8, 1, 0xb07a44);
      p.rect(4, 23, 8, 2, 0xa87442);
      p.rect(4, 25, 1, 5, 0x5a3818);
      p.rect(11, 25, 1, 5, 0x5a3818);
      p.outline();
      break;
    case Deco.Fireplace:
      p.rect(2, 6, 28, 26, 0x8d877e);
      for (let y = 9; y < 32; y += 4) {
        p.rect(2, y, 28, 1, 0x6c645b);
        for (let x = (y / 4) % 2 ? 2 : 6; x < 30; x += 8) p.rect(x, y - 3, 1, 3, 0x6c645b);
      }
      p.rect(0, 4, 32, 4, 0x6b4423);
      p.rect(0, 4, 32, 1, 0x8a5a2b);
      p.rect(9, 16, 14, 16, 0x1a1210);
      p.ellipse(16, 16, 7, 4, 0x1a1210);
      p.ellipse(16, 27, 5, 4, 0xe86a2c);
      p.ellipse(16, 28, 3, 2.5, 0xf6c445);
      p.rect(11, 30, 10, 2, 0x5a3818);
      p.outline();
      break;
    case Deco.PottedPlant:
      p.shadow(8, 31, 4, 1);
      p.rect(5, 24, 6, 7, 0xb8603a);
      p.rect(4, 23, 8, 2, 0xd07048);
      for (const [x, y, r] of [[8, 18, 4], [5, 20, 3], [11, 20, 3], [8, 14, 3]]) p.ellipse(x, y, r, r, 0x4a9a44);
      p.ellipse(7, 15, 1.5, 1.5, 0x7cc860);
      p.outline();
      break;
    case Deco.Crate:
      p.shadow(8, 31, 6, 1);
      p.rect(2, 18, 12, 12, 0xa87442);
      p.rect(2, 18, 12, 2, 0xc89058);
      for (let k = 0; k < 10; k++) {
        p.set(3 + k, 20 + k, 0x7a4f28);
        p.set(12 - k, 20 + k, 0x7a4f28);
      }
      p.outline();
      break;
    case Deco.Lamp:
      p.shadow(8, 31, 4, 1);
      p.rect(7, 12, 2, 18, 0x4a4a52);
      p.rect(5, 29, 6, 2, 0x4a4a52);
      p.rect(4, 6, 8, 6, 0xf6d070);
      p.rect(3, 6, 10, 1, 0xd8a840);
      p.rect(5, 7, 2, 4, 0xfff0b0);
      p.outline();
      break;
    case Deco.Minecart:
      p.shadow(8, 30, 7, 1.5);
      // Iron-banded wooden cart, heaped with ore.
      p.ellipse(5, 23, 3.5, 2.5, 0x5a524a);
      p.ellipse(9.5, 22, 3.5, 3, 0x6c645b);
      p.ellipse(8, 21.5, 2, 1.5, 0x857d74);
      for (const [x, y] of [[4, 22], [9, 21], [11, 23], [7, 23]]) p.set(x, y, x % 2 ? 0xf2c14e : 0xe07a3c);
      p.rect(1, 23, 14, 6, 0x7a4f28);
      p.rect(1, 23, 14, 1, 0xa87442);
      p.rect(1, 25, 14, 1, 0x5c5c66);
      p.rect(0, 23, 1, 6, 0x5c5c66);
      p.rect(15, 23, 1, 6, 0x5c5c66);
      for (const x of [4, 11]) {
        p.ellipse(x, 29, 2, 2, 0x3a3a42);
        p.set(x, 29, 0x8a8a96);
      }
      p.outline();
      break;
    case Deco.Crop: {
      // A row of cabbages and carrot tops.
      const leaf = [0x5aab48, 0x7cc860, 0x3d8a3a];
      p.ellipse(8, 14, 6, 1.2, 0x000000, 50);
      for (const [x, y, r] of [[4, 10, 3], [11, 11, 3.2], [8, 7, 2.6]]) {
        p.ellipse(x, y, r, r * 0.85, leaf[2]);
        p.ellipse(x - 0.5, y - 0.5, r * 0.7, r * 0.6, leaf[0]);
        p.set(x - 1, y - 1, leaf[1]);
      }
      p.set(14, 6, 0x5aab48);
      p.set(14, 7, 0xe8823a);
      p.set(2, 5, 0x5aab48);
      p.set(2, 6, 0xe8823a);
      p.outline(0x24401c);
      break;
    }
    case Deco.Fence:
      // Pickets on two rails, spanning the tile.
      p.ellipse(8, 23, 8, 1, 0x000000, 50);
      p.rect(0, 13, 16, 2, 0x9a6a3a);
      p.rect(0, 18, 16, 2, 0x8a5a2b);
      for (let x = 1; x < 16; x += 4) {
        p.rect(x, 9, 2, 13, 0xd8c8a8);
        p.rect(x, 9, 1, 13, 0xf0e4c8);
        p.set(x, 8, 0xd8c8a8);
      }
      p.outline(0x4a3420);
      break;
    case Deco.Bench:
      p.ellipse(8, 22, 8, 1.2, 0x000000, 60);
      p.rect(1, 9, 14, 3, 0x9a6a3a);
      p.rect(1, 9, 14, 1, 0xb88850);
      p.rect(1, 15, 14, 3, 0xa87442);
      p.rect(1, 15, 14, 1, 0xc89058);
      for (const x of [2, 12]) {
        p.rect(x, 12, 2, 3, 0x6b4423);
        p.rect(x, 18, 2, 4, 0x5c3a1c);
      }
      p.outline(0x3a2414);
      break;
    case Deco.Throne: {
      // A high-backed gilded throne with a red cushion.
      p.ellipse(12, 34, 10, 1.5, 0x000000, 70);
      const gold = 0xd4a640;
      p.rect(5, 4, 14, 22, gold);
      p.rect(6, 5, 12, 20, 0xa8323a);
      p.rect(6, 5, 2, 20, 0xc8424a);
      for (const x of [5, 10, 15]) p.rect(x, 1, 4, 4, gold);
      p.set(7, 0, 0xf6e08a);
      p.set(12, 0, 0xf6e08a);
      p.set(17, 0, 0xf6e08a);
      p.rect(3, 20, 18, 10, gold);
      p.rect(5, 21, 14, 5, 0xb8323a);
      p.rect(5, 21, 14, 1, 0xd8525a);
      p.rect(3, 20, 3, 10, 0xf0c860);
      p.rect(18, 20, 3, 10, shade(gold, 0.75));
      p.rect(4, 30, 3, 4, shade(gold, 0.7));
      p.rect(17, 30, 3, 4, shade(gold, 0.7));
      p.set(12, 12, 0x4ab8f0);
      p.outline(0x3a2410);
      break;
    }
    case Deco.ArmorStand:
      // A suit of armour on a stand.
      p.shadow(8, 30, 5, 1.5);
      p.rect(7, 26, 2, 4, 0x6b4423);
      p.rect(5, 29, 6, 1, 0x5c3a1c);
      p.rect(5, 15, 6, 11, 0x9aa0aa);
      p.rect(5, 15, 2, 11, 0xc8ccd4);
      p.rect(10, 15, 1, 11, 0x6a6f78);
      p.rect(3, 15, 2, 7, 0x8a8f99);
      p.rect(11, 15, 2, 7, 0x6a6f78);
      p.rect(5, 20, 6, 1, 0x5a5f68);
      p.rect(5, 7, 6, 7, 0xb8bcc4);
      p.rect(5, 7, 2, 7, 0xd8dce4);
      p.rect(6, 10, 4, 1, 0x2a2a30);
      p.rect(7, 4, 2, 3, 0xb8323a);
      p.outline(0x24242a);
      break;
    case Deco.WeaponRack:
      // Spears and a sword in a wooden rack.
      p.shadow(8, 30, 6, 1.5);
      p.rect(2, 26, 12, 3, 0x6b4423);
      p.rect(2, 12, 12, 2, 0x8a5a2b);
      for (const x of [2, 13]) p.rect(x, 10, 1, 19, 0x5c3a1c);
      for (const x of [4, 7]) {
        p.rect(x, 4, 1, 23, 0x8a5a2b);
        p.rect(x - 1, 2, 3, 3, 0xc8ccd4);
        p.set(x, 1, 0xe8ecf4);
      }
      p.rect(10, 6, 2, 18, 0xc8ccd4);
      p.rect(10, 6, 1, 18, 0xe8ecf4);
      p.rect(9, 23, 4, 1, 0xd4a640);
      p.rect(10, 24, 2, 3, 0x6b4423);
      p.outline(0x2a1d14);
      break;
    case Deco.StairsUp:
      // Stone steps climbing away, each lighter and narrower, with a rail.
      for (let k = 0; k < 6; k++) {
        const y = 28 - k * 4;
        const inset = Math.round(k * 0.4);
        p.rect(1 + inset, y, 14 - inset * 2, 4, shade(0x9a948a, 0.8 + k * 0.06));
        p.rect(1 + inset, y, 14 - inset * 2, 1, shade(0x9a948a, 1.05 + k * 0.05));
      }
      p.rect(0, 8, 1, 24, 0x6b4423);
      p.rect(15, 8, 1, 24, 0x5c3a1c);
      p.rect(0, 7, 2, 2, 0xa87442);
      p.rect(14, 7, 2, 2, 0x8a5a2b);
      p.outline(0x2a2620);
      break;
    case Deco.StairsDown:
      // Steps sinking into the dark.
      p.rect(0, 2, 16, 18, 0x2a2622);
      for (let k = 0; k < 4; k++) {
        const y = 4 + k * 4;
        p.rect(1 + k, y, 14 - k * 2, 3, shade(0x8a8478, 1 - k * 0.2));
        p.rect(1 + k, y, 14 - k * 2, 1, shade(0x8a8478, 1.15 - k * 0.2));
      }
      p.rect(0, 2, 16, 2, 0x6c645b);
      p.rect(0, 2, 16, 1, 0x9a948a);
      p.outline(0x1a1714);
      break;
    case Deco.Dummy:
      // A straw training dummy on a post.
      p.shadow(8, 30, 4, 1.2);
      p.rect(7, 18, 2, 12, 0x6b4423);
      p.rect(2, 13, 12, 2, 0x8a5a2b);
      p.ellipse(8, 15, 3.5, 4.5, 0xd8b85a);
      p.ellipse(7, 14, 2, 3, 0xe8c870);
      p.ellipse(8, 7, 3, 3, 0xd8b85a);
      p.ellipse(7.5, 6.5, 2, 2, 0xe8c870);
      p.rect(5, 15, 6, 1, 0xa8323a);
      p.set(7, 7, 0x3a2414);
      p.set(9, 7, 0x3a2414);
      for (const [x, y] of [[3, 12], [13, 12], [6, 19], [10, 19]]) p.set(x, y, 0xc8a048);
      p.outline(0x3a2a14);
      break;
    case Deco.Moonwell:
      // A ring of pale stones around still, glowing water.
      p.ellipse(12, 19, 11, 4.5, 0x000000, 60);
      p.ellipse(12, 17, 11, 5.5, 0x8a93a8);
      p.ellipse(12, 16.5, 10, 4.5, 0xb8c0d4);
      p.ellipse(12, 17, 7.5, 3, 0x2a5a9a);
      p.ellipse(12, 16.5, 6.5, 2.4, 0x7fd8ff);
      p.ellipse(10, 16, 2.5, 0.8, 0xe8fbff);
      for (const [x, y] of [[4, 7], [19, 5], [12, 2], [7, 11], [17, 10]]) {
        p.set(x, y, 0xd8f4ff);
        p.set(x, y - 1, 0x7fd8ff, 160);
      }
      for (let k = 0; k < 7; k++) p.set(2 + k * 3.2, 16 + (k % 2 ? 2 : -1), 0x6a7388);
      p.outline(0x2a3044);
      break;
    case Deco.SupportBeam:
      // Two posts and a lintel, braced at the corners.
      for (const x of [1, 12]) {
        p.rect(x, 6, 3, 25, 0x8a5a2b);
        p.rect(x, 6, 1, 25, 0xa87442);
        p.rect(x + 2, 6, 1, 25, 0x5c3a1c);
      }
      p.rect(0, 3, 16, 4, 0x9a6634);
      p.rect(0, 3, 16, 1, 0xb88850);
      p.rect(0, 6, 16, 1, 0x5c3a1c);
      for (let k = 0; k < 3; k++) {
        p.set(4 + k, 7 + k, 0x7a4f28);
        p.set(11 - k, 7 + k, 0x7a4f28);
      }
      p.outline();
      break;
    case Deco.Tent: {
      p.ellipse(16, 30, 14, 2, 0x000000, 60);
      for (let y = 6; y < 30; y++) {
        const half = (y - 6) * 0.58;
        p.rect(Math.round(16 - half), y, Math.round(half), 1, y % 6 ? 0xd8c08a : 0xc8ae78);
        p.rect(16, y, Math.round(half), 1, y % 6 ? 0xb89a68 : 0xa8885a);
      }
      // The open flap.
      for (let y = 16; y < 30; y++) p.rect(16, y, Math.round((y - 16) * 0.35), 1, 0x3a2a1a);
      p.rect(15, 3, 2, 4, 0x6b4a2b);
      p.rect(17, 3, 4, 2, 0xc8402c);
      p.outline();
      break;
    }
    case Deco.Treasure:
      p.ellipse(8, 27, 6, 2.5, 0x8a6a45, 200);
      for (let k = -4; k <= 4; k++) {
        p.rect(8 + k, 27 + k * 0.5, 2, 1, 0xc8323e);
        p.rect(8 + k, 27 - k * 0.5, 2, 1, 0xc8323e);
      }
      break;
    case Deco.Meteorite:
      p.shadow(8, 30, 7, 1.5);
      p.ellipse(8, 25.5, 7, 4.5, 0x3a3440);
      p.ellipse(7, 24.5, 5, 3, 0x524a5a);
      for (const [x, y] of [[5, 25], [9, 26], [11, 24], [7, 27]]) p.set(x, y, 0xff9a3a);
      p.set(6, 23, 0xffd27a);
      p.outline(0x1a1420);
      break;
    case Deco.Rift:
      // Frame 0 of the tear; TileRenderer swaps in the others (`riftFrame`).
      riftTear(p, 0);
      break;
    case Deco.RiftScar:
      // A closed rift: a faint, cold scar on the ground.
      p.ellipse(8, 11, 6, 2.5, 0x2a1e38, 120);
      for (let k = -4; k <= 4; k++) p.set(8 + k, 11 + (k % 2), k % 3 ? 0x6a4a98 : 0x8a74a0, 200);
      p.set(5, 9, 0x5af0e8, 160);
      p.set(11, 13, 0x5af0e8, 120);
      break;
    case Deco.ChestOpen:
      p.shadow(8, 30, 6, 1.5);
      p.rect(2, 21, 12, 9, 0x8a5a2b);
      p.rect(3, 22, 10, 4, 0x3a2414);
      p.rect(2, 16, 12, 5, 0xa87442);
      p.rect(2, 20, 12, 1, 0xd4a640);
      p.outline();
      break;
    case Deco.Anvil:
      p.shadow(8, 30, 6, 1.5);
      p.rect(5, 25, 6, 5, 0x6b4a2b);
      p.rect(6, 22, 4, 3, 0x4a4a52);
      p.rect(2, 18, 12, 4, 0x5c5c66);
      p.rect(2, 18, 12, 1, 0x8a8a96);
      p.rect(0, 19, 3, 2, 0x5c5c66);
      p.outline();
      break;
  }
}

// ---------------------------------------------------------------------------
// Item icons (16 x 16)

function rockIcon(p: Painter, base: RGB, fleck?: RGB): void {
  p.ellipse(8, 9, 6, 5, shade(base, 0.75));
  p.ellipse(7.5, 8.5, 5.5, 4.5, base);
  p.ellipse(6, 7, 2, 1.5, shade(base, 1.25));
  if (fleck) for (const [x, y] of [[5, 9], [9, 7], [10, 10], [7, 11]]) p.set(x, y, fleck);
}

function toolIcon(p: Painter, head: RGB, pick: boolean): void {
  for (let k = 0; k < 11; k++) p.rect(3 + k, 13 - k, 2, 1, 0x8a5a2b);
  if (pick) {
    p.rect(5, 3, 9, 2, head);
    p.rect(3, 4, 2, 3, head);
    p.rect(14, 4, 1, 3, head);
    p.rect(5, 3, 9, 1, shade(head, 1.3));
  } else {
    p.rect(9, 2, 5, 5, head);
    p.rect(9, 2, 5, 1, shade(head, 1.3));
    p.rect(13, 3, 1, 4, shade(head, 0.7));
  }
}

function paintItem(p: Painter, icon: number): void {
  switch (icon) {
    case Items.wood.icon:
      p.rect(2, 9, 12, 4, 0x8a5a2b);
      p.rect(3, 5, 12, 4, 0xa06a35);
      p.ellipse(3, 11, 1.5, 2, 0xd9b27a);
      p.ellipse(4, 7, 1.5, 2, 0xd9b27a);
      break;
    case Items.stone.icon:
      rockIcon(p, 0x9a9389);
      break;
    case Items.coal.icon:
      rockIcon(p, 0x34303a, 0x6a6470);
      break;
    case Items.ironOre.icon:
      rockIcon(p, 0x857d74, 0xd08a5a);
      break;
    case Items.goldOre.icon:
      rockIcon(p, 0x857d74, 0xf2c94e);
      break;
    case Items.crystal.icon:
      for (let y = 0; y < 12; y++) p.rect(8 - Math.min(3, y >> 1), 2 + y, Math.min(6, (y >> 1) * 2 + 1), 1, y < 6 ? 0xb9a3f5 : 0x9b7fe0);
      p.rect(7, 4, 1, 6, 0xffffff, 160);
      break;
    case Items.herb.icon:
      p.rect(7, 6, 1, 8, 0x3f7a30);
      for (const [x, y] of [[5, 5], [9, 6], [5, 9], [9, 10], [7, 3]]) p.ellipse(x, y, 2, 1.3, 0x5fae4a);
      break;
    case Items.vegetables.icon:
      p.ellipse(6, 10, 4, 3.5, 0x4f9a4a);
      p.ellipse(5.5, 9.5, 2.8, 2.4, 0x7cc860);
      for (let k = 0; k < 6; k++) p.rect(10 + k * 0.4, 6 + k, 3 - k * 0.4, 1, 0xe8823a);
      p.rect(11, 3, 1, 3, 0x5aab48);
      p.rect(13, 3, 1, 3, 0x5aab48);
      break;
    case Items.berries.icon:
      for (const [x, y] of [[6, 9], [10, 9], [8, 12], [8, 7]]) {
        p.ellipse(x, y, 2.2, 2.2, 0xc8324a);
        p.set(x - 1, y - 1, 0xf08aa0);
      }
      p.ellipse(9, 4, 3, 1.3, 0x4f9a4a);
      break;
    case Items.mushroom.icon:
      p.rect(6, 8, 4, 6, 0xf1e6d0);
      p.ellipse(8, 7, 6, 3.5, 0xc8402f);
      p.set(5, 6, 0xffffff);
      p.set(9, 5, 0xffffff);
      p.set(11, 7, 0xffffff);
      break;
    case Items.cactusFruit.icon:
      p.ellipse(8, 9, 4.5, 5, 0xe0507a);
      p.ellipse(7, 7, 1.5, 2, 0xf08aa0);
      for (const [x, y] of [[6, 10], [9, 8], [10, 11]]) p.set(x, y, 0x7a2040);
      p.rect(7, 2, 2, 3, 0x4f9a4a);
      break;
    case Items.roastMushroom.icon:
      for (let k = 0; k < 10; k++) p.set(3 + k, 13 - k * 0.3, 0x8a5a2b);
      p.ellipse(9, 7, 5, 3, 0x8a4a2a);
      p.rect(8, 9, 2, 3, 0xd8b88a);
      break;
    case Items.stew.icon:
      p.ellipse(8, 10, 7, 4, 0x8a5a2b);
      p.ellipse(8, 8.5, 6, 2.5, 0xa8642e);
      p.set(6, 8, 0x5fae4a);
      p.set(10, 9, 0xe8c050);
      p.rect(7, 2, 1, 3, 0xffffff, 120);
      p.rect(9, 3, 1, 3, 0xffffff, 120);
      break;
    case Items.bandage.icon:
      p.ellipse(8, 9, 6, 4.5, 0xf2ece0);
      p.ellipse(8, 9, 2, 1.5, 0xc9c0b0);
      p.rect(2, 9, 4, 1, 0x7fbf6a);
      break;
    case Items.potion.icon:
      p.rect(7, 2, 2, 3, 0xc9c0b0);
      p.ellipse(8, 10, 5, 4.5, 0xd8323a);
      p.ellipse(6.5, 8.5, 1.5, 1.5, 0xf08a8a);
      break;
    case Items.ironIngot.icon:
      p.rect(3, 7, 10, 5, 0x8a8a96);
      p.rect(4, 6, 8, 1, 0xb8b8c4);
      p.rect(3, 11, 10, 1, 0x5c5c66);
      break;
    case Items.starIngot.icon:
      p.rect(3, 7, 10, 5, 0x6a5aa8);
      p.rect(4, 6, 8, 1, 0xb0a0f0);
      p.rect(3, 11, 10, 1, 0x40306a);
      p.set(6, 8, 0xfff0c0);
      p.set(10, 9, 0xfff0c0);
      break;
    case Items.starAxe.icon:
      toolIcon(p, 0x9f8ff0, false);
      break;
    case Items.starPickaxe.icon:
      toolIcon(p, 0x9f8ff0, true);
      break;
    case Items.schematic.icon:
      // A rolled blueprint, tied with a red cord.
      p.rect(3, 4, 10, 8, 0x5a8ac8);
      p.rect(3, 4, 10, 1, 0x8ab8f0);
      for (let k = 0; k < 3; k++) p.rect(5, 6 + k * 2, 6 - k, 1, 0xd8f4ff);
      p.ellipse(3, 8, 1.5, 4, 0x3a6aa8);
      p.ellipse(13, 8, 1.5, 4, 0x3a6aa8);
      p.rect(7, 4, 1, 8, 0xc8402c);
      break;
    case Items.riftShard.icon:
      for (let y = 0; y < 12; y++) {
        const half = y < 5 ? y * 0.7 : (11 - y) * 0.55;
        p.rect(Math.round(8 - half), 2 + y, Math.max(1, Math.round(half * 2)), 1, y < 5 ? 0x9ff8f2 : 0x3ac8d8);
      }
      p.set(7, 5, 0xffffff);
      p.set(4, 8, 0xff6ab8, 220);
      p.set(11, 10, 0xb07aff, 220);
      break;
    case Items.riftTonic.icon:
      p.rect(7, 2, 2, 3, 0xc9c0b0);
      p.ellipse(8, 10, 5, 4.5, 0x8a5ac8);
      p.ellipse(8, 10.5, 2, 2, 0x5af0e8);
      p.ellipse(6.5, 8.5, 1.5, 1.5, 0xe8d0ff);
      break;
    case Items.frostDraught.icon:
      p.rect(7, 2, 2, 3, 0xc9c0b0);
      p.ellipse(8, 10, 5, 4.5, 0x7fc8e8);
      p.ellipse(6.5, 8.5, 1.5, 1.5, 0xe0f6ff);
      break;
    case Items.stoneAxe.icon:
      toolIcon(p, 0x9a9389, false);
      break;
    case Items.stonePickaxe.icon:
      toolIcon(p, 0x9a9389, true);
      break;
    case Items.ironAxe.icon:
      toolIcon(p, 0xc4c4d0, false);
      break;
    case Items.ironPickaxe.icon:
      toolIcon(p, 0xc4c4d0, true);
      break;
    case Items.gem.icon:
      for (let y = 0; y < 10; y++) {
        const half = y < 3 ? 3 + y : 6 - (y - 3) * 0.85;
        p.rect(Math.round(8 - half), 3 + y, Math.max(1, Math.round(half * 2)), 1, y < 3 ? 0x7fd0f8 : 0x3a8fd8);
      }
      p.set(6, 5, 0xffffff);
      break;
    case Items.idol.icon:
      p.rect(5, 12, 6, 2, 0xb8902a);
      p.rect(6, 6, 4, 6, 0xe8c050);
      p.ellipse(8, 4.5, 2.5, 2.5, 0xe8c050);
      p.rect(4, 7, 2, 3, 0xd4a640);
      p.rect(10, 7, 2, 3, 0xd4a640);
      p.set(7, 4, 0x6a4a10);
      p.set(9, 4, 0x6a4a10);
      break;
    case Items.woodenSword.icon:
    case Items.ironSword.icon:
    case Items.starSword.icon:
    case Items.frostBlade.icon:
    case Items.venomBlade.icon:
    case Items.spiritBlade.icon:
    case Items.riftBlade.icon: {
      const blades: Record<number, RGB> = {
        [Items.woodenSword.icon]: 0xb8864e,
        [Items.ironSword.icon]: 0xd0d0dc,
        [Items.starSword.icon]: 0xa898f8,
        [Items.frostBlade.icon]: 0x9fdcf8,
        [Items.venomBlade.icon]: 0x8ad05a,
        [Items.spiritBlade.icon]: 0xe8f4ff,
        [Items.riftBlade.icon]: 0x9a7aff,
      };
      const blade = blades[icon];
      for (let k = 0; k < 9; k++) p.rect(5 + k, 10 - k, 2, 2, blade);
      for (let k = 0; k < 8; k++) p.set(6 + k, 9 - k, shade(blade, 1.25));
      p.rect(3, 10, 5, 2, 0x6b4a2b);
      p.rect(2, 12, 2, 2, 0x5a3a22);
      p.rect(4, 8, 2, 5, 0x8a6a42);
      // Rift shards set along the blade, fringed with a glitch.
      if (icon === Items.riftBlade.icon) {
        for (const k of [2, 5, 8]) p.set(6 + k, 10 - k, 0x5af0e8);
        p.set(12, 2, 0xff6ab8);
      }
      break;
    }
    case Items.bow.icon:
    case Items.crystalBow.icon: {
      const crystal = icon === Items.crystalBow.icon;
      for (let k = 0; k <= 12; k++) p.set(4 + Math.sin((k / 12) * Math.PI) * 6, 2 + k, crystal ? 0x5a8ac8 : 0x8a5a2b);
      for (let k = 0; k <= 12; k++) p.set(5 + Math.sin((k / 12) * Math.PI) * 6, 2 + k, crystal ? 0x9fdcf8 : 0xa87442);
      p.rect(4, 2, 1, 13, 0xf2ece0);
      if (crystal) p.rect(10, 7, 2, 3, 0xd8f4ff);
      break;
    }
    case Items.arrow.icon:
      for (let k = 0; k < 10; k++) p.set(3 + k, 12 - k, 0x8a5a2b);
      p.rect(12, 2, 2, 2, 0xb8b8c4);
      p.rect(2, 12, 2, 1, 0xd8402c);
      p.rect(3, 13, 1, 1, 0xd8402c);
      break;
    case Items.leatherArmor.icon:
    case Items.ironArmor.icon:
    case Items.starArmor.icon: {
      const c = icon === Items.starArmor.icon ? STAR_PLATE : icon === Items.ironArmor.icon ? 0xa8a8b4 : 0x9a6a3e;
      p.rect(4, 4, 8, 10, c);
      p.rect(2, 4, 3, 4, c);
      p.rect(11, 4, 3, 4, c);
      p.rect(6, 4, 4, 2, 0x3a2414);
      p.rect(4, 4, 2, 10, shade(c, 1.2));
      p.rect(4, 9, 8, 1, shade(c, 0.75));
      break;
    }
    case Items.leatherCap.icon:
    case Items.ironHelmet.icon:
    case Items.starHelmet.icon: {
      const iron = icon !== Items.leatherCap.icon;
      const c = icon === Items.starHelmet.icon ? STAR_PLATE : iron ? 0xa4a8b4 : 0x8a5a2b;
      p.ellipse(8, 8, 6, 5, c);
      p.rect(2, 8, 12, 3, c);
      p.ellipse(6, 6, 2.5, 2, shade(c, 1.3));
      p.rect(2, 10, 12, 1, shade(c, 0.7));
      if (iron) {
        p.rect(3, 11, 2, 3, c);
        p.rect(11, 11, 2, 3, c);
        p.rect(7, 11, 2, 3, c);
        p.rect(7, 2, 2, 2, 0xb8323a);
      }
      break;
    }
    case Items.leatherPants.icon:
    case Items.ironGreaves.icon:
    case Items.starGreaves.icon: {
      const c = icon === Items.starGreaves.icon ? STAR_PLATE : icon === Items.ironGreaves.icon ? 0xa4a8b4 : 0x8a5a2b;
      p.rect(4, 2, 8, 4, c);
      p.rect(4, 6, 3, 9, c);
      p.rect(9, 6, 3, 9, c);
      p.rect(4, 2, 8, 1, shade(c, 1.3));
      p.rect(4, 6, 1, 9, shade(c, 1.2));
      p.rect(9, 6, 1, 9, shade(c, 1.2));
      p.rect(4, 3, 8, 1, shade(c, 0.7));
      break;
    }
    case Items.leatherBoots.icon:
    case Items.ironBoots.icon:
    case Items.starBoots.icon: {
      const c = icon === Items.starBoots.icon ? STAR_PLATE : icon === Items.ironBoots.icon ? 0xa4a8b4 : 0x8a5a2b;
      for (const x of [2, 9]) {
        p.rect(x, 4, 4, 8, c);
        p.rect(x, 10, 6, 3, c);
        p.rect(x, 4, 1, 8, shade(c, 1.25));
        p.rect(x, 12, 6, 1, shade(c, 0.55));
      }
      break;
    }
    case Items.woodenShield.icon:
    case Items.ironShield.icon:
    case Items.chitinShield.icon: {
      const iron = icon === Items.ironShield.icon;
      const face = iron ? 0xa4a8b4 : icon === Items.chitinShield.icon ? 0xc8a060 : 0x9a6634;
      // A heater shield: straight top, rounded to a point below.
      for (let y = 1; y < 15; y++) {
        const half = y < 8 ? 6 : Math.max(0, 6 - (y - 8) * 0.9);
        p.rect(Math.round(8 - half), y, Math.round(half * 2), 1, face);
      }
      p.rect(2, 1, 1, 7, shade(face, 1.3));
      if (iron) {
        p.rect(7, 2, 2, 11, 0xb8323a);
        p.rect(3, 6, 10, 2, 0xb8323a);
      } else {
        for (let x = 4; x < 13; x += 3) p.rect(x, 1, 1, 12, shade(face, 0.75));
        p.rect(2, 4, 12, 1, 0x5c5c66);
        p.ellipse(8, 7, 1.5, 1.5, 0x8a8a96);
      }
      break;
    }
    case Items.rawMeat.icon:
    case Items.cookedMeat.icon: {
      const cooked = icon === Items.cookedMeat.icon;
      p.rect(10, 9, 4, 2, 0xefe8d8);
      p.ellipse(7, 8, 5, 4, cooked ? 0x9a5a2e : 0xd8606a);
      p.ellipse(6, 7, 2.5, 1.5, cooked ? 0xc07a42 : 0xf09aa0);
      break;
    }
    case Items.hide.icon:
      p.ellipse(8, 8, 6, 5, 0x9a6a3e);
      p.rect(2, 4, 2, 2, 0x9a6a3e);
      p.rect(12, 11, 2, 2, 0x9a6a3e);
      p.ellipse(7, 7, 3, 2, 0xb8845a);
      break;
    case Items.silk.icon:
      p.ellipse(8, 8, 5, 5, 0xf2f2f8);
      for (let k = 0; k < 4; k++) p.rect(4, 5 + k * 2, 8, 1, 0xd0d0dc);
      break;
    case Items.chitin.icon:
      p.ellipse(8, 8, 6, 4.5, 0xc8a060);
      p.rect(3, 7, 10, 1, 0x9a7440);
      p.ellipse(7, 6, 3, 1.5, 0xe0bc80);
      break;
    case Items.venom.icon:
      p.ellipse(8, 9, 4.5, 5, 0x7ac83a);
      p.ellipse(7, 8, 2, 2, 0xb8f07a);
      p.rect(7, 2, 2, 3, 0x5a8a2a);
      break;
    case Items.iceShard.icon:
      for (let y = 0; y < 12; y++) {
        const half = y < 6 ? y * 0.5 + 0.5 : (12 - y) * 0.5;
        p.rect(Math.round(8 - half), 2 + y, Math.max(1, Math.round(half * 2)), 1, y < 6 ? 0xd8f4ff : 0x7fc8e8);
      }
      break;
    case Items.bone.icon:
      for (let k = 0; k < 9; k++) p.rect(4 + k, 11 - k, 2, 2, 0xefe8d8);
      for (const [x, y] of [[3, 11], [4, 13], [12, 2], [14, 4]]) p.ellipse(x, y, 1.5, 1.5, 0xefe8d8);
      break;
    case Items.coin.icon:
      p.ellipse(8, 8, 5, 5, 0xe8c050);
      p.ellipse(8, 8, 3, 3, 0xd4a640);
      p.rect(7, 6, 2, 4, 0xf6e08a);
      break;
    case Items.torch.icon:
      for (let k = 0; k < 9; k++) p.rect(5 + k * 0.5, 14 - k, 2, 1, 0x8a5a2b);
      p.ellipse(10, 4.5, 2.5, 3.5, 0xe86a2c);
      p.ellipse(10, 5, 1.2, 2, 0xf6c445);
      break;
    case Items.lantern.icon:
      lanternIcon(p, 0x5c5c66, 0xf6c445, 0xfff0a0);
      break;
    case Items.wanderersLantern.icon:
      lanternIcon(p, 0x8a6a3a, 0x4ab8f0, 0xd8f4ff);
      break;
    case Items.spiritEssence.icon:
      p.ellipse(8, 9, 4, 5, 0xbfe8ff, 200);
      p.ellipse(8, 9, 2, 3, 0xffffff);
      p.rect(7, 2, 2, 3, 0xbfe8ff, 160);
      break;
    case Items.starMetal.icon:
      rockIcon(p, 0x524a5a, 0xff9a3a);
      p.set(6, 6, 0xffd27a);
      break;
    case Items.antidote.icon:
      p.rect(7, 2, 2, 3, 0xc9c0b0);
      p.ellipse(8, 10, 5, 4.5, 0x5ac85a);
      p.ellipse(6.5, 8.5, 1.5, 1.5, 0xb8f0b8);
      break;
  }
  p.outline();
}

/** A lantern: a ring handle, a cap, a glass case around a flame, and a base. */
function lanternIcon(p: Painter, metal: RGB, glow: RGB, core: RGB): void {
  const dark = shade(metal, 0.7);
  for (const [x, y] of [[6, 0], [7, 0], [8, 0], [9, 0], [5, 1], [10, 1], [5, 2], [10, 2]]) p.set(x, y, dark);
  p.rect(6, 3, 4, 1, metal);
  p.rect(5, 4, 6, 1, shade(metal, 1.25));
  p.rect(5, 5, 6, 7, glow);
  p.rect(6, 5, 1, 7, shade(glow, 1.2));
  p.ellipse(8, 8.5, 1.5, 2.2, core);
  p.set(8, 6, core);
  p.rect(5, 5, 1, 7, dark);
  p.rect(10, 5, 1, 7, dark);
  p.rect(4, 12, 8, 1, shade(metal, 1.25));
  p.rect(4, 13, 8, 1, metal);
  p.rect(5, 14, 6, 1, dark);
}

// ---------------------------------------------------------------------------
// Creatures (facing right; the renderer mirrors them) and projectiles

function legs(p: Painter, xs: number[], top: number, bottom: number, w: number, color: RGB, frame: number): void {
  xs.forEach((x, i) => {
    const lift = frame === 1 && i % 2 === 0 ? 1 : 0;
    p.rect(x, top, w, bottom - top - lift, color);
  });
}

function wolf(p: Painter, f: number): void {
  p.ellipse(12, 15, 9, 1.5, 0x000000, 60);
  for (let k = 0; k < 4; k++) p.rect(2 + k, 6 + k * 0.6, 2, 2, 0x6a6f78);
  legs(p, [6, 9, 14, 17], 11, 15, 2, 0x5a5f68, f);
  p.ellipse(11, 9, 7, 3.5, 0x8a8f99);
  p.ellipse(11, 7.5, 6, 1.5, 0x6a6f78);
  p.rect(7, 11, 9, 1, 0xb8bcc4);
  p.ellipse(18, 7, 3.5, 3, 0x8a8f99);
  p.rect(20, 7, 3, 2, 0x9aa0aa);
  p.rect(16, 3, 2, 2, 0x5a5f68);
  p.rect(18, 2, 2, 3, 0x5a5f68);
  p.set(19, 6, 0xf2c94e);
  p.set(22, 7, 0x1a1a1e);
  p.outline(0x24242a);
}

function bear(p: Painter, f: number): void {
  p.ellipse(16, 23, 13, 1.5, 0x000000, 60);
  legs(p, [6, 11, 19, 24], 17, 23, 4, 0x5c3a20, f);
  p.ellipse(15, 13, 11, 7, 0x7a4f2e);
  p.ellipse(13, 9, 8, 3, 0x96643c);
  p.ellipse(26, 11, 5, 4.5, 0x7a4f2e);
  p.ellipse(23.5, 6.5, 1.8, 1.8, 0x5c3a20);
  p.ellipse(27.5, 6.5, 1.8, 1.8, 0x5c3a20);
  p.ellipse(29.5, 12, 2.5, 2, 0xa87a52);
  p.set(31, 11, 0x1a1210);
  p.set(26, 10, 0x1a1210);
  p.outline(0x2a1a10);
}

function spider(p: Painter, f: number): void {
  p.ellipse(10, 15, 8, 1, 0x000000, 60);
  for (let i = 0; i < 4; i++) {
    const knee = 5 + (f === 1 && i % 2 ? 1 : 0);
    const footX = 2 + i * 5;
    for (let k = 0; k <= 4; k++) p.set(10 + (footX - 10) * (k / 8), 10 - (10 - knee) * (k / 4), 0x2a1e2a);
    for (let k = 0; k <= 5; k++) p.set(10 + (footX - 10) * (0.5 + k / 10), knee + (15 - knee) * (k / 5), 0x2a1e2a);
  }
  p.ellipse(7, 9, 5, 4, 0x3a2a3a);
  p.rect(6, 7, 2, 3, 0xc8323e);
  p.ellipse(13, 10, 3, 2.5, 0x4a3a4a);
  p.set(15, 9, 0xff4040);
  p.set(14, 9, 0xff4040);
  p.outline(0x140c14);
}

function scorpion(p: Painter, f: number): void {
  p.ellipse(12, 15, 10, 1.2, 0x000000, 60);
  legs(p, [8, 11, 14], 12, 15, 1, 0x7a5a30, f);
  for (let k = 0; k < 4; k++) p.ellipse(8 + k * 2.5, 11, 2.5, 2, k % 2 ? 0xb88c50 : 0xc8a060);
  // Tail arching over the back to a stinger.
  for (let k = 0; k <= 8; k++) {
    const a = Math.PI * (0.9 - k * 0.11);
    p.ellipse(9 + Math.cos(a) * 5, 9 - Math.sin(a) * 6, 1.4, 1.4, k % 2 ? 0xb88c50 : 0xc8a060);
  }
  p.rect(12, 2, 2, 2, 0x8a2020);
  p.ellipse(19, 10, 2.2, 1.6, 0xc8a060);
  p.rect(21, 8, 2, 1, 0xb88c50);
  p.rect(21, 11, 2, 1, 0xb88c50);
  p.set(16, 10, 0x1a1210);
  p.outline(0x3a2410);
}

function lurker(p: Painter, f: number, buried: boolean): void {
  p.ellipse(12, 17, 10, 3, 0xc9a062);
  p.ellipse(12, 16.5, 9, 2.2, 0xdcb677);
  for (const [x, y] of [[6, 16], [16, 17], [11, 15]]) p.set(x, y, 0xa8824c);
  if (!buried) {
    const sway = f === 1 ? 1 : 0;
    for (let y = 4; y < 16; y++) {
      const x = 10 + Math.round(Math.sin(y * 0.5) * 1.2) + (y < 9 ? sway : 0);
      p.rect(x, y, 5, 1, y % 3 ? 0x8a6a4a : 0x6e523a);
      p.set(x, y, 0xa8865e);
    }
    p.rect(10 + sway, 3, 5, 2, 0x5a3a2a);
    p.set(11 + sway, 3, 0xffffff);
    p.set(13 + sway, 3, 0xffffff);
    p.set(14 + sway, 6, 0xffd040);
  }
  p.outline(0x4a3418);
}

function golem(p: Painter, f: number): void {
  p.ellipse(10, 27, 8, 1.2, 0x000000, 60);
  const step = f === 1 ? 1 : 0;
  p.rect(6, 20, 3, 7 - step, 0x6aa8c8);
  p.rect(11, 20, 3, 6 + step, 0x6aa8c8);
  p.rect(5, 10, 10, 11, 0x9fd4ea);
  p.rect(5, 10, 3, 11, 0xd8f0fa);
  p.rect(12, 10, 3, 11, 0x6aa8c8);
  p.rect(1, 11, 4, 9, 0x8cc4de);
  p.rect(15, 11, 4, 9, 0x6aa8c8);
  p.rect(6, 3, 8, 7, 0xb8e2f2);
  p.rect(6, 3, 3, 7, 0xe6f6fc);
  p.rect(7, 6, 2, 1, 0x2a6aff);
  p.rect(11, 6, 2, 1, 0x2a6aff);
  p.rect(8, 13, 4, 3, 0xffffff, 150);
  p.outline(0x2a4a64);
}

function skeleton(p: Painter, f: number): void {
  const bone = 0xefe8d8;
  p.ellipse(8, 25, 5, 1, 0x000000, 60);
  const step = f === 1 ? 1 : 0;
  p.rect(6, 17, 1, 8 - step, bone);
  p.rect(9, 17, 1, 7 + step, bone);
  p.rect(5, 16, 6, 1, bone);
  p.rect(7, 8, 1, 9, 0xd8d0bc);
  for (let y = 9; y < 15; y += 2) p.rect(5, y, 5, 1, bone);
  p.rect(3, 9, 1, 6, bone);
  p.rect(11, 9, 1, 6, bone);
  p.rect(5, 2, 6, 6, bone);
  p.rect(6, 4, 1, 2, 0x1a1414);
  p.rect(9, 4, 1, 2, 0x1a1414);
  p.rect(7, 7, 2, 1, 0x8a8070);
  p.outline(0x3a3428);
}

function stag(p: Painter, f: number): void {
  p.ellipse(22, 38, 15, 2, 0x000000, 60);
  legs(p, [13, 17, 27, 31], 27, 38, 2, 0x7a5430, f);
  p.ellipse(22, 22, 13, 7, 0xb8854a);
  p.ellipse(20, 18, 10, 3, 0xd09a5a);
  for (const [x, y] of [[15, 21], [20, 23], [25, 20], [18, 25]]) p.set(x, y, 0xf6ead0);
  for (let k = 0; k < 7; k++) p.rect(31 + k * 0.7, 18 - k, 4, 2, 0xb8854a);
  p.ellipse(38, 10, 4, 3, 0xc8955a);
  p.rect(41, 10, 3, 2, 0xd8a86a);
  p.set(39, 9, 0x1a1210);
  // Glowing antlers.
  const glow = 0xa8f0ff;
  for (const [x0, dir] of [[36, -1], [39, 1]]) {
    for (let k = 0; k < 8; k++) p.set(x0 + dir * k * 0.5, 7 - k, glow);
    p.set(x0 + dir * 2, 3, 0xe8ffff);
    p.rect(x0 + dir * 1, 4, 2, 1, glow);
    p.rect(x0 + dir * 3, 1, 1, 2, glow);
  }
  p.outline(0x3a2410);
}

function guardian(p: Painter, f: number): void {
  p.ellipse(20, 42, 15, 2, 0x000000, 60);
  const step = f === 1 ? 1 : 0;
  p.rect(12, 30, 6, 12 - step, 0x6c645b);
  p.rect(22, 30, 6, 11 + step, 0x6c645b);
  p.rect(10, 12, 20, 19, 0x8d8579);
  p.rect(10, 12, 6, 19, 0xa9a196);
  p.rect(25, 12, 5, 19, 0x6c645b);
  p.rect(2, 13, 8, 17, 0x7d766c);
  p.rect(30, 13, 8, 17, 0x6c645b);
  p.rect(15, 2, 10, 10, 0x9a9389);
  p.rect(17, 6, 2, 2, 0xffb030);
  p.rect(21, 6, 2, 2, 0xffb030);
  p.ellipse(20, 20, 3.5, 3.5, 0xffb030);
  p.ellipse(20, 20, 2, 2, 0xfff0a0);
  for (const [x, y] of [[12, 16], [26, 24], [4, 20], [16, 28]]) p.rect(x, y, 3, 2, 0x5a8a3a);
  for (const [x, y] of [[14, 22], [24, 15]]) p.rect(x, y, 1, 4, 0x4a443c);
  p.outline(0x2a2620);
}

function wraith(p: Painter, f: number): void {
  const bob = f === 1 ? 1 : 0;
  p.ellipse(10, 25, 6, 1.2, 0x000000, 40);
  for (let y = 4; y < 22; y++) {
    const half = Math.min(6, 2 + (y - 4) * 0.4);
    const wisp = y > 18 ? ((y + bob) % 2 ? -1 : 1) : 0;
    p.rect(Math.round(10 - half) + wisp, y - bob, Math.round(half * 2), 1, y < 9 ? 0x5a6a8a : 0x9fb0d0, y > 17 ? 150 : 210);
  }
  p.rect(7, 6 - bob, 6, 4, 0x1a1e2a);
  p.set(8, 7 - bob, 0x7fe8ff);
  p.set(11, 7 - bob, 0x7fe8ff);
  p.outline(0x2a3044);
}

// Wildlife -------------------------------------------------------------------

function rabbit(p: Painter, f: number, fur: RGB, belly: RGB): void {
  const hop = f === 1 ? 1 : 0;
  p.ellipse(8, 13, 5, 1, 0x000000, 60);
  p.ellipse(7, 9 - hop, 4.5, 3, fur);
  p.ellipse(6, 10 - hop, 3, 1.6, belly);
  p.ellipse(2.5, 8 - hop, 1.6, 1.6, 0xffffff);
  p.ellipse(11, 6.5 - hop, 2.6, 2.3, fur);
  p.rect(10, 1 - hop, 1, 4, fur);
  p.rect(12, 1 - hop, 1, 4, shade(fur, 0.85));
  p.set(10, 2 - hop, 0xf0a0a8);
  p.set(12, 6 - hop, 0x1a1210);
  p.set(13.5, 7 - hop, 0xd87080);
  p.rect(4, 11 - hop, 2, 2 + hop, shade(fur, 0.8));
  p.rect(9, 11 - hop, 2, 2 + hop, shade(fur, 0.8));
  p.outline(shade(fur, 0.35));
}

function deer(p: Painter, f: number): void {
  p.ellipse(14, 23, 10, 1.5, 0x000000, 60);
  legs(p, [7, 10, 18, 21], 15, 23, 2, 0x7a5430, f);
  p.ellipse(14, 12, 9, 4.5, 0xa8743e);
  p.ellipse(13, 15, 7, 1.8, 0xe8d0a8);
  p.ellipse(5, 10, 1.5, 1.5, 0xf6ead0);
  for (const [x, y] of [[11, 10], [15, 9], [18, 11], [13, 12]]) p.set(x, y, 0xe8d0a8);
  for (let k = 0; k < 5; k++) p.rect(21 + k * 0.6, 9 - k, 3, 2, 0xa8743e);
  p.ellipse(25, 4, 3, 2.3, 0xb8844a);
  p.rect(26, 4, 2, 2, 0xc8955a);
  p.set(27.5, 4, 0x1a1210);
  p.set(25, 3, 0x1a1210);
  p.rect(23, 1, 1, 2, 0x8a5a2b);
  p.rect(22, 0, 1, 2, 0x8a5a2b);
  p.outline(0x3a2410);
}

function boar(p: Painter, f: number): void {
  p.ellipse(12, 17, 10, 1.4, 0x000000, 60);
  legs(p, [5, 8, 15, 18], 12, 17, 2, 0x3a2a20, f);
  p.ellipse(11, 9, 9, 5, 0x5a4232);
  p.ellipse(10, 6, 7, 2, 0x6e5240);
  for (let x = 4; x < 16; x += 2) p.rect(x, 3 + (x % 4 ? 1 : 0), 1, 2, 0x3a2a20);
  p.ellipse(20, 10, 3.5, 3, 0x5a4232);
  p.rect(22, 10, 2, 3, 0x8a6a58);
  p.set(23, 11, 0x2a1a14);
  p.rect(21, 12, 1, 2, 0xf6ead0);
  p.set(19, 8, 0x1a1210);
  p.rect(18, 6, 2, 2, 0x4a3428);
  p.outline(0x1e140e);
}

function lizard(p: Painter, f: number): void {
  const sway = f === 1 ? 1 : 0;
  p.ellipse(10, 10, 8, 1, 0x000000, 50);
  for (let k = 0; k < 6; k++) p.set(1 + k, 7 + Math.round(Math.sin(k * 0.9 + sway) * 0.8), 0xb8904a);
  p.ellipse(10, 7, 5, 2, 0xc8a050);
  p.ellipse(10, 6.5, 4, 1, 0xd8b868);
  for (const [x, y] of [[8, 6], [11, 6], [13, 7]]) p.set(x, y, 0x8a6a30);
  p.ellipse(16, 6.5, 2.5, 1.6, 0xc8a050);
  p.set(17, 6, 0x1a1210);
  p.rect(7, 8, 1, 2 - sway, 0xa88040);
  p.rect(13, 8, 1, 1 + sway, 0xa88040);
  p.outline(0x4a3418);
}

function goat(p: Painter, f: number): void {
  p.ellipse(11, 21, 8, 1.4, 0x000000, 60);
  legs(p, [5, 8, 14, 17], 14, 21, 2, 0x8a8478, f);
  p.ellipse(11, 11, 8, 4.5, 0xe8e4da);
  p.ellipse(10, 9, 6, 1.6, 0xf6f4ee);
  p.ellipse(3, 9, 1.4, 1.4, 0xd8d2c6);
  for (let k = 0; k < 4; k++) p.rect(17 + k * 0.5, 9 - k, 3, 2, 0xe8e4da);
  p.ellipse(20, 5, 2.6, 2.2, 0xe8e4da);
  p.rect(21, 7, 1, 3, 0xd8d2c6);
  p.set(20.5, 4.5, 0x1a1210);
  // Curled horns.
  for (const [x, y] of [[18, 2], [17, 1], [16, 1], [15, 2], [15, 3]]) p.set(x, y, 0x6a5a48);
  p.outline(0x3a3630);
}

function projectile(p: Painter, kind: number): void {
  switch (kind) {
    case 0: // arrow
      p.rect(2, 8, 11, 1, 0x8a5a2b);
      p.rect(13, 7, 2, 3, 0xb8b8c4);
      p.set(15, 8, 0xb8b8c4);
      p.rect(1, 7, 2, 1, 0xd8402c);
      p.rect(1, 9, 2, 1, 0xd8402c);
      break;
    case 1: // web
      p.ellipse(8, 8, 4, 4, 0xf4f4f8, 220);
      for (const [dx, dy] of [[1, 0], [0, 1], [0.7, 0.7], [-0.7, 0.7]]) {
        for (let k = -6; k <= 6; k++) p.set(8 + dx * k, 8 + dy * k, 0xffffff, 200);
      }
      break;
    case 2: // ice shard
      for (let y = 0; y < 10; y++) {
        const half = y < 5 ? y * 0.6 : (10 - y) * 0.6;
        p.rect(Math.round(8 - half), 3 + y, Math.max(1, Math.round(half * 2)), 1, y < 5 ? 0xd8f4ff : 0x7fc8e8);
      }
      p.outline(0x2a6a8a);
      break;
    case 3: // boulder
      p.ellipse(8, 8, 5, 5, 0x857d74);
      p.ellipse(7, 7, 2.5, 2, 0xa9a196);
      p.outline(0x2a2620);
      break;
    case 4: // rift shard
      p.ellipse(8, 8, 5, 5, RIFT.violet, 70);
      for (let y = 0; y < 9; y++) {
        const half = y < 4 ? y * 0.8 : (8 - y) * 0.8;
        p.rect(Math.round(8 - half), 4 + y, Math.max(1, Math.round(half * 2)), 1, y < 4 ? RIFT.cyanLt : RIFT.cyan);
      }
      p.set(7, 6, 0xffffff);
      p.outline(RIFT.ink);
      break;
  }
}

export const PROJECTILE_KINDS = ['arrow', 'web', 'ice', 'boulder', 'shard'] as const;

/** Frame keys: `<species>:<frame>`, `lurker:buried`, `projectile:<kind>`. */
const CREATURE_FRAMES: Array<[string, number, number, (p: Painter) => void]> = [
  ...[0, 1].flatMap((f): Array<[string, number, number, (p: Painter) => void]> => [
    [`wolf:${f}`, 24, 16, (p) => wolf(p, f)],
    [`bear:${f}`, 32, 24, (p) => bear(p, f)],
    [`spider:${f}`, 20, 16, (p) => spider(p, f)],
    [`scorpion:${f}`, 24, 16, (p) => scorpion(p, f)],
    [`lurker:${f}`, 24, 20, (p) => lurker(p, f, false)],
    [`golem:${f}`, 20, 28, (p) => golem(p, f)],
    [`skeleton:${f}`, 16, 26, (p) => skeleton(p, f)],
    [`stag:${f}`, 48, 40, (p) => stag(p, f)],
    [`guardian:${f}`, 40, 44, (p) => guardian(p, f)],
    [`wraith:${f}`, 20, 26, (p) => wraith(p, f)],
    [`rabbit:${f}`, 16, 14, (p) => rabbit(p, f, 0xa88a6a, 0xe8d8c0)],
    [`hare:${f}`, 16, 14, (p) => rabbit(p, f, 0xf0f2f6, 0xffffff)],
    [`deer:${f}`, 30, 24, (p) => deer(p, f)],
    [`boar:${f}`, 26, 18, (p) => boar(p, f)],
    [`lizard:${f}`, 20, 11, (p) => lizard(p, f)],
    [`goat:${f}`, 24, 22, (p) => goat(p, f)],
  ]),
  ['lurker:buried', 24, 20, (p) => lurker(p, 0, true)],
  ...[0, 1].flatMap((f): Array<[string, number, number, (p: Painter) => void]> => [
    [`glitchling:${f}`, 20, 16, (p) => glitchling(p, f)],
    [`shard-wisp:${f}`, 16, 24, (p) => shardWisp(p, f)],
    [`rift-warden:${f}`, 40, 48, (p) => riftWarden(p, f)],
  ]),
  ...PROJECTILE_KINDS.map((k, i): [string, number, number, (p: Painter) => void] => [`projectile:${k}`, 16, 16, (p) => projectile(p, i)]),
];

const CREATURES = shelfPack(
  CREATURE_FRAMES.map(([, w, h]) => [w, h]),
  CREATURE_Y,
);
const CREATURE_INDEX = new Map(CREATURE_FRAMES.map(([key], i) => [key, i]));
/** Armour worn over the human figure: one row of 16 frames (direction × walk
 *  frame) per set and part. Parts: 0 head, 1 chest, 2 legs, 3 feet. */
const ARMOR_Y = CREATURE_Y + CREATURES.height;
export const ARMOR_PARTS = 4;
// ---------------------------------------------------------------------------
// Rift creatures and the outer dimensions: the same warm pixel art, washed in
// violet and cyan, with glitchy colour fringes.

const RIFT = {
  void: 0x120a24,
  nebula: 0x2a1450,
  star: 0x6a4aa8,
  stone: 0x6e5c80,
  stoneLt: 0x8c78a2,
  stoneDk: 0x4e3e60,
  mortar: 0x3a2c4a,
  wall: 0x584870,
  violet: 0xb07aff,
  violetDk: 0x6a3aa8,
  cyan: 0x3ac8d8,
  cyanLt: 0x9ff8f2,
  cyanDk: 0x2a8aa8,
  pink: 0xff6ab8,
  gold: 0xf2c96a,
  ink: 0x1a1030,
};

/** Five-by-five glyphs for plates and mural stones. */
const GLYPHS = [
  ['.###.', '#...#', '#...#', '#...#', '.###.'], // ring
  ['..#..', '.#.#.', '.#.#.', '#...#', '#####'], // triangle
  ['#...#', '.#.#.', '..#..', '.#.#.', '#...#'], // cross
  ['..#..', '.#.#.', '#...#', '.#.#.', '..#..'], // diamond
  ['.##..', '#....', '#....', '#....', '.##..'], // moon
  ['#.#.#', '.###.', '#####', '.###.', '#.#.#'], // star
];

function glyph(p: Painter, g: number, x0: number, y0: number, c: RGB, a = 255): void {
  GLYPHS[g % GLYPHS.length].forEach((row, y) => {
    for (let x = 0; x < 5; x++) if (row[x] === '#') p.set(x0 + x, y0 + y, c, a);
  });
}

/** A soft glow around the opaque pixels of a glyph. */
function glyphGlow(p: Painter, g: number, x0: number, y0: number, c: RGB): void {
  GLYPHS[g % GLYPHS.length].forEach((row, y) => {
    for (let x = 0; x < 5; x++) {
      if (row[x] !== '#') continue;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) p.set(x0 + x + dx, y0 + y + dy, c, 70);
    }
  });
}

function glitchling(p: Painter, f: number): void {
  const hop = f === 1 ? 1 : 0;
  p.ellipse(10, 15, 7, 1.2, 0x000000, 60);
  legs(p, [5, 8, 12, 15], 11, 15, 1, 0x4a2a80, f);
  p.ellipse(9, 9 - hop, 6, 3.6, 0x7a4ab8);
  p.ellipse(8.5, 7.5 - hop, 5, 1.6, 0x9a6ad8);
  p.rect(5, 11 - hop, 8, 1, 0x5a2a90);
  // Jagged spines along the back.
  for (const x of [4, 7, 10]) p.rect(x, 4 - hop, 1, 2, 0x5a2a90);
  p.ellipse(15.5, 8 - hop, 3.4, 3, 0x8a5ac8);
  p.rect(16, 3 - hop, 1, 3, 0x5a2a90);
  p.rect(18, 4 - hop, 1, 2, 0x5a2a90);
  p.set(16, 7 - hop, RIFT.cyanLt);
  p.set(18, 7 - hop, RIFT.cyanLt);
  p.rect(17, 10 - hop, 2, 1, 0x2a1030);
  p.outline(RIFT.ink);
  // A glitch: a slice of the body slips sideways, fringed pink and cyan.
  const row = f === 1 ? 6 : 9;
  for (let x = 3; x < 13; x += 3) {
    p.set(x - 1, row - hop, RIFT.pink, 200);
    p.set(x + 1, row - hop + 1, RIFT.cyan, 200);
  }
}

function shardWisp(p: Painter, f: number): void {
  const bob = f === 1 ? 1 : 0;
  p.ellipse(8, 22, 4, 1, 0x000000, 50);
  p.ellipse(8, 10 - bob, 7, 7, RIFT.violet, 60);
  // Trailing wisps below the shard.
  for (let y = 15; y < 21; y++) {
    const x = 8 + Math.round(Math.sin((y + f * 2) * 0.9) * 1.5);
    p.rect(x - 1, y - bob, 2, 1, y % 2 ? RIFT.violet : RIFT.violetDk, 200 - (y - 15) * 25);
  }
  for (let y = 0; y < 13; y++) {
    const half = y < 5 ? y * 0.8 : (12 - y) * 0.45;
    const x0 = Math.round(8 - half);
    const w = Math.max(1, Math.round(half * 2));
    p.rect(x0, 3 + y - bob, w, 1, y < 5 ? RIFT.cyanLt : RIFT.cyan);
    p.rect(x0 + w - 1, 3 + y - bob, 1, 1, RIFT.cyanDk);
  }
  p.set(7, 6 - bob, 0xffffff);
  p.set(7, 7 - bob, 0xffffff);
  p.outline(0x1a3a4a);
  p.set(4 + f * 7, 9 - bob, RIFT.pink, 220);
}

function riftWarden(p: Painter, f: number): void {
  const sway = f === 1 ? 1 : 0;
  p.ellipse(20, 46, 13, 2, 0x000000, 70);
  // The robe, widening to a ragged hem.
  for (let y = 16; y < 45; y++) {
    const half = 7 + (y - 16) * 0.2;
    const hem = y > 41 ? ((y + sway) % 2 ? 1 : -1) : 0;
    p.rect(Math.round(20 - half) + hem, y, Math.round(half * 2), 1, y < 22 ? 0x4e3474 : 0x3a2458);
    p.rect(Math.round(20 - half) + hem, y, 3, 1, 0x5e4488);
    p.rect(Math.round(20 + half) - 3 + hem, y, 3, 1, 0x2a1840);
  }
  // Arms ending in crystal claws.
  for (const side of [-1, 1]) {
    const x = 20 + side * 11 - (side < 0 ? 3 : 0);
    p.rect(x, 20 + sway, 3, 14, 0x34204e);
    p.rect(x, 34 + sway, 1, 3, RIFT.cyanLt);
    p.rect(x + 1, 34 + sway, 1, 4, RIFT.cyan);
    p.rect(x + 2, 34 + sway, 1, 3, RIFT.cyanLt);
    // Shard pauldrons.
    p.rect(20 + side * 9 - 2, 14, 4, 5, RIFT.cyan);
    p.rect(20 + side * 9 - 2, 14, 2, 3, RIFT.cyanLt);
    p.rect(20 + side * 10 - 1, 11, 2, 3, RIFT.cyan);
  }
  // The hood, an empty face and one eye.
  p.ellipse(20, 10, 6, 6.5, 0x2a1840);
  p.ellipse(20, 11, 3.6, 4, 0x0a0614);
  p.rect(19, 10, 2, 2, RIFT.cyanLt);
  p.set(18, 10, RIFT.cyan, 160);
  p.set(21, 11, RIFT.cyan, 160);
  // A crown of shards.
  for (const [x, h] of [[15, 3], [20, 5], [25, 3]]) {
    p.rect(x - 1, 4 - h, 2, h + 1, RIFT.violet);
    p.set(x - 1, 4 - h, 0xe8d0ff);
  }
  // Its core, the gem it guards the rift with.
  for (let y = 0; y < 7; y++) {
    const half = y < 3 ? y : 6 - y;
    p.rect(20 - half, 23 + y, half * 2 + 1, 1, y < 3 ? 0xff9ad0 : RIFT.pink);
  }
  p.outline(0x140a20);
  for (let y = 23; y < 30; y++) p.set(16 - sway * 2, y, RIFT.pink, 70);
  // Glitch slices across the robe.
  const row = f === 1 ? 31 : 37;
  for (let x = 12; x < 29; x += 4) {
    p.set(x, row, RIFT.pink, 210);
    p.set(x + 2, row + 1, RIFT.cyan, 210);
  }
}

// Dimension tiles ---------------------------------------------------------------

function dimFloor(p: Painter, v: number, rng: Rng): void {
  p.rect(0, 0, 16, 16, RIFT.stone);
  p.speckle(rng, 7, 0x7e6c92);
  p.speckle(rng, 4, 0x625272);
  p.rect(0, 0, 16, 1, 0x52425f);
  p.rect(0, 8, 16, 1, 0x52425f);
  p.rect(v & 1 ? 5 : 11, 0, 1, 8, 0x52425f);
  p.rect(v & 2 ? 3 : 9, 8, 1, 8, 0x52425f);
  p.rect(1, 1, 3, 1, 0x7e6c92);
  if (v === 3) for (let k = 0; k < 3; k++) p.set(rng.int(2, 13), rng.int(10, 14), RIFT.cyan);
}

function dimVoid(p: Painter, v: number, rng: Rng): void {
  p.rect(0, 0, 16, 16, RIFT.void);
  if (v % 2) p.ellipse(rng.int(3, 12), rng.int(3, 12), rng.int(3, 6), rng.int(2, 4), RIFT.nebula, 110);
  p.speckle(rng, 3, RIFT.star);
  if (v >= 2) p.set(rng.int(1, 14), rng.int(1, 14), 0xbff6ff);
}

function dimWallTop(p: Painter, v: number, rng: Rng): void {
  p.rect(0, 0, 16, 16, RIFT.stoneDk);
  for (const [x, y, w, h] of [[0, 0, 7, 7], [7, 0, 9, 6], [0, 7, 9, 9], [9, 6, 7, 10]]) {
    p.rect(x, y, w, h, shade(RIFT.stoneDk, 0.92 + ((x + y + v) % 3) * 0.07));
    p.rect(x, y, w, 1, 0x6e5c80);
    p.rect(x, y + h - 1, w, 1, RIFT.mortar);
  }
  p.speckle(rng, 5, 0x5a4870);
}

function dimWallFace(p: Painter, v: number, rng: Rng): void {
  p.rect(0, 0, 16, 16, RIFT.wall);
  for (let y = 3; y < 15; y += 4) {
    p.rect(0, y + 3, 16, 1, RIFT.mortar);
    const off = (y / 4) % 2 ? 4 : 0;
    for (let x = off; x < 16; x += 8) p.rect(x, y, 1, 4, RIFT.mortar);
  }
  p.rect(0, 0, 16, 3, 0x7a6894);
  p.rect(0, 3, 16, 1, RIFT.mortar);
  p.rect(0, 14, 16, 2, 0x2a1e38);
  // Crystal veins grow in the mortar.
  if (v % 2) {
    const x = rng.int(2, 12);
    p.rect(x, 11, 1, 3, RIFT.cyan);
    p.set(x + 1, 12, RIFT.cyanLt);
    p.set(x - 1, 13, RIFT.cyanDk);
  }
}

/** A floating slab over the void: its face shows below the top. */
function slab(p: Painter, top: RGB, rng: Rng): void {
  p.rect(1, 0, 14, 13, top);
  p.rect(1, 0, 14, 1, shade(top, 1.2));
  p.speckle(rng, 5, shade(top, 0.9));
  p.rect(1, 13, 14, 2, RIFT.stoneDk);
  p.rect(2, 15, 12, 1, RIFT.mortar);
}

function dimCrumble(p: Painter, v: number, rng: Rng): void {
  slab(p, 0x7a6888, rng);
  const crack = 0x3a2c4a;
  if (v >= 1) {
    for (const [x, y] of [[4, 2], [5, 3], [5, 4], [6, 5], [7, 5], [8, 6], [11, 3], [11, 4], [10, 5], [9, 8], [9, 9], [8, 10]]) p.set(x, y, crack);
  }
  if (v >= 2) {
    for (const [x, y] of [[3, 7], [3, 8], [4, 9], [12, 7], [13, 8], [6, 11], [5, 12]]) p.set(x, y, crack);
    // Corners already breaking away.
    for (const [x, y] of [[1, 0], [2, 0], [1, 1], [14, 12], [13, 12], [14, 11], [1, 12], [1, 11]]) p.clear(x, y);
  }
}

function dimGlitch(p: Painter, v: number, rng: Rng): void {
  const base = 0x5e6a90;
  for (let y = 0; y < 15; y++) {
    // Whole, then slipping rows, then a few fragments.
    if (v === 2 && y % 3 !== 0) continue;
    if (v === 1 && y % 5 === 2) continue;
    const shift = v === 0 ? 0 : rng.int(-2, 2);
    const w = v === 2 ? rng.int(4, 9) : 14;
    const x0 = v === 2 ? rng.int(1, 15 - w) : 1;
    p.rect(x0 + shift, y, w, 1, y % 2 ? base : shade(base, 1.12), v === 2 ? 200 : 255);
    if (y % 4 === 1) p.set(x0 + shift, y, RIFT.pink, 220);
    if (y % 4 === 3) p.set(x0 + w - 1 + shift, y, RIFT.cyanLt, 220);
  }
  if (v === 0) {
    p.rect(1, 0, 14, 1, RIFT.cyanLt, 170);
    p.rect(1, 13, 14, 2, 0x3a3e5e);
  }
}

function dimPlate(p: Painter, g: number, rng: Rng, down: boolean): void {
  dimFloor(p, 0, rng);
  if (down) {
    p.ellipse(8, 8.5, 6, 5, 0x4e3e60);
    p.ellipse(8, 8.5, 5, 4, RIFT.stone);
    glyphGlow(p, g, 6, 6, RIFT.cyan);
    glyph(p, g, 6, 6, RIFT.cyanLt);
  } else {
    p.ellipse(8, 9.5, 6, 5, 0x3a2c4a);
    p.ellipse(8, 8, 6, 5, RIFT.stoneLt);
    p.ellipse(7, 6.5, 3.5, 2, 0xa290b8);
    glyph(p, g, 6, 5, RIFT.mortar);
  }
}

function dimCheckpoint(p: Painter, v: number, rng: Rng): void {
  dimFloor(p, 1, rng);
  for (let k = 0; k < 24; k++) {
    const a = (k / 24) * Math.PI * 2;
    p.set(8 + Math.cos(a) * 5.5, 8 + Math.sin(a) * 5, v ? RIFT.cyanLt : RIFT.cyan, v ? 240 : 150);
  }
  p.rect(7, 7, 2, 2, v ? RIFT.cyanLt : RIFT.cyanDk);
}

function dimRune(p: Painter, v: number, rng: Rng): void {
  dimFloor(p, 2, rng);
  const c = RIFT.violet;
  if (v === 0) {
    for (let k = 3; k < 13; k++) p.set(k, 8, c, 200);
    for (let k = 4; k < 12; k++) p.set(8, k, c, 200);
    p.set(5, 5, c);
    p.set(11, 11, c);
  } else {
    for (let k = 0; k < 6; k++) {
      p.set(3 + k, 8 - k, c, 200);
      p.set(8 + k, 3 + k, c, 200);
    }
    p.set(8, 11, c);
  }
}

/** Dimension tile looks: key, cells (variants or frames), painter. */
const DIM_TILES: Array<[string, number, (p: Painter, v: number, rng: Rng) => void]> = [
  ['void', 4, dimVoid],
  ['floor', 4, dimFloor],
  ['wall-top', 4, dimWallTop],
  ['wall-face', 4, dimWallFace],
  ['crumble', 3, dimCrumble],
  ['glitch', 3, dimGlitch],
  ['plate-up', GLYPHS.length, (p, g, rng) => dimPlate(p, g, rng, false)],
  ['plate-down', GLYPHS.length, (p, g, rng) => dimPlate(p, g, rng, true)],
  ['checkpoint', 2, dimCheckpoint],
  ['rune', 2, dimRune],
];

// Dimension props ---------------------------------------------------------------

function dimPillar(p: Painter): void {
  p.shadow(8, 30, 5, 1.5);
  p.rect(5, 8, 6, 20, RIFT.stone);
  p.rect(5, 8, 2, 20, RIFT.stoneLt);
  p.rect(10, 8, 1, 20, RIFT.stoneDk);
  p.rect(4, 5, 8, 3, RIFT.stoneLt);
  p.rect(4, 7, 8, 1, RIFT.stoneDk);
  p.rect(4, 27, 8, 3, RIFT.stoneDk);
  p.rect(4, 27, 8, 1, RIFT.stoneLt);
  p.rect(5, 16, 6, 2, RIFT.cyan);
  p.rect(5, 16, 2, 1, RIFT.cyanLt);
  p.outline(RIFT.ink);
}

function dimCrystal(p: Painter): void {
  p.shadow(8, 30, 6, 1.5);
  p.ellipse(8, 28, 6, 2.5, RIFT.stoneDk);
  const shard = (cx: number, top: number, half: number) => {
    for (let y = top; y < 28; y++) {
      const w = y < top + half ? y - top + 1 : half;
      p.rect(cx - Math.floor(w / 2), y, Math.max(1, Math.floor(w / 2)), 1, RIFT.cyanLt);
      p.rect(cx, y, Math.max(1, Math.ceil(w / 2)), 1, y < top + 3 ? RIFT.cyan : RIFT.cyanDk);
    }
  };
  shard(4, 18, 3);
  shard(12, 15, 3);
  shard(8, 6, 4);
  p.set(7, 10, 0xffffff);
  p.set(7, 11, 0xffffff);
  p.outline(0x1a3a4a);
}

/** A sealed door: an energy curtain under a stone lintel. */
function dimGate(p: Painter, f: number): void {
  for (let y = 6; y < 30; y++) {
    for (let x = 0; x < 16; x++) {
      const streak = (x + f * 2 + Math.floor(y / 3)) % 5 === 0;
      p.set(x, y, streak ? RIFT.cyanLt : (x + y + f) % 2 ? RIFT.violet : RIFT.cyan, streak ? 220 : 120);
    }
  }
  p.rect(0, 2, 16, 4, RIFT.stoneDk);
  p.rect(0, 2, 16, 1, RIFT.stoneLt);
  for (let x = 2; x < 16; x += 5) p.set(x + f, 4, RIFT.cyanLt);
  p.rect(0, 29, 16, 1, RIFT.cyanLt, 200);
}

/** The vault's chest: 0 sealed while the Warden lives, 1 ready, 2 open. */
function dimChest(p: Painter, s: number): void {
  p.shadow(8, 22, 6, 1.5);
  const wood = 0x5a3a6a;
  p.rect(2, 13, 12, 9, wood);
  p.rect(2, 19, 12, 1, RIFT.violet);
  if (s === 2) {
    p.rect(3, 14, 10, 4, 0x1a1030);
    p.rect(4, 14, 8, 2, RIFT.gold, 200);
    p.set(6, 13, 0xffffff);
    p.rect(2, 8, 12, 5, 0x6e4a80);
    p.rect(2, 12, 12, 1, RIFT.violet);
  } else {
    p.rect(2, 13, 12, 3, 0x6e4a80);
    p.rect(2, 16, 12, 1, RIFT.violet);
    p.rect(7, 15, 2, 3, s ? RIFT.cyanLt : RIFT.violetDk);
    if (s === 0) {
      // Chains of light across the lid.
      for (let x = 2; x < 14; x++) p.set(x, 14 + ((x >> 1) % 2), RIFT.pink, 200);
    }
  }
  p.outline(RIFT.ink);
}

/** The portal home: a stone arch, dark while dormant, then swirling (frames 1–3). */
function dimPortal(p: Painter, f: number): void {
  p.shadow(16, 46, 13, 2);
  // The opening.
  if (f === 0) {
    p.ellipse(16, 26, 8, 15, RIFT.void);
    for (const [x, y] of [[13, 20], [18, 28], [15, 34], [19, 17]]) p.set(x, y, RIFT.star);
  } else {
    const rings = [RIFT.violetDk, RIFT.violet, RIFT.cyan, RIFT.cyanLt, 0xffffff];
    for (let k = 0; k < rings.length; k++) {
      const c = rings[(k + f) % rings.length];
      p.ellipse(16, 26, 8 - k * 1.5, 15 - k * 2.8, c, k === rings.length - 1 ? 255 : 230);
    }
    for (let k = 0; k < 6; k++) {
      const a = (k / 6) * Math.PI * 2 + f * 0.7;
      p.set(16 + Math.cos(a) * 6, 26 + Math.sin(a) * 11, 0xffffff, 200);
    }
  }
  // Pillars and the arch.
  for (const x of [3, 25]) {
    p.rect(x, 14, 4, 31, RIFT.stone);
    p.rect(x, 14, 1, 31, RIFT.stoneLt);
    p.rect(x + 3, 14, 1, 31, RIFT.stoneDk);
    p.rect(x - 1, 43, 6, 3, RIFT.stoneDk);
  }
  for (let k = 0; k <= 20; k++) {
    const a = Math.PI * (k / 20);
    const x = 16 - Math.cos(a) * 11;
    const y = 14 - Math.sin(a) * 10;
    p.rect(x - 2, y - 1, 4, 4, k % 4 === 0 ? RIFT.stoneLt : RIFT.stone);
  }
  p.rect(14, 2, 4, 3, f ? RIFT.cyanLt : RIFT.cyanDk);
  p.outline(RIFT.ink);
}

/** The rift the player came in by: a jagged tear of light over the floor. */
function dimRift(p: Painter, f: number): void {
  p.ellipse(16, 28, 10, 2.5, RIFT.violet, 90);
  const xs: number[] = [];
  for (let y = 2; y < 28; y++) xs.push(16 + Math.round(Math.sin(y * 0.7 + f * 1.3) * 2 + (y % 5 === 0 ? (f ? 1 : -1) : 0)));
  xs.forEach((x, i) => {
    const y = 2 + i;
    const w = 1 + Math.round(Math.sin((i / xs.length) * Math.PI) * 3);
    p.rect(x - w - 1, y, w * 2 + 3, 1, RIFT.violet, 120);
    p.rect(x - w, y, w * 2 + 1, 1, RIFT.cyan);
    p.rect(x - Math.floor(w / 2), y, Math.max(1, w), 1, 0xffffff);
  });
  for (const [x, y] of [[9, 8], [23, 14], [11, 21], [22, 5]]) p.set(x + f, y, RIFT.pink, 220);
}

/** An overworld rift, 32 x 48 standing on its tile: a tear hanging in the air
 *  over scorched ground. Three frames, swapped on a timer, never redrawn. */
function riftTear(p: Painter, f: number): void {
  p.ellipse(16, 45, 11, 2.5, RIFT.violetDk, 110);
  p.ellipse(16, 45, 6, 1.4, RIFT.cyan, 120);
  // The tear: a jagged seam, widest in the middle, wobbling per frame.
  for (let y = 4; y < 41; y++) {
    const t = (y - 4) / 37;
    const x = 16 + Math.round(Math.sin(y * 0.55 + f * 2.1) * 1.6 + (y % 6 === f * 2 ? (f % 2 ? 1 : -1) : 0));
    const w = Math.round(Math.sin(t * Math.PI) * 4.5);
    p.rect(x - w - 2, y, w * 2 + 5, 1, RIFT.violet, 90);
    p.rect(x - w - 1, y, w * 2 + 3, 1, RIFT.violetDk, 220);
    p.rect(x - w, y, w * 2 + 1, 1, y % 4 === f ? RIFT.cyanLt : RIFT.cyan);
    if (w > 0) p.rect(x - Math.floor(w / 2), y, Math.max(1, w), 1, 0xffffff);
  }
  // Glitch slices: a row of the tear slips sideways, fringed pink.
  const row = 12 + f * 9;
  p.rect(10 + f, row, 12, 1, RIFT.pink, 200);
  p.rect(12 - f, row + 1, 9, 1, RIFT.cyanLt, 180);
  for (const [x, y] of [[5, 10], [26, 18], [7, 30], [25, 36], [20, 6]]) p.set(x + ((f + y) % 3) - 1, y - f * 2, f === 1 ? RIFT.pink : 0xe8d0ff, 220);
}

/** A mural stone: 0 dark, 1 lit by the hint, 2 done. */
function dimStele(p: Painter, g: number, s: number): void {
  p.shadow(8, 22, 5, 1.5);
  p.rect(3, 5, 10, 16, RIFT.wall);
  p.rect(4, 4, 8, 1, RIFT.wall);
  p.rect(3, 5, 2, 16, 0x7a6894);
  p.rect(12, 5, 1, 16, RIFT.mortar);
  p.rect(2, 19, 12, 3, RIFT.stoneDk);
  p.rect(2, 19, 12, 1, RIFT.stoneLt);
  const c = s === 2 ? RIFT.cyanLt : s === 1 ? RIFT.violet : 0x2a1e38;
  if (s) glyphGlow(p, g, 6, 9, s === 2 ? RIFT.cyan : RIFT.violet);
  glyph(p, g, 6, 9, c);
  p.outline(RIFT.ink);
}

/** Dimension props, drawn standing on their tile: key, size, painter. */
const DIM_PROP_FRAMES: Array<[string, number, number, (p: Painter) => void]> = [
  ['pillar', 16, 32, dimPillar],
  ['crystal', 16, 32, dimCrystal],
  ...[0, 1].map((f): [string, number, number, (p: Painter) => void] => [`gate:${f}`, 16, 32, (p) => dimGate(p, f)]),
  ...[0, 1, 2].map((s): [string, number, number, (p: Painter) => void] => [`chest:${s}`, 16, 24, (p) => dimChest(p, s)]),
  ...[0, 1, 2, 3].map((f): [string, number, number, (p: Painter) => void] => [`portal:${f}`, 32, 48, (p) => dimPortal(p, f)]),
  ...[0, 1].map((f): [string, number, number, (p: Painter) => void] => [`rift:${f}`, 32, 32, (p) => dimRift(p, f)]),
  // The overworld tear's other frames; frame 0 is its decoration cell.
  ...[1, 2].map((f): [string, number, number, (p: Painter) => void] => [`tear:${f}`, 32, 48, (p) => riftTear(p, f)]),
  ...GLYPHS.flatMap((_, g) => [0, 1, 2].map((s): [string, number, number, (p: Painter) => void] => [`glyph:${g}:${s}`, 16, 24, (p) => dimStele(p, g, s)])),
];

/** The outer dimensions' tiles (16 x 16 cells) and props, below the armour. */
const DIM_Y = ARMOR_Y + ARMOR_SETS * ARMOR_PARTS * 32;
const DIM_CELLS = new Map<string, number>();
let dimCellCount = 0;
for (const [key, n] of DIM_TILES) {
  DIM_CELLS.set(key, dimCellCount);
  dimCellCount += n;
}
const DIM_PROPS = shelfPack(
  DIM_PROP_FRAMES.map(([, w, h]) => [w, h]),
  DIM_Y + Math.ceil(dimCellCount / 16) * 16,
);
const DIM_PROP_INDEX = new Map(DIM_PROP_FRAMES.map(([key], i) => [key, i]));
export const ATLAS_H = DIM_Y + Math.ceil(dimCellCount / 16) * 16 + DIM_PROPS.height;

/** Atlas cell of an armour overlay frame. */
export function armorCell(set: number, part: number, dir: number, frame: number): [number, number] {
  return [(dir * 4 + frame) * 16, ARMOR_Y + (set * ARMOR_PARTS + part) * 32];
}

const ARMOR_COLORS = [
  // Leather.
  { base: 0x8a5a2b, light: 0xb07a44, dark: 0x5c3a1c, trim: 0xd8a848 },
  // Iron.
  { base: 0xa4a8b4, light: 0xdadee6, dark: 0x6a6f78, trim: 0x4a4f58 },
  // Starforged: violet plate with gold trim.
  { base: STAR_PLATE, light: 0xb8b0f0, dark: 0x4a4088, trim: 0xe8c050 },
];

/** Paints one armour piece over the human figure (see `paintHuman`). */
function paintArmor(p: Painter, set: number, part: number, dir: number, frame: number): void {
  const { base, light, dark, trim } = ARMOR_COLORS[set];
  const step = frame === 1 ? 1 : frame === 3 ? -1 : 0;
  const side = dir === Dir.Left || dir === Dir.Right;
  // Iron and starforged are plate; leather is soft.
  const iron = set >= 1;
  switch (part) {
    case 0: // Head.
      if (dir === Dir.Up) {
        p.rect(4, 8, 8, iron ? 9 : 5, base);
        p.rect(4, 8, 8, 1, light);
        if (iron) p.rect(4, 15, 8, 1, dark);
      } else {
        p.rect(4, iron ? 8 : 9, 8, iron ? 4 : 3, base);
        p.rect(4, iron ? 8 : 9, 8, 1, light);
        p.rect(4, 11, 8, 1, dark);
        if (iron) {
          // Cheek guards, and a nose guard from the front.
          if (dir === Dir.Down) {
            p.rect(4, 12, 1, 4, base);
            p.rect(11, 12, 1, 4, base);
            p.rect(7, 12, 2, 3, base);
          } else {
            p.rect(dir === Dir.Left ? 10 : 4, 12, 2, 4, base);
            p.rect(dir === Dir.Left ? 5 : 10, 12, 1, 3, base);
          }
          p.set(7, 7, 0xb8323a);
          p.set(8, 7, 0xb8323a);
        }
      }
      break;
    case 1: // Chest.
      p.rect(5, 18, 6, 6, base);
      p.rect(5, 18, 6, 1, light);
      p.rect(5, 23, 6, 1, dark);
      if (iron) p.rect(8, 19, 1, 4, light);
      else p.set(8, 23, trim);
      if (side) {
        const ax = dir === Dir.Left ? 8 + step : 7 - step;
        p.rect(ax, 19, 2, 2, light);
      } else {
        p.rect(4, 18 + step, 1, 3, light);
        p.rect(11, 18 - step, 1, 3, base);
      }
      break;
    case 2: // Legs.
      if (side) {
        p.rect(7 + step, 25, 2, 3, base);
        p.rect(7 - step, 25, 2, 3, dark);
      } else {
        p.rect(6, 25, 2, 3 - Math.max(0, step), base);
        p.rect(9, 25, 2, 3 - Math.max(0, -step), base);
        p.set(6, 25, light);
        p.set(9, 25, light);
      }
      if (iron && !side) {
        p.set(6, 26, light);
        p.set(9, 26, light);
      }
      break;
    case 3: // Feet.
      if (side) {
        p.rect(7 + step, 27, 2, 3, base);
        p.rect(7 - step, 27, 2, 3, dark);
        p.rect(dir === Dir.Left ? 6 + step : 8 + step, 29, 2, 1, dark);
      } else {
        p.rect(6, 27 - Math.max(0, step), 2, 3, base);
        p.rect(9, 27 - Math.max(0, -step), 2, 3, base);
        p.rect(6, 29 - Math.max(0, step), 2, 1, dark);
        p.rect(9, 29 - Math.max(0, -step), 2, 1, dark);
      }
      break;
  }
  p.outline(shade(dark, 0.55));
}

/** Atlas frame for a creature or projectile key, e.g. `wolf:1`. */
export function creatureFrame(key: string): Frame {
  return CREATURES.frames[CREATURE_INDEX.get(key)!];
}

/** Atlas cell of a dimension tile look, e.g. `dimCell('crumble', 2)`. */
export function dimCell(key: string, variant: number): [number, number] {
  const cell = DIM_CELLS.get(key)! + variant;
  return [(cell % 16) * 16, DIM_Y + Math.floor(cell / 16) * 16];
}

/** Atlas frame of a dimension prop, e.g. `portal:2` or `glyph:3:1`. */
export function dimFrame(key: string): Frame {
  return DIM_PROPS.frames[DIM_PROP_INDEX.get(key)!];
}

/** Frames of the overworld rift's animation. */
export const RIFT_FRAMES = 3;

/** Atlas frame `f` of the overworld rift's animation. */
export function riftFrame(f: number): Frame {
  return f === 0 ? decoFrame(Deco.Rift) : dimFrame(`tear:${f}`);
}

// ---------------------------------------------------------------------------
// Player (four directions, four walk frames)

function paintHuman(p: Painter, dir: number, frame: number, o: Outfit): void {
  const { skin, hair, shirt, pants } = o;
  const step = frame === 1 ? 1 : frame === 3 ? -1 : 0;
  p.shadow(8, 30, 5, 1.5);

  // Legs and shoes.
  if (dir === Dir.Left || dir === Dir.Right) {
    p.rect(7 + step, 25, 2, 4, pants);
    p.rect(7 - step, 25, 2, 4, shade(pants, 0.8));
    p.rect(7 + step, 29, 2, 1, 0x4a3020);
    p.rect(7 - step, 29, 2, 1, 0x4a3020);
  } else {
    p.rect(6, 25, 2, 4 - Math.max(0, step), pants);
    p.rect(9, 25, 2, 4 - Math.max(0, -step), pants);
    p.rect(6, 29 - Math.max(0, step), 2, 1, 0x4a3020);
    p.rect(9, 29 - Math.max(0, -step), 2, 1, 0x4a3020);
  }

  // Body and arms.
  p.rect(5, 18, 6, 7, shirt);
  p.rect(5, 18, 6, 1, shade(shirt, 1.2));
  if (dir === Dir.Left || dir === Dir.Right) {
    const ax = dir === Dir.Left ? 8 + step : 7 - step;
    p.rect(ax, 19, 2, 5, shade(shirt, 0.85));
    p.rect(ax, 24, 2, 1, skin);
  } else {
    p.rect(4, 19 + step, 1, 5, shade(shirt, 0.85));
    p.rect(11, 19 - step, 1, 5, shade(shirt, 0.85));
    p.set(4, 24 + step, skin);
    p.set(11, 24 - step, skin);
  }

  // Head.
  p.rect(5, 11, 6, 7, skin);
  p.rect(5, 10, 6, 2, hair);
  if (dir === Dir.Up) {
    p.rect(5, 10, 6, 7, hair);
    p.rect(4, 11, 1, 5, hair);
    p.rect(11, 11, 1, 5, hair);
  } else if (dir === Dir.Down) {
    p.rect(4, 11, 1, 4, hair);
    p.rect(11, 11, 1, 4, hair);
    p.set(6, 14, 0x2a1a10);
    p.set(9, 14, 0x2a1a10);
    p.set(7, 16, 0xd99a7a);
    p.set(8, 16, 0xd99a7a);
  } else {
    const back = dir === Dir.Left ? 10 : 5;
    const eye = dir === Dir.Left ? 6 : 9;
    p.rect(back, 11, 1, 5, hair);
    p.rect(dir === Dir.Left ? 9 : 6, 11, 1, 3, hair);
    p.set(eye, 14, 0x2a1a10);
  }

  // Outfit details.
  if (o.extra === 'apron' && dir !== Dir.Up) p.rect(6, 19, 4, 7, 0xf2ece0);
  if (o.extra === 'robe') {
    p.rect(5, 24, 6, 5, shirt);
    p.rect(4, 8, 8, 2, shade(shirt, 0.8));
    p.rect(6, 6, 4, 2, shade(shirt, 0.8));
    p.set(7, 5, 0xe8c050);
  }
  if (o.extra === 'mask' && dir !== Dir.Up) p.rect(5, 15, 6, 2, 0x1a1414);
  if (o.extra === 'ragged') {
    p.rect(5, 24, 2, 1, shade(shirt, 0.6));
    p.set(10, 23, shade(shirt, 0.7));
    p.set(7, 21, shade(shirt, 0.7));
  }
  p.outline();
}

// ---------------------------------------------------------------------------

export function buildAtlas(): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = ATLAS_W;
  canvas.height = ATLAS_H;
  const ctx = canvas.getContext('2d')!;
  const img = ctx.createImageData(ATLAS_W, ATLAS_H);
  const p = new Painter(img);

  for (let id = 0; id < TILE_COUNT; id++) {
    for (let v = 0; v < TILE_VARIANTS; v++) {
      const cell = id * TILE_VARIANTS + v;
      p.cell((cell % 16) * 16, Math.floor(cell / 16) * 16, 16, 16);
      const rng = new Rng(id * 977 + v * 131 + 7);
      if (id < PALETTE_COUNT * 4) paintGround(p, PALETTES[Math.floor(id / 4)][id % 4], rng);
      else paintShared(p, id, rng, v);
    }
  }
  for (let d = 1; d < DECO_COUNT; d++) {
    const f = DECOS.frames[d];
    p.cell(f.x, f.y, f.w, f.h);
    paintDeco(p, d, new Rng(d * 313));
  }
  for (let dir = 0; dir < 4; dir++) {
    for (let f = 0; f < 4; f++) {
      OUTFIT_NAMES.forEach((name, row) => {
        p.cell((dir * 4 + f) * 16, PLAYER_Y + row * 32, 16, 32);
        paintHuman(p, dir, f, OUTFITS[name]);
      });
    }
  }
  for (const item of ITEM_LIST) {
    p.cell((item.icon % 16) * 16, ITEM_Y + Math.floor(item.icon / 16) * 16, 16, 16);
    paintItem(p, item.icon);
  }
  CREATURE_FRAMES.forEach(([, , , paint], i) => {
    const f = CREATURES.frames[i];
    p.cell(f.x, f.y, f.w, f.h);
    paint(p);
  });
  for (let set = 0; set < ARMOR_SETS; set++) {
    for (let part = 0; part < ARMOR_PARTS; part++) {
      for (let dir = 0; dir < 4; dir++) {
        for (let f = 0; f < 4; f++) {
          const [x, y] = armorCell(set, part, dir, f);
          p.cell(x, y, 16, 32);
          paintArmor(p, set, part, dir, f);
        }
      }
    }
  }
  for (const [key, n, paint] of DIM_TILES) {
    for (let v = 0; v < n; v++) {
      const [x, y] = dimCell(key, v);
      p.cell(x, y, 16, 16);
      paint(p, v, new Rng(DIM_CELLS.get(key)! * 389 + v * 53 + 11));
    }
  }
  DIM_PROP_FRAMES.forEach(([, , , paint], i) => {
    const f = DIM_PROPS.frames[i];
    p.cell(f.x, f.y, f.w, f.h);
    paint(p);
  });
  ctx.putImageData(img, 0, 0);
  return canvas;
}

/** Atlas pixel rectangle of a tile cell. */
export function tileCell(tile: number, variant: number): [number, number] {
  const cell = tile * TILE_VARIANTS + variant;
  return [(cell % 16) * 16, Math.floor(cell / 16) * 16];
}

export function decoFrame(deco: number): Frame {
  return DECOS.frames[deco];
}

export function itemCell(icon: number): [number, number] {
  return [(icon % 16) * 16, ITEM_Y + Math.floor(icon / 16) * 16];
}

/** A human frame; `outfit` defaults to the player's. */
export function playerCell(dir: number, frame: number, outfit = 'player'): [number, number] {
  return [(dir * 4 + frame) * 16, PLAYER_Y + Math.max(0, OUTFIT_NAMES.indexOf(outfit)) * 32];
}
