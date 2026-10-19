// Draws what changes on a dimension's challenge sites, over its land (which
// the dimension's own `TileRenderer` draws like the overworld): flat overlays
// for slabs and plates that crack, blink and press, the black water of a tide
// hall rising and falling over its floor, its valves, and props standing among
// the player and enemies (gates, mural stones, the vault's chest, the portal).
// Only site tiles get a sprite, made once in `open()` and grouped in 16 x 16
// blocks for culling; frames touch only blocks in view, and only what changed.
// Sprites are pooled across trips. No meshes: the land is never redrawn here.

import { Container, Rectangle, Sprite, Texture } from 'pixi.js';
import { TILE_SIZE } from '../config';
import type { DimensionRun } from '../dimension/Challenges';
import { DimTile } from '../dimension/DimTile';
import { dimCell, dimFrame } from './Atlas';
import type { Light } from './Lighting';

/** Block edge in tiles: one cull test each. */
const BLOCK = 16;
const BLOCK_PX = BLOCK * TILE_SIZE;
/** Culling margin in pixels, for tall props and light glow. */
const CULL_PAD = 4 * TILE_SIZE;
const GLYPHS = 6;

/** How each kind of slot is drawn and updated. */
const Kind = {
  Crumble: 0,
  Glitch: 1,
  Plate: 2,
  Glyph: 3,
  Chest: 4,
  Portal: 5,
  Gate: 6,
  Flood: 7,
  Valve: 8,
} as const;

interface Block {
  bx: number;
  by: number;
  inView: boolean;
  /** Slot indices: overlays on the ground, and props among the entities. */
  flats: number[];
  props: number[];
}

export class SiteRenderer {
  /** Above the land's meshes, below everything that stands. */
  readonly flats = new Container();
  private readonly blocks: Block[] = [];
  private readonly spritePool: Sprite[] = [];
  // Slots: one per site tile.
  private slotSprite: Sprite[] = [];
  private slotTile: number[] = [];
  private slotKind: number[] = [];
  private readonly portalLight: Light = { x: 0, y: 0, radius: 0, warmth: 0.15 };
  private portalBlock: Block | null = null;
  private run: DimensionRun | null = null;
  // Textures, made once.
  private readonly crumble: Texture[];
  private readonly glitch: Texture[];
  private readonly plateUp: Texture[];
  private readonly plateDown: Texture[];
  /** Mural stones: glyph * 3 + state (dark, hinted, done). */
  private readonly stele: Texture[] = [];
  private readonly chest: Texture[];
  private readonly portal: Texture[];
  private readonly gate: Texture[];
  private readonly flood: Texture[];
  private readonly valve: Texture[];

  constructor(
    private readonly atlas: Texture,
    /** The y-sorted container the player and enemies are in: gets the props. */
    private readonly entities: Container,
  ) {
    this.flats.visible = false;
    const cell = (key: string, v: number) => {
      const [x, y] = dimCell(key, v);
      return this.texture(x, y, 16, 16);
    };
    const prop = (key: string) => {
      const f = dimFrame(key);
      return this.texture(f.x, f.y, f.w, f.h);
    };
    const range = (n: number) => Array.from({ length: n }, (_, i) => i);
    this.crumble = range(3).map((v) => cell('crumble', v));
    this.glitch = range(3).map((v) => cell('glitch', v));
    this.plateUp = range(GLYPHS).map((g) => cell('plate-up', g));
    this.plateDown = range(GLYPHS).map((g) => cell('plate-down', g));
    for (let g = 0; g < GLYPHS; g++) for (let s = 0; s < 3; s++) this.stele.push(prop(`glyph:${g}:${s}`));
    this.chest = range(3).map((s) => prop(`chest:${s}`));
    this.portal = range(4).map((f) => prop(`portal:${f}`));
    this.gate = range(2).map((f) => prop(`gate:${f}`));
    this.flood = range(3).map((v) => cell('flood', v));
    this.valve = range(2).map((v) => cell('valve', v));
  }

  get opened(): boolean {
    return this.run !== null;
  }

  /** Makes the sprites of a run's sites. */
  open(run: DimensionRun): void {
    this.close();
    this.run = run;
    const L = run.layout;
    const byKey = new Map<number, Block>();
    const bw = Math.ceil(L.w / BLOCK);
    for (let t = 0; t < L.tiles.length; t++) {
      const kind = KIND_OF[L.tiles[t]];
      if (kind === undefined) continue;
      const bx = Math.floor((t % L.w) / BLOCK);
      const by = Math.floor(Math.floor(t / L.w) / BLOCK);
      let b = byKey.get(by * bw + bx);
      if (!b) {
        byKey.set(by * bw + bx, (b = { bx, by, inView: false, flats: [], props: [] }));
        this.blocks.push(b);
      }
      this.slot(b, t, kind);
      if (kind === Kind.Portal) {
        this.portalBlock = b;
        this.portalLight.x = ((t % L.w) + 0.5) * TILE_SIZE;
        this.portalLight.y = (Math.floor(t / L.w) - 1) * TILE_SIZE;
      }
    }
    this.flats.visible = true;
  }

  /** Clears the sites, keeping the sprites for the next trip. */
  close(): void {
    if (!this.run) return;
    for (const b of this.blocks) for (const s of b.props) if (b.inView) this.entities.removeChild(this.slotSprite[s]);
    for (const s of this.slotSprite) {
      s.visible = true;
      s.alpha = 1;
      this.spritePool.push(s);
    }
    this.flats.removeChildren();
    this.blocks.length = 0;
    this.slotSprite = [];
    this.slotTile = [];
    this.slotKind = [];
    this.portalBlock = null;
    this.run = null;
    this.flats.visible = false;
  }

  /** Culls to the camera's view (world pixels) and animates what is in it. */
  update(minX: number, minY: number, maxX: number, maxY: number): void {
    const run = this.run;
    if (!run) return;
    minX -= CULL_PAD;
    minY -= CULL_PAD;
    maxX += CULL_PAD;
    maxY += CULL_PAD;
    for (const b of this.blocks) {
      const x = b.bx * BLOCK_PX;
      const y = b.by * BLOCK_PX;
      const inView = x < maxX && x + BLOCK_PX > minX && y < maxY && y + BLOCK_PX > minY;
      if (inView !== b.inView) this.setInView(b, inView);
      if (!inView) continue;
      for (const s of b.flats) this.look(run, s);
      for (const s of b.props) this.look(run, s);
    }
    this.portalLight.radius = (run.portalOpen ? 5 : 1.5) * TILE_SIZE;
  }

  /** The portal's glow, when in view. */
  lights(out: Light[]): void {
    if (this.portalBlock?.inView) out.push(this.portalLight);
  }

  private setInView(b: Block, inView: boolean): void {
    b.inView = inView;
    for (const s of b.flats) this.slotSprite[s].renderable = inView;
    for (const s of b.props) {
      if (inView) this.entities.addChild(this.slotSprite[s]);
      else this.entities.removeChild(this.slotSprite[s]);
    }
  }

  /** Sets a slot's texture and fade from the run's state, touching only what changed. */
  private look(run: DimensionRun, slot: number): void {
    const sprite = this.slotSprite[slot];
    const t = this.slotTile[slot];
    const time = run.time;
    let tex: Texture | null = null;
    let alpha = 1;
    let dx = 0;
    switch (this.slotKind[slot]) {
      case Kind.Crumble: {
        const s = run.stateOf(t);
        if (s < 1) {
          tex = this.crumble[s === 0 ? 0 : s < 0.5 ? 1 : 2];
          // Cracking slabs shudder.
          if (s > 0) dx = Math.floor(time * 30) % 2 ? 1 : -1;
        }
        break;
      }
      case Kind.Glitch: {
        const s = run.stateOf(t);
        if (s === 0) tex = this.glitch[0];
        else if (s < 1) {
          tex = this.glitch[Math.floor(time * 20) % 2 ? 1 : 0];
          alpha = 0.85;
        } else {
          // A ghost of where it will come back.
          tex = this.glitch[2];
          alpha = 0.22;
        }
        break;
      }
      case Kind.Plate: {
        const g = run.layout.glyphs[t];
        tex = run.stateOf(t) >= 1 ? this.plateDown[g] : this.plateUp[g];
        break;
      }
      case Kind.Glyph: {
        const s = run.stateOf(t);
        tex = this.stele[run.layout.glyphs[t] * 3 + (s >= 1 ? 2 : s > 0 ? 1 : 0)];
        break;
      }
      case Kind.Chest:
        tex = this.chest[run.stateOf(t)];
        break;
      case Kind.Portal:
        tex = run.portalOpen ? this.portal[1 + (Math.floor(time * 6) % 3)] : this.portal[0];
        break;
      case Kind.Gate:
        if (run.stateOf(t) === 1) tex = this.gate[Math.floor(time * 6) % 2];
        break;
      case Kind.Flood: {
        // Dry floor is the land's own; the water creeps in, then covers it.
        const s = run.stateOf(t);
        if (s >= 1) tex = this.flood[2];
        else if (s > 0) {
          tex = this.flood[1];
          alpha = 0.5 + 0.5 * s;
        }
        break;
      }
      case Kind.Valve:
        // Under water with its band, else turned or not.
        tex = run.holeAt(t) ? this.flood[2] : this.valve[run.stateOf(t) >= 1 ? 1 : 0];
        break;
    }
    const visible = tex !== null;
    if (sprite.visible !== visible) sprite.visible = visible;
    if (!tex) return;
    if (sprite.texture !== tex) sprite.texture = tex;
    if (sprite.alpha !== alpha) sprite.alpha = alpha;
    const x = ((t % run.layout.w) + 0.5) * TILE_SIZE + dx;
    if (sprite.x !== x) sprite.x = x;
  }

  private slot(b: Block, t: number, kind: number): void {
    const w = this.run!.layout.w;
    const gx = t % w;
    const gy = Math.floor(t / w);
    const s = this.spritePool.pop() ?? new Sprite();
    s.texture = this.firstLook(kind);
    s.visible = true;
    s.alpha = 1;
    const i = this.slotSprite.length;
    this.slotSprite.push(s);
    this.slotTile.push(t);
    this.slotKind.push(kind);
    if (kind === Kind.Crumble || kind === Kind.Glitch || kind === Kind.Plate || kind === Kind.Flood || kind === Kind.Valve) {
      s.anchor.set(0.5, 0);
      s.position.set((gx + 0.5) * TILE_SIZE, gy * TILE_SIZE);
      s.renderable = false;
      this.flats.addChild(s);
      b.flats.push(i);
    } else {
      // Props stand on the bottom centre of their tile and sort by it.
      s.anchor.set(0.5, 1);
      s.position.set((gx + 0.5) * TILE_SIZE, (gy + 1) * TILE_SIZE);
      s.zIndex = (gy + 1) * TILE_SIZE;
      s.renderable = true;
      b.props.push(i);
    }
  }

  /** A slot's first look by kind (the next `update` sets the real one). */
  private firstLook(kind: number): Texture {
    switch (kind) {
      case Kind.Crumble:
        return this.crumble[0];
      case Kind.Glitch:
        return this.glitch[0];
      case Kind.Plate:
        return this.plateUp[0];
      case Kind.Glyph:
        return this.stele[0];
      case Kind.Chest:
        return this.chest[0];
      case Kind.Portal:
        return this.portal[0];
      case Kind.Flood:
        return this.flood[2];
      case Kind.Valve:
        return this.valve[0];
      default:
        return this.gate[0];
    }
  }

  private texture(x: number, y: number, w: number, h: number): Texture {
    return new Texture({ source: this.atlas.source, frame: new Rectangle(x, y, w, h) });
  }
}

/** The slot kind of each site tile; none for `None`. */
const KIND_OF: Partial<Record<number, number>> = {
  [DimTile.Crumble]: Kind.Crumble,
  [DimTile.Glitch]: Kind.Glitch,
  [DimTile.Plate]: Kind.Plate,
  [DimTile.Glyph]: Kind.Glyph,
  [DimTile.Chest]: Kind.Chest,
  [DimTile.Portal]: Kind.Portal,
  [DimTile.Gate]: Kind.Gate,
  [DimTile.Flood]: Kind.Flood,
  [DimTile.Valve]: Kind.Valve,
};
