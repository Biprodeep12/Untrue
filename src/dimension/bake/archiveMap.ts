// Bakes The Drowned Archive's fixed map: run once (npm run bake), and the
// output, public/dimensions/archive.json, is the map everyone plays. It is
// built from a fixed seed around hand-placed landmarks, so baking again gives
// the same file.
//
// The land: the library of the old network's keepers, adrift in the void and
// half drowned in black ink-water. From the rift in the Lower Stacks a
// walkway runs north to the Reading Room, where the last keeper, Ondine,
// waits by the Great Lectern and its empty Ledger. West lie the Flooded
// Stacks and the Scriptorium (waves of drowned pages and ink wraiths); north
// of them the Cipher Wing and its gallery, whose order is written on a stone
// by its door; east the Sluice Hall, a race from valve to valve across the
// flood to the Map Room. North of the Reading Room the Atrium, sealed until
// all three are done, holds the Archivist; the vault and the portal home lie
// behind it.
//
// The plot: the Ledger's three index pages, hidden when the keepers drowned
// the archive, lie in the Flooded Stacks, in the Map Room and in the Lost
// Carrel (a secret, up a walkway off the east bridge). With them the Ledger
// opens, and its newest entry is in the player's own hand.

import { CHUNK_SIZE } from '../../config';
import { SimplexNoise } from '../../generation/Noise';
import { Rng } from '../../generation/Random';
import { Deco, isSolid, isVoid, Tile } from '../../generation/Tiles';
import { DIMENSION_FORMAT, rle, toBase64, type DimensionFile, type PlotFile, type SiteFile } from '../DimensionData';
import { GLYPH_COUNT } from '../Hollow';

const W = 256;
const H = 256;
const SEED = 0xa4c41e;

type XY = [number, number];
type R = { x: number; y: number; w: number; h: number };

const REGIONS = ['The Lower Stacks', 'The Reading Room', 'The Flooded Stacks', 'The Cipher Wing', 'The Sluice Wing', 'The Atrium', 'The Map Room', 'The Lost Carrel', 'The Ink Sea'];
const LOWER = 0;
const READING = 1;
const STACKS = 2;
const CIPHER = 3;
const SLUICE = 4;
const ATRIUM_R = 5;
const MAPROOM = 6;
const CARREL = 7;
const SEA = 8;

/** Glyph names, as the catalogue stone spells them out. */
const GLYPH_NAMES = ['ring', 'triangle', 'cross', 'diamond', 'moon', 'star'];

/** The landmarks, in tiles. */
const RIFT: XY = [128, 226];
const READING_ROOM: R = { x: 98, y: 132, w: 61, h: 39 };
const LECTERN: XY = [128, 147];
const ONDINE: XY = [130, 148];
const SCRIPTORIUM: R = { x: 30, y: 158, w: 21, h: 17 };
const GALLERY: R = { x: 50, y: 64, w: 19, h: 15 };
const SLUICE_HALL: R = { x: 172, y: 141, w: 55, h: 21 };
const ATRIUM: R = { x: 115, y: 70, w: 27, h: 25 };
const VAULT: R = { x: 123, y: 42, w: 11, h: 9 };
const PORTAL: XY = [128, 45];
const CHEST: XY = [131, 46];
const MAP_ROOM_AT: XY = [240, 151];
const CARREL_AT: XY = [200, 100];
/** The Sluice Hall's valves (ledge, then mid-flood islands), and its bands. */
const VALVES: XY[] = [[176, 151], [191, 151], [204, 151]];

const RELICS: Array<{ id: string; at: XY; name: string }> = [
  { id: 'index-drowned', at: [38, 132], name: 'Index of the Drowned' },
  { id: 'index-kept', at: [243, 151], name: 'Index of the Kept' },
  { id: 'index-null', at: [202, 98], name: 'Index of the Null' },
];

const PLOT: PlotFile = {
  resident: { name: 'Ondine', x: ONDINE[0], y: ONDINE[1], look: 'keeper' },
  goal: 'the Ledger of the Drift',
  relics: RELICS.map((r) => ({ id: r.id, x: r.at[0], y: r.at[1], name: r.name })),
  talk: {
    first: [
      'Another reader. It has been so long. I am Ondine, last of the keepers. Mind the water: it is ink, mostly, and memory, and it does not forgive.',
      'This is where we wrote down every place the world let go of. Not to bring them back. The Drift is the world breathing. But so that nothing would be lost entirely. The roads you came by were ours: we walked them to visit the lost.',
      'When the Null began to follow our roads home, we drowned the archive and tore the index out of the Ledger, so the way could never be opened again. Three pages. I hid them, and then I forgot where. Will you find them?',
    ],
    waiting: 'The Ledger lies open, and empty: {found} of {of} index pages found. They will be where the water could not reach.',
    ready: [
      'The index. All three. Lay them in… there. Now the Ledger can be read again.',
      'Read it with me. The last entries. I want to know who woke the roads.',
    ],
    after: 'You did not know. I can see that. But the roads are open because of that entry, and the Null walks them. Close what you can. Start with the Archivist. It was my friend, once.',
    cleared: 'The water is stiller already. Past the archive the roads go on, into places even we never catalogued. Take care of the Ledger\'s last line. Write a better one.',
  },
  restored: {
    title: 'The Ledger Opens',
    pages: [
      'The Ledger\'s pages turn by themselves: centuries of lost places in a hundred hands. A valley, a harbour, a hamlet with a bell. Then the entries stop, for a long, long time.',
      'The last entry is new; the ink is barely dry. It names no place. It says: "The road answers. I am going to see where the lost things go." The hand is yours. Ondine looks at you, and does not look away.',
    ],
  },
  closing: {
    title: 'The Archive Sleeps',
    pages: [
      'The tear folds shut, and the black water of the Drowned Archive lies still. On the Great Lectern the Ledger closes itself, gently, like a book someone means to come back to.',
      'You know now whose hand woke the network. You do not yet know why, or what the Null wants with roads it never built. The answers are further out. So are the next rifts.',
    ],
  },
  reward: { xp: 200, items: [{ item: 'rift-shard', count: 3 }, { item: 'gem', count: 1 }] },
};

export function bakeArchive(): DimensionFile {
  return new ArchiveBaker().bake();
}

class ArchiveBaker {
  private readonly ground = new Uint8Array(W * H).fill(Tile.Void);
  private readonly decos = new Uint8Array(W * H);
  /** No decorations here: sites, walkways, round stones. */
  private readonly keep = new Uint8Array(W * H);
  private readonly rng = new Rng(SEED);
  private readonly edge = new SimplexNoise(SEED ^ 0x11);
  private readonly patch = new SimplexNoise(SEED ^ 0x22);
  private readonly sites: SiteFile[] = [];
  private readonly clues: Array<{ id: string; x: number; y: number; title: string; pages: string[] }> = [];

  bake(): DimensionFile {
    this.land();
    this.walkways();
    this.lowerStacks();
    this.readingRoom();
    this.floodedStacks();
    this.scriptorium();
    this.cipherWing();
    this.sluiceHall();
    this.mapRoom();
    this.carrel();
    this.atrium();
    this.stones();
    this.relics();
    this.cliffs();
    this.furnish();
    this.check();
    const cw = W / CHUNK_SIZE;
    const regionMap = new Uint8Array(cw * (H / CHUNK_SIZE));
    for (let cy = 0; cy < H / CHUNK_SIZE; cy++) for (let cx = 0; cx < cw; cx++) regionMap[cy * cw + cx] = regionAt(cx * CHUNK_SIZE + 16, cy * CHUNK_SIZE + 16);
    return {
      format: DIMENSION_FORMAT,
      id: 'archive',
      name: 'The Drowned Archive',
      width: W,
      height: H,
      mood: { darkness: 0.5, tint: 0x0e2a3a, music: 'archive' },
      tiles: toBase64(rle(this.ground)),
      decos: toBase64(rle(this.decos)),
      regions: REGIONS,
      regionMap: toBase64(rle(regionMap)),
      rift: RIFT,
      portal: PORTAL,
      chest: CHEST,
      sites: this.sites,
      clues: this.clues,
      spawns: [
        { rect: [92, 194, 72, 34], species: ['drowned-page'], cap: 3 },
        { rect: [14, 118, 70, 64], species: ['drowned-page', 'ink-wraith'], cap: 4 },
        { rect: [30, 56, 60, 52], species: ['ink-wraith', 'drowned-page'], cap: 3 },
        { rect: [160, 112, 30, 30], species: ['ink-wraith'], cap: 2 },
        { rect: [104, 96, 48, 34], species: ['null-shade', 'ink-wraith'], cap: 3 },
        { rect: [228, 140, 22, 22], species: ['drowned-page'], cap: 2 },
      ],
      plot: PLOT,
    };
  }

  // Helpers ---------------------------------------------------------------------

  private at(x: number, y: number): number {
    return y * W + x;
  }

  private inside(x: number, y: number): boolean {
    return x >= 0 && y >= 0 && x < W && y < H;
  }

  private set(x: number, y: number, t: number): void {
    if (this.inside(x, y)) this.ground[this.at(x, y)] = t;
  }

  private fill(r: R, t: number): void {
    for (let y = r.y; y < r.y + r.h; y++) for (let x = r.x; x < r.x + r.w; x++) this.set(x, y, t);
  }

  private protect(r: R, pad = 0): void {
    for (let y = r.y - pad; y < r.y + r.h + pad; y++) for (let x = r.x - pad; x < r.x + r.w + pad; x++) if (this.inside(x, y)) this.keep[this.at(x, y)] = 1;
  }

  private land1(x: number, y: number): boolean {
    return this.inside(x, y) && !isVoid(this.ground[this.at(x, y)]);
  }

  private deco(x: number, y: number, d: number): void {
    if (this.inside(x, y)) this.decos[this.at(x, y)] = d;
  }

  /** The floor a tile of open land should be: marble, wet in patches. */
  private floor(x: number, y: number): number {
    const n = this.patch.noise2(x / 14, y / 14);
    if (n > 0.45) return Tile.Shallows;
    if (n > 0.15) return Tile.ArchiveWet;
    return Tile.ArchiveFloor;
  }

  /** A walled hall of shelves: book walls round it, floor inside. */
  private hall(r: R, inner = Tile.ArchiveFloor): void {
    this.fill(r, Tile.BookWall);
    for (let y = r.y + 1; y < r.y + r.h - 1; y++) for (let x = r.x + 1; x < r.x + r.w - 1; x++) this.set(x, y, inner === Tile.ArchiveFloor ? this.dryFloor(x, y) : inner);
  }

  /** Marble, wet in patches, never wading-deep (for halls and sites). */
  private dryFloor(x: number, y: number): number {
    return this.patch.noise2(x / 9, y / 9) > 0.3 ? Tile.ArchiveWet : Tile.ArchiveFloor;
  }

  /** A straight walkway `width` wide from a to b (axis-aligned legs). */
  private walk(a: XY, b: XY, width = 5, t?: number): void {
    const half = width >> 1;
    let [x, y] = a;
    const put = () => {
      for (let dy = -half; dy <= half; dy++) for (let dx = -half; dx <= half; dx++) {
        const gx = x + dx;
        const gy = y + dy;
        if (!this.inside(gx, gy)) continue;
        const i = this.at(gx, gy);
        if (isVoid(this.ground[i]) || this.ground[i] === Tile.InkWater) this.ground[i] = t ?? this.dryFloor(gx, gy);
        this.keep[i] = 1;
      }
    };
    put();
    while (x !== b[0]) {
      x += Math.sign(b[0] - x);
      put();
    }
    while (y !== b[1]) {
      y += Math.sign(b[1] - y);
      put();
    }
  }

  // The land --------------------------------------------------------------------

  /** Islands of the library adrift in the void, ragged at the edges. */
  private land(): void {
    const masses: Array<[number, number, number, number]> = [
      [128, 210, 44, 22], // the Lower Stacks
      [128, 151, 40, 27], // round the Reading Room
      [50, 148, 36, 32], // the Flooded Stacks
      [60, 80, 32, 26], // the Cipher Wing
      [199, 151, 34, 18], // the Sluice Wing
      [241, 151, 12, 12], // the Map Room
      [CARREL_AT[0], CARREL_AT[1], 9, 7], // the Lost Carrel
      [128, 80, 26, 24], // the Atrium's island
      // Drifts of floor, for the view.
      [18, 222, 6, 4], [232, 214, 7, 5], [214, 40, 8, 6], [22, 30, 6, 5], [178, 238, 5, 4], [240, 70, 5, 6],
    ];
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const ragged = 0.18 * this.edge.noise2(x / 8, y / 8) + 0.08 * this.edge.noise2(x / 3, y / 3);
        for (const [cx, cy, rx, ry] of masses) {
          if (Math.hypot((x - cx) / rx, (y - cy) / ry) + ragged < 1) {
            this.ground[this.at(x, y)] = this.floor(x, y);
            break;
          }
        }
      }
    }
    // Pools of black ink in the open floor: too deep to wade.
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const i = this.at(x, y);
        if (this.ground[i] === Tile.Shallows && this.patch.noise2(x / 5, y / 5) > 0.55) this.ground[i] = Tile.InkWater;
      }
    }
    for (let k = 0; k < W; k++) {
      for (let d = 0; d < 3; d++) {
        this.set(k, d, Tile.Void);
        this.set(k, H - 1 - d, Tile.Void);
        this.set(d, k, Tile.Void);
        this.set(W - 1 - d, k, Tile.Void);
      }
    }
  }

  /** Walkways joining the wings, laid over the void and the ink. */
  private walkways(): void {
    this.walk([128, 218], [128, 170]); // Lower Stacks to the Reading Room
    this.walk([98, 151], [72, 151]); // Reading Room to the Flooded Stacks
    this.walk([158, 151], [172, 151]); // Reading Room to the Sluice Hall
    this.walk([56, 126], [56, 92], 4); // Flooded Stacks to the Cipher Wing
    this.walk([128, 132], [128, 95]); // Reading Room to the Atrium
    // To the Lost Carrel: a narrow board-walk north off the east bridge.
    this.walk([166, 149], [166, 112], 2);
    this.walk([166, 112], [196, 112], 2);
    this.walk([196, 112], [196, 102], 2);
  }

  /** The Lower Stacks: the rift home in a ring of marble, rows of shelves round it. */
  private lowerStacks(): void {
    const [rx, ry] = RIFT;
    this.fill({ x: rx - 5, y: ry - 3, w: 11, h: 8 }, Tile.ArchiveFloor);
    for (const [dx, dy] of [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1]]) this.set(rx + dx, ry + dy, Tile.RiftGround);
    this.deco(rx, ry, Deco.Rift);
    this.protect({ x: rx - 7, y: ry - 7, w: 15, h: 14 });
    // Rows of stacks, east and west of the walkway.
    for (const side of [-1, 1]) {
      for (let row = 0; row < 4; row++) {
        const y = 196 + row * 6;
        const x0 = side < 0 ? 96 : 138;
        for (let x = x0; x < x0 + 22; x++) {
          if (!this.land1(x, y) || this.keep[this.at(x, y)]) continue;
          // Gaps to walk through.
          if ((x - x0) % 9 === 4) continue;
          this.set(x, y, Tile.BookWall);
        }
      }
    }
  }

  /** The Reading Room: a great walled hall, carpet down its middle, ink pools
   *  in its corners, lamps, and the Great Lectern with the empty Ledger. */
  private readingRoom(): void {
    const r = READING_ROOM;
    this.hall(r);
    // Doorways on every side.
    for (let k = -2; k <= 2; k++) {
      this.set(128 + k, r.y, Tile.ArchiveFloor);
      this.set(128 + k, r.y + r.h - 1, Tile.ArchiveFloor);
      this.set(r.x, 151 + k, Tile.ArchiveFloor);
      this.set(r.x + r.w - 1, 151 + k, Tile.ArchiveFloor);
    }
    for (let y = r.y + 2; y < r.y + r.h - 2; y++) for (let x = 124; x <= 132; x++) this.set(x, y, Tile.ArchiveCarpet);
    for (let x = r.x + 2; x < r.x + r.w - 2; x++) for (let y = 149; y <= 153; y++) this.set(x, y, Tile.ArchiveCarpet);
    for (const [px, py] of [[104, 137], [146, 137], [104, 160], [146, 160]]) this.fill({ x: px, y: py, w: 7, h: 5 }, Tile.InkWater);
    // Reading tables of stacked books, lamps along the carpet.
    for (const [x, y] of [[110, 142], [146, 144], [110, 158], [146, 156]]) this.deco(x, y, Deco.Lectern);
    for (let y = r.y + 4; y < r.y + r.h - 4; y += 6) {
      this.deco(122, y, Deco.Lamp);
      this.deco(134, y, Deco.Lamp);
    }
    this.deco(...LECTERN, Deco.Lectern);
    this.protect(r, 1);
  }

  /** The Flooded Stacks: long shelves standing in the shallows. */
  private floodedStacks(): void {
    for (let row = 0; row < 7; row++) {
      const y = 122 + row * 6;
      for (let x = 22; x < 84; x++) {
        if (!this.land1(x, y) || this.keep[this.at(x, y)]) continue;
        if ((x + row * 3) % 11 < 3) continue;
        this.set(x, y, Tile.BookWall);
      }
    }
  }

  /** The Scriptorium: waves come out of the drowned pages; its gate seals. */
  private scriptorium(): void {
    const r = SCRIPTORIUM;
    this.walk([62, 166], [r.x + r.w, 166], 5);
    this.hall(r);
    const gx = r.x + r.w - 1;
    const gate: XY[] = [];
    for (let y = 165; y <= 167; y++) {
      this.set(gx, y, Tile.ArchiveFloor);
      gate.push([gx, y]);
    }
    for (const [x, y] of [[35, 162], [45, 170], [36, 171]]) this.deco(x, y, Deco.BookPile);
    const spawns: XY[] = [];
    const inner = { x: r.x + 3, y: r.y + 3, w: r.w - 6, h: r.h - 6 };
    for (let x = inner.x; x < inner.x + inner.w; x += 3) for (const y of [inner.y, inner.y + inner.h - 1]) spawns.push([x + 0.5, y + 0.9]);
    this.protect(r, 2);
    this.sites.push({ kind: 'combat', name: 'The Scriptorium', rect: [r.x, r.y, r.w, r.h], entry: [r.x + r.w + 1.5, 166.9], center: [r.x + 10.5, 166.9], gates: gate, spawns });
  }

  /** The Cipher Wing: the gallery's plates must be pressed in the catalogue's
   *  order, and the order is written on the stone outside its door. */
  private cipherWing(): void {
    const r = GALLERY;
    this.hall(r);
    for (let x = 58; x <= 60; x++) this.set(x, r.y + r.h - 1, Tile.ArchiveFloor);
    const rng = this.rng;
    const pool = Array.from({ length: GLYPH_COUNT }, (_, g) => g);
    shuffle(pool, rng);
    const glyphs = pool.slice(0, 5);
    const order = shuffle(glyphs.slice(), rng);
    const mural: Array<[number, number, number]> = order.map((g, k) => [54 + k * 2, r.y + 1, g]);
    const spots: XY[] = [];
    for (let y = r.y + 4; y <= r.y + r.h - 4; y += 2) for (let x = r.x + 3; x <= r.x + r.w - 4; x += 2) spots.push([x, y]);
    shuffle(spots, rng);
    const plates: Array<[number, number, number]> = glyphs.map((g, k) => [spots[k][0], spots[k][1], g]);
    this.protect(r, 2);
    this.walk([59, r.y + r.h], [59, 92], 3);
    this.sites.push({ kind: 'puzzle', name: 'The Cipher Gallery', rect: [r.x, r.y, r.w, r.h], entry: [59.5, r.y + r.h + 1.9], center: [59.5, 71.9], plates, mural, hint: 'text' });
    const named = order.map((g) => `the ${GLYPH_NAMES[g]}`);
    this.clues.push({
      id: 'catalogue-stone',
      x: 54,
      y: 84,
      title: 'IV. The Catalogue',
      pages: [
        '"Visitors to the gallery: the plates are shelved in catalogue order, as every keeper learns on the first day. A wrong plate returns the shelf to its start."',
        `"The catalogue reads: first ${named[0]}, then ${named.slice(1, -1).join(', then ')}, and last ${named[named.length - 1]}."`,
      ],
    });
  }

  /** The Sluice Hall: the ledge, three bands of flooded floor between three
   *  valves, and the far side. Shelves stand in the water, so the dry way
   *  across winds. */
  private sluiceHall(): void {
    const r = SLUICE_HALL;
    this.hall(r);
    // Ways in and out.
    for (let y = 150; y <= 152; y++) {
      this.set(r.x, y, Tile.ArchiveFloor);
      this.set(r.x + r.w - 1, y, Tile.ArchiveFloor);
    }
    const flood: Array<[number, number, number]> = [];
    // Each band runs up to and round the next valve, so the water rising
    // over a band takes everyone on it back (none is left on an island).
    const bands: Array<[number, number, number]> = [
      [178, 191, 3],
      [192, 204, 2],
      [205, 216, 1],
    ];
    const valve = new Set(VALVES.map(([x, y]) => this.at(x, y)));
    for (const [x0, x1, depth] of bands) {
      for (let y = r.y + 1; y < r.y + r.h - 1; y++) {
        for (let x = x0; x <= x1; x++) {
          // Shelves standing in the flood, staggered.
          const shelf = x < x1 && (x - x0) % 6 === 3 && ((x - x0) % 12 === 3 ? y < 151 - 1 : y > 151 + 1);
          if (shelf) {
            this.set(x, y, Tile.BookWall);
            continue;
          }
          if (valve.has(this.at(x, y))) continue;
          this.set(x, y, Tile.ArchiveWet);
          flood.push([x, y, depth]);
        }
      }
    }
    // The valves: the first on the ledge, the rest on islands in the flood.
    for (const [x, y] of VALVES) this.set(x, y, Tile.ArchiveFloor);
    this.fill({ x: 173, y: r.y + 1, w: 5, h: r.h - 2 }, Tile.ArchiveFloor);
    this.fill({ x: 217, y: r.y + 1, w: 9, h: r.h - 2 }, Tile.ArchiveFloor);
    this.protect(r, 1);
    this.sites.push({
      kind: 'tide',
      name: 'The Sluice Hall',
      rect: [r.x, r.y, r.w, r.h],
      entry: [170.5, 151.9],
      center: [199.5, 151.9],
      checkpoints: [[175.5, 152.9]],
      valves: VALVES,
      flood,
      goal: [217, r.y + 1, 9, r.h - 2],
    });
  }

  /** The Map Room, past the Sluice Hall: a round room of charts. */
  private mapRoom(): void {
    const [cx, cy] = MAP_ROOM_AT;
    this.walk([227, 151], [cx - 6, 151], 3);
    for (let y = cy - 7; y <= cy + 7; y++) {
      for (let x = cx - 9; x <= cx + 9; x++) {
        const d = Math.hypot((x - cx) / 9, (y - cy) / 7);
        if (d > 1) continue;
        this.set(x, y, d > 0.86 ? Tile.BookWall : Tile.ArchiveCarpet);
        this.keep[this.at(x, y)] = 1;
      }
    }
    for (let x = cx - 9; x <= cx - 6; x++) for (let y = 150; y <= 152; y++) this.set(x, y, Tile.ArchiveFloor);
    this.deco(cx - 2, cy - 4, Deco.Telescope);
    this.deco(cx + 4, cy - 3, Deco.Lectern);
    this.deco(cx + 3, cy + 4, Deco.BookPile);
  }

  /** The Lost Carrel: a reading nook adrift on its own, where a keeper hid
   *  an index page and a note. */
  private carrel(): void {
    const [cx, cy] = CARREL_AT;
    this.protect({ x: cx - 5, y: cy - 4, w: 11, h: 9 });
    this.set(cx - 3, cy - 2, Tile.ArchiveCarpet);
    this.deco(cx + 3, cy - 1, Deco.Lamp);
    this.deco(cx - 3, cy + 1, Deco.BookPile);
  }

  /** The Atrium: the Archivist's hall, sealed until the three trials are
   *  done, the vault and its portal behind it to the north. */
  private atrium(): void {
    const r = ATRIUM;
    this.fill({ x: 112, y: 30, w: 33, h: 40 }, Tile.Void);
    this.hall(r);
    const gate: XY[] = [];
    const gy = r.y + r.h - 1;
    for (let x = 127; x <= 129; x++) {
      this.set(x, gy, Tile.ArchiveFloor);
      gate.push([x, gy]);
      this.set(x, r.y, Tile.ArchiveFloor);
    }
    // The corridor and the vault.
    this.fill({ x: 126, y: 50, w: 5, h: 20 }, Tile.BookWall);
    this.fill({ x: 127, y: 49, w: 3, h: 21 }, Tile.ArchiveFloor);
    this.hall(VAULT);
    for (let x = 127; x <= 129; x++) this.set(x, VAULT.y + VAULT.h - 1, Tile.ArchiveFloor);
    this.set(...PORTAL, Tile.ArchiveFloor);
    this.set(...CHEST, Tile.ArchiveFloor);
    this.protect({ x: 112, y: 30, w: 33, h: 66 });
    // A ring of carpet under the Archivist, and pillars round it.
    const cx = 128;
    const cy = 82;
    for (let y = r.y + 1; y < r.y + r.h - 1; y++) {
      for (let x = r.x + 1; x < r.x + r.w - 1; x++) {
        const d = Math.hypot(x - cx, y - cy);
        if (d > 3 && d < 4.2) this.set(x, y, Tile.ArchiveCarpet);
      }
    }
    for (let k = 0; k < 6; k++) {
      const a = (k / 6) * Math.PI * 2 + Math.PI / 6;
      this.deco(Math.round(cx + Math.cos(a) * 8), Math.round(cy + Math.sin(a) * 7), Deco.Pillar);
    }
    const spawns: XY[] = [];
    for (let k = 0; k < 8; k++) {
      const a = (k / 8) * Math.PI * 2;
      spawns.push([Math.round(cx + Math.cos(a) * 5) + 0.5, Math.round(cy + Math.sin(a) * 5) + 0.9]);
    }
    this.sites.push({ kind: 'boss', name: 'The Atrium', rect: [r.x, r.y, r.w, r.h], entry: [128.5, r.y + r.h + 1.9], center: [cx + 0.5, cy + 0.9], gates: gate, spawns });
    this.sites.push({ kind: 'vault', name: 'The Vault', rect: [VAULT.x, VAULT.y, VAULT.w, VAULT.h], entry: [128.5, VAULT.y + VAULT.h - 1.1], center: [128.5, 46.9] });
  }

  /** The lore stones, numbered in the order they read best. */
  private stones(): void {
    const stones: Array<{ id: string; at: XY; title: string; pages: string[] }> = [
      {
        id: 'porter-stone',
        at: [121, 223],
        title: 'I. The Porter\'s Stone',
        pages: ['"Welcome, reader. Here are kept the names of every place the world let go of. Walk softly; most of them are sleeping."'],
      },
      {
        id: 'charter-stone',
        at: [120, 166],
        title: 'II. The Keepers\' Charter',
        pages: [
          '"We do not undo the Drift. The Drift is the world breathing: what is let go makes room for what comes. We only remember."',
          '"And we built roads, so the lost could be visited. Not brought back. Visited. So a grandmother might stand once more in the square where she was born, and then come home."',
        ],
      },
      {
        id: 'stacks-stone',
        at: [66, 140],
        title: 'III. On the Shelving of Places',
        pages: ['"Every place is shelved where it drifted from, and when. Some shelves are very long. Some places drift twice. Some, we think, drifted here from worlds that were never ours."'],
      },
      {
        id: 'flood-stone',
        at: [168, 146],
        title: 'V. The Flood',
        pages: [
          '"The Null found our roads. It does not walk; it spreads, and it spread along them, back toward the kept world. So we drowned the archive, to drown the roads\' ink, and tore the index out of the Ledger."',
          '"Without the index the Ledger cannot be written in, and without the Ledger no road can open. That was the whole of our plan. It was a good plan, while it lasted."',
        ],
      },
      {
        id: 'carrel-stone',
        at: [198, 98],
        title: 'VI. The Last Keeper\'s Note',
        pages: [
          '"Ondine stays. Someone must. I have hidden the last page where only someone looking very hard would find it."',
          '"If the Ledger is ever written in again, it will be by someone who does not know what it is. Forgive them, Ondine. Then stop them."',
        ],
      },
    ];
    for (const c of stones) this.clues.push({ id: c.id, x: c.at[0], y: c.at[1], title: c.title, pages: c.pages });
    this.clues.sort((a, b) => a.title.localeCompare(b.title));
    for (const c of this.clues) {
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const i = this.at(c.x + dx, c.y + dy);
          if (isVoid(this.ground[i]) || this.ground[i] === Tile.InkWater || this.ground[i] === Tile.BookWall) this.ground[i] = Tile.ArchiveFloor;
          this.keep[i] = 1;
        }
      }
      this.deco(c.x, c.y, Deco.LoreStone);
    }
  }

  /** The index pages, each on open floor. */
  private relics(): void {
    for (const r of RELICS) {
      const [x, y] = r.at;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const i = this.at(x + dx, y + dy);
          if (isVoid(this.ground[i]) || this.ground[i] === Tile.InkWater || this.ground[i] === Tile.BookWall) this.ground[i] = Tile.ArchiveFloor;
          this.keep[i] = 1;
        }
      }
      this.deco(x, y, Deco.Relic);
    }
    const [ox, oy] = ONDINE;
    this.keep[this.at(ox, oy)] = 1;
  }

  /** The land's underside hangs into the void below it. */
  private cliffs(): void {
    for (let y = H - 1; y > 0; y--) {
      for (let x = 0; x < W; x++) {
        const i = this.at(x, y);
        if (this.ground[i] === Tile.Void && !isVoid(this.ground[i - W])) this.ground[i] = Tile.VoidCliff;
      }
    }
  }

  /** Book piles, lamps, lecterns and shelves among the stacks, never crowding. */
  private furnish(): void {
    const table: Array<Array<[number, number]>> = [];
    table[LOWER] = [[Deco.BookPile, 0.025], [Deco.Bookshelf, 0.01], [Deco.Crate, 0.004]];
    table[READING] = [[Deco.BookPile, 0.02], [Deco.Book, 0.004]];
    table[STACKS] = [[Deco.BookPile, 0.04], [Deco.Bookshelf, 0.015], [Deco.Barrel, 0.004]];
    table[CIPHER] = [[Deco.BookPile, 0.025], [Deco.Statue, 0.003], [Deco.Bookshelf, 0.01]];
    table[SLUICE] = [[Deco.BookPile, 0.02], [Deco.Barrel, 0.006]];
    table[ATRIUM_R] = [[Deco.BookPile, 0.015]];
    table[MAPROOM] = [[Deco.BookPile, 0.02]];
    table[CARREL] = [[Deco.BookPile, 0.03]];
    table[SEA] = [[Deco.BookPile, 0.02]];
    const rng = new Rng(SEED ^ 0x44);
    for (let y = 1; y < H - 1; y++) {
      for (let x = 1; x < W - 1; x++) {
        const i = this.at(x, y);
        const roll = rng.next();
        const t = this.ground[i];
        if (this.keep[i] || this.decos[i] || (t !== Tile.ArchiveFloor && t !== Tile.ArchiveWet)) continue;
        // Nothing beside the void or a wall: the aisles stay open.
        let open = true;
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const n = this.ground[this.at(x + dx, y + dy)];
          if (isVoid(n) || n === Tile.BookWall || n === Tile.InkWater) open = false;
        }
        if (!open) continue;
        let acc = 0;
        for (const [deco, p] of table[regionAt(x, y)] ?? []) {
          acc += p;
          if (roll >= acc) continue;
          this.decos[i] = deco;
          break;
        }
      }
    }
    // Lamps along the walkways, every so often.
    for (let y = 172; y < 216; y += 8) this.deco(125, y, Deco.Lamp);
    for (let y = 98; y < 130; y += 8) this.deco(125, y, Deco.Lamp);
  }

  /** The bake fails rather than ship a map that cannot be finished. */
  private check(): void {
    const sites = this.sites;
    const overlay = new Set<number>();
    for (const s of sites) for (const [x, y] of s.flood ?? []) overlay.add(this.at(x, y));
    for (const s of sites) for (const [x, y] of s.valves ?? []) overlay.add(this.at(x, y));
    const reach = (bossOpen: boolean): Uint8Array => {
      const gates = new Set<number>();
      if (!bossOpen) for (const s of sites) if (s.kind === 'boss') for (const [x, y] of s.gates ?? []) gates.add(this.at(x, y));
      const solid = new Set<number>();
      for (const s of sites) for (const [x, y] of s.mural ?? []) solid.add(this.at(x, y));
      solid.add(this.at(...CHEST));
      const seen = new Uint8Array(W * H);
      const start = this.at(RIFT[0], RIFT[1] + 1);
      const stack = [start];
      seen[start] = 1;
      while (stack.length) {
        const t = stack.pop()!;
        const x = t % W;
        const y = Math.floor(t / W);
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const nx = x + dx;
          const ny = y + dy;
          if (!this.inside(nx, ny)) continue;
          const n = this.at(nx, ny);
          if (seen[n] || gates.has(n) || solid.has(n)) continue;
          const open = overlay.has(n) || (!isVoid(this.ground[n]) && !isSolid(this.ground[n], this.decos[n]));
          if (!open) continue;
          seen[n] = 1;
          stack.push(n);
        }
      }
      return seen;
    };
    const all = reach(true);
    const tileOf = ([x, y]: XY) => this.at(Math.floor(x), Math.floor(y));
    const beside = (seen: Uint8Array, t: number) => [1, -1, W, -W].some((d) => seen[t + d] === 1);
    for (const s of sites) {
      if (!all[tileOf(s.entry)]) throw new Error(`The Drowned Archive: ${s.name} cannot be reached`);
      for (const p of s.checkpoints ?? []) if (!all[tileOf(p)]) throw new Error(`The Drowned Archive: the ledge of ${s.name} cannot be reached`);
      for (const [x, y] of s.plates ?? []) if (!all[this.at(x, y)]) throw new Error(`The Drowned Archive: a plate of ${s.name} cannot be reached`);
      for (const [x, y] of s.valves ?? []) if (!all[this.at(x, y)]) throw new Error(`The Drowned Archive: a valve of ${s.name} cannot be reached`);
      for (const p of s.spawns ?? []) if (!all[tileOf(p)]) throw new Error(`The Drowned Archive: a spawn of ${s.name} is shut in`);
      if (s.goal) {
        const [gx, gy, gw, gh] = s.goal;
        let ok = false;
        for (let y = gy; y < gy + gh && !ok; y++) for (let x = gx; x < gx + gw && !ok; x++) ok = all[this.at(x, y)] === 1;
        if (!ok) throw new Error(`The Drowned Archive: the far side of ${s.name} cannot be reached`);
      }
    }
    if (!all[this.at(...PORTAL)] || !beside(all, this.at(...CHEST))) throw new Error('The Drowned Archive: the vault cannot be reached');
    for (const c of this.clues) if (!beside(all, this.at(c.x, c.y))) throw new Error(`The Drowned Archive: the stone ${c.id} cannot be reached`);
    for (const r of RELICS) if (!beside(all, this.at(...r.at))) throw new Error(`The Drowned Archive: the ${r.name} cannot be reached`);
    if (!all[this.at(...ONDINE)]) throw new Error('The Drowned Archive: Ondine cannot be reached');
    if (reach(false)[this.at(...PORTAL)]) throw new Error("The Drowned Archive: the vault can be reached around the Atrium's gate");
  }
}

/** The region a tile is in, by where it lies. */
function regionAt(x: number, y: number): number {
  if (y >= 186) return LOWER;
  if (x >= 228) return MAPROOM;
  if (x >= 186 && y < 124) return CARREL;
  if (x >= 160 && y >= 124) return SLUICE;
  if (x >= 104 && x < 152 && y < 112) return ATRIUM_R;
  if (x < 96 && y < 108) return CIPHER;
  if (x < 92) return STACKS;
  if (x >= 96 && x < 162 && y >= 124) return READING;
  return SEA;
}

function shuffle<T>(a: T[], rng: Rng): T[] {
  for (let k = a.length - 1; k > 0; k--) {
    const j = rng.int(0, k);
    [a[k], a[j]] = [a[j], a[k]];
  }
  return a;
}
