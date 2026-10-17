// Draws an outer dimension: the static floor as one batched mesh per 16 x 16
// block over the atlas (as TileRenderer does for chunks), flat overlays for
// tiles that change (crumbling, glitching, plates), and y-sorted props
// (pillars, crystals, mural stones, gates, the chest, the portal, the rift)
// that stand among the player and enemies. Everything is made once in
// `open()`; frames only cull blocks and swap textures on tiles in view whose
// look changed. Sprites and meshes are pooled across runs.

import { Container, Mesh, MeshGeometry, Rectangle, Sprite, Texture } from 'pixi.js';
import { TILE_SIZE } from '../config';
import type { DimensionRun } from '../dimension/Challenges';
import { DimTile } from '../dimension/DimTile';
import { hash3 } from '../generation/Random';
import { ATLAS_H, ATLAS_W, dimCell, dimFrame, TILE_VARIANTS } from './Atlas';
import type { Light } from './Lighting';

/** Block edge in tiles: one mesh and one cull test each. */
const BLOCK = 16;
const BLOCK_AREA = BLOCK * BLOCK;
const BLOCK_PX = BLOCK * TILE_SIZE;
/** Culling margin in pixels, for tall props and light glow. */
const CULL_PAD = 4 * TILE_SIZE;
const INSET = 0.02;
const GLYPHS = 6;

/** How each kind of slot is drawn and updated. */
const Kind = {
  Crumble: 0,
  Glitch: 1,
  Plate: 2,
  Glyph: 3,
  Chest: 4,
  Portal: 5,
  Rift: 6,
  Gate: 7,
  /** Pillars and crystals: never change. */
  Still: 8,
} as const;

/** Lights by tile: radius in tiles and warmth. */
const GLOW: Partial<Record<number, [number, number]>> = {
  [DimTile.Crystal]: [3.5, 0],
  [DimTile.Rift]: [4, 0],
  [DimTile.Checkpoint]: [1.5, 0],
  [DimTile.Portal]: [5, 0.15],
};

interface Block {
  mesh: Mesh<MeshGeometry>;
  bx: number;
  by: number;
  inView: boolean;
  /** Slot indices: overlays on the floor, and props among the entities. */
  flats: number[];
  props: number[];
  lights: Light[];
}

export class DimensionRenderer {
  private readonly base = new Container();
  private readonly flats = new Container();
  private readonly blocks: Block[] = [];
  private readonly meshPool: Mesh<MeshGeometry>[] = [];
  private readonly spritePool: Sprite[] = [];
  private readonly lightPool: Light[] = [];
  private readonly positions: Float32Array;
  private readonly indices: Uint32Array;
  // Slots: one per changing tile or prop.
  private slotSprite: Sprite[] = [];
  private slotTile: number[] = [];
  private slotKind: number[] = [];
  private portalLight: Light | null = null;
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
  private readonly rift: Texture[];
  private readonly gate: Texture[];
  private readonly pillar: Texture;
  private readonly crystal: Texture;

  constructor(
    private readonly atlas: Texture,
    /** Below everything that stands: gets the floor meshes and overlays. */
    ground: Container,
    /** The y-sorted container the player and enemies are in: gets the props. */
    private readonly entities: Container,
  ) {
    ground.addChild(this.base, this.flats);
    this.base.visible = this.flats.visible = false;
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
    this.rift = range(2).map((f) => prop(`rift:${f}`));
    this.gate = range(2).map((f) => prop(`gate:${f}`));
    this.pillar = prop('pillar');
    this.crystal = prop('crystal');
    // Every block mesh shares one quad layout; only UVs change.
    this.positions = new Float32Array(BLOCK_AREA * 8);
    this.indices = new Uint32Array(BLOCK_AREA * 6);
    for (let i = 0; i < BLOCK_AREA; i++) {
      const x = (i % BLOCK) * TILE_SIZE;
      const y = Math.floor(i / BLOCK) * TILE_SIZE;
      this.positions.set([x, y, x + TILE_SIZE, y, x + TILE_SIZE, y + TILE_SIZE, x, y + TILE_SIZE], i * 8);
      const v = i * 4;
      this.indices.set([v, v + 1, v + 2, v, v + 2, v + 3], i * 6);
    }
  }

  get opened(): boolean {
    return this.run !== null;
  }

  /** Builds the floor and props of a run's dimension. */
  open(run: DimensionRun): void {
    this.close();
    this.run = run;
    const L = run.layout;
    const bw = Math.ceil(L.w / BLOCK);
    const bh = Math.ceil(L.h / BLOCK);
    for (let by = 0; by < bh; by++) {
      for (let bx = 0; bx < bw; bx++) {
        const mesh = this.meshPool.pop() ?? this.createMesh();
        mesh.position.set(bx * BLOCK_PX, by * BLOCK_PX);
        mesh.visible = false;
        this.base.addChild(mesh);
        const b: Block = { mesh, bx, by, inView: false, flats: [], props: [], lights: [] };
        this.writeUVs(b);
        this.addSlots(b);
        this.blocks.push(b);
      }
    }
    this.base.visible = this.flats.visible = true;
  }

  /** Clears the dimension, keeping meshes and sprites for the next one. */
  close(): void {
    if (!this.run) return;
    for (const b of this.blocks) {
      this.base.removeChild(b.mesh);
      this.meshPool.push(b.mesh);
      for (const s of b.props) if (b.inView) this.entities.removeChild(this.slotSprite[s]);
      for (const l of b.lights) this.lightPool.push(l);
    }
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
    this.portalLight = null;
    this.run = null;
    this.base.visible = this.flats.visible = false;
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
      for (const s of b.props) if (this.slotKind[s] !== Kind.Still) this.look(run, s);
    }
    if (this.portalLight) this.portalLight.radius = (run.portalOpen ? 5 : 1.5) * TILE_SIZE;
  }

  /** Crystals, the rift, safe pads and the portal light the dark, in view only. */
  lights(out: Light[]): void {
    for (const b of this.blocks) if (b.inView) for (const l of b.lights) out.push(l);
  }

  private setInView(b: Block, inView: boolean): void {
    b.inView = inView;
    b.mesh.visible = inView;
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
      case Kind.Rift:
        tex = this.rift[Math.floor(time * 5) % 2];
        break;
      case Kind.Gate:
        if (run.stateOf(t) === 1) tex = this.gate[Math.floor(time * 6) % 2];
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

  private addSlots(b: Block): void {
    const L = this.run!.layout;
    for (let ly = 0; ly < BLOCK; ly++) {
      for (let lx = 0; lx < BLOCK; lx++) {
        const gx = b.bx * BLOCK + lx;
        const gy = b.by * BLOCK + ly;
        if (gx >= L.w || gy >= L.h) continue;
        const t = gy * L.w + gx;
        const tile = L.tiles[t];
        const glow = GLOW[tile];
        if (glow) {
          const l = this.lightPool.pop() ?? { x: 0, y: 0, radius: 0, warmth: 0 };
          l.x = (gx + 0.5) * TILE_SIZE;
          l.y = (gy + 0.5) * TILE_SIZE;
          l.radius = glow[0] * TILE_SIZE;
          l.warmth = glow[1];
          b.lights.push(l);
          if (tile === DimTile.Portal) this.portalLight = l;
        }
        switch (tile) {
          case DimTile.Crumble:
            this.slot(b, t, Kind.Crumble, this.crumble[0], true);
            break;
          case DimTile.Glitch:
            this.slot(b, t, Kind.Glitch, this.glitch[0], true);
            break;
          case DimTile.Plate:
            this.slot(b, t, Kind.Plate, this.plateUp[0], true);
            break;
          case DimTile.Glyph:
            this.slot(b, t, Kind.Glyph, this.stele[0], false);
            break;
          case DimTile.Chest:
            this.slot(b, t, Kind.Chest, this.chest[0], false);
            break;
          case DimTile.Portal:
            this.slot(b, t, Kind.Portal, this.portal[0], false);
            break;
          case DimTile.Rift:
            this.slot(b, t, Kind.Rift, this.rift[0], false);
            break;
          case DimTile.Door:
            this.slot(b, t, Kind.Gate, this.gate[0], false);
            break;
          case DimTile.Pillar:
            this.slot(b, t, Kind.Still, this.pillar, false);
            break;
          case DimTile.Crystal:
            this.slot(b, t, Kind.Still, this.crystal, false);
            break;
        }
      }
    }
  }

  private slot(b: Block, t: number, kind: number, tex: Texture, flat: boolean): void {
    const w = this.run!.layout.w;
    const gx = t % w;
    const gy = Math.floor(t / w);
    const s = this.spritePool.pop() ?? new Sprite();
    s.texture = tex;
    s.visible = true;
    s.alpha = 1;
    const i = this.slotSprite.length;
    this.slotSprite.push(s);
    this.slotTile.push(t);
    this.slotKind.push(kind);
    if (flat) {
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

  private createMesh(): Mesh<MeshGeometry> {
    const geometry = new MeshGeometry({ positions: this.positions, uvs: new Float32Array(BLOCK_AREA * 8), indices: this.indices });
    return new Mesh({ geometry, texture: this.atlas });
  }

  /** The static floor: void, stone, walls (top or face by what is below), and
   *  the floor under everything drawn on top. */
  private writeUVs(b: Block): void {
    const L = this.run!.layout;
    const uvs = b.mesh.geometry.uvs;
    for (let i = 0; i < BLOCK_AREA; i++) {
      const gx = b.bx * BLOCK + (i % BLOCK);
      const gy = b.by * BLOCK + Math.floor(i / BLOCK);
      const inside = gx < L.w && gy < L.h;
      const tile = inside ? L.tiles[gy * L.w + gx] : DimTile.Void;
      const v = hash3(gx, gy, 17) % TILE_VARIANTS;
      let x: number;
      let y: number;
      switch (tile) {
        case DimTile.Void:
        case DimTile.Crumble:
        case DimTile.Glitch:
          [x, y] = dimCell('void', v);
          break;
        case DimTile.Wall: {
          const below = gy + 1 < L.h ? L.tiles[(gy + 1) * L.w + gx] : DimTile.Void;
          [x, y] = dimCell(below === DimTile.Wall ? 'wall-top' : 'wall-face', v);
          break;
        }
        case DimTile.Checkpoint:
          [x, y] = dimCell('checkpoint', 0);
          break;
        case DimTile.Rune:
          [x, y] = dimCell('rune', (gx + gy) % 2);
          break;
        default:
          [x, y] = dimCell('floor', v);
      }
      const u0 = (x + INSET) / ATLAS_W;
      const v0 = (y + INSET) / ATLAS_H;
      const u1 = (x + 16 - INSET) / ATLAS_W;
      const v1 = (y + 16 - INSET) / ATLAS_H;
      const o = i * 8;
      uvs[o] = u0;
      uvs[o + 1] = v0;
      uvs[o + 2] = u1;
      uvs[o + 3] = v0;
      uvs[o + 4] = u1;
      uvs[o + 5] = v1;
      uvs[o + 6] = u0;
      uvs[o + 7] = v1;
    }
    b.mesh.geometry.getBuffer('aUV').update();
  }

  private texture(x: number, y: number, w: number, h: number): Texture {
    return new Texture({ source: this.atlas.source, frame: new Rectangle(x, y, w, h) });
  }
}
