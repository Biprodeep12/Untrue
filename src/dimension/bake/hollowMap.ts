// Bakes The Hollow's fixed map: run once (npm run bake), and the output,
// public/dimensions/hollow.json, is the map everyone plays. It is built from a
// fixed seed around hand-placed landmarks, so baking again gives the same file.
//
// The land: islands of violet moss, ash fields and crystal-strewn shores adrift
// in a void, tied together by ruined causeways. In the middle the Causeway, a
// ruined plaza; around it the three trials (the Glitch Nest in the Ash Fields,
// the Crumbling Path across a chasm to the Far Shelf, the Glyph Hall in the
// Glyphwood), and to the north, on Warden's Rise, the Warden's arena, sealed
// until all three are done, guarding the vault with the portal home. Round
// the Warden's plateau the ground is pocked with the Null's marks.
//
// Off the Shattered Shore drift two places the world let go of: a patch of
// ordinary forest (A Drifted Wood) and the ruins of a hamlet (The Lost
// Hamlet), in the overworld's own grass, timber and stone. This is where
// drifted land goes.
//
// The plot: Isolde, the hamlet's bell-ringer, waits by an empty bell frame.
// Her father kept watch on the old road and became the Warden when the Null
// came up it. The bell's three pieces lie in the Ember Watch (Ash Fields), on
// the Far Shelf (past the Crumbling Path) and on the Quiet Islet (a secret,
// at the end of a broken causeway out of the Glyphwood). Rung again, the bell
// lets the Warden remember, for a moment, who came up the road before the hum.
// Elsewhere: the Sunken Shrine in the Crystal Reach, a graveyard behind the
// hamlet, and seven lore stones, numbered so they read in order.

import { CHUNK_SIZE } from '../../config';
import { Rng } from '../../generation/Random';
import { SimplexNoise } from '../../generation/Noise';
import { Deco, Ground, groundTile, isSolid, isVoid, Tile } from '../../generation/Tiles';
import { DIMENSION_FORMAT, rle, toBase64, type DimensionFile, type SiteFile } from '../DimensionData';
import { GLYPH_COUNT } from '../Hollow';

const W = 256;
const H = 256;
const SEED = 0x401104;

type XY = [number, number];

/** Region names, as the HUD shows them. */
const REGIONS = ['Shattered Shore', 'Ash Fields', 'Crystal Reach', 'Glyphwood', 'Ruined Causeway', "Warden's Rise", 'The Far Shelf', 'A Drifted Wood', 'The Lost Hamlet', 'The Quiet Islet'];
/** Regions that are overworld land, drifted here. */
const WOOD = 7;
const HAMLET = 8;
const ISLET = 9;
/** The overworld forest's grass. */
const GRASS = [groundTile(0, Ground.Base), groundTile(0, Ground.Alt), groundTile(0, Ground.Detail)];

/** The landmarks, in tiles. */
const RIFT: XY = [128, 222];
const NEST = { x: 45, y: 142, w: 19, h: 17 };
const CHASM = { x: 189, y: 125, w: 47, h: 51 };
const SHELF = { x: 212, y: 143, w: 15, h: 15 };
const PATH_SITE = { x: 188, y: 138, w: 25, h: 25 };
const HALL = { x: 60, y: 59, w: 17, h: 15 };
const ARENA = { x: 117, y: 60, w: 23, h: 21 };
const VAULT = { x: 123, y: 40, w: 11, h: 9 };
const PORTAL: XY = [128, 43];
const CHEST: XY = [131, 44];
/** The drifted fragments' middles. */
const WOOD_AT: XY = [40, 212];
const HAMLET_AT: XY = [218, 214];
/** Landmarks of the plot and the secrets. */
const EMBER_WATCH = { x: 30, y: 134, w: 7, h: 7 };
const SHRINE_AT: XY = [166, 128];
const ISLET_AT: XY = [26, 20];
const BELL: XY = [214, 211];
const ISOLDE: XY = [216, 212];
const RELICS: Array<{ id: string; at: XY; name: string }> = [
  { id: 'bell-crown', at: [33, 137], name: 'bell crown' },
  { id: 'bell-lip', at: [222, 153], name: 'bell lip' },
  { id: 'bell-clapper', at: [28, 19], name: 'bell clapper' },
];

/** The Lost Hamlet's bell, and the watchman who became the Warden. */
const PLOT = {
  resident: { name: 'Isolde', x: ISOLDE[0], y: ISOLDE[1], look: 'hamlet-ghost' },
  goal: "the hamlet's bell",
  relics: RELICS.map((r) => ({ id: r.id, x: r.at[0], y: r.at[1], name: r.name })),
  talk: {
    first: [
      'You can see me? Then you are not from here. I am Isolde. I rang the bell of this hamlet, before it drifted. When the Drift took us we came here slowly, the whole hamlet, like falling asleep.',
      'My father kept watch on the old road, the one with the gate. When the hum came up the road he went to meet it, and he did not come back the same. Now they call him the Warden.',
      "The bell broke the night the tear opened. Its pieces are scattered across the Hollow: the crown, the lip, the clapper. If it rang once more, he might hear it. He might remember he was a man. Will you find them?",
    ],
    waiting: 'The bell is in pieces still: {found} of {of} found. Listen as you walk. Bronze hums back when the void does.',
    ready: [
      'You found them. All of them. Hold the crown steady while I set the lip… there. And the clapper.',
      'Stand back. It has been a long time since anything here made a sound on purpose.',
    ],
    after: 'He heard it. I know he did. When you face him, be quick. Let him rest.',
    cleared: 'He is at peace. The bell will ring as long as this place is remembered. Go on: there are other lost places, and other keepers waiting in them.',
  },
  restored: {
    title: 'The Bell Rings',
    pages: [
      "The bell rings out across the void, clear and very old. Far off on Warden's Rise the Warden stops. For a heartbeat it is only a man in a watchman's coat, turning toward the sound.",
      'Isolde listens to something you cannot hear. "He remembers. Someone came up the road before the hum, he says. Someone with ash on their hands, asking the way into the old network. He showed them the way. He has been sorry ever since."',
    ],
  },
  closing: {
    title: 'The Hollow Holds',
    pages: [
      'The tear folds shut behind you. In the Hollow, the hamlet bell rings once more, and then the lost places are quiet for the first time since the Fracture.',
      "But the network's roads run on past the Hollow, deeper, toward a place where every lost thing was written down. A drowned library, the stones said. The next rift you find may open there.",
    ],
  },
  reward: { xp: 120, items: [{ item: 'rift-shard', count: 2 }, { item: 'coin', count: 40 }] },
};

const CLUES: Array<{ id: string; at: XY; title: string; pages: string[] }> = [
  {
    id: 'first-stone',
    at: [121, 219],
    title: 'I. A Stone by the Rift',
    pages: [
      'Carved in a hand you almost know: "What the world lets go of does not end. It drifts. Out past the edge of everything kept, it comes here, and so did we."',
      '"Our grandparents told us the land behind us would drift, as it always had. They were right. They never said where it went."',
    ],
  },
  {
    id: 'causeway-stone',
    at: [128, 145],
    title: 'II. The Causeway Stone',
    pages: [
      '"The roads were old when we drifted in. Someone laid them to join one lost place to another, all the way out into the dark. A network, the elders said. Asleep. Best left asleep."',
    ],
  },
  {
    id: 'burnt-stone',
    at: [214, 206],
    title: 'III. The Hamlet Stone',
    pages: [
      'Scorched along one edge: "For as long as anyone remembered, the Drift was a slow tide. Places went, and new ones came. You learned to say goodbye."',
      '"Then the old roads woke, and the tide began to tear. Now holes open between what is kept and what is lost, and things come through that were never part of either."',
    ],
  },
  {
    id: 'listening-stone',
    at: [48, 84],
    title: 'IV. The Listening Stone',
    pages: [
      '"Past the furthest of the lost places there is a place where nothing has ever been. We call it the Null. It does not hate. It does not want. It only spreads, wherever the edges thin."',
      '"Hush. When the wind drops you can hear it hum."',
    ],
  },
  {
    id: 'far-stone',
    at: [220, 147],
    title: 'V. The Stone Beyond the Path',
    pages: [
      '"The Warden was set at the crossing to keep the old roads shut. Something reached it before we did. Look at its eyes when it turns: there is nothing behind them now. Only the hum."',
    ],
  },
  {
    id: 'last-stone',
    at: [125, 44],
    title: 'VI. The Last Stone',
    pages: [
      '"Close the tear, and the edge mends here, for a while. But the network is awake, and it did not wake by itself. Someone came looking for where the lost places go."',
      'Below, newer, scratched in haste, in a hand very like your own: "I only wanted to see."',
    ],
  },
  {
    id: 'quiet-stone',
    at: [24, 19],
    title: 'VII. The Stone Nobody Was Meant to Find',
    pages: [
      '"The keepers of the roads wrote down every place that drifted, so that nothing would be lost entirely. Their library is past here, under black water now. If you are reading this, you found the way the keepers used."',
      'Scratched beneath, in the same hurried hand as the Last Stone: "Found their ledger. It answers when you write in it. I wrote."',
    ],
  },
];

export function bakeHollow(): DimensionFile {
  return new HollowBaker().bake();
}

class HollowBaker {
  private readonly ground = new Uint8Array(W * H).fill(Tile.Void);
  private readonly decos = new Uint8Array(W * H);
  /** No decorations here: sites, causeways, plazas, around stones. */
  private readonly keep = new Uint8Array(W * H);
  private readonly rng = new Rng(SEED);
  private readonly edge = new SimplexNoise(SEED ^ 0x11);
  private readonly patch = new SimplexNoise(SEED ^ 0x22);
  private readonly wobble = new SimplexNoise(SEED ^ 0x33);
  private readonly sites: SiteFile[] = [];

  bake(): DimensionFile {
    this.land();
    this.causeways();
    this.wood();
    this.hamlet();
    this.rise();
    this.chasm();
    this.nest();
    this.hall();
    this.plazas();
    this.stones();
    this.nullMarks();
    this.emberWatch();
    this.shrine();
    this.islet();
    this.bell();
    this.relics();
    this.cliffs();
    this.plant();
    this.check();
    const regionMap = new Uint8Array((W / CHUNK_SIZE) * (H / CHUNK_SIZE));
    for (let cy = 0; cy < H / CHUNK_SIZE; cy++) {
      for (let cx = 0; cx < W / CHUNK_SIZE; cx++) regionMap[cy * (W / CHUNK_SIZE) + cx] = regionAt(cx * CHUNK_SIZE + 16, cy * CHUNK_SIZE + 16);
    }
    return {
      format: DIMENSION_FORMAT,
      id: 'hollow',
      name: 'The Hollow',
      width: W,
      height: H,
      mood: { darkness: 0.55, tint: 0x2a1450, music: 'rift' },
      tiles: toBase64(rle(this.ground)),
      decos: toBase64(rle(this.decos)),
      regions: REGIONS,
      regionMap: toBase64(rle(regionMap)),
      rift: RIFT,
      portal: PORTAL,
      chest: CHEST,
      sites: this.sites,
      clues: CLUES.map((c) => ({ id: c.id, x: c.at[0], y: c.at[1], title: c.title, pages: c.pages })),
      plot: PLOT,
      spawns: [
        { rect: [14, 112, 86, 74], species: ['glitchling'], cap: 4 },
        { rect: [144, 118, 42, 66], species: ['shard-wisp', 'glitchling'], cap: 3 },
        { rect: [30, 34, 80, 72], species: ['glitchling', 'shard-wisp'], cap: 4 },
        { rect: [90, 186, 80, 54], species: ['glitchling'], cap: 2 },
        { rect: [100, 100, 60, 70], species: ['glitchling'], cap: 2 },
        // Even the lost places are not safe.
        { rect: [20, 196, 44, 34], species: ['glitchling'], cap: 2 },
        { rect: [198, 200, 42, 30], species: ['glitchling', 'shard-wisp'], cap: 2 },
        // The Null's own, thick round the Warden's plateau.
        { rect: [100, 84, 56, 22], species: ['null-shade', 'glitchling'], cap: 3 },
        { rect: [14, 120, 30, 26], species: ['null-shade'], cap: 1 },
      ],
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

  private fill(r: { x: number; y: number; w: number; h: number }, t: number): void {
    for (let y = r.y; y < r.y + r.h; y++) for (let x = r.x; x < r.x + r.w; x++) this.set(x, y, t);
  }

  private protect(r: { x: number; y: number; w: number; h: number }, pad = 0): void {
    for (let y = r.y - pad; y < r.y + r.h + pad; y++) for (let x = r.x - pad; x < r.x + r.w + pad; x++) if (this.inside(x, y)) this.keep[this.at(x, y)] = 1;
  }

  private land1(x: number, y: number): boolean {
    return !isVoid(this.ground[this.at(x, y)]);
  }

  /** The moss, ash or sand a tile of open land should be; on drifted land,
   *  the overworld's grass. */
  private soil(x: number, y: number): number {
    const region = regionAt(x, y);
    const n = this.patch.noise2(x / 22, y / 22);
    if (region === ISLET) return n > 0 ? Tile.ShardSand : Tile.HollowMoss;
    if (region === WOOD || region === HAMLET) {
      const d = this.patch.noise2(x / 6, y / 6);
      return GRASS[d > 0.35 ? 2 : d < -0.3 ? 1 : 0];
    }
    if (region === 1 && n > -0.25) return Tile.Ash;
    if ((region === 2 || region === 6) && n > 0.35) return Tile.ShardSand;
    return n > 0.15 ? Tile.HollowMossDark : Tile.HollowMoss;
  }

  // The land --------------------------------------------------------------------

  /** Islands with ragged edges. */
  private land(): void {
    const masses: Array<[number, number, number, number]> = [
      [128, 214, 40, 27], // Shattered Shore
      [128, 150, 25, 22], // the Causeway
      [58, 150, 40, 33], // Ash Fields
      [164, 150, 25, 31], // Crystal Reach
      [70, 72, 36, 31], // Glyphwood
      [128, 94, 16, 13], // the foot of the Rise
      [WOOD_AT[0], WOOD_AT[1], 21, 16], // A Drifted Wood
      [HAMLET_AT[0], HAMLET_AT[1], 22, 15], // The Lost Hamlet
      [ISLET_AT[0], ISLET_AT[1], 9, 7], // The Quiet Islet
      // Islets adrift, for the view.
      [12, 182, 5, 4], [208, 60, 11, 9], [238, 96, 6, 6], [176, 236, 6, 4], [196, 24, 5, 5], [244, 240, 5, 4],
    ];
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const ragged = 0.2 * this.edge.noise2(x / 9, y / 9) + 0.1 * this.edge.noise2(x / 3.5, y / 3.5);
        for (const [cx, cy, rx, ry] of masses) {
          if (Math.hypot((x - cx) / rx, (y - cy) / ry) + ragged < 1) {
            this.ground[this.at(x, y)] = this.soil(x, y);
            break;
          }
        }
      }
    }
    // The map's edge is void all round.
    for (let k = 0; k < W; k++) {
      for (let d = 0; d < 3; d++) {
        this.set(k, d, Tile.Void);
        this.set(k, H - 1 - d, Tile.Void);
        this.set(d, k, Tile.Void);
        this.set(W - 1 - d, k, Tile.Void);
      }
    }
  }

  /** Ruined roads from the Causeway to every landmark: land four wide,
   *  flagstones down the middle where they have not crumbled. */
  private causeways(): void {
    const roads: XY[][] = [
      [[128, 219], [128, 196], [127, 176], [128, 158]],
      [[120, 150], [96, 152], [80, 149], [64, 150]],
      [[136, 150], [158, 148], [174, 151], [188, 150]],
      [[122, 143], [104, 122], [84, 98], [68, 75]],
      [[128, 142], [129, 120], [128, 100], [128, 82]],
      // Out to the drifted places, west and east of the shore.
      [[110, 222], [90, 220], [72, 216], [58, 213]],
      [[146, 222], [168, 220], [184, 216], [198, 214]],
    ];
    for (const road of roads) {
      for (let k = 0; k + 1 < road.length; k++) {
        const [ax, ay] = road[k];
        const [bx, by] = road[k + 1];
        const len = Math.ceil(Math.hypot(bx - ax, by - ay));
        for (let s = 0; s <= len; s++) {
          const t = s / len;
          // Sideways wobble, so the roads do not run ruler-straight.
          const nx = -(by - ay) / len;
          const ny = (bx - ax) / len;
          const off = 1.5 * this.wobble.noise2((ax + bx) * 0.01 + t * 2.2, (ay + by) * 0.01);
          const x = ax + (bx - ax) * t + nx * off;
          const y = ay + (by - ay) * t + ny * off;
          for (let dy = -2; dy <= 2; dy++) {
            for (let dx = -2; dx <= 2; dx++) {
              const gx = Math.round(x + dx);
              const gy = Math.round(y + dy);
              if (!this.inside(gx, gy)) continue;
              const i = this.at(gx, gy);
              const mid = Math.abs(dx) + Math.abs(dy) <= 1;
              const broken = this.patch.noise2(gx / 3, gy / 3) < -0.45;
              if (mid && !broken) this.ground[i] = Tile.RuinFloor;
              else if (isVoid(this.ground[i])) this.ground[i] = this.soil(gx, gy);
              this.keep[i] = 1;
            }
          }
        }
      }
    }
  }

  /** A Drifted Wood: a patch of ordinary overworld forest, grass and oaks,
   *  lost to the Drift and come to rest here. Planted with the rest (`plant`). */
  private wood(): void {
    // A path once ran through it; a few flagstones of it are left.
    const [cx, cy] = WOOD_AT;
    for (let x = cx - 14; x <= cx + 10; x++) {
      const y = cy + Math.round(2 * Math.sin(x / 5));
      if (this.land1(x, y) && this.patch.noise2(x / 2, y / 2) > -0.2) this.set(x, y, Tile.Path);
    }
  }

  /** The Lost Hamlet: what is left of a village the world let go of. Broken
   *  timber houses on drifted grass, a well, a field gone to seed. */
  private hamlet(): void {
    const [cx, cy] = HAMLET_AT;
    // The lane through it.
    for (let x = cx - 18; x <= cx + 14; x++) for (const y of [cy, cy + 1]) if (this.land1(x, y)) this.set(x, y, Tile.Path);
    for (let y = cy - 9; y <= cy + 8; y++) if (this.land1(cx - 2, y)) this.set(cx - 2, y, Tile.Path);
    const houses: Array<{ x: number; y: number; w: number; h: number; stone?: boolean }> = [
      { x: cx - 13, y: cy - 7, w: 7, h: 6 },
      { x: cx + 2, y: cy - 8, w: 8, h: 6, stone: true },
      { x: cx - 11, y: cy + 3, w: 6, h: 5 },
    ];
    for (const r of houses) {
      const wall = r.stone ? Tile.StoneWall : Tile.WoodWall;
      for (let y = r.y; y < r.y + r.h; y++) {
        for (let x = r.x; x < r.x + r.w; x++) {
          const edge = x === r.x || y === r.y || x === r.x + r.w - 1 || y === r.y + r.h - 1;
          // Walls broken open where the Drift tore at them.
          const broken = edge && this.patch.noise2(x / 1.7, y / 1.7) < -0.2;
          this.set(x, y, edge && !broken ? wall : broken ? Tile.Rubble : Tile.WoodFloor);
        }
      }
      // A doorway onto the lane side.
      this.set(r.x + (r.w >> 1), r.y + r.h - 1, Tile.WoodFloor);
      this.protect(r, 1);
    }
    this.decos[this.at(cx - 9, cy - 4)] = Deco.Barrel;
    this.decos[this.at(cx + 5, cy - 5)] = Deco.Bookshelf;
    this.decos[this.at(cx - 9, cy + 5)] = Deco.Crate;
    // The well on the green, and the field gone to seed.
    this.decos[this.at(cx + 4, cy + 4)] = Deco.Well;
    this.protect({ x: cx + 2, y: cy + 2, w: 5, h: 5 });
    for (let y = cy + 3; y <= cy + 7; y++) {
      for (let x = cx + 8; x <= cx + 14; x++) {
        if (!this.land1(x, y)) continue;
        this.set(x, y, Tile.Farmland);
        if ((x + y) % 3 === 0 && this.patch.noise2(x, y) > -0.3) this.decos[this.at(x, y)] = Deco.Crop;
        this.keep[this.at(x, y)] = 1;
      }
    }
    for (let x = cx + 7; x <= cx + 15; x++) if (this.land1(x, cy + 2) && x % 3 !== 0) this.decos[this.at(x, cy + 2)] = Deco.Fence;
    for (let x = cx - 18; x <= cx + 14; x++) this.keep[this.at(x, cy)] = this.keep[this.at(x, cy + 1)] = 1;
  }

  /** The Ember Watch: a ruined watch post at the Ash Fields' edge, its fire
   *  long out, bones round it. The bell's crown lies inside. */
  private emberWatch(): void {
    const r = EMBER_WATCH;
    // Firm ground round it, wherever the fields' edge had crumbled.
    for (let y = r.y - 3; y < r.y + r.h + 3; y++) for (let x = r.x - 3; x < r.x + r.w + 3; x++) if (!this.land1(x, y)) this.set(x, y, this.soil(x, y));
    this.room(r);
    // Broken open on its east side, toward the nest.
    for (let y = r.y + 2; y <= r.y + 4; y++) this.set(r.x + r.w - 1, y, Tile.RuinFloor);
    this.set(r.x, r.y + 3, Tile.Rubble);
    this.decos[this.at(r.x + 1, r.y + 1)] = Deco.Banner;
    this.decos[this.at(r.x + 4, r.y + 4)] = Deco.Bones;
    for (const [x, y] of [[r.x + r.w + 1, r.y + 1], [r.x - 1, r.y + r.h], [r.x + r.w + 2, r.y + r.h - 1]]) if (this.land1(x, y)) this.decos[this.at(x, y)] = Deco.Bones;
    this.protect(r, 1);
  }

  /** The Sunken Shrine: a rune ring half sunk in shard sand, a worn statue
   *  in it, crystals grown up round the edge. */
  private shrine(): void {
    const [cx, cy] = SHRINE_AT;
    for (let y = cy - 5; y <= cy + 5; y++) {
      for (let x = cx - 5; x <= cx + 5; x++) {
        const d = Math.hypot(x - cx, y - cy);
        if (d > 5.4) continue;
        this.set(x, y, d > 4.2 ? Tile.ShardSand : d > 3.2 && d < 4.2 ? Tile.Rune : Tile.RuinFloor);
        this.keep[this.at(x, y)] = 1;
      }
    }
    this.decos[this.at(cx, cy)] = Deco.Statue;
    for (let k = 0; k < 5; k++) {
      const a = (k / 5) * Math.PI * 2 + 0.4;
      this.decos[this.at(Math.round(cx + Math.cos(a) * 6.5), Math.round(cy + Math.sin(a) * 6))] = Deco.RiftCrystal;
    }
  }

  /** The Quiet Islet, at the end of a causeway half fallen into the void out
   *  of the Glyphwood's north-west: a seventh stone, and the bell's clapper. */
  private islet(): void {
    const road: XY[] = [[46, 56], [40, 44], [33, 33], [28, 24]];
    for (let k = 0; k + 1 < road.length; k++) {
      const [ax, ay] = road[k];
      const [bx, by] = road[k + 1];
      const len = Math.ceil(Math.hypot(bx - ax, by - ay));
      for (let st = 0; st <= len; st++) {
        const x = Math.round(ax + ((bx - ax) * st) / len);
        const y = Math.round(ay + ((by - ay) * st) / len);
        // Two wide, gapped at the edges where it crumbled.
        for (const [dx, dy] of [[0, 0], [1, 0], [0, 1]]) {
          const i = this.at(x + dx, y + dy);
          this.ground[i] = this.patch.noise2((x + dx) / 2, (y + dy) / 2) > -0.3 ? Tile.RuinFloor : Tile.ShardSand;
          this.keep[i] = 1;
        }
      }
    }
    const [cx, cy] = ISLET_AT;
    this.protect({ x: cx - 5, y: cy - 4, w: 11, h: 9 });
    this.set(cx, cy, Tile.Rune);
  }

  /** The hamlet's bell frame, empty, by the lane; Isolde waits beside it. A
   *  few graves behind the houses. */
  private bell(): void {
    const [bx, by] = BELL;
    for (let y = by - 1; y <= by + 2; y++) for (let x = bx - 1; x <= bx + 2; x++) {
      if (this.ground[this.at(x, y)] !== Tile.Path) this.ground[this.at(x, y)] = GRASS[0];
      this.keep[this.at(x, y)] = 1;
      if (this.decos[this.at(x, y)] !== Deco.LoreStone) this.decos[this.at(x, y)] = 0;
    }
    this.decos[this.at(bx, by)] = Deco.BellFrame;
    const [hx, hy] = HAMLET_AT;
    for (const [dx, dy] of [[10, -6], [12, -6], [14, -6], [11, -4], [13, -4]]) {
      const i = this.at(hx + dx, hy + dy);
      if (!isVoid(this.ground[i])) {
        this.decos[i] = Deco.Gravestone;
        this.keep[i] = 1;
      }
    }
  }

  /** The bell's pieces, each on a patch of open ground. */
  private relics(): void {
    for (const r of RELICS) {
      const [x, y] = r.at;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const i = this.at(x + dx, y + dy);
          if (isVoid(this.ground[i])) this.ground[i] = this.soil(x + dx, y + dy);
          this.keep[i] = 1;
        }
      }
      this.decos[this.at(x, y)] = Deco.Relic;
    }
  }

  /** Round the Warden's plateau, the Null's marks: small round absences in
   *  the moss, thickest by the arena's walls. Ground to walk on, nothing more. */
  private nullMarks(): void {
    const rng = new Rng(SEED ^ 0x77);
    const cx = ARENA.x + ARENA.w / 2;
    const cy = ARENA.y + ARENA.h / 2;
    let placed = 0;
    for (let tries = 0; tries < 400 && placed < 18; tries++) {
      const a = rng.next() * Math.PI * 2;
      const d = 13 + rng.next() * 9;
      const x = Math.round(cx + Math.cos(a) * d * 1.05);
      const y = Math.round(cy + Math.sin(a) * d * 0.9);
      if (!this.inside(x, y)) continue;
      const i = this.at(x, y);
      const t = this.ground[i];
      if (t !== Tile.HollowMoss && t !== Tile.HollowMossDark && t !== Tile.Ash) continue;
      this.ground[i] = Tile.NullMark;
      this.decos[i] = 0;
      placed++;
    }
  }

  /** Warden's Rise: the arena on a plateau, the vault behind it over the void. */
  private rise(): void {
    // Nothing north of the arena but the vault and its corridor.
    this.fill({ x: 96, y: 4, w: 64, h: 56 }, Tile.Void);
    for (let y = ARENA.y; y < ARENA.y + ARENA.h + 4; y++) {
      for (let x = ARENA.x - 3; x < ARENA.x + ARENA.w + 3; x++) this.ground[this.at(x, y)] = this.soil(x, y);
    }
    this.room(ARENA);
    const gate: XY[] = [];
    const gy = ARENA.y + ARENA.h - 1;
    for (let x = 127; x <= 129; x++) {
      this.set(x, gy, Tile.RuinFloor);
      gate.push([x, gy]);
      // The doorway out to the corridor and the vault.
      this.set(x, ARENA.y, Tile.RuinFloor);
    }
    // The corridor and the vault.
    this.fill({ x: 126, y: 49, w: 5, h: 11 }, Tile.RuinWall);
    this.fill({ x: 127, y: 48, w: 3, h: 12 }, Tile.RuinFloor);
    this.room(VAULT);
    for (let x = 127; x <= 129; x++) this.set(x, VAULT.y + VAULT.h - 1, Tile.RuinFloor);
    this.set(128, 45, Tile.Rune);
    this.protect({ x: 120, y: 38, w: 17, h: 24 });
    this.protect(ARENA, 3);

    // A rune circle under the Warden, and pillars around it.
    const cx = 128;
    const cy = 70;
    for (let y = ARENA.y + 1; y < ARENA.y + ARENA.h - 1; y++) {
      for (let x = ARENA.x + 1; x < ARENA.x + ARENA.w - 1; x++) {
        const d = Math.hypot(x - cx, y - cy);
        if (d > 2.5 && d < 3.5) this.set(x, y, Tile.Rune);
      }
    }
    for (let k = 0; k < 6; k++) {
      const a = (k / 6) * Math.PI * 2 + Math.PI / 6;
      this.decos[this.at(Math.round(cx + Math.cos(a) * 7), Math.round(cy + Math.sin(a) * 6.5))] = Deco.RuinPillar;
    }
    const spawns: XY[] = [];
    for (let k = 0; k < 8; k++) {
      const a = (k / 8) * Math.PI * 2;
      spawns.push([Math.round(cx + Math.cos(a) * 5) + 0.5, Math.round(cy + Math.sin(a) * 5) + 0.9]);
    }
    this.sites.push({ kind: 'boss', name: "Warden's Arena", rect: [ARENA.x, ARENA.y, ARENA.w, ARENA.h], entry: [128.5, ARENA.y + ARENA.h + 1.9], center: [cx + 0.5, cy + 0.9], gates: gate, spawns });
    this.sites.push({ kind: 'vault', name: 'The Vault', rect: [VAULT.x, VAULT.y, VAULT.w, VAULT.h], entry: [128.5, VAULT.y + VAULT.h - 1.1], center: [128.5, 44.9] });
  }

  /** Walls round a rect, flagstones inside. */
  private room(r: { x: number; y: number; w: number; h: number }): void {
    this.fill(r, Tile.RuinWall);
    this.fill({ x: r.x + 1, y: r.y + 1, w: r.w - 2, h: r.h - 2 }, Tile.RuinFloor);
  }

  /** The Crumbling Path: a chasm, a ledge, and the Far Shelf beyond, reached
   *  only over slabs that crumble and glitch. */
  private chasm(): void {
    this.fill(CHASM, Tile.Void);
    for (let y = SHELF.y; y < SHELF.y + SHELF.h; y++) {
      for (let x = SHELF.x; x < SHELF.x + SHELF.w; x++) {
        // A rounded shelf.
        const d = Math.hypot((x - (SHELF.x + 7)) / 7.6, (y - (SHELF.y + 7)) / 7.6);
        if (d < 1) this.set(x, y, this.soil(x, y));
      }
    }
    this.fill({ x: 212, y: 147, w: 2, h: 7 }, Tile.ShardSand);
    // The ledge on this side.
    this.fill({ x: 183, y: 146, w: 6, h: 9 }, Tile.RuinFloor);
    this.protect({ x: 183, y: 138, w: 30, h: 25 });
    this.protect(SHELF, 1);

    const rng = this.rng;
    const lo = { x: 192, y: 140 };
    const hi = { x: 206, y: 158 };
    const start = { x: 189, y: 149 };
    const end = { x: 210, y: 149 };
    const dist = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
    let bends = [{ x: 196, y: 141 }, { x: 204, y: 157 }];
    let best = -1;
    for (let k = 0; k < 12; k++) {
      const b0 = { x: rng.int(lo.x, lo.x + 5), y: rng.int(lo.y, hi.y) };
      const b1 = { x: rng.int(hi.x - 5, hi.x), y: rng.int(lo.y, hi.y) };
      const len = dist(start, b0) + dist(b0, b1) + dist(b1, end);
      if (len > best && Math.abs(b0.y - b1.y) >= 8) {
        best = len;
        bends = [b0, b1];
      }
    }
    // 2 x 2 steps from the ledge to the shelf, by the two bends.
    const order: number[] = [];
    const seen = new Set<number>();
    const step = (x: number, y: number) => {
      for (const [dx, dy] of [[0, 0], [1, 0], [0, 1], [1, 1]]) {
        const t = this.at(x + dx, y + dy);
        if (seen.has(t)) continue;
        seen.add(t);
        order.push(t);
      }
    };
    const walk = (a: { x: number; y: number }, b: { x: number; y: number }, xFirst: boolean) => {
      let { x, y } = a;
      step(x, y);
      for (let leg = 0; leg < 2; leg++) {
        if ((leg === 0) === xFirst) while (x !== b.x) step((x += Math.sign(b.x - x)), y);
        else while (y !== b.y) step(x, (y += Math.sign(b.y - y)));
      }
    };
    const points = [start, ...bends, end];
    for (let k = 0; k + 1 < points.length; k++) walk(points[k], points[k + 1], k % 2 === 0);
    // A safe pad at each bend; the rest are slabs over the void.
    const pads = new Set<number>();
    for (const b of bends) for (const [dx, dy] of [[0, 0], [1, 0], [0, 1], [1, 1]]) pads.add(this.at(b.x + dx, b.y + dy));
    for (const t of pads) this.ground[t] = Tile.RunePad;
    let path = order.filter((t) => !pads.has(t));
    // Runs of crumbling slabs, broken by glitching ones; a glitch run has two
    // fixed stepping stones before it to wait on.
    const glitch = new Map<number, number>();
    for (let k = 0; k < path.length; ) {
      const len = rng.int(6, 10);
      if (k > 4 && k + len < path.length - 4 && rng.chance(0.45)) {
        const ph = rng.int(0, 255);
        for (let j = k; j < k + 2; j++) this.ground[path[j]] = Tile.RuinFloor;
        for (let j = k + 2; j < k + len; j++) glitch.set(path[j], ph);
      }
      k += len;
    }
    path = path.filter((t) => isVoid(this.ground[t]));
    const checkpoints: XY[] = [[186.5, 150.9], ...bends.map((b): XY => [b.x + 1, b.y + 1.9])];
    this.sites.push({
      kind: 'hazard',
      name: 'The Crumbling Path',
      rect: [PATH_SITE.x, PATH_SITE.y, PATH_SITE.w, PATH_SITE.h],
      entry: [185.5, 150.9],
      center: [200.5, 150.9],
      checkpoints,
      path: path.map((t) => [t % W, Math.floor(t / W), glitch.has(t) ? 1 : 0, glitch.get(t) ?? 0]),
      goal: [SHELF.x, SHELF.y, SHELF.w, SHELF.h],
    });
  }

  /** The Glitch Nest: a walled ring of ash in the Ash Fields; its gate seals while the waves come. */
  private nest(): void {
    this.room(NEST);
    for (let y = NEST.y + 1; y < NEST.y + NEST.h - 1; y++) {
      for (let x = NEST.x + 1; x < NEST.x + NEST.w - 1; x++) if (this.patch.noise2(x / 4, y / 4) > 0.1) this.set(x, y, Tile.Ash);
    }
    const gx = NEST.x + NEST.w - 1;
    const gate: XY[] = [];
    for (let y = 149; y <= 151; y++) {
      this.set(gx, y, Tile.RuinFloor);
      gate.push([gx, y]);
    }
    for (const [x, y] of [[50, 148], [58, 153], [53, 156]]) this.decos[this.at(x, y)] = Deco.RuinPillar;
    const spawns: XY[] = [];
    const r = { x: NEST.x + 3, y: NEST.y + 3, w: NEST.w - 6, h: NEST.h - 6 };
    for (let x = r.x; x < r.x + r.w; x += 3) for (const y of [r.y, r.y + r.h - 1]) spawns.push([x + 0.5, y + 0.9]);
    for (let y = r.y + 3; y < r.y + r.h - 1; y += 3) for (const x of [r.x, r.x + r.w - 1]) spawns.push([x + 0.5, y + 0.9]);
    this.protect(NEST, 2);
    this.sites.push({ kind: 'combat', name: 'Glitch Nest', rect: [NEST.x, NEST.y, NEST.w, NEST.h], entry: [NEST.x + NEST.w + 1.5, 150.9], center: [54.5, 150.9], gates: gate, spawns });
  }

  /** The Glyph Hall: a mural of the order on the north wall, plates on the floor. */
  private hall(): void {
    this.room(HALL);
    for (let x = 67; x <= 69; x++) this.set(x, HALL.y + HALL.h - 1, Tile.RuinFloor);
    const rng = this.rng;
    const pool = Array.from({ length: GLYPH_COUNT }, (_, g) => g);
    shuffle(pool, rng);
    const glyphs = pool.slice(0, 5);
    const order = shuffle(glyphs.slice(), rng);
    const mural: Array<[number, number, number]> = order.map((g, k) => [64 + k * 2, HALL.y + 1, g]);
    const spots: XY[] = [];
    for (let y = HALL.y + 4; y <= HALL.y + HALL.h - 5; y += 2) for (let x = HALL.x + 3; x <= HALL.x + HALL.w - 4; x += 2) spots.push([x, y]);
    shuffle(spots, rng);
    const plates: Array<[number, number, number]> = glyphs.map((g, k) => [spots[k][0], spots[k][1], g]);
    for (const [x, y] of [[HALL.x + 1, HALL.y + 1], [HALL.x + HALL.w - 2, HALL.y + 1]]) this.decos[this.at(x, y)] = Deco.RiftCrystal;
    this.protect(HALL, 2);
    this.sites.push({ kind: 'puzzle', name: 'Glyph Hall', rect: [HALL.x, HALL.y, HALL.w, HALL.h], entry: [68.5, HALL.y + HALL.h + 1.9], center: [68.5, 66.9], plates, mural });
  }

  /** The Causeway's ruined plaza and the arrival's. */
  private plazas(): void {
    for (let y = 141; y <= 159; y++) {
      for (let x = 119; x <= 137; x++) {
        const d = Math.hypot(x - 128, y - 150);
        if (d < 8 && this.patch.noise2(x / 2.5, y / 2.5) > -0.55) this.set(x, y, Tile.RuinFloor);
        if (d < 9) this.keep[this.at(x, y)] = 1;
      }
    }
    for (const [x, y] of [[122, 144], [134, 144], [122, 156], [134, 156]]) this.decos[this.at(x, y)] = Deco.RuinPillar;
    // The rift home on scorched ground in a ring of flagstones.
    const [rx, ry] = RIFT;
    this.fill({ x: rx - 4, y: ry - 2, w: 9, h: 7 }, Tile.RuinFloor);
    for (const [x, y] of [[rx - 3, ry - 1], [rx + 3, ry - 1], [rx - 3, ry + 3], [rx + 3, ry + 3]]) this.set(x, y, Tile.Rune);
    for (const [dx, dy] of [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1]]) this.set(rx + dx, ry + dy, Tile.RiftGround);
    this.decos[this.at(rx, ry)] = Deco.Rift;
    this.protect({ x: rx - 6, y: ry - 6, w: 13, h: 13 });
    this.set(...PORTAL, Tile.RuinFloor);
    this.set(...CHEST, Tile.RuinFloor);
  }

  /** The lore stones, each on a patch of open ground. */
  private stones(): void {
    for (const c of CLUES) {
      const [x, y] = c.at;
      for (let dy = -2; dy <= 2; dy++) {
        for (let dx = -2; dx <= 2; dx++) {
          const i = this.at(x + dx, y + dy);
          if (isVoid(this.ground[i])) this.ground[i] = this.soil(x + dx, y + dy);
          this.keep[i] = 1;
          if (this.decos[i] === Deco.RuinPillar && (dx || dy)) this.decos[i] = 0;
        }
      }
      this.decos[this.at(x, y)] = Deco.LoreStone;
    }
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

  /** Trees, crystals, grass and caps by region, never crowding each other. */
  private plant(): void {
    const tall = new Set<number>([Deco.HollowTree, Deco.AshTree, Deco.RiftCrystal, Deco.Oak, Deco.Pine]);
    const table: Array<Array<[number, number]>> = [
      [[Deco.ShardGrass, 0.04], [Deco.HollowTree, 0.025], [Deco.GlowCap, 0.01], [Deco.Stone, 0.008]],
      [[Deco.AshTree, 0.035], [Deco.Stone, 0.015], [Deco.ShardGrass, 0.01], [Deco.GlowCap, 0.004]],
      [[Deco.RiftCrystal, 0.03], [Deco.ShardGrass, 0.06], [Deco.HollowTree, 0.02]],
      [[Deco.HollowTree, 0.11], [Deco.ShardGrass, 0.05], [Deco.GlowCap, 0.02]],
      [[Deco.HollowTree, 0.015], [Deco.ShardGrass, 0.02], [Deco.Stone, 0.006]],
      [[Deco.ShardGrass, 0.03], [Deco.Stone, 0.01]],
      [[Deco.RiftCrystal, 0.04], [Deco.ShardGrass, 0.06]],
      // The drifted forest: the overworld's own trees, bushes and flowers.
      [[Deco.Oak, 0.09], [Deco.Pine, 0.025], [Deco.Bush, 0.03], [Deco.Flowers, 0.04], [Deco.Mushroom, 0.01], [Deco.Stone, 0.008]],
      // The hamlet's green, gone wild.
      [[Deco.Oak, 0.02], [Deco.Bush, 0.03], [Deco.Flowers, 0.05], [Deco.Stone, 0.01]],
      // The Quiet Islet: shard grass and a little light.
      [[Deco.ShardGrass, 0.08], [Deco.GlowCap, 0.04]],
    ];
    const rng = new Rng(SEED ^ 0x44);
    for (let y = 1; y < H - 1; y++) {
      for (let x = 1; x < W - 1; x++) {
        const i = this.at(x, y);
        const roll = rng.next();
        if (this.keep[i] || this.decos[i] || !isOpenSoil(this.ground[i])) continue;
        // Keep the land's edge clear: no decoration beside the void.
        if (!this.land1(x - 1, y) || !this.land1(x + 1, y) || !this.land1(x, y - 1) || !this.land1(x, y + 1)) continue;
        let acc = 0;
        for (const [deco, p] of table[regionAt(x, y)]) {
          acc += p;
          if (roll >= acc) continue;
          if (tall.has(deco)) {
            let crowded = false;
            for (let dy = -1; dy <= 1 && !crowded; dy++) for (let dx = -1; dx <= 1 && !crowded; dx++) crowded = tall.has(this.decos[this.at(x + dx, y + dy)]);
            if (crowded) break;
          }
          this.decos[i] = deco;
          break;
        }
      }
    }
  }

  /** The bake fails rather than ship a map that cannot be finished. */
  private check(): void {
    const sites = this.sites;
    const pathTiles = new Set<number>();
    for (const s of sites) for (const [x, y] of s.path ?? []) pathTiles.add(this.at(x, y));
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
          const open = pathTiles.has(n) || (!isVoid(this.ground[n]) && !isSolid(this.ground[n], this.decos[n]));
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
      if (!all[tileOf(s.entry)]) throw new Error(`The Hollow: ${s.name} cannot be reached`);
      for (const p of s.checkpoints ?? []) if (!all[tileOf(p)]) throw new Error(`The Hollow: a pad of ${s.name} cannot be reached`);
      for (const [x, y] of s.plates ?? []) if (!all[this.at(x, y)]) throw new Error(`The Hollow: a plate of ${s.name} cannot be reached`);
      for (const p of s.spawns ?? []) if (!all[tileOf(p)]) throw new Error(`The Hollow: a spawn of ${s.name} is shut in`);
      if (s.goal) {
        const [gx, gy, gw, gh] = s.goal;
        let ok = false;
        for (let y = gy; y < gy + gh && !ok; y++) for (let x = gx; x < gx + gw && !ok; x++) ok = all[this.at(x, y)] === 1;
        if (!ok) throw new Error(`The Hollow: the far side of ${s.name} cannot be reached`);
      }
    }
    if (!all[this.at(...PORTAL)] || !beside(all, this.at(...CHEST))) throw new Error('The Hollow: the vault cannot be reached');
    for (const c of CLUES) if (!beside(all, this.at(...c.at))) throw new Error(`The Hollow: the stone ${c.id} cannot be reached`);
    for (const r of RELICS) if (!beside(all, this.at(...r.at))) throw new Error(`The Hollow: the ${r.name} cannot be reached`);
    if (!all[this.at(...ISOLDE)]) throw new Error('The Hollow: Isolde cannot be reached');
    // The vault is behind the Warden: with its gate shut there is no way in.
    if (reach(false)[this.at(...PORTAL)]) throw new Error("The Hollow: the vault can be reached around the Warden's gate");
  }
}

/** The region a tile is in, by where it lies. */
function regionAt(x: number, y: number): number {
  if (x < 40 && y < 36) return ISLET;
  if (y >= 188 && x < 76) return WOOD;
  if (y >= 188 && x >= 184) return HAMLET;
  if (x >= 96 && x < 160 && y < 100) return 5;
  if (x < 112 && y < 112) return 3;
  if (x >= 189) return 6;
  if (x >= 152 && y < 186) return 2;
  if (x < 100 && y < 186) return 1;
  if (y >= 184) return 0;
  return 4;
}

/** Open moss, ash, sand or drifted grass: where things grow. */
function isOpenSoil(t: number): boolean {
  return t === Tile.HollowMoss || t === Tile.HollowMossDark || t === Tile.Ash || t === Tile.ShardSand || GRASS.includes(t);
}

function shuffle<T>(a: T[], rng: Rng): T[] {
  for (let k = a.length - 1; k > 0; k--) {
    const j = rng.int(0, k);
    [a[k], a[j]] = [a[j], a[k]];
  }
  return a;
}
