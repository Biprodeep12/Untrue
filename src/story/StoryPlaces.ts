// The story's fixed places (The World That Forgets). Each is a persistent
// object placed by the world seed at a set distance from the origin, on
// flat, dry ground, so the story's pacing follows the difficulty bands.

import { hash, Rng, unit } from '../generation/Random';
import { cabin, Layout, village } from '../generation/StructureGenerator';
import type { TerrainFields } from '../generation/TerrainGenerator';
import { BiomeType, Deco, Tile } from '../generation/Tiles';
import { WorldObject } from '../world/WorldObject';

export type PlaceId = 'monument' | 'graves' | 'observatory' | 'archive' | 'anchor';

export interface StoryPlace {
  id: PlaceId;
  name: string;
  /** Distance from the origin, in tiles; 0 sits on the origin. */
  distance: number;
  build(rng: Rng): Layout;
}

function monument(): Layout {
  const l = new Layout(7, 7);
  l.disc(3, 3, 3.2, Tile.Path);
  l.disc(3, 3, 1.2, Tile.StoneFloor);
  l.clearDecos(0, 0, 7, 7);
  l.deco(3, 3, Deco.Monument);
  return l;
}

/** The Village of Graves: a village with a cemetery on its east side. */
function graves(rng: Rng): Layout {
  const base = village({ rng, palette: 0, biome: BiomeType.Forest });
  const s = base.w;
  const l = new Layout(s + 14, s);
  l.blit(base, 0, 0);
  const m = Math.floor(s / 2);
  // Road from the square to the cemetery gate.
  l.fill(m, m - 1, s - m + 2, 2, Tile.Path);
  const cx = s + 1;
  const cy = m - 6;
  l.clearDecos(cx, cy, 12, 12);
  l.border(cx, cy, 12, 12, Tile.Path);
  for (let row = 0; row < 3; row++) {
    for (let col = 0; col < 4; col++) l.deco(cx + 2 + col * 2 + (row % 2), cy + 3 + row * 3, Deco.Gravestone);
  }
  // A campfire by the well, for the night that follows.
  l.deco(m + 3, m + 2, Deco.Campfire);
  return l;
}

function observatory(): Layout {
  const l = new Layout(21, 23);
  const c = 10;
  l.clearDecos(0, 0, 21, 23);
  l.disc(c, c, 10, Tile.StoneWall);
  l.disc(c, c, 8, Tile.StoneFloor);
  l.fill(c - 1, c + 8, 3, 3, Tile.StoneFloor);
  l.fill(c - 1, c + 11, 3, 2, Tile.Path);
  l.deco(c, c - 4, Deco.Telescope);
  for (const [x, y] of [[c - 6, c - 3], [c - 6, c], [c + 6, c - 3], [c + 6, c]]) l.deco(x, y, Deco.Bookshelf);
  l.deco(c - 3, c + 3, Deco.Book);
  return l;
}

/** The Sunken Archive: wings of shelves, three memory rooms, and the Hall of Lanterns. */
function archive(rng: Rng): Layout {
  const s = 64;
  const l = new Layout(s, s);
  const m = s / 2;
  l.clearDecos(0, 0, s, s);
  l.fill(0, 0, s, s, Tile.DarkFloor);
  l.border(0, 0, s, s, Tile.StoneWall, 2);
  // Entrance in the south wall.
  l.fill(m - 2, s - 2, 4, 2, Tile.DarkFloor);
  // Hall of Lanterns in the middle.
  l.border(m - 11, m - 11, 22, 22, Tile.StoneWall, 2);
  l.fill(m - 2, m + 9, 4, 2, Tile.DarkFloor);
  for (let y = m - 7; y <= m + 6; y += 4) {
    for (let x = m - 7; x <= m + 6; x += 4) l.deco(x, y, Deco.LanternRack);
  }
  l.fill(m - 3, m - 3, 6, 6, Tile.TempleFloor);
  // Three memory rooms: west, north, east.
  const rooms: Array<[number, number, number, number, number, number]> = [
    [4, m - 6, 12, 12, 15, m - 1],
    [m - 6, 4, 12, 10, m - 1, 13],
    [s - 16, m - 6, 12, 12, s - 16, m - 1],
  ];
  rooms.forEach(([x, y, w, h, dx, dy], i) => {
    l.border(x, y, w, h, Tile.StoneWall);
    l.fill(dx, dy, i === 1 ? 2 : 1, i === 1 ? 1 : 2, Tile.DarkFloor);
    l.fill(x + w / 2 - 2, y + h / 2 - 2, 4, 4, Tile.TempleFloor);
    l.deco(x + w / 2, y + h / 2, Deco.Pedestal);
  });
  // Shelves along the outer walls.
  for (let k = 6; k < s - 6; k += 3) {
    if (Math.abs(k - m) > 4) {
      l.deco(k, 3, Deco.Bookshelf);
      l.deco(k, s - 4, Deco.Bookshelf);
    }
  }
  for (let i = 0; i < 40; i++) l.tile(rng.int(3, s - 4), rng.int(3, s - 4), Tile.Rubble);
  return l;
}

/** The Original Anchor: a vast round platform around its core. */
function anchor(): Layout {
  const s = 72;
  const c = (s - 1) / 2;
  const l = new Layout(s, s);
  l.clearDecos(0, 0, s, s);
  l.disc(c, c, 34, Tile.StoneFloor);
  l.disc(c, c, 30, Tile.TempleFloor);
  l.disc(c, c, 24, Tile.DarkFloor);
  l.disc(c, c, 8, Tile.TempleFloor);
  for (let a = 0; a < 16; a++) {
    const t = (a / 16) * Math.PI * 2;
    l.deco(Math.round(c + Math.cos(t) * 28), Math.round(c + Math.sin(t) * 28), Deco.Pillar);
    if (a % 2 === 0) l.deco(Math.round(c + Math.cos(t) * 16), Math.round(c + Math.sin(t) * 16), Deco.LanternRack);
  }
  l.deco(Math.round(c), Math.round(c), Deco.AnchorCore);
  return l;
}

export const PLACES: Record<PlaceId, StoryPlace> = {
  monument: { id: 'monument', name: 'Waking Monument', distance: 0, build: monument },
  graves: { id: 'graves', name: 'Village of Graves', distance: 260, build: graves },
  observatory: { id: 'observatory', name: 'The Observatory', distance: 1400, build: observatory },
  archive: { id: 'archive', name: 'Sunken Archive', distance: 3200, build: archive },
  anchor: { id: 'anchor', name: 'The Original Anchor', distance: 5200, build: anchor },
};

export const PLACE_ORDER: readonly PlaceId[] = ['monument', 'graves', 'observatory', 'archive', 'anchor'];

/** The story playground packs the places around the spawn, one per compass
 *  direction so they never run into each other: [distance, bearing]. */
const COMPACT: Record<PlaceId, [number, number]> = {
  monument: [0, 0],
  graves: [70, 0],
  observatory: [80, Math.PI / 2],
  archive: [110, Math.PI],
  anchor: [140, -Math.PI / 2],
};

/** Builds a story place at its seeded spot, as a persistent object; `compact`
 *  puts it near the spawn instead, for the story playground. */
export function placeStory(id: PlaceId, seed: number, fields: TerrainFields, compact = false): WorldObject {
  const place = PLACES[id];
  const rng = new Rng(hash(seed, PLACE_ORDER.indexOf(id), 0x5707));
  const layout = place.build(rng);
  let x = -Math.floor(layout.w / 2);
  let y = -Math.floor(layout.h / 2) - 3;
  const distance = compact ? COMPACT[id][0] : place.distance;
  if (distance > 0) {
    const angle = compact ? COMPACT[id][1] : unit(hash(seed, PLACE_ORDER.indexOf(id), 0xa11e)) * Math.PI * 2;
    // Walk outward along the bearing until the whole footprint is buildable.
    for (let step = 0; step < 80; step++) {
      const d = distance + step * 12;
      const cx = Math.round(Math.cos(angle + step * 0.05) * d);
      const cy = Math.round(Math.sin(angle + step * 0.05) * d);
      x = cx - Math.floor(layout.w / 2);
      y = cy - Math.floor(layout.h / 2);
      if (footprintBuildable(fields, x, y, layout.w, layout.h)) break;
    }
  }
  const o = new WorldObject(`story:${id}`, `story-${id}`, place.name, 'persistent', x, y, layout);
  o.anchor = o.id;
  return o;
}

function footprintBuildable(fields: TerrainFields, x: number, y: number, w: number, h: number): boolean {
  for (let j = 0; j <= 4; j++) {
    for (let i = 0; i <= 4; i++) if (!fields.isBuildable(x + (w * i) / 4, y + (h * j) / 4)) return false;
  }
  return true;
}

// Post-ending discoveries ----------------------------------------------------

export function echoMonument(): Layout {
  const l = new Layout(5, 5);
  l.disc(2, 2, 2.2, Tile.Path);
  l.clearDecos(0, 0, 5, 5);
  l.deco(2, 2, Deco.Monument);
  return l;
}

export function memoryFragment(): Layout {
  const l = new Layout(5, 5);
  l.disc(2, 2, 2.2, Tile.TempleFloor);
  l.clearDecos(0, 0, 5, 5);
  l.deco(2, 2, Deco.Pedestal);
  return l;
}

/** The quiet cabin from the epilogue: a cabin with a table and a book outside. */
export function quietCabin(rng: Rng): Layout {
  const base = cabin({ rng, palette: 0, biome: BiomeType.Forest });
  const l = new Layout(base.w, base.h + 3);
  l.blit(base, 0, 0);
  l.fill(1, base.h, 6, 3, Tile.WoodFloor);
  l.deco(3, base.h + 1, Deco.Book);
  l.deco(5, base.h + 1, Deco.LanternRack);
  for (let i = 0; i < l.tiles.length; i++) if (l.decos[i] === Deco.Barrel || l.decos[i] === Deco.Chest) l.decos[i] = Deco.Clear;
  return l;
}
