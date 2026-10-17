// The Hollow: the first outer dimension. A chain of stone chambers floating in
// a violet void, built from the rift's seed: an arrival platform, a combat
// chamber, a crumbling path over the void, a glyph puzzle, the Rift Warden's
// arena, and a vault with the way home.

import { SPECIES } from '../entities/Species';
import { Rng } from '../generation/Random';
import type { Chamber, ChamberKind, DimensionDef, DimensionLayout, Point, Rect, RewardSpec } from './Dimension';
import { DimTile, isSolidDim, NO_GLYPH } from './DimTile';

const W = 96;
const H = 96;
/** Chambers in the order they are met. */
const KINDS: readonly ChamberKind[] = ['arrival', 'combat', 'hazard', 'puzzle', 'boss', 'vault'];
/** Outer size ranges per chamber, walls included: [minW, maxW, minH, maxH]. */
const SIZES: Record<ChamberKind, [number, number, number, number]> = {
  arrival: [11, 11, 11, 11],
  combat: [17, 19, 15, 17],
  hazard: [21, 23, 21, 23],
  puzzle: [15, 17, 13, 15],
  boss: [21, 23, 19, 21],
  vault: [11, 11, 9, 9],
};
/** Right, down, left, up. */
const DX = [1, 0, -1, 0];
const DY = [0, 1, 0, -1];
/** Glyph kinds the art has. */
export const GLYPH_COUNT = 6;

/** Item id of the dimension's own material, `Items.riftShard`. */
export const RIFT_SHARD_ID = 'rift-shard';
/** The Rift Shard's catalogue entry, as `Items.riftShard` has it. */
export const RIFT_SHARD = {
  id: RIFT_SHARD_ID,
  name: 'Rift Shard',
  description: 'A splinter of an outer dimension. It flickers, as if it cannot decide to exist.',
  rarity: 'Epic',
} as const;

/** What the vault's chest holds. */
export const HOLLOW_REWARDS: readonly RewardSpec[] = [
  { item: RIFT_SHARD_ID, min: 3, max: 5, chance: 1 },
  { item: 'coin', min: 20, max: 45, chance: 1 },
  { item: 'crystal', min: 1, max: 2, chance: 0.6 },
  { item: 'gem', min: 1, max: 1, chance: 0.3 },
  { item: 'star-metal', min: 1, max: 1, chance: 0.25 },
];

export const HOLLOW: DimensionDef = {
  id: 'hollow',
  name: 'The Hollow',
  mood: { darkness: 0.55, tint: 0x2a1450, music: 'rift', palette: [0x120a24, 0x4a3a5e, 0x8a74a0, 0xb07aff, 0x5af0e8, 0xff6ab8] },
  size: { w: W, h: H },
  generate: generateHollow,
  roster: [SPECIES.glitchling, SPECIES.shardWisp, SPECIES.riftWarden],
  waves: [
    [[SPECIES.glitchling, 4]],
    [[SPECIES.glitchling, 3], [SPECIES.shardWisp, 2]],
    [[SPECIES.glitchling, 3], [SPECIES.shardWisp, 3]],
  ],
  boss: {
    species: SPECIES.riftWarden,
    addCap: 6,
    phases: [
      { below: 0.66, adds: [[SPECIES.glitchling, 3]], cooldownScale: 1, speedScale: 1, text: 'The Warden tears the air open. Glitchlings pour out!' },
      { below: 0.33, adds: [[SPECIES.shardWisp, 2]], cooldownScale: 0.55, speedScale: 1.35, text: 'The Warden flickers with fury. Its blows quicken!' },
    ],
  },
  hazard: { crumbleDelay: 0.55, reform: 5, glitchOn: 2, glitchOff: 1.3, glitchWarn: 0.5, fallDamage: 15 },
  rewards: HOLLOW_REWARDS,
};

interface Placed {
  kind: ChamberKind;
  rect: Rect;
  /** Direction travelled to reach it from the previous chamber; -1 for the first. */
  dir: number;
  /** Corridor floor in, both wall gaps included. */
  floor: Rect | null;
  /** Corridor walls in (the strip between the two chambers). */
  walls: Rect | null;
  /** Middle tile of the corridor's crossing, along the shared side. */
  cross: number;
}

function overlaps(a: Rect, b: Rect, margin: number): boolean {
  return a.x - margin < b.x + b.w && b.x - margin < a.x + a.w && a.y - margin < b.y + b.h && b.y - margin < a.y + a.h;
}

/** Tries to put chamber `kind` beside `prev`, travelling in `dir`. */
function attach(prev: Rect, kind: ChamberKind, dir: number, rng: Rng): Placed | null {
  const [w0, w1, h0, h1] = SIZES[kind];
  const w = rng.int(w0, w1);
  const h = rng.int(h0, h1);
  const len = rng.int(3, 6);
  if (DX[dir] !== 0) {
    // The corridor's middle row, inside both chambers.
    const cy = rng.int(prev.y + 2, prev.y + prev.h - 3);
    const y = rng.int(cy - h + 3, cy - 2);
    const x = dir === 0 ? prev.x + prev.w + len : prev.x - len - w;
    const fx = dir === 0 ? prev.x + prev.w - 1 : x + w - 1;
    return {
      kind, dir, cross: cy, rect: { x, y, w, h },
      floor: { x: fx, y: cy - 1, w: len + 2, h: 3 },
      walls: { x: fx + 1, y: cy - 2, w: len, h: 5 },
    };
  }
  const cx = rng.int(prev.x + 2, prev.x + prev.w - 3);
  const x = rng.int(cx - w + 3, cx - 2);
  const y = dir === 1 ? prev.y + prev.h + len : prev.y - len - h;
  const fy = dir === 1 ? prev.y + prev.h - 1 : y + h - 1;
  return {
    kind, dir, cross: cx, rect: { x, y, w, h },
    floor: { x: cx - 1, y: fy, w: 3, h: len + 2 },
    walls: { x: cx - 2, y: fy + 1, w: 5, h: len },
  };
}

function fits(p: Placed, placed: readonly Placed[]): boolean {
  const r = p.rect;
  if (r.x < 1 || r.y < 1 || r.x + r.w > W - 1 || r.y + r.h > H - 1) return false;
  const last = placed.length - 1;
  for (let i = 0; i <= last; i++) {
    const q = placed[i];
    if (overlaps(r, q.rect, 1)) return false;
    if (q.walls && overlaps(r, q.walls, 1)) return false;
    // The new corridor runs out of the last chamber, so it may touch that one.
    if (p.walls && i < last && overlaps(p.walls, q.rect, 1)) return false;
    if (p.walls && q.walls && overlaps(p.walls, q.walls, 1)) return false;
  }
  return true;
}

/** Lays the chain out, backtracking when a chamber has nowhere to go. */
function chain(rng: Rng, placed: Placed[]): boolean {
  const i = placed.length;
  if (i === KINDS.length) return true;
  const prev = placed[i - 1];
  const dirs = [0, 1, 2, 3];
  for (let k = dirs.length - 1; k > 0; k--) {
    const j = rng.int(0, k);
    [dirs[k], dirs[j]] = [dirs[j], dirs[k]];
  }
  for (const dir of dirs) {
    // Never leave through the side the chain came in by.
    if (prev.dir >= 0 && dir === (prev.dir + 2) % 4) continue;
    for (let attempt = 0; attempt < 3; attempt++) {
      const p = attach(prev.rect, KINDS[i], dir, rng);
      if (!p || !fits(p, placed)) continue;
      placed.push(p);
      if (chain(rng, placed)) return true;
      placed.pop();
    }
  }
  return false;
}

/** Builds The Hollow from a rift's seed. */
export function generateHollow(seed: number): DimensionLayout {
  let placed: Placed[] = [];
  let rng!: Rng;
  for (let attempt = 0; ; attempt++) {
    rng = new Rng((seed ^ 0x401104) + attempt * 0x9e3779b1);
    const [w0, , h0] = SIZES.arrival;
    const start = { x: rng.int(36, W - 36 - w0), y: rng.int(36, H - 36 - h0), w: w0, h: h0 };
    placed = [{ kind: 'arrival', rect: start, dir: -1, floor: null, walls: null, cross: 0 }];
    if (chain(rng, placed)) break;
    if (attempt > 50) throw new Error(`The Hollow could not be laid out for seed ${seed}`);
  }
  return new Builder(placed, rng).build();
}

class Builder {
  private readonly tiles = new Uint8Array(W * H);
  private readonly glyphs = new Uint8Array(W * H).fill(NO_GLYPH);
  private readonly phase = new Uint8Array(W * H);
  /** Doorways and their approaches stay clear of props. */
  private readonly clear = new Uint8Array(W * H);
  private readonly chambers: Chamber[] = [];
  private readonly doors: number[][] = [];
  private rift = 0;
  private portal = 0;
  private chest = 0;
  private arrival: Point = { x: 0, y: 0 };

  constructor(
    private readonly placed: readonly Placed[],
    private readonly rng: Rng,
  ) {}

  build(): DimensionLayout {
    const { placed, tiles } = this;
    tiles.fill(DimTile.Void);
    for (const p of placed) {
      this.fill(p.rect, DimTile.Wall);
      this.fill(inset(p.rect, 1), DimTile.Floor);
    }
    for (let i = 1; i < placed.length; i++) {
      const p = placed[i];
      this.fill(p.walls!, DimTile.Wall);
      this.fill(p.floor!, DimTile.Floor);
      const door = this.doorTiles(p);
      for (const t of door) tiles[t] = DimTile.Door;
      this.doors.push(door);
      // Keep both ends of the corridor clear.
      this.markClear(door[1]);
      this.markClear(this.gapTile(p));
    }
    for (let i = 0; i < placed.length; i++) this.chambers.push(this.furnish(i));
    return {
      w: W, h: H, tiles, glyphs: this.glyphs, phase: this.phase, chambers: this.chambers, doors: this.doors,
      arrival: this.arrival, rift: this.rift, portal: this.portal, chest: this.chest,
    };
  }

  private at(x: number, y: number): number {
    return y * W + x;
  }

  private fill(r: Rect, t: number): void {
    for (let y = r.y; y < r.y + r.h; y++) for (let x = r.x; x < r.x + r.w; x++) this.tiles[this.at(x, y)] = t;
  }

  /** The three door tiles in chamber `p`'s wall, middle one second. */
  private doorTiles(p: Placed): number[] {
    const r = p.rect;
    const c = p.cross;
    if (p.dir === 0) return [this.at(r.x, c - 1), this.at(r.x, c), this.at(r.x, c + 1)];
    if (p.dir === 2) return [this.at(r.x + r.w - 1, c - 1), this.at(r.x + r.w - 1, c), this.at(r.x + r.w - 1, c + 1)];
    if (p.dir === 1) return [this.at(c - 1, r.y), this.at(c, r.y), this.at(c + 1, r.y)];
    return [this.at(c - 1, r.y + r.h - 1), this.at(c, r.y + r.h - 1), this.at(c + 1, r.y + r.h - 1)];
  }

  /** Middle tile of the gap in the previous chamber's wall that `p`'s corridor leaves by. */
  private gapTile(p: Placed): number {
    const f = p.floor!;
    if (p.dir === 0) return this.at(f.x, p.cross);
    if (p.dir === 2) return this.at(f.x + f.w - 1, p.cross);
    if (p.dir === 1) return this.at(p.cross, f.y);
    return this.at(p.cross, f.y + f.h - 1);
  }

  private markClear(t: number): void {
    const tx = t % W;
    const ty = Math.floor(t / W);
    for (let y = ty - 3; y <= ty + 3; y++) for (let x = tx - 3; x <= tx + 3; x++) if (x >= 0 && y >= 0 && x < W && y < H) this.clear[this.at(x, y)] = 1;
  }

  /** Puts a solid prop on open floor, never beside another prop or in a doorway,
   *  so it can never cut the floor in two. */
  private prop(x: number, y: number, t: number): boolean {
    const i = this.at(x, y);
    if (this.tiles[i] !== DimTile.Floor || this.clear[i]) return false;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const n = this.tiles[this.at(x + dx, y + dy)];
        if (n !== DimTile.Wall && isSolidDim(n)) return false;
      }
    }
    this.tiles[i] = t;
    return true;
  }

  private furnish(i: number): Chamber {
    const p = this.placed[i];
    const r = p.rect;
    const cx = r.x + Math.floor(r.w / 2);
    const cy = r.y + Math.floor(r.h / 2);
    const ch: Chamber = {
      kind: p.kind, rect: r, entry: this.entryPoint(p), spawns: [], checkpoints: [], path: [], goal: null,
      plates: [], order: [], mural: [], center: feet(cx, cy),
    };
    const corners = () => {
      this.prop(r.x + 1, r.y + 1, DimTile.Crystal);
      this.prop(r.x + r.w - 2, r.y + 1, DimTile.Crystal);
      this.prop(r.x + 1, r.y + r.h - 2, DimTile.Crystal);
      this.prop(r.x + r.w - 2, r.y + r.h - 2, DimTile.Crystal);
    };
    switch (p.kind) {
      case 'arrival':
        this.rift = this.at(cx, cy - 1);
        this.tiles[this.rift] = DimTile.Rift;
        this.arrival = feet(cx, cy + 1);
        ch.entry = this.arrival;
        for (const [x, y] of [[cx - 2, cy + 2], [cx + 2, cy + 2], [cx - 2, cy - 2], [cx + 2, cy - 2]]) this.tiles[this.at(x, y)] = DimTile.Rune;
        corners();
        break;
      case 'combat': {
        corners();
        for (let n = this.rng.int(2, 4), tries = 0; n > 0 && tries < 40; tries++) {
          if (this.prop(this.rng.int(r.x + 4, r.x + r.w - 5), this.rng.int(r.y + 4, r.y + r.h - 5), DimTile.Pillar)) n--;
        }
        ch.spawns = this.ring(inset(r, 3), 3);
        break;
      }
      case 'hazard':
        this.hazard(i, ch);
        break;
      case 'puzzle':
        this.puzzle(i, ch);
        corners();
        break;
      case 'boss': {
        // A rune circle under the Warden, pillars around the arena.
        for (let y = r.y + 1; y < r.y + r.h - 1; y++) {
          for (let x = r.x + 1; x < r.x + r.w - 1; x++) {
            const d = Math.hypot(x - cx, y - cy);
            if (d > 2.5 && d < 3.5) this.tiles[this.at(x, y)] = DimTile.Rune;
          }
        }
        const rad = Math.min(r.w, r.h) / 2 - 3.5;
        for (let k = 0; k < 6; k++) {
          const a = (k / 6) * Math.PI * 2 + Math.PI / 6;
          this.prop(Math.round(cx + Math.cos(a) * rad), Math.round(cy + Math.sin(a) * rad), DimTile.Pillar);
        }
        corners();
        for (let k = 0; k < 8; k++) {
          const a = (k / 8) * Math.PI * 2;
          const x = Math.round(cx + Math.cos(a) * 5);
          const y = Math.round(cy + Math.sin(a) * 5);
          if (!isSolidDim(this.tiles[this.at(x, y)])) ch.spawns.push(feet(x, y));
        }
        break;
      }
      case 'vault':
        this.portal = this.at(cx, cy - 1);
        this.tiles[this.portal] = DimTile.Portal;
        this.chest = this.at(cx + 2, cy - 1);
        this.tiles[this.chest] = DimTile.Chest;
        this.tiles[this.at(cx, cy + 1)] = DimTile.Rune;
        corners();
        break;
    }
    return ch;
  }

  /** Feet in the corridor two tiles before chamber `p`'s door. */
  private entryPoint(p: Placed): Point {
    const r = p.rect;
    if (p.dir === 0) return feet(r.x - 2, p.cross);
    if (p.dir === 2) return feet(r.x + r.w + 1, p.cross);
    if (p.dir === 1) return feet(p.cross, r.y - 2);
    if (p.dir === 3) return feet(p.cross, r.y + r.h + 1);
    return feet(r.x + 2, r.y + 2);
  }

  /** Floor spots every `step` tiles around the edge of `r`. */
  private ring(r: Rect, step: number): Point[] {
    const out: Point[] = [];
    for (let x = r.x; x < r.x + r.w; x += step) {
      for (const y of [r.y, r.y + r.h - 1]) if (this.tiles[this.at(x, y)] === DimTile.Floor) out.push(feet(x, y));
    }
    for (let y = r.y + step; y < r.y + r.h - 1; y += step) {
      for (const x of [r.x, r.x + r.w - 1]) if (this.tiles[this.at(x, y)] === DimTile.Floor) out.push(feet(x, y));
    }
    return out;
  }

  /** The void room: a ledge at each door and a winding path of crumbling and
   *  glitching tiles between them, with a safe pad at each bend. */
  private hazard(i: number, ch: Chamber): void {
    const p = this.placed[i];
    const next = this.placed[i + 1];
    const r = p.rect;
    const rng = this.rng;
    this.fill(inset(r, 1), DimTile.Void);
    // Ledges: inward from the door in, and from the gap out.
    const inDoor = this.doors[i - 1][1];
    const outGap = this.gapTile(next);
    const inX = DX[p.dir];
    const inY = DY[p.dir];
    const outX = -DX[next.dir];
    const outY = -DY[next.dir];
    const ledge = (t: number, ix: number, iy: number): Rect => {
      const tx = t % W;
      const ty = Math.floor(t / W);
      let x0 = 99, y0 = 99, x1 = -1, y1 = -1;
      for (let depth = 1; depth <= 2; depth++) {
        for (let across = -2; across <= 2; across++) {
          const x = tx + ix * depth + (ix === 0 ? across : 0);
          const y = ty + iy * depth + (iy === 0 ? across : 0);
          if (x <= r.x || y <= r.y || x >= r.x + r.w - 1 || y >= r.y + r.h - 1) continue;
          x0 = Math.min(x0, x);
          y0 = Math.min(y0, y);
          x1 = Math.max(x1, x);
          y1 = Math.max(y1, y);
        }
      }
      return { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
    };
    const inLedge = ledge(inDoor, inX, inY);
    const outLedge = ledge(outGap, outX, outY);
    // The path: from beyond one ledge, by two bends, to beyond the other.
    const lo = { x: r.x + 3, y: r.y + 3 };
    const hi = { x: r.x + r.w - 5, y: r.y + r.h - 5 };
    const clamp = (x: number, y: number): Point => ({ x: Math.max(lo.x, Math.min(hi.x, x)), y: Math.max(lo.y, Math.min(hi.y, y)) });
    const ix0 = inDoor % W, iy0 = Math.floor(inDoor / W);
    const ox0 = outGap % W, oy0 = Math.floor(outGap / W);
    const start = clamp(ix0 + inX * 3, iy0 + inY * 3);
    const end = clamp(ox0 + outX * 3, oy0 + outY * 3);
    // Of a few tries, the two bends that make the longest walk.
    const d = (a: Point, b: Point) => Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
    let bends: Point[] = [];
    let best = -1;
    for (let k = 0; k < 8; k++) {
      const b0 = { x: rng.int(lo.x, hi.x), y: rng.int(lo.y, hi.y) };
      const b1 = { x: rng.int(lo.x, hi.x), y: rng.int(lo.y, hi.y) };
      const len = d(start, b0) + d(b0, b1) + d(b1, end);
      // Bends too close together would merge their pads.
      if (len > best && d(b0, b1) >= 6) {
        best = len;
        bends = [b0, b1];
      }
    }
    if (!bends.length) bends = [clamp(start.x, end.y), clamp(end.x, start.y)];
    const points = [start, ...bends, end];
    const order: number[] = [];
    const seen = new Uint8Array(W * H);
    const step = (x: number, y: number) => {
      for (const [dx, dy] of [[0, 0], [1, 0], [0, 1], [1, 1]]) {
        const t = this.at(x + dx, y + dy);
        if (seen[t]) continue;
        seen[t] = 1;
        order.push(t);
        this.tiles[t] = DimTile.Crumble;
      }
    };
    // Walk from the ledge's edge onto the path's start.
    this.walk(this.ledgeEdge(inLedge, start), start, rng.chance(0.5), step);
    for (let k = 0; k + 1 < points.length; k++) this.walk(points[k], points[k + 1], rng.chance(0.5), step);
    this.walk(end, this.ledgeEdge(outLedge, end), rng.chance(0.5), step);
    this.fill(inLedge, DimTile.Floor);
    this.fill(outLedge, DimTile.Floor);
    ch.checkpoints.push(feet(inLedge.x + Math.floor(inLedge.w / 2), inLedge.y + Math.floor(inLedge.h / 2)));
    for (const b of bends) {
      this.fill({ x: b.x, y: b.y, w: 2, h: 2 }, DimTile.Checkpoint);
      ch.checkpoints.push({ x: b.x + 1, y: b.y + 1.9 });
    }
    ch.goal = outLedge;
    // Runs of crumbling tiles, broken by glitching ones; a glitch run has a
    // safe step before it to wait on.
    const path = order.filter((t) => this.tiles[t] === DimTile.Crumble);
    for (let k = 0; k < path.length; ) {
      const len = rng.int(6, 10);
      if (k > 4 && k + len < path.length - 4 && rng.chance(0.45)) {
        const ph = rng.int(0, 255);
        for (let j = k; j < k + 2; j++) this.tiles[path[j]] = DimTile.Floor;
        for (let j = k + 2; j < k + len; j++) {
          this.tiles[path[j]] = DimTile.Glitch;
          this.phase[path[j]] = ph;
        }
      }
      k += len;
    }
    ch.path = path.filter((t) => this.tiles[t] === DimTile.Crumble || this.tiles[t] === DimTile.Glitch);
  }

  /** The tile of `ledge` nearest to `p`. */
  private ledgeEdge(ledge: Rect, p: Point): Point {
    return {
      x: Math.max(ledge.x, Math.min(ledge.x + ledge.w - 2, p.x)),
      y: Math.max(ledge.y, Math.min(ledge.y + ledge.h - 2, p.y)),
    };
  }

  /** Steps from `a` to `b`, along one axis and then the other. */
  private walk(a: Point, b: Point, xFirst: boolean, step: (x: number, y: number) => void): void {
    let { x, y } = a;
    step(x, y);
    for (let leg = 0; leg < 2; leg++) {
      if ((leg === 0) === xFirst) {
        while (x !== b.x) step((x += Math.sign(b.x - x)), y);
      } else {
        while (y !== b.y) step(x, (y += Math.sign(b.y - y)));
      }
    }
  }

  /** Plates in the middle, a mural of the order along a wall without a door. */
  private puzzle(i: number, ch: Chamber): void {
    const p = this.placed[i];
    const r = p.rect;
    const rng = this.rng;
    const pool = [0, 1, 2, 3, 4, 5];
    shuffle(pool, rng);
    const n = rng.int(4, 5);
    const glyphs = pool.slice(0, n);
    ch.order = shuffle(glyphs.slice(), rng);
    // Sides by outward direction; the chain comes in through one and leaves through another.
    const doorSides = new Set([(p.dir + 2) % 4, this.placed[i + 1].dir]);
    const side = [3, 1, 2, 0].find((s) => !doorSides.has(s))!;
    const horizontal = side === 1 || side === 3;
    const span = horizontal ? r.w - 2 : r.h - 2;
    const first = Math.floor((span - (2 * n - 1)) / 2) + 1;
    for (let k = 0; k < n; k++) {
      const along = first + k * 2;
      const x = horizontal ? r.x + along : side === 0 ? r.x + r.w - 2 : r.x + 1;
      const y = horizontal ? (side === 3 ? r.y + 1 : r.y + r.h - 2) : r.y + along;
      const t = this.at(x, y);
      this.tiles[t] = DimTile.Glyph;
      this.glyphs[t] = ch.order[k];
      ch.mural.push(t);
    }
    // Plates on a grid two apart, in the middle, shuffled.
    const spots: number[] = [];
    for (let y = r.y + 4; y <= r.y + r.h - 5; y += 2) {
      for (let x = r.x + 4; x <= r.x + r.w - 5; x += 2) {
        const t = this.at(x, y);
        if (this.tiles[t] === DimTile.Floor && !this.clear[t]) spots.push(t);
      }
    }
    // Rooms are big enough for this, but fall back to any floor rather than fail.
    if (spots.length < n) {
      for (let y = r.y + 2; y < r.y + r.h - 2; y++) for (let x = r.x + 2; x < r.x + r.w - 2; x++) if (this.tiles[this.at(x, y)] === DimTile.Floor) spots.push(this.at(x, y));
    }
    shuffle(spots, rng);
    ch.plates = new Array<number>(GLYPH_COUNT).fill(-1);
    for (let k = 0; k < n; k++) {
      const t = spots[k];
      this.tiles[t] = DimTile.Plate;
      this.glyphs[t] = glyphs[k];
      ch.plates[glyphs[k]] = t;
    }
  }
}

function inset(r: Rect, by: number): Rect {
  return { x: r.x + by, y: r.y + by, w: r.w - by * 2, h: r.h - by * 2 };
}

/** Feet position on a tile, as enemies stand in the world. */
function feet(x: number, y: number): Point {
  return { x: x + 0.5, y: y + 0.9 };
}

function shuffle<T>(a: T[], rng: Rng): T[] {
  for (let k = a.length - 1; k > 0; k--) {
    const j = rng.int(0, k);
    [a[k], a[j]] = [a[j], a[k]];
  }
  return a;
}
