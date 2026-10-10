// Structures and points of interest (spec 3.3, 3.4, 3.6): definitions, tile
// layouts, and the per-chunk placement roll.

import { CHUNK_SIZE } from '../config';
import { SimplexNoise } from './Noise';
import { Rng, streamRng, Stream } from './Random';
import { TerrainFields } from './TerrainGenerator';
import { BiomeType, Deco, Ground, groundTile, Tile } from './Tiles';
import { difficultyBand, distanceFromOrigin } from './WorldRules';

export const Rarity = { Common: 0, Uncommon: 1, Rare: 2, ExtremelyRare: 3 } as const;
export type Rarity = (typeof Rarity)[keyof typeof Rarity];

export type Persistence = 'temporary' | 'semi-persistent' | 'persistent';

export type BuildingStyle = 'house' | 'cabin' | 'stone' | 'keep' | 'city' | 'mine';

/** A building drawn as one sprite over a solid footprint, with a door to enter. */
export interface BuildingSpec {
  /** Footprint, in tiles from the layout's top-left. */
  x: number;
  y: number;
  w: number;
  h: number;
  /** Door column, counted from the footprint's left edge, in the bottom row. */
  door: number;
  style: BuildingStyle;
  /** Seeds the building's look and its interior. */
  seed: number;
}

/** A stamp over terrain. `tiles` holds tile id + 1 (0 keeps the terrain).
 *  `decos` holds a decoration id, 0 to keep, or Deco.Clear. Setting a tile
 *  also removes the terrain's decoration there. */
export class Layout {
  readonly tiles: Uint8Array;
  readonly decos: Uint8Array;
  buildings: BuildingSpec[] = [];

  constructor(
    readonly w: number,
    readonly h: number,
  ) {
    this.tiles = new Uint8Array(w * h);
    this.decos = new Uint8Array(w * h);
  }

  inside(x: number, y: number): boolean {
    return x >= 0 && y >= 0 && x < this.w && y < this.h;
  }

  tile(x: number, y: number, t: number): void {
    if (this.inside(x, y)) this.tiles[y * this.w + x] = t + 1;
  }

  deco(x: number, y: number, d: number): void {
    if (this.inside(x, y)) this.decos[y * this.w + x] = d;
  }

  tileAt(x: number, y: number): number {
    return this.inside(x, y) ? this.tiles[y * this.w + x] - 1 : -1;
  }

  fill(x: number, y: number, w: number, h: number, t: number): void {
    for (let j = y; j < y + h; j++) for (let i = x; i < x + w; i++) this.tile(i, j, t);
  }

  /** Clears the terrain's decorations from an area, keeping anything the
   *  layout has already placed there. */
  clearDecos(x: number, y: number, w: number, h: number): void {
    for (let j = y; j < y + h; j++) {
      for (let i = x; i < x + w; i++) if (this.inside(i, j) && !this.decos[j * this.w + i]) this.deco(i, j, Deco.Clear);
    }
  }

  border(x: number, y: number, w: number, h: number, t: number, thickness = 1): void {
    this.fill(x, y, w, thickness, t);
    this.fill(x, y + h - thickness, w, thickness, t);
    this.fill(x, y, thickness, h, t);
    this.fill(x + w - thickness, y, thickness, h, t);
  }

  disc(cx: number, cy: number, r: number, t: number): void {
    for (let y = Math.floor(cy - r); y <= Math.ceil(cy + r); y++) {
      for (let x = Math.floor(cx - r); x <= Math.ceil(cx + r); x++) {
        if ((x - cx) ** 2 + (y - cy) ** 2 <= r * r) this.tile(x, y, t);
      }
    }
  }

  /** Copies another layout onto this one at an offset, buildings included. */
  blit(src: Layout, dx: number, dy: number): void {
    for (let y = 0; y < src.h; y++) {
      for (let x = 0; x < src.w; x++) {
        if (!this.inside(x + dx, y + dy)) continue;
        this.tiles[(y + dy) * this.w + x + dx] = src.tiles[y * src.w + x];
        this.decos[(y + dy) * this.w + x + dx] = src.decos[y * src.w + x];
      }
    }
    for (const b of src.buildings) this.buildings.push({ ...b, x: b.x + dx, y: b.y + dy });
  }

  /** Quarter turns clockwise. Buildings only face the camera, so layouts with
   *  buildings never rotate (their definitions say `rotate: false`). */
  rotated(quarters: number): Layout {
    if (this.buildings.length && quarters & 3) throw new Error('Layouts with buildings cannot rotate');
    let out: Layout = this;
    for (let q = 0; q < (quarters & 3); q++) {
      const src = out;
      const next = new Layout(src.h, src.w);
      for (let y = 0; y < src.h; y++) {
        for (let x = 0; x < src.w; x++) {
          const to = x * next.w + (src.h - 1 - y);
          next.tiles[to] = src.tiles[y * src.w + x];
          next.decos[to] = src.decos[y * src.w + x];
        }
      }
      out = next;
    }
    return out;
  }

  mirrored(): Layout {
    const out = new Layout(this.w, this.h);
    for (let y = 0; y < this.h; y++) {
      for (let x = 0; x < this.w; x++) {
        const from = y * this.w + x;
        const to = y * this.w + (this.w - 1 - x);
        out.tiles[to] = this.tiles[from];
        out.decos[to] = this.decos[from];
      }
    }
    out.buildings = this.buildings.map((b) => ({ ...b, x: this.w - b.x - b.w, door: b.w - 1 - b.door }));
    return out;
  }
}

export interface BuildContext {
  rng: Rng;
  palette: number;
  biome: BiomeType;
}

export interface StructureDef {
  kind: string;
  name: string;
  rarity: Rarity;
  weight: number;
  /** Allowed biomes; all when omitted. */
  biomes?: readonly BiomeType[];
  /** Minimum distance from the origin, in tiles. */
  minDistance: number;
  /** Minimum distance between two live structures of this kind, in tiles. */
  spacing: number;
  /** Requires flat, dry ground at the centre. */
  flatGround: boolean;
  /** Free rotation. Buildings only mirror so their fronts face the camera. */
  rotate: boolean;
  persistence: Persistence;
  build(ctx: BuildContext): Layout;
}

export interface Placement {
  id: string;
  /** The anchor chunk and roll slot, the same on every visit. */
  anchor: string;
  def: StructureDef;
  x: number;
  y: number;
  layout: Layout;
}

// ---------------------------------------------------------------------------
// Layout helpers

/** Tile value that leaves the terrain untouched. */
const KEEP = -1;

/** A building over a solid footprint, with a doorstep path outside its door. */
function building(l: Layout, x: number, y: number, w: number, h: number, rng: Rng, style: BuildingStyle = 'house', door = rng.int(1, w - 2)): void {
  // The ground stays as it is under the sprite; an invisible marker makes it solid.
  for (let j = y; j < y + h; j++) for (let i = x; i < x + w; i++) l.deco(i, j, Deco.Footprint);
  l.tile(x + door, y + h, Tile.Path);
  l.buildings.push({ x, y, w, h, door, style, seed: rng.uint() });
}

function areaFree(l: Layout, x: number, y: number, w: number, h: number): boolean {
  for (let j = y; j < y + h; j++) {
    for (let i = x; i < x + w; i++) {
      if (!l.inside(i, j) || l.tileAt(i, j) !== -1) return false;
      const d = l.decos[j * l.w + i];
      if (d && d !== Deco.Clear) return false;
    }
  }
  return true;
}

function scatter(l: Layout, rng: Rng, count: number, deco: number, onTile?: number): void {
  for (let n = 0, tries = 0; n < count && tries < count * 20; tries++) {
    const x = rng.int(0, l.w - 1);
    const y = rng.int(0, l.h - 1);
    const t = l.tileAt(x, y);
    if (onTile !== undefined ? t !== onTile : t < 0) continue;
    if (l.decos[y * l.w + x] !== 0 && l.decos[y * l.w + x] !== Deco.Clear) continue;
    l.deco(x, y, deco);
    n++;
  }
}


function shore(ctx: BuildContext): number {
  return groundTile(ctx.palette, Ground.Shore);
}

// ---------------------------------------------------------------------------
// Layouts

function camp({ rng }: BuildContext): Layout {
  const s = rng.int(7, 9);
  const l = new Layout(s, s);
  const c = (s - 1) / 2;
  l.disc(c, c, c, Tile.Path);
  l.clearDecos(0, 0, s, s);
  l.deco(Math.round(c), Math.round(c), Deco.Campfire);
  l.deco(Math.round(c) + (rng.chance(0.5) ? -2 : 2), Math.round(c) - 2, Deco.Tent);
  scatter(l, rng, rng.int(1, 2), Deco.Barrel, Tile.Path);
  return l;
}

function abandonedCamp({ rng }: BuildContext): Layout {
  const s = rng.int(8, 10);
  const l = new Layout(s, s);
  const c = (s - 1) / 2;
  l.disc(c, c, c, Tile.Path);
  for (let i = 0; i < s; i++) l.tile(rng.int(0, s - 1), rng.int(0, s - 1), Tile.Rubble);
  l.deco(Math.round(c), Math.round(c) - 2, Deco.Tent);
  scatter(l, rng, rng.int(2, 3), Deco.Bones);
  scatter(l, rng, 1, Deco.Barrel);
  if (rng.chance(0.3)) scatter(l, rng, 1, Deco.Chest, Tile.Path);
  return l;
}

function house({ rng }: BuildContext): Layout {
  const w = rng.int(6, 8);
  const h = rng.int(5, 6);
  const l = new Layout(w + 3, h + 2);
  l.clearDecos(0, 0, l.w, l.h);
  building(l, 1, 0, w, h, rng);
  l.tile(w + 1, h - 1, Tile.Path);
  l.deco(w + 1, h - 1, Deco.Barrel);
  return l;
}

function deposit({ rng }: BuildContext): Layout {
  const s = rng.int(6, 8);
  const l = new Layout(s, s);
  const c = (s - 1) / 2;
  l.disc(c, c, c, Tile.Rubble);
  for (let i = 0; i < s; i++) l.tiles[rng.int(0, s * s - 1)] = 0;
  scatter(l, rng, rng.int(3, 6), Deco.Ore, Tile.Rubble);
  scatter(l, rng, rng.int(1, 2), Deco.Stone, Tile.Rubble);
  return l;
}

/** The shell of an old stone hall: walls standing in runs and collapsed in
 *  others, an inner wall, a colonnade, and nature creeping back in. */
function ruins({ rng }: BuildContext): Layout {
  const w = rng.int(12, 18);
  const h = rng.int(10, 15);
  const l = new Layout(w, h);
  l.clearDecos(0, 0, w, h);
  l.fill(0, 0, w, h, Tile.StoneFloor);
  // Overgrown patches where the floor has given way.
  for (let k = rng.int(2, 4); k > 0; k--) l.disc(rng.int(2, w - 3), rng.int(2, h - 3), rng.range(1.2, 2.6), KEEP);

  // Outer walls: standing and collapsed runs, solid at the corners.
  const ring: Array<[number, number]> = [];
  for (let x = 0; x < w; x++) ring.push([x, 0]);
  for (let y = 1; y < h; y++) ring.push([w - 1, y]);
  for (let x = w - 2; x >= 0; x--) ring.push([x, h - 1]);
  for (let y = h - 2; y > 0; y--) ring.push([0, y]);
  let standing = true;
  for (const [x, y] of ring) {
    const corner = (x === 0 || x === w - 1) && (y === 0 || y === h - 1);
    if (!corner && rng.chance(0.16)) standing = !standing;
    if (standing || corner) l.tile(x, y, Tile.StoneWall);
    else {
      l.tile(x, y, Tile.Rubble);
      // Fallen stones spill inward.
      if (rng.chance(0.6)) l.tile(x + (x === 0 ? 1 : x === w - 1 ? -1 : 0), y + (y === 0 ? 1 : y === h - 1 ? -1 : 0), Tile.Rubble);
    }
  }
  // A way in through the south wall.
  const gate = rng.int(2, w - 3);
  l.fill(gate, h - 1, 2, 1, Tile.StoneFloor);

  // An inner wall with a doorway.
  const ix = rng.int(4, w - 5);
  const gap = rng.int(2, h - 3);
  for (let y = 1; y < h - 1; y++) if (Math.abs(y - gap) > 0 && rng.chance(0.75)) l.tile(ix, y, Tile.StoneWall);

  // A colonnade, some columns fallen.
  const row = rng.chance(0.5) ? 2 : h - 3;
  for (let x = 2; x < w - 2; x += 3) {
    if (x === ix) continue;
    if (rng.chance(0.7)) l.deco(x, row, Deco.Pillar);
    else {
      l.tile(x, row, Tile.Rubble);
      l.deco(x, row, Deco.Stone);
    }
  }
  // Nature creeping back in.
  scatter(l, rng, rng.int(2, 4), Deco.Bush, Tile.StoneFloor);
  scatter(l, rng, rng.int(2, 4), Deco.Flowers, Tile.StoneFloor);
  if (rng.chance(0.25)) scatter(l, rng, 1, Deco.Chest, Tile.StoneFloor);
  return l;
}

function tower({ rng }: BuildContext): Layout {
  const r = rng.int(4, 5);
  const s = r * 2 + 1;
  const l = new Layout(s, s + 1);
  l.disc(r, r, r, Tile.StoneWall);
  l.disc(r, r, r - 1.5, Tile.StoneFloor);
  for (let y = r; y <= s; y++) l.tile(r, y, Tile.Path);
  if (rng.chance(0.4)) l.deco(r, r - 1, Deco.Chest);
  return l;
}

export function cabin({ rng }: BuildContext): Layout {
  const w = rng.int(9, 11);
  const h = rng.int(6, 7);
  const l = new Layout(w + 5, h + 2);
  l.clearDecos(0, 0, l.w, l.h);
  building(l, 0, 0, w, h, rng, 'cabin');
  l.fill(w + 1, h - 3, 3, 3, Tile.Path);
  l.deco(w + 2, h - 2, Deco.Barrel);
  if (rng.chance(0.5)) l.deco(w + 3, h - 3, Deco.Barrel);
  if (rng.chance(0.3)) l.deco(w + 3, h - 1, Deco.Chest);
  return l;
}

/** A timber-framed mine entrance cut into a rocky hill, with a yard of rails,
 *  ore and supplies in front. The entrance leads down into the mine. */
function mine({ rng }: BuildContext): Layout {
  const w = 17;
  const h = 14;
  const l = new Layout(w, h);
  const mid = 8;
  // The hill: a ragged mound of rock, darker at its heart.
  const tops = Array.from({ length: w }, () => rng.range(-0.6, 0.6));
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < w; x++) {
      const dx = (x - mid) / 8.4;
      const dy = (y - 3.4) / (4.4 + tops[x]);
      const d = dx * dx + dy * dy;
      if (d < 0.55) l.tile(x, y, Tile.RockDark);
      else if (d < 1) l.tile(x, y, Tile.Rock);
    }
  }
  // The hill runs down to the ground on both sides of the entrance.
  l.fill(mid - 4, 4, 9, 3, Tile.Rock);
  building(l, mid - 2, 4, 5, 3, rng, 'mine', 2);
  // The yard.
  for (let y = 7; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const d = ((x - mid) / 7.2) ** 2 + ((y - 9.5) / 4.2) ** 2;
      if (d < 1 - rng.range(0, 0.15)) l.tile(x, y, rng.chance(0.12) ? Tile.Rubble : Tile.Path);
    }
  }
  l.clearDecos(0, 0, w, h);
  // Rails out of the entrance, with a cart at the end of the line.
  for (let y = 7; y <= 11; y++) l.tile(mid, y, Tile.Rail);
  l.deco(mid, 11, Deco.Minecart);
  // Lamps by the entrance, ore heaps and supplies around the yard.
  l.deco(mid - 2, 7, Deco.Lamp);
  l.deco(mid + 2, 7, Deco.Lamp);
  for (const [x, y] of [[mid - 4, 8], [mid + 4, 9], [mid - 5, 10]]) l.deco(x, y, Deco.Ore);
  l.deco(mid + 4, 7, Deco.Crate);
  l.deco(mid + 5, 8, Deco.Barrel);
  l.deco(mid - 3, 12, Deco.Stone);
  if (rng.chance(0.5)) l.deco(mid + 3, 12, Deco.Crate);
  return l;
}

/** A village laid out along streets. A main street runs right across, through
 *  a cobbled square with the well; a cross street runs north to south, and
 *  back lanes run parallel to the main street. Houses stand in rows facing the
 *  streets, each with a path from its door, and gardens, fences, lamps and
 *  benches fill the gaps. Trees are cleared only where the village needs room. */
export function village({ rng, palette }: BuildContext): Layout {
  const s = rng.int(46, 56);
  const l = new Layout(s, s);
  const m = Math.floor(s / 2);
  const grass = groundTile(palette, Ground.Base);
  // Marks open ground as used, so nothing else is placed there.
  const lawn = (x: number, y: number, d: number) => {
    if (l.tileAt(x, y) !== -1 || !areaFree(l, x, y, 1, 1)) return false;
    l.tile(x, y, grass);
    l.deco(x, y, d);
    return true;
  };

  // Streets.
  l.fill(0, m - 1, s, 2, Tile.Path);
  l.fill(m - 1, 3, 2, s - 6, Tile.Path);
  const streets = [m - 1];
  for (const y of [m - 13, m + 12]) {
    if (y < 9 || y > s - 4) continue;
    const x0 = rng.int(3, 7);
    const x1 = s - rng.int(3, 7);
    l.fill(x0, y, x1 - x0, 2, Tile.Path);
    streets.push(y);
  }
  // The square, cobbled, with the well, an anvil and benches.
  const sq = 4;
  l.fill(m - sq - 1, m - sq - 1, sq * 2 + 2, sq * 2 + 2, Tile.StoneFloor);
  l.border(m - sq - 1, m - sq - 1, sq * 2 + 2, sq * 2 + 2, Tile.Path);
  l.deco(m + 2, m + 2, Deco.Well);
  l.deco(m - 3, m - 3, Deco.Anvil);
  l.deco(m - 3, m + 2, Deco.Bench);
  l.deco(m + 2, m - 3, Deco.Bench);
  for (const [x, y] of [[m - sq - 1, m - sq - 1], [m + sq, m - sq - 1], [m - sq - 1, m + sq], [m + sq, m + sq]]) l.deco(x, y, Deco.Lamp);
  const inSquare = (x: number, y: number) => x >= m - sq - 2 && x <= m + sq + 1 && y >= m - sq - 2 && y <= m + sq + 1;

  // Houses in rows on the north side of each street, doors facing it.
  const doors: number[] = [];
  for (const street of streets) {
    for (let x = rng.int(1, 3); x < s - 6; ) {
      const w = rng.int(6, 8);
      const h = rng.int(5, 6);
      const bottom = street - 3;
      const top = bottom - h + 1;
      const clear = top >= 2 && x + w < s - 1 && !inSquare(x, bottom) && !inSquare(x + w, bottom) && !inSquare(x, top);
      // The cross street, its verge, and room for the path all stay free.
      if (!clear || x + w > m - 3 && x < m + 3 || !areaFree(l, x - 1, top - 1, w + 2, h + 3)) {
        x++;
        continue;
      }
      building(l, x, top, w, h, rng);
      const b = l.buildings[l.buildings.length - 1];
      const dx = x + b.door;
      l.tile(dx, street - 1, Tile.Path);
      doors.push(dx);
      // Room around the house, so trees do not grow into its roof.
      l.clearDecos(x - 1, top - 2, w + 2, h + 2);
      // Flowers by the door, and sometimes a barrel or crate.
      if (rng.chance(0.7)) lawn(dx - 1, street - 2, Deco.Flowers);
      if (rng.chance(0.5)) lawn(dx + 1, street - 2, rng.chance(0.5) ? Deco.Flowers : Deco.Barrel);
      x += w + rng.int(2, 4);
    }
  }

  // Lamps along the main street, between the doors.
  for (let x = 3; x < s - 3; x += 7) {
    if (Math.abs(x - m) < sq + 3 || doors.some((d) => Math.abs(d - x) < 2)) continue;
    lawn(x, m - 2, Deco.Lamp) || lawn(x, m + 1, Deco.Lamp);
  }
  for (let y = 5; y < s - 5; y += 8) if (!inSquare(m, y)) lawn(m + 1, y, Deco.Lamp);

  // Fenced gardens wherever there is room, with rows of vegetables.
  for (let n = 0, tries = 0; n < rng.int(3, 5) && tries < 200; tries++) {
    const w = rng.int(4, 6);
    const h = 3;
    const x = rng.int(2, s - w - 2);
    const y = rng.int(3, s - h - 3);
    if (!areaFree(l, x - 1, y - 2, w + 2, h + 4)) continue;
    for (let j = 0; j < h; j++) {
      for (let i = 0; i < w; i++) {
        l.tile(x + i, y + j, Tile.Farmland);
        l.deco(x + i, y + j, j % 2 === 0 ? Deco.Crop : Deco.Clear);
      }
    }
    for (let i = -1; i <= w; i++) {
      lawn(x + i, y - 1, Deco.Fence);
      if (i !== Math.floor(w / 2)) lawn(x + i, y + h, Deco.Fence);
    }
    n++;
  }

  // Streets and the square stay clear of trees.
  for (let y = 0; y < s; y++) {
    for (let x = 0; x < s; x++) if (l.tileAt(x, y) === Tile.Path && !l.decos[y * s + x]) l.deco(x, y, Deco.Clear);
  }
  scatter(l, rng, rng.int(2, 4), Deco.Barrel, Tile.Path);
  if (rng.chance(0.5)) scatter(l, rng, 1, Deco.Chest, Tile.Path);
  return l;
}

function temple(ctx: BuildContext, size: [number, number], ancient: boolean): Layout {
  const { rng } = ctx;
  const s = rng.int(size[0], size[1]);
  const l = new Layout(s, s + 2);
  l.fill(0, 0, s, s, Tile.StoneFloor);
  l.fill(1, 1, s - 2, s - 2, Tile.TempleFloor);
  for (let y = 3; y < s - 3; y += 3) {
    l.deco(3, y, Deco.Pillar);
    l.deco(s - 4, y, Deco.Pillar);
  }
  const m = Math.floor(s / 2);
  l.deco(m, 2, Deco.Statue);
  l.fill(m - 2, s, 4, 2, Tile.Path);
  if (ancient) {
    l.deco(m - 3, 2, Deco.Statue);
    l.deco(m + 3, 2, Deco.Statue);
    l.deco(m, 4, Deco.Chest);
    for (let i = 0; i < s; i++) l.tile(rng.int(1, s - 2), rng.int(1, s - 2), Tile.Rubble);
  } else if (rng.chance(0.5)) {
    l.deco(m, 4, Deco.Chest);
  }
  return l;
}

/** A castle: a moat crossed by a drawbridge, a curtain wall with round
 *  towers at the corners and flanking the gatehouse, and inside, a courtyard
 *  with the keep at its head, barracks, a training yard, a smithy, a stable,
 *  a garden, lamps and banners. */
function castle({ rng, palette }: BuildContext): Layout {
  const s = rng.int(66, 76);
  const l = new Layout(s, s);
  const m = Math.floor(s / 2);
  const grass = groundTile(palette, Ground.Base);

  // The moat: shallow at its banks, deep in the middle.
  l.border(0, 0, s, s, Tile.Water, 1);
  l.border(1, 1, s - 2, s - 2, Tile.WaterDeep, 1);
  l.border(2, 2, s - 4, s - 4, Tile.Water, 1);
  // Curtain wall, two thick, and round towers.
  const w0 = 4;
  const inner = s - w0 * 2;
  l.border(w0, w0, inner, inner, Tile.StoneWall, 2);
  for (const [x, y] of [[w0 + 1, w0 + 1], [s - w0 - 2, w0 + 1], [w0 + 1, s - w0 - 2], [s - w0 - 2, s - w0 - 2]]) l.disc(x, y, 3.6, Tile.StoneWall);
  for (const [x, y] of [[w0 + 1, m], [s - w0 - 2, m]]) l.disc(x, y, 2.6, Tile.StoneWall);
  // The gatehouse: two towers flanking the gate, and the drawbridge.
  const gy = s - w0 - 2;
  l.disc(m - 4, gy, 2.8, Tile.StoneWall);
  l.disc(m + 3, gy, 2.8, Tile.StoneWall);
  l.fill(m - 1, gy - 1, 2, 3, Tile.StoneFloor);
  for (let y = gy + 2; y < s; y++) {
    l.tile(m - 1, y, Tile.BridgeV);
    l.tile(m, y, Tile.BridgeV2);
  }
  l.clearDecos(0, 0, s, w0 + 2);
  l.clearDecos(0, s - w0 - 2, s, w0 + 2);
  l.clearDecos(0, 0, w0 + 2, s);
  l.clearDecos(s - w0 - 2, 0, w0 + 2, s);

  // The keep at the head of the courtyard, two floors and a cellar inside.
  const kw = rng.int(9, 11) * 2;
  const kh = 7;
  const ky = w0 + 4;
  const kx = m - kw / 2;
  building(l, kx, ky, kw, kh, rng, 'keep', kw / 2);
  l.clearDecos(kx - 3, ky - 3, kw + 6, kh + 4);
  // The road from the gate to the keep, and a square before its door.
  const road0 = ky + kh + 1;
  l.fill(m - 2, road0, 4, gy - 1 - road0, Tile.StoneFloor);
  l.fill(m - 9, road0, 18, 6, Tile.StoneFloor);
  l.border(m - 9, road0, 18, 6, Tile.Path);
  l.deco(m - 6, road0 + 3, Deco.Well);
  l.deco(m + 5, road0 + 3, Deco.Statue);
  l.deco(m - 3, road0, Deco.Banner);
  l.deco(m + 2, road0, Deco.Banner);
  for (let y = road0 + 7; y < gy - 2; y += 5) {
    l.deco(m - 3, y, Deco.Lamp);
    l.deco(m + 2, y, Deco.Lamp);
  }
  // Banners along the inside of the north wall.
  for (let x = w0 + 6; x < s - w0 - 6; x += 6) if (x < kx - 2 || x > kx + kw + 1) l.deco(x, w0 + 2, Deco.Banner);

  // Barracks on both sides, with paths to the road.
  const by = road0 + 8;
  const bw = rng.int(9, 11);
  for (const bx of [w0 + 4, s - w0 - 4 - bw]) {
    building(l, bx, by, bw, 6, rng, 'stone');
    const b = l.buildings[l.buildings.length - 1];
    const dx = bx + b.door;
    l.clearDecos(bx - 1, by - 2, bw + 2, 9);
    for (let x = Math.min(dx, m - 2); x <= Math.max(dx, m + 1); x++) l.tile(x, by + 7, Tile.Path);
    l.tile(dx, by + 6, Tile.Path);
  }
  // A training yard on the west side: dummies and a weapon rack.
  const ty = by + 10;
  if (ty + 6 < gy - 3) {
    const tx = w0 + 4;
    l.fill(tx, ty, 11, 6, Tile.Path);
    for (let k = 0; k < 3; k++) l.deco(tx + 2 + k * 3, ty + 2, Deco.Dummy);
    l.deco(tx + 1, ty + 4, Deco.WeaponRack);
    l.deco(tx + 9, ty + 4, Deco.ArmorStand);
    // A smithy and a stable on the east side.
    const sx = s - w0 - 15;
    l.fill(sx, ty, 4, 4, Tile.Path);
    l.deco(sx + 1, ty + 1, Deco.Anvil);
    l.deco(sx + 3, ty + 1, Deco.Crate);
    l.deco(sx + 1, ty + 3, Deco.Barrel);
    if (areaFree(l, s - w0 - 10, ty - 1, 8, 8)) {
      building(l, s - w0 - 9, ty, 6, 5, rng, 'cabin');
      l.clearDecos(s - w0 - 10, ty - 2, 8, 8);
    }
  }
  // A walled kitchen garden beside the keep.
  for (const gx of [w0 + 4, s - w0 - 10]) {
    const gy0 = ky + 1;
    if (!areaFree(l, gx - 1, gy0 - 1, 8, 6)) continue;
    for (let j = 0; j < 4; j++) {
      for (let i = 0; i < 6; i++) {
        l.tile(gx + i, gy0 + j, Tile.Farmland);
        l.deco(gx + i, gy0 + j, j % 2 === 0 ? Deco.Crop : Deco.Clear);
      }
    }
    for (let i = -1; i <= 6; i++) {
      if (areaFree(l, gx + i, gy0 - 1, 1, 1)) {
        l.tile(gx + i, gy0 - 1, grass);
        l.deco(gx + i, gy0 - 1, Deco.Fence);
      }
    }
  }
  scatter(l, rng, rng.int(4, 7), Deco.Barrel, Tile.StoneFloor);
  // The courtyard's paved parts stay clear of trees.
  for (let i = 0; i < s * s; i++) {
    const t = l.tiles[i] - 1;
    if ((t === Tile.StoneFloor || t === Tile.Path) && !l.decos[i]) l.decos[i] = Deco.Clear;
  }
  return l;
}

function dungeon({ rng }: BuildContext): Layout {
  const s = rng.int(12, 16);
  const l = new Layout(s, s);
  l.border(0, 0, s, s, Tile.StoneWall);
  l.fill(1, 1, s - 2, s - 2, Tile.DarkFloor);
  const m = Math.floor(s / 2);
  l.fill(m - 1, s - 1, 2, 1, Tile.DarkFloor);
  l.fill(m - 1, m - 1, 2, 2, Tile.Cave);
  for (const [x, y] of [[2, 2], [s - 3, 2], [2, s - 3], [s - 3, s - 3]]) l.deco(x, y, Deco.Pillar);
  l.deco(m + 2, m - 1, Deco.Chest);
  scatter(l, rng, rng.int(2, 4), Deco.Bones, Tile.DarkFloor);
  return l;
}

function city({ rng }: BuildContext, lost: boolean): Layout {
  const s = rng.int(84, 94);
  const l = new Layout(s, s);
  const m = Math.floor(s / 2);
  const step = 14;
  l.clearDecos(0, 0, s, s);
  // City blocks: buildings, or a small park. Blocks under the central plaza stay empty.
  const plaza = (x: number, y: number) => x + step > m - 9 && x < m + 9 && y + step > m - 9 && y < m + 9;
  for (let by = 3; by + step <= s - 2; by += step) {
    for (let bx = 3; bx + step <= s - 2; bx += step) {
      if (plaza(bx, by)) continue;
      if (rng.chance(0.85)) building(l, bx + 2, by + 2, step - 5, step - 6, rng, 'city');
      else for (let n = 0; n < 4; n++) l.deco(bx + rng.int(3, step - 3), by + rng.int(3, step - 3), Deco.Oak);
    }
  }
  for (let p = 2; p < s - 2; p += step) {
    l.fill(p, 2, 3, s - 4, Tile.StoneFloor);
    l.fill(2, p, s - 4, 3, Tile.StoneFloor);
  }
  l.border(0, 0, s, s, Tile.StoneWall, 2);
  for (const [x, y, w, h] of [[m - 2, 0, 4, 2], [m - 2, s - 2, 4, 2], [0, m - 2, 2, 4], [s - 2, m - 2, 2, 4]]) {
    l.fill(x, y, w, h, Tile.StoneFloor);
  }
  l.fill(m - 9, m - 9, 18, 18, Tile.TempleFloor);
  l.clearDecos(m - 9, m - 9, 18, 18);
  l.deco(m, m - 3, Deco.Statue);
  l.deco(m, m + 3, Deco.Well);
  for (const [x, y] of [[m - 6, m - 6], [m + 5, m - 6], [m - 6, m + 5], [m + 5, m + 5]]) l.deco(x, y, Deco.Pillar);
  if (lost) {
    for (let i = 0; i < l.tiles.length; i++) {
      const t = l.tiles[i] - 1;
      if (t === Tile.StoneFloor && rng.chance(0.15)) l.tiles[i] = 0;
    }
    l.buildings = l.buildings.filter((bd) => {
      if (!rng.chance(0.3)) return true;
      l.fill(bd.x, bd.y, bd.w, bd.h, Tile.Rubble);
      for (let y = bd.y; y < bd.y + bd.h; y++) l.decos.fill(0, y * l.w + bd.x, y * l.w + bd.x + bd.w);
      return false;
    });
    scatter(l, rng, 12, Deco.Bones);
    scatter(l, rng, 4, Deco.Chest, Tile.TempleFloor);
  }
  return l;
}

function bossArena({ rng }: BuildContext): Layout {
  const r = rng.int(16, 20);
  const s = r * 2 + 5;
  const c = (s - 1) / 2;
  const l = new Layout(s, s);
  l.disc(c, c, r + 2, Tile.StoneWall);
  l.disc(c, c, r, Tile.DarkFloor);
  for (const [dx, dy] of [[0, 1], [0, -1], [1, 0], [-1, 0]]) {
    for (let k = r - 1; k <= r + 2; k++) {
      for (let w = -1; w <= 1; w++) l.tile(Math.round(c + dx * k + dy * w), Math.round(c + dy * k + dx * w), Tile.DarkFloor);
    }
  }
  for (let a = 0; a < 12; a++) {
    const t = (a / 12) * Math.PI * 2;
    l.deco(Math.round(c + Math.cos(t) * (r - 3)), Math.round(c + Math.sin(t) * (r - 3)), Deco.Pillar);
  }
  l.deco(Math.round(c), Math.round(c), Deco.Statue);
  scatter(l, rng, 10, Deco.Bones, Tile.DarkFloor);
  return l;
}

function standingStones({ rng }: BuildContext, crystal: boolean): Layout {
  const r = rng.int(8, 10);
  const s = r * 2 + 3;
  const c = (s - 1) / 2;
  const l = new Layout(s, s);
  l.clearDecos(0, 0, s, s);
  l.disc(c, c, r, Tile.Path);
  l.disc(c, c, r - 2.5, KEEP);
  l.disc(c, c, 3, Tile.TempleFloor);
  const count = crystal ? 12 : 8;
  for (let a = 0; a < count; a++) {
    const t = (a / count) * Math.PI * 2;
    l.deco(Math.round(c + Math.cos(t) * (r - 1)), Math.round(c + Math.sin(t) * (r - 1)), crystal ? Deco.Crystal : Deco.Pillar);
  }
  l.deco(Math.round(c), Math.round(c), crystal ? Deco.Crystal : Deco.Statue);
  return l;
}

/** Natural lake: overlapping lobes with a noise-warped edge, smoothed, depth
 *  from distance to the shore, and a thin, patchy beach. */
function lake(ctx: BuildContext): Layout {
  const { rng, biome } = ctx;
  const size = rng.int(18, 58);
  const w = size + 14;
  const h = Math.min(90, Math.round(size * rng.range(0.75, 1.25)) + 14);
  const noise = new SimplexNoise(rng.uint());
  const cx = w / 2;
  const cy = h / 2;

  // Two to four overlapping ellipses give bays and points instead of an egg.
  const lobes = Array.from({ length: rng.int(2, 4) }, (_, i) => ({
    x: cx + (i ? rng.range(-0.22, 0.22) * size : 0),
    y: cy + (i ? rng.range(-0.22, 0.22) * (h - 14) : 0),
    rx: rng.range(0.22, 0.36) * size,
    ry: rng.range(0.22, 0.36) * (h - 14),
  }));
  let water = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const wx = x + noise.noise2(x / 13, y / 13) * 4;
      const wy = y + noise.noise2(x / 13 + 50, y / 13 + 50) * 4;
      let field = -Infinity;
      for (const l of lobes) field = Math.max(field, 1 - ((wx - l.x) / l.rx) ** 2 - ((wy - l.y) / l.ry) ** 2);
      field += noise.fbm(x / 8, y / 8, 2) * 0.28;
      water[y * w + x] = field > 0 ? 1 : 0;
    }
  }

  // Smooth away single-tile notches and specks.
  for (let pass = 0; pass < 2; pass++) {
    const next = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let n = 0;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) if ((dx || dy) && water[(y + dy) * w + x + dx] && x + dx >= 0 && x + dx < w) n++;
        }
        const i = y * w + x;
        next[i] = n >= 5 ? 1 : n <= 3 ? 0 : water[i];
      }
    }
    water = next;
  }
  dropSmallPatches(water, w, h, 1, 20);
  dropSmallPatches(water, w, h, 0, 6);

  // Distance from the shoreline, inward for water and outward for land.
  const inward = distanceTo(water, w, h, 0);
  const outward = distanceTo(water, w, h, 1);
  const l = new Layout(w, h);
  const beach = shore(ctx);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const wobble = noise.noise2(x / 6 + 90, y / 6);
      if (water[i]) {
        const deep = inward[i] > 3 + wobble * 1.5;
        if (biome === BiomeType.Snow) l.tile(x, y, deep && wobble > 0.35 ? Tile.Water : Tile.Ice);
        else l.tile(x, y, deep ? Tile.WaterDeep : Tile.Water);
      } else if (outward[i] < 1.5 ? wobble > -0.45 : outward[i] < 2.5 && wobble > 0.3) {
        l.tile(x, y, beach);
        if (biome === BiomeType.Desert && outward[i] >= 1.5 && rng.chance(0.25)) l.deco(x, y, Deco.Palm);
      }
    }
  }
  return cropped(l);
}

/** Flips connected patches of `value` smaller than `min` tiles. */
function dropSmallPatches(grid: Uint8Array, w: number, h: number, value: number, min: number): void {
  const seen = new Uint8Array(w * h);
  for (let start = 0; start < grid.length; start++) {
    if (seen[start] || grid[start] !== value) continue;
    const patch = [start];
    seen[start] = 1;
    for (let k = 0; k < patch.length; k++) {
      const i = patch[k];
      const x = i % w;
      for (const j of [i - w, i + w, x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1]) {
        if (j < 0 || j >= grid.length || seen[j] || grid[j] !== value) continue;
        seen[j] = 1;
        patch.push(j);
      }
    }
    // Land touching the layout edge is the outside world, never an island.
    const edge = value === 0 && patch.some((i) => i % w === 0 || i % w === w - 1 || i < w || i >= grid.length - w);
    if (patch.length < min && !edge) for (const i of patch) grid[i] = 1 - value;
  }
}

/** Approximate Euclidean distance (two-pass chamfer) from each cell to the
 *  nearest cell whose value is `target`. Round contours, unlike grid steps. */
function distanceTo(grid: Uint8Array, w: number, h: number, target: number): Float32Array {
  const dist = new Float32Array(w * h);
  for (let i = 0; i < grid.length; i++) dist[i] = grid[i] === target ? 0 : 1e9;
  const D = Math.SQRT2;
  const relax = (i: number, x: number, y: number, dx: number, dy: number, cost: number) => {
    const nx = x + dx;
    const ny = y + dy;
    if (nx >= 0 && ny >= 0 && nx < w && ny < h) dist[i] = Math.min(dist[i], dist[ny * w + nx] + cost);
  };
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      relax(i, x, y, -1, 0, 1);
      relax(i, x, y, 0, -1, 1);
      relax(i, x, y, -1, -1, D);
      relax(i, x, y, 1, -1, D);
    }
  }
  for (let y = h - 1; y >= 0; y--) {
    for (let x = w - 1; x >= 0; x--) {
      const i = y * w + x;
      relax(i, x, y, 1, 0, 1);
      relax(i, x, y, 0, 1, 1);
      relax(i, x, y, 1, 1, D);
      relax(i, x, y, -1, 1, D);
    }
  }
  return dist;
}

/** Trims empty margins so the footprint, and its collision box, stays tight. */
function cropped(l: Layout): Layout {
  let x0 = l.w;
  let y0 = l.h;
  let x1 = -1;
  let y1 = -1;
  for (let y = 0; y < l.h; y++) {
    for (let x = 0; x < l.w; x++) {
      if (!l.tiles[y * l.w + x] && !l.decos[y * l.w + x]) continue;
      x0 = Math.min(x0, x);
      y0 = Math.min(y0, y);
      x1 = Math.max(x1, x);
      y1 = Math.max(y1, y);
    }
  }
  if (x1 < 0) return l;
  const out = new Layout(x1 - x0 + 1, y1 - y0 + 1);
  for (let y = 0; y < out.h; y++) {
    for (let x = 0; x < out.w; x++) {
      out.tiles[y * out.w + x] = l.tiles[(y + y0) * l.w + x + x0];
      out.decos[y * out.w + x] = l.decos[(y + y0) * l.w + x + x0];
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Definitions

const FOREST_SNOW: readonly BiomeType[] = [BiomeType.Forest, BiomeType.Snow];

const def = (d: Omit<StructureDef, 'persistence'> & { persistence?: Persistence }): StructureDef => ({
  persistence: 'temporary',
  ...d,
});

export const STRUCTURES: readonly StructureDef[] = [
  def({ kind: 'camp', name: 'Camp', rarity: Rarity.Common, weight: 3, minDistance: 0, spacing: 60, flatGround: true, rotate: true, build: camp }),
  def({ kind: 'house', name: 'Small House', rarity: Rarity.Common, weight: 3, minDistance: 0, spacing: 40, flatGround: true, rotate: false, build: house }),
  def({ kind: 'deposit', name: 'Ore Deposit', rarity: Rarity.Common, weight: 2, minDistance: 0, spacing: 30, flatGround: false, rotate: true, build: deposit }),
  def({ kind: 'ruins', name: 'Ruins', rarity: Rarity.Uncommon, weight: 3, minDistance: 0, spacing: 100, flatGround: true, rotate: true, build: ruins }),
  def({ kind: 'tower', name: 'Tower', rarity: Rarity.Uncommon, weight: 2, minDistance: 0, spacing: 150, flatGround: true, rotate: false, build: tower }),
  def({ kind: 'cabin', name: 'Cabin', rarity: Rarity.Uncommon, weight: 2, biomes: FOREST_SNOW, minDistance: 0, spacing: 100, flatGround: true, rotate: false, build: cabin }),
  def({ kind: 'abandoned-camp', name: 'Abandoned Camp', rarity: Rarity.Uncommon, weight: 2, minDistance: 0, spacing: 80, flatGround: true, rotate: true, build: abandonedCamp }),
  def({ kind: 'mine', name: 'Mine', rarity: Rarity.Uncommon, weight: 1, minDistance: 0, spacing: 150, flatGround: false, rotate: false, persistence: 'semi-persistent', build: mine }),
  def({ kind: 'village', name: 'Village', rarity: Rarity.Rare, weight: 3, biomes: FOREST_SNOW, minDistance: 150, spacing: 500, flatGround: true, rotate: false, persistence: 'semi-persistent', build: village }),
  def({ kind: 'temple', name: 'Temple', rarity: Rarity.Rare, weight: 2, minDistance: 300, spacing: 400, flatGround: true, rotate: false, build: (c) => temple(c, [20, 28], false) }),
  def({ kind: 'castle', name: 'Castle', rarity: Rarity.Rare, weight: 2, biomes: FOREST_SNOW, minDistance: 400, spacing: 800, flatGround: true, rotate: false, persistence: 'semi-persistent', build: castle }),
  def({ kind: 'dungeon', name: 'Dungeon', rarity: Rarity.Rare, weight: 2, minDistance: 250, spacing: 300, flatGround: false, rotate: true, build: dungeon }),
  def({ kind: 'giant-city', name: 'Giant City', rarity: Rarity.ExtremelyRare, weight: 2, minDistance: 2500, spacing: 3000, flatGround: true, rotate: false, persistence: 'persistent', build: (c) => city(c, false) }),
  def({ kind: 'sun-temple', name: 'Sun Temple', rarity: Rarity.ExtremelyRare, weight: 1, biomes: [BiomeType.Desert], minDistance: 2500, spacing: 3000, flatGround: true, rotate: false, persistence: 'persistent', build: (c) => temple(c, [32, 40], true) }),
  def({ kind: 'boss-arena', name: 'Boss Arena', rarity: Rarity.ExtremelyRare, weight: 2, minDistance: 2500, spacing: 3000, flatGround: true, rotate: true, persistence: 'persistent', build: bossArena }),
  def({ kind: 'standing-stones', name: 'Standing Stones', rarity: Rarity.ExtremelyRare, weight: 2, minDistance: 2500, spacing: 3000, flatGround: false, rotate: true, persistence: 'persistent', build: (c) => standingStones(c, false) }),
];

/** Very low odds rolled per anchor chunk, independent of the structure roll (spec 3.6).
 *  The legendary creature waits for the enemy system. */
export const RARE_EVENTS: ReadonlyArray<{ chance: number; def: StructureDef }> = [
  { chance: 0.001, def: def({ kind: 'ancient-temple', name: 'Ancient Temple', rarity: Rarity.ExtremelyRare, weight: 0, minDistance: 0, spacing: 0, flatGround: false, rotate: false, persistence: 'persistent', build: (c) => temple(c, [30, 38], true) }) },
  { chance: 0.0001, def: def({ kind: 'lost-city', name: 'Lost City', rarity: Rarity.ExtremelyRare, weight: 0, minDistance: 0, spacing: 0, flatGround: false, rotate: false, persistence: 'persistent', build: (c) => city(c, true) }) },
  { chance: 0.00001, def: def({ kind: 'crystal-monolith', name: 'Crystal Monolith', rarity: Rarity.ExtremelyRare, weight: 0, minDistance: 0, spacing: 0, flatGround: false, rotate: true, persistence: 'persistent', build: (c) => standingStones(c, true) }) },
];

const LAKE: StructureDef = def({ kind: 'lake', name: 'Lake', rarity: Rarity.Common, weight: 0, minDistance: 0, spacing: 0, flatGround: true, rotate: true, build: lake });
const LAKE_CHANCE: Record<BiomeType, number> = { [BiomeType.Forest]: 0.06, [BiomeType.Desert]: 0.025, [BiomeType.Snow]: 0.05 };
const LAKE_NAMES: Record<BiomeType, string> = { [BiomeType.Forest]: 'Lake', [BiomeType.Desert]: 'Oasis', [BiomeType.Snow]: 'Frozen Lake' };

const STRUCTURE_CHANCE = 0.22;
const TIER_WEIGHTS = [70, 22, 6, 1];
const TIER_GROWTH = [0, 0.3, 1, 2];

// ---------------------------------------------------------------------------
// Placement roll

export interface RollContext {
  worldSeed: number;
  cx: number;
  cy: number;
  visit: number;
  biome: BiomeType;
  palette: number;
  fields: TerrainFields;
  /** Multiplies the odds of rare events and extremely rare structures. */
  rareBoost?: number;
}

/** Everything anchored in one chunk for this visit. Placements may overlap
 *  neighbouring chunks by up to one chunk; the caller checks collisions. */
export function rollAnchor(ctx: RollContext): Placement[] {
  const { worldSeed, cx, cy, visit } = ctx;
  const out: Placement[] = [];
  const centreX = cx * CHUNK_SIZE + CHUNK_SIZE / 2;
  const centreY = cy * CHUNK_SIZE + CHUNK_SIZE / 2;
  const distance = distanceFromOrigin(centreX, centreY);

  const events = streamRng(Stream.RareEvent, worldSeed, cx, cy, visit);
  const boost = ctx.rareBoost ?? 1;
  const event = RARE_EVENTS.find((e) => events.next() < e.chance * boost);
  if (event) {
    const p = place(ctx, event.def, 'event', streamRng(Stream.Layout, worldSeed, cx, cy, visit, 0));
    if (p) out.push(p);
  }

  const rng = streamRng(Stream.Structure, worldSeed, cx, cy, visit);
  if (rng.chance(STRUCTURE_CHANCE)) {
    const band = difficultyBand(centreX, centreY);
    const candidates = STRUCTURES.filter(
      (d) => d.minDistance <= distance && (!d.biomes || d.biomes.includes(ctx.biome)),
    );
    const tiers = [0, 1, 2, 3].filter((t) => candidates.some((d) => d.rarity === t));
    const tier = rng.weighted(tiers, (t) => TIER_WEIGHTS[t] * (1 + TIER_GROWTH[t] * band) * (t === Rarity.ExtremelyRare ? boost : 1));
    const chosen = rng.weighted(candidates.filter((d) => d.rarity === tier), (d) => d.weight);
    if (chosen) {
      const p = place(ctx, chosen, 'structure', streamRng(Stream.Layout, worldSeed, cx, cy, visit, 1));
      if (p) out.push(p);
    }
  }

  const lakes = streamRng(Stream.Lake, worldSeed, cx, cy, visit);
  if (lakes.chance(LAKE_CHANCE[ctx.biome])) {
    const named = { ...LAKE, name: LAKE_NAMES[ctx.biome] };
    const p = place(ctx, named, 'lake', streamRng(Stream.Layout, worldSeed, cx, cy, visit, 2));
    if (p) out.push(p);
  }
  return out;
}

/** Builds and orients a layout, then positions it so it contains a random
 *  tile of the anchor chunk and stays within one chunk of it. */
function place(ctx: RollContext, d: StructureDef, slot: string, rng: Rng): Placement | null {
  let layout = d.build({ rng, palette: ctx.palette, biome: ctx.biome });
  if (d.rotate) layout = layout.rotated(rng.int(0, 3));
  if (rng.chance(0.5)) layout = layout.mirrored();

  const ax = ctx.cx * CHUNK_SIZE;
  const ay = ctx.cy * CHUNK_SIZE;
  const tx = ax + rng.int(0, CHUNK_SIZE - 1);
  const ty = ay + rng.int(0, CHUNK_SIZE - 1);
  const x = rng.int(Math.max(ax - CHUNK_SIZE, tx - layout.w + 1), Math.min(ax + 2 * CHUNK_SIZE - layout.w, tx));
  const y = rng.int(Math.max(ay - CHUNK_SIZE, ty - layout.h + 1), Math.min(ay + 2 * CHUNK_SIZE - layout.h, ty));

  // Flat structures need dry, level ground across their footprint: checked on
  // a grid of points, more of them for bigger layouts.
  if (d.flatGround) {
    const n = layout.w * layout.h > 400 ? 4 : 2;
    for (let j = 0; j <= n; j++) {
      for (let i = 0; i <= n; i++) if (!ctx.fields.isBuildable(x + (layout.w * i) / n, y + (layout.h * j) / n)) return null;
    }
  }
  const anchor = `${ctx.cx},${ctx.cy}/${slot}`;
  return { id: `${d.kind}@${ctx.cx},${ctx.cy}#${ctx.visit}/${slot}`, anchor, def: d, x, y, layout };
}
