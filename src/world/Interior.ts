// Building interiors: a furnished room behind every door, generated from the
// building's seed so it is the same each time the player walks in. Mines lead
// into a cave of ore and crystal instead, and a castle keep has three floors
// joined by stairs: a cellar, the great hall, and an upper floor.

import { hash, hashString, Rng, Stream } from '../generation/Random';
import type { BuildingSpec } from '../generation/StructureGenerator';
import { Deco, isSolid, Tile } from '../generation/Tiles';
import type { Place } from '../game/Place';
import type { WorldObject } from './WorldObject';

/** Chest ids inside buildings start here, so they never clash with layout indices. */
const CHEST_BASE = 1_000_000;
/** Ids for rocks and ore mined inside, in the same opened set. */
const MINED_BASE = 2_000_000;

/** Floors of a keep, from the cellar up, with their names. */
export const KEEP_FLOORS: Record<number, string> = { [-1]: 'Cellar', 0: 'Great Hall', 1: 'Upper Floor' };

/** What the player reads when leafing through a bookshelf. */
export const BOOKS = [
  "A farmer's almanac, its margins full of notes on frost and rain.",
  'A book of maps. No two pages show the same coastline.',
  "A children's story about a fox who outwits a bear. The last page is torn out.",
  'A ledger of trades: salt, iron and wool, in a careful hand.',
  'Poems about the sea, by someone who had plainly never seen it.',
  'A cookbook. The stew recipe calls for mushrooms, herbs and a handful of berries.',
  'A diary: "Rain again. The well is full and the roads are mud."',
];

/** Stairs on a floor: the tile, and the floor they lead to. */
export interface Stairs {
  x: number;
  y: number;
  to: number;
}

const CHEST_CHANCE: Record<BuildingSpec['style'], number> = { house: 0.5, cabin: 0.6, stone: 0.4, keep: 0.8, city: 0.5, mine: 0.55 };

export class Interior implements Place {
  readonly kind = 'interior';
  /** Nothing fights indoors. */
  readonly arena = null;
  readonly w: number;
  readonly h: number;
  readonly tiles: Uint8Array;
  readonly decos: Uint8Array;
  /** The doormat tile in the bottom wall; stepping on it leaves. */
  readonly exit: { x: number; y: number };
  /** Where the player stands on entering, in tiles (feet). */
  readonly spawn: { x: number; y: number };
  /** Where the player stands outside, in world tiles (feet). */
  readonly outside: { x: number; y: number };
  /** The building's door tile in the world. */
  readonly door: { x: number; y: number };
  /** Spots where residents stand, in tiles (feet). */
  readonly spots: Array<{ x: number; y: number }> = [];
  /** A cave: always dark, lit only by lamps and the way out. */
  readonly cave: boolean;
  /** Something was mined since the renderer last looked. */
  changed = false;
  /** Stairs to other floors. */
  readonly stairs: Stairs[] = [];
  /** The floor's name, for buildings with more than one. */
  readonly floorName: string;

  constructor(
    readonly object: WorldObject,
    readonly index: number,
    /** 0 is the floor with the door; the keep also has -1 (cellar) and 1. */
    readonly floor = 0,
  ) {
    const spec = object.layout.buildings[index];
    const keep = spec.style === 'keep';
    const rng = new Rng((spec.seed ^ 0x1e7) + floor * 7919);
    this.cave = spec.style === 'mine' || (keep && floor < 0);
    this.floorName = keep ? KEEP_FLOORS[floor] : '';
    const w = (this.w = keep ? 22 : this.cave ? 20 : Math.min(16, Math.max(9, spec.w + 4)));
    const h = (this.h = keep ? 16 : this.cave ? 16 : Math.min(12, Math.max(8, spec.h + 4)));
    this.tiles = new Uint8Array(w * h);
    this.decos = new Uint8Array(w * h);
    const doorX = this.cave || keep ? Math.floor(w / 2) : Math.max(2, Math.min(w - 3, Math.round((spec.door / Math.max(1, spec.w - 1)) * (w - 1))));
    // Only the ground floor has a way out.
    this.exit = floor === 0 ? { x: doorX, y: h - 1 } : { x: -99, y: -99 };
    this.spawn = { x: doorX + 0.5, y: h - 1.2 };
    this.door = { x: object.x + spec.x + spec.door, y: object.y + spec.y + spec.h - 1 };
    this.outside = { x: this.door.x + 0.5, y: this.door.y + 1.9 };
    if (keep) this.keepFloor(rng);
    else if (this.cave) this.dig(rng);
    else this.furnish(spec, rng);
  }

  /** Where the player arrives coming up or down from another floor. */
  arrival(from: number): { x: number; y: number } {
    const s = this.stairs.find((st) => st.to === from) ?? this.stairs[0];
    return { x: s.x + 0.5, y: s.y + 1.9 };
  }

  /** Floors are told apart in the object's opened set. */
  private get slot(): number {
    return this.floor === 0 ? this.index : 100 + this.index * 4 + this.floor + 1;
  }

  /** A chest's id in the object's opened set. */
  chestId(x: number, y: number): number {
    return CHEST_BASE + this.slot * 1000 + this.at(x, y);
  }

  isOpened(x: number, y: number): boolean {
    return this.object.emptyChests || this.object.opened.has(this.chestId(x, y));
  }

  private mined(i: number): boolean {
    return this.object.opened.has(MINED_BASE + this.slot * 1000 + i);
  }

  /** Something on this tile was mined or gathered; it stays gone. */
  harvest(x: number, y: number): void {
    this.object.opened.add(this.minedId(x, y));
    this.changed = true;
  }

  /** A mined tile's id in the object's opened set. */
  minedId(x: number, y: number): number {
    return MINED_BASE + this.slot * 1000 + this.at(x, y);
  }

  /** The tile in this room whose chest or mined id (in the object's opened set) is `id`, if any. */
  tileOf(id: number): { x: number; y: number; deco: number } | null {
    const local = id - (id >= MINED_BASE ? MINED_BASE : CHEST_BASE) - this.slot * 1000;
    if (id < CHEST_BASE || local < 0 || local >= this.w * this.h) return null;
    return { x: local % this.w, y: Math.floor(local / this.w), deco: this.decos[local] };
  }

  /** Seeds what mining a tile gives. */
  seedAt(x: number, y: number): number {
    return hash(Stream.Loot, hashString(this.object.id), this.slot, x, y);
  }

  /** Collision for the player inside: walls, furniture, and anything outside the room. */
  /** The doorstep outside, as a place. */
  get spot(): { x: number; y: number } {
    return this.outside;
  }

  isSolidAt(gx: number, gy: number): boolean {
    if (gx < 0 || gy < 0 || gx >= this.w || gy >= this.h) return true;
    if (gx === this.exit.x && gy === this.exit.y) return false;
    const t = this.tileAt(gx, gy)!;
    return isSolid(t.tile, t.deco);
  }

  tileAt(gx: number, gy: number): { tile: number; deco: number } | null {
    if (gx < 0 || gy < 0 || gx >= this.w || gy >= this.h) return null;
    const i = this.at(gx, gy);
    let deco = this.decos[i];
    if (deco === Deco.Chest && this.isOpened(gx, gy)) deco = Deco.ChestOpen;
    else if (deco && this.mined(i)) deco = 0;
    return { tile: this.tiles[i], deco };
  }

  private at(x: number, y: number): number {
    return y * this.w + x;
  }

  private solid(x: number, y: number): boolean {
    const i = this.at(x, y);
    return isSolid(this.tiles[i], this.decos[i]);
  }

  /** Places a decoration on open floor, keeping the walk from the door clear. */
  private place(x: number, y: number, deco: number): boolean {
    if (x <= 0 || y <= 2 || x >= this.w - 1 || y >= this.h - 1) return false;
    if (x === this.exit.x && y >= this.h - 3) return false;
    const i = this.at(x, y);
    if (this.decos[i] || isSolid(this.tiles[i], 0)) return false;
    this.decos[i] = deco;
    return true;
  }

  // Rooms ---------------------------------------------------------------------

  private furnish(spec: BuildingSpec, rng: Rng): void {
    const { w, h } = this;
    const stone = spec.style === 'stone' || spec.style === 'keep' || spec.style === 'city';
    const floor = stone ? Tile.StoneFloor : Tile.WoodFloor;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let t: number = floor;
        if (y === 0 || x === 0 || x === w - 1 || y === h - 1) t = Tile.WallTop;
        else if (y <= 2) t = Tile.InteriorWall;
        this.tiles[y * w + x] = t;
      }
    }
    this.tiles[this.at(this.exit.x, h - 1)] = Tile.Rug;

    // A rug in the middle of the room.
    const cx = Math.floor(w / 2);
    const cy = Math.floor((h + 3) / 2);
    for (let y = cy - 1; y <= cy + 1; y++) for (let x = cx - 2; x <= cx + 1; x++) this.tiles[this.at(x, y)] = Tile.Rug;

    const back = 3;
    if (spec.style === 'stone') {
      this.barracks(rng, cx, cy);
      return;
    }
    // Against the back wall (row 3): fireplace, shelves, a bed.
    this.place(rng.chance(0.5) ? 2 : w - 4, back, Deco.Fireplace);
    this.place(w - 2, back, Deco.Bed);
    for (let k = 0; k < (spec.style === 'keep' ? 3 : 1 + rng.int(0, 1)); k++) this.place(rng.int(2, w - 3), back, Deco.Bookshelf);
    if (spec.style === 'keep') this.place(cx, back, Deco.Banner);
    // Table and chairs in the middle.
    this.place(cx, cy, Deco.Table);
    this.place(cx - 2, cy, Deco.Chair);
    this.place(cx + 2, cy, Deco.Chair);
    // Corners and walls.
    this.place(1, h - 2, rng.chance(0.5) ? Deco.PottedPlant : Deco.Crate);
    this.place(w - 2, h - 2, rng.chance(0.5) ? Deco.Barrel : Deco.PottedPlant);
    if (rng.chance(0.6)) this.place(1, back + 1, Deco.Lamp);
    if (spec.style !== 'house' && rng.chance(0.6)) this.place(w - 2, h - 3, Deco.Crate);
    if (rng.chance(CHEST_CHANCE[spec.style])) this.place(rng.chance(0.5) ? 1 : w - 2, cy, Deco.Chest);

    // Residents stand around the table.
    for (const [x, y] of [[cx - 1, cy + 2], [cx + 1, cy - 2], [cx - 3, cy + 1], [cx + 3, cy - 1]]) {
      if (!this.solid(x, y)) this.spots.push({ x: x + 0.5, y: y + 0.9 });
    }
  }

  /** Barracks: a row of bunks, racks of weapons, a table for the watch. */
  private barracks(rng: Rng, cx: number, cy: number): void {
    const { w, h } = this;
    for (let x = 2; x < w - 2; x += 2) this.place(x, 3, Deco.Bed);
    this.place(1, 5, Deco.WeaponRack);
    this.place(w - 2, 5, Deco.ArmorStand);
    this.place(cx, cy + 1, Deco.Table);
    this.place(cx - 2, cy + 1, Deco.Chair);
    this.place(cx + 2, cy + 1, Deco.Chair);
    this.place(1, h - 2, Deco.Barrel);
    this.place(w - 2, h - 2, Deco.Crate);
    this.place(w - 2, h - 3, Deco.Lamp);
    if (rng.chance(CHEST_CHANCE.stone)) this.place(1, cy + 1, Deco.Chest);
  }

  // Keeps ---------------------------------------------------------------------

  /** Lays out one floor of a keep (22 × 16). */
  private keepFloor(rng: Rng): void {
    const { w, h, tiles } = this;
    const fill = (x: number, y: number, fw: number, fh: number, t: number) => {
      for (let j = y; j < y + fh; j++) for (let i = x; i < x + fw; i++) tiles[this.at(i, j)] = t;
    };
    const floorTile = this.floor < 0 ? Tile.DarkFloor : this.floor > 0 ? Tile.WoodFloor : Tile.StoneFloor;
    fill(0, 0, w, h, Tile.WallTop);
    fill(1, 1, w - 2, 2, this.floor > 0 ? Tile.InteriorWall : Tile.StoneWallFace);
    fill(1, 3, w - 2, h - 4, floorTile);
    const stairs = (x: number, y: number, to: number) => {
      this.place(x, y, to > this.floor ? Deco.StairsUp : Deco.StairsDown);
      this.stairs.push({ x, y, to });
    };
    const cx = Math.floor(w / 2);

    if (this.floor === 0) {
      // The great hall: a carpet to the throne on its dais, pillars, feast
      // tables, fireplaces, banners and suits of armour.
      tiles[this.at(this.exit.x, h - 1)] = Tile.Rug;
      fill(cx - 1, 5, 3, h - 6, Tile.Rug);
      fill(cx - 4, 3, 9, 2, Tile.TempleFloor);
      this.place(cx, 3, Deco.Throne);
      this.place(cx - 3, 3, Deco.Banner);
      this.place(cx + 3, 3, Deco.Banner);
      this.place(3, 3, Deco.Fireplace);
      this.place(w - 5, 3, Deco.Fireplace);
      stairs(w - 2, 3, 1);
      stairs(1, 3, -1);
      for (const y of [6, 9, 12]) {
        this.place(cx - 5, y, Deco.Pillar);
        this.place(cx + 5, y, Deco.Pillar);
      }
      for (const y of [7, 11]) {
        this.place(3, y, Deco.Table);
        this.place(1, y, Deco.Chair);
        this.place(5, y, Deco.Chair);
        this.place(w - 4, y, Deco.Table);
        this.place(w - 6, y, Deco.Chair);
        this.place(w - 2, y, Deco.Chair);
      }
      this.place(1, h - 3, Deco.ArmorStand);
      this.place(w - 2, h - 3, Deco.ArmorStand);
      this.place(cx - 3, h - 3, Deco.Lamp);
      this.place(cx + 3, h - 3, Deco.Lamp);
      this.place(cx - 3, 6, Deco.Lamp);
      this.place(cx + 3, 6, Deco.Lamp);
    } else if (this.floor > 0) {
      // The upper floor: a library, a bedchamber and an armory off a corridor.
      for (const x of [7, 14]) fill(x, 3, 1, h - 9, Tile.WallTop);
      fill(1, h - 4, w - 2, 1, Tile.Rug);
      // Library.
      for (const x of [1, 2, 4, 5]) this.place(x, 3, Deco.Bookshelf);
      this.place(3, 6, Deco.Table);
      this.place(3, 7, Deco.Chair);
      this.place(6, 3, Deco.Lamp);
      this.place(1, 8, Deco.PottedPlant);
      // Bedchamber.
      fill(9, 5, 4, 3, Tile.Rug);
      this.place(10, 3, Deco.Fireplace);
      this.place(8, 3, Deco.Bed);
      this.place(13, 3, Deco.Bed);
      this.place(13, 8, Deco.Chest);
      this.place(8, 8, Deco.PottedPlant);
      // Armory, and the stairs down.
      stairs(w - 2, 3, 0);
      this.place(15, 3, Deco.WeaponRack);
      this.place(16, 3, Deco.WeaponRack);
      this.place(18, 3, Deco.ArmorStand);
      this.place(16, 7, Deco.Dummy);
      this.place(19, 8, Deco.Crate);
      // The corridor.
      this.place(7, h - 5, Deco.Lamp);
      this.place(14, h - 5, Deco.Lamp);
      this.place(cx, h - 2, Deco.Banner);
      this.place(1, h - 2, Deco.Barrel);
    } else {
      // The cellar: stores, wine, pillars, and the keep's treasure.
      for (let k = 0; k < 14; k++) tiles[this.at(rng.int(2, w - 3), rng.int(4, h - 2))] = Tile.Rubble;
      stairs(1, 3, 0);
      for (let x = 4; x < 10; x++) this.place(x, 3, x % 2 ? Deco.Barrel : Deco.Crate);
      for (let x = 13; x < w - 1; x++) this.place(x, 3, Deco.Barrel);
      for (const x of [6, 11, 16]) {
        this.place(x, 7, Deco.Pillar);
        this.place(x, 11, Deco.Pillar);
      }
      for (const [x, y] of [[2, 12], [3, 12], [2, 13], [4, 13]]) this.place(x, y, rng.chance(0.5) ? Deco.Crate : Deco.Barrel);
      this.place(w - 2, h - 3, Deco.Chest);
      this.place(w - 3, h - 2, Deco.Chest);
      this.place(8, 5, Deco.Lamp);
      this.place(15, 5, Deco.Lamp);
      this.place(cx, h - 2, Deco.Lamp);
    }
    const start = this.floor === 0 ? this.at(this.exit.x, this.exit.y) : this.at(this.stairs[0].x, this.stairs[0].y + 1);
    this.unblock(start);
  }

  // Mines ---------------------------------------------------------------------

  /** Carves a cave: a main chamber with side pockets, a railed tunnel from the
   *  entrance, timber props along the walls, and ore and crystal to mine. */
  private dig(rng: Rng): void {
    const { w, h, tiles } = this;
    const floor = new Uint8Array(w * h);
    const open = (x: number, y: number) => x >= 1 && y >= 2 && x <= w - 2 && y <= h - 3;
    const carve = (cx: number, cy: number, rx: number, ry: number) => {
      for (let y = Math.floor(cy - ry); y <= Math.ceil(cy + ry); y++) {
        for (let x = Math.floor(cx - rx); x <= Math.ceil(cx + rx); x++) {
          if (open(x, y) && ((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2 <= 1 + rng.range(-0.12, 0.12)) floor[this.at(x, y)] = 1;
        }
      }
    };
    const cx = w / 2 - 0.5;
    const cy = h / 2 - 1.5;
    carve(cx, cy, w / 2 - 3.5, h / 2 - 3.5);
    for (let k = 0; k < 4; k++) carve(rng.range(3, w - 4), rng.range(3, h - 5), rng.range(1.8, 3.2), rng.range(1.5, 2.5));
    // The tunnel from the entrance, three wide.
    const ex = this.exit.x;
    for (let y = Math.floor(cy); y < h; y++) for (let x = ex - 1; x <= ex + 1; x++) floor[this.at(x, y)] = 1;
    const near = (x: number, y: number) => {
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx >= 0 && ny >= 0 && nx < w && ny < h && floor[this.at(nx, ny)]) return true;
        }
      }
      return false;
    };

    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = this.at(x, y);
        if (floor[i]) tiles[i] = rng.chance(0.08) ? Tile.Rubble : Tile.MineFloor;
        // Rock with floor below shows its face; rock beside the floor is lit
        // rubble-strewn stone; deeper rock fades into the dark.
        else if (y + 1 < h && floor[i + w]) tiles[i] = Tile.CaveWall;
        else tiles[i] = near(x, y) ? Tile.RockDark : Tile.CaveRoof;
      }
    }
    for (let y = Math.floor(cy) - 2; y < h; y++) if (floor[this.at(ex, y)]) tiles[this.at(ex, y)] = Tile.Rail;
    this.place(ex, Math.floor(cy) - 2, Deco.Minecart);

    // Floor cells against the rock, where things are placed.
    const walls: Array<[number, number]> = [];
    const backs: Array<[number, number]> = [];
    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        if (!floor[this.at(x, y)] || Math.abs(x - ex) <= 1) continue;
        const rockAt = (dx: number, dy: number) => !floor[this.at(x + dx, y + dy)];
        if (rockAt(0, -1)) backs.push([x, y]);
        if (rockAt(0, -1) || rockAt(-1, 0) || rockAt(1, 0) || rockAt(0, 1)) walls.push([x, y]);
      }
    }
    for (let i = walls.length - 1; i > 0; i--) {
      const j = rng.int(0, i);
      [walls[i], walls[j]] = [walls[j], walls[i]];
    }
    // Timber props along the back walls.
    backs.forEach(([x, y], k) => {
      if (k % 4 === 1) this.place(x, y, Deco.SupportBeam);
    });
    let n = 0;
    // Keep things apart, so they do not line up along the walls.
    const crowded = (x: number, y: number) => {
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) if (this.decos[this.at(x + dx, y + dy)]) return true;
      return false;
    };
    const put = (deco: number, count: number) => {
      for (let placed = 0; placed < count && n < walls.length; n++) {
        const [x, y] = walls[n];
        if (crowded(x, y)) continue;
        if (this.place(x, y, deco)) placed++;
      }
    };
    put(Deco.Lamp, 3);
    put(Deco.Ore, rng.int(6, 9));
    if (rng.chance(0.55)) put(Deco.Crystal, rng.int(1, 3));
    put(Deco.Stone, rng.int(3, 5));
    put(Deco.Crate, 1);
    put(Deco.Barrel, 1);
    if (rng.chance(CHEST_CHANCE.mine)) put(Deco.Chest, 1);
    this.unblock(this.at(this.exit.x, this.exit.y));
  }

  /** Removes anything the player could not walk up to from `start`. */
  private unblock(start: number): void {
    const { w, h } = this;
    const reach = new Uint8Array(w * h);
    const queue = [start];
    reach[queue[0]] = 1;
    while (queue.length) {
      const i = queue.pop()!;
      for (const j of [i - 1, i + 1, i - w, i + w]) {
        if (j < 0 || j >= w * h || reach[j] || isSolid(this.tiles[j], this.decos[j])) continue;
        reach[j] = 1;
        queue.push(j);
      }
    }
    for (let i = 0; i < w * h; i++) {
      if (!this.decos[i]) continue;
      if (![i - 1, i + 1, i - w, i + w].some((j) => reach[j])) this.decos[i] = 0;
    }
  }
}
