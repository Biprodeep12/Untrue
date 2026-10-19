// Draws chunks: one batched mesh per chunk over a single atlas texture, plus
// pooled, y-sorted sprites for decorations. Chunks are loaded a chunk beyond
// the screen; those outside the camera's view are culled, so their meshes are
// not drawn and their sprites leave the sorted container. Rifts' tears are
// animated by swapping a few frames on a timer, their halos pulse, a scorched
// decal lies under each, and a rift's glitch can nudge a decoration near it
// for a moment; none of it costs anything without a rift.

import { Container, Mesh, MeshGeometry, Rectangle, Sprite, Texture } from 'pixi.js';
import { CHUNK_AREA, CHUNK_SIZE, TILE_SIZE } from '../config';
import { chunkKey } from '../coords';
import { hash3 } from '../generation/Random';
import { Deco, DECO_COUNT, Tile } from '../generation/Tiles';
import type { Chunk } from '../world/Chunk';
import type { ChunkListener } from '../world/ChunkManager';
import { ATLAS_H, ATLAS_W, decoFrame, dimFrame, RIFT_FPS, RIFT_FRAMES, riftFrame, tileCell, TILE_VARIANTS } from './Atlas';
import { TEAR_MID_UP } from './RiftArt';
import type { Light } from './Lighting';

/** Decorations that glow at night: radius in tiles, warmth, and the glow's
 *  colour if not a fire's. */
export const GLOWING: Partial<Record<number, [number, number, number?]>> = {
  [Deco.Fireplace]: [5, 1],
  [Deco.Lamp]: [3.5, 0.8],
  [Deco.Campfire]: [5, 1],
  [Deco.Meteorite]: [2.5, 0.6],
  [Deco.Moonwell]: [6, 0],
  [Deco.Rift]: [5, 1.1, 0xb07aff],
  [Deco.RiftScar]: [1.5, 0.3, 0x9ff8f2],
  // The outer dimensions.
  [Deco.RiftCrystal]: [3, 0.5, 0x5af0e8],
  [Deco.GlowCap]: [1.6, 0.35, 0x5af0e8],
  [Deco.LoreStone]: [2.5, 0.6, 0xb07aff],
  [Deco.Relic]: [2.5, 0.8, 0xffe28a],
  [Deco.Lectern]: [2, 0.5, 0x8ae8ff],
};
/** Decorations at least this tall, in pixels, fade as the player walks behind them. */
const TALL = 24;
/** Rifts' ground decals sort below everything standing. */
const GROUND_Z = -1e9;
/** Facade variant without a window; the rest glow at night. */
const BLANK_FACADE = 3;
/** Walls with something else below them show their front face. */
const WALL_FACES: Partial<Record<number, number>> = {
  [Tile.StoneWall]: Tile.StoneWallFace,
  [Tile.WoodWall]: Tile.WoodWallFace,
  [Tile.RuinWall]: Tile.RuinWallFace,
  [Tile.BookWall]: Tile.BookWallFace,
};

/** Pulls UVs in slightly so neighbouring atlas cells never bleed when zoomed out. */
const INSET = 0.02;
/** Culling margin in pixels: tall decorations reach above their tile, and lights glow past the edge. */
const CULL_PAD = 6 * TILE_SIZE;
const CHUNK_PX = CHUNK_SIZE * TILE_SIZE;

interface Drawn {
  mesh: Mesh<MeshGeometry>;
  sprites: Sprite[];
  /** The tall ones (trees and the like), which fade as the player walks behind. */
  tall: Sprite[];
  lights: Light[];
  /** Rifts' halos and ground decals: shown and pooled with the chunk, but
   *  never faded, jolted or reused as decorations. */
  fx: Sprite[];
  /** On screen (or near it) as of the last cull. */
  inView: boolean;
  cx: number;
  cy: number;
}

export class TileRenderer implements ChunkListener {
  private readonly drawn = new Map<number, Drawn>();
  private readonly chunkOf = new Map<number, Chunk>();
  private readonly meshPool: Mesh<MeshGeometry>[] = [];
  private readonly spritePool: Sprite[] = [];
  private readonly decoTextures: Texture[] = [];
  private readonly positions: Float32Array;
  private readonly indices: Uint32Array;
  /** The camera's view in world pixels, padded; reused every frame. */
  private readonly view = { minX: 0, minY: 0, maxX: 0, maxY: 0 };
  /** Nothing is culled until the first cull. */
  private culled = false;
  /** Rift sprites in drawn chunks, animated by `animate`; usually none. */
  private readonly rifts: Sprite[] = [];
  private readonly riftTextures: Texture[] = [];
  private riftTime = 0;
  /** Rifts' halos, pulsing with them; their scorched ground, open and closed. */
  private readonly halos: Sprite[] = [];
  private readonly haloTexture: Texture;
  private readonly groundTextures: Texture[];
  private readonly haloPool: Sprite[] = [];
  private readonly decalPool: Sprite[] = [];
  /** 0 to 1: how hard rifts flare, while the player steps through one. */
  flare = 0;
  /** Decorations a rift's glitch moved, their own x, and how long until they settle. */
  private readonly jolted: Sprite[] = [];
  private readonly joltX: number[] = [];
  private joltLeft = 0;

  constructor(
    private readonly atlas: Texture,
    private readonly ground: Container,
    private readonly entities: Container,
    /** The composed tile anywhere in the world, for neighbours across chunks. */
    private readonly tileAt: (gx: number, gy: number) => number | undefined = () => undefined,
  ) {
    for (let d = 0; d < DECO_COUNT; d++) {
      const { x, y, w, h } = decoFrame(d);
      this.decoTextures.push(new Texture({ source: atlas.source, frame: new Rectangle(x, y, w, h) }));
    }
    const frame = ({ x, y, w, h }: { x: number; y: number; w: number; h: number }) => new Texture({ source: atlas.source, frame: new Rectangle(x, y, w, h) });
    for (let f = 0; f < RIFT_FRAMES; f++) this.riftTextures.push(frame(riftFrame(f)));
    this.haloTexture = frame(dimFrame('rift-halo'));
    this.groundTextures = [frame(dimFrame('rift-ground:0')), frame(dimFrame('rift-ground:1'))];
    // Every chunk mesh shares the same quad layout; only UVs change.
    this.positions = new Float32Array(CHUNK_AREA * 8);
    this.indices = new Uint32Array(CHUNK_AREA * 6);
    for (let i = 0; i < CHUNK_AREA; i++) {
      const x = (i % CHUNK_SIZE) * TILE_SIZE;
      const y = Math.floor(i / CHUNK_SIZE) * TILE_SIZE;
      this.positions.set([x, y, x + TILE_SIZE, y, x + TILE_SIZE, y + TILE_SIZE, x, y + TILE_SIZE], i * 8);
      const v = i * 4;
      this.indices.set([v, v + 1, v + 2, v, v + 2, v + 3], i * 6);
    }
  }

  private readonly faded: Sprite[] = [];

  /** Makes tall sprites in front of the player see-through, as in Stardew. */
  fadeAround(px: number, py: number): void {
    for (const s of this.faded) s.alpha = 1;
    this.faded.length = 0;
    const cx = Math.floor(px / (CHUNK_SIZE * TILE_SIZE));
    const cy = Math.floor(py / (CHUNK_SIZE * TILE_SIZE));
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const d = this.drawn.get(chunkKey(cx + dx, cy + dy));
        if (!d) continue;
        // Only the tall ones, by their texture's size (a sprite's own size is
        // worked out from its bounds on every read); decorations are unscaled.
        for (const s of d.tall) {
          if (s.zIndex <= py) continue;
          const tex = s.texture;
          if (py <= s.y - tex.height || py - 20 >= s.y) continue;
          const half = tex.width / 2;
          // The player's body, from feet to head, overlaps the sprite.
          if (px > s.x - half && px < s.x + half) {
            s.alpha = 0.45;
            this.faded.push(s);
          }
        }
      }
    }
  }

  /** Swaps the frames of every rift's tear and pulses its halo (harder while
   *  it flares); nothing to do without one. */
  animate(dt: number): void {
    if (!this.rifts.length) return;
    this.riftTime += dt;
    const tex = this.riftTextures[Math.floor(this.riftTime * RIFT_FPS) % RIFT_FRAMES];
    const flare = this.flare;
    const sx = 1 + 0.3 * flare;
    const sy = 1 + 0.1 * flare;
    for (const s of this.rifts) {
      if (s.texture !== tex) s.texture = tex;
      if (s.scale.x !== sx) s.scale.set(sx, sy);
    }
    const pulse = Math.sin(this.riftTime * 2.4);
    const alpha = Math.min(1, 0.5 + 0.14 * pulse + 0.5 * flare);
    const size = 1 + 0.05 * pulse + 0.6 * flare;
    for (const h of this.halos) {
      h.alpha = alpha;
      h.scale.set(size);
    }
  }

  /** A rift's glitch: the decoration nearest a tile jumps sideways, tinted,
   *  until `settle` puts it back. */
  jolt(gx: number, gy: number, dx: number, tint: number, seconds: number): void {
    const d = this.drawn.get(chunkKey(Math.floor(gx / CHUNK_SIZE), Math.floor(gy / CHUNK_SIZE)));
    if (!d?.inView) return;
    const px = (gx + 0.5) * TILE_SIZE;
    const py = (gy + 1) * TILE_SIZE;
    let best: Sprite | null = null;
    let bestD = (4 * TILE_SIZE) ** 2;
    for (const s of d.sprites) {
      const e = (s.x - px) ** 2 + (s.y - py) ** 2;
      if (e < bestD && !this.jolted.includes(s) && !this.rifts.includes(s)) {
        bestD = e;
        best = s;
      }
    }
    if (!best) return;
    this.jolted.push(best);
    this.joltX.push(best.x);
    best.x += dx;
    best.tint = tint;
    this.joltLeft = seconds;
  }

  /** Puts jolted decorations back once their moment is over (now, for `Infinity`). */
  settle(dt: number): void {
    if (!this.jolted.length || (this.joltLeft -= dt) > 0) return;
    for (let i = 0; i < this.jolted.length; i++) {
      this.jolted[i].x = this.joltX[i];
      this.jolted[i].tint = 0xffffff;
    }
    this.jolted.length = 0;
    this.joltX.length = 0;
  }

  /** Hides every chunk until the next `cull`, e.g. while the player is in a dimension. */
  hideAll(): void {
    this.cull(-Infinity, -Infinity, -Infinity, -Infinity);
  }

  get drawnCount(): number {
    return this.drawn.size;
  }

  /** Shows only chunks overlapping the camera's view (world pixels). */
  cull(minX: number, minY: number, maxX: number, maxY: number): void {
    const v = this.view;
    v.minX = minX - CULL_PAD;
    v.minY = minY - CULL_PAD;
    v.maxX = maxX + CULL_PAD;
    v.maxY = maxY + CULL_PAD;
    this.culled = true;
    for (const d of this.drawn.values()) this.setInView(d, this.overlaps(d));
  }

  private overlaps(d: Drawn): boolean {
    if (!this.culled) return true;
    const v = this.view;
    const x = d.cx * CHUNK_PX;
    const y = d.cy * CHUNK_PX;
    return x < v.maxX && x + CHUNK_PX > v.minX && y < v.maxY && y + CHUNK_PX > v.minY;
  }

  private setInView(d: Drawn, inView: boolean): void {
    if (d.inView === inView) return;
    d.inView = inView;
    d.mesh.visible = inView;
    for (const s of d.sprites) {
      if (inView) this.entities.addChild(s);
      else this.entities.removeChild(s);
    }
    for (const s of d.fx) {
      if (inView) this.entities.addChild(s);
      else this.entities.removeChild(s);
    }
  }

  show(chunk: Chunk): void {
    const mesh = this.meshPool.pop() ?? this.createMesh();
    this.writeUVs(mesh, chunk);
    mesh.position.set(chunk.cx * CHUNK_SIZE * TILE_SIZE, chunk.cy * CHUNK_SIZE * TILE_SIZE);
    this.ground.addChild(mesh);
    const d: Drawn = { mesh, sprites: [], tall: [], lights: [], fx: [], inView: true, cx: chunk.cx, cy: chunk.cy };
    d.inView = this.overlaps(d);
    mesh.visible = d.inView;
    this.addDecos(d, chunk);
    this.collectLights(d, chunk);
    // The chunk above may have walls whose faces depended on this one.
    this.refreshFaces(chunk.cx, chunk.cy - 1);
    this.drawn.set(chunk.key, d);
    this.chunkOf.set(chunk.key, chunk);
  }

  hide(chunk: Chunk): void {
    const d = this.drawn.get(chunk.key);
    if (!d) return;
    this.drawn.delete(chunk.key);
    this.chunkOf.delete(chunk.key);
    this.ground.removeChild(d.mesh);
    this.meshPool.push(d.mesh);
    this.releaseSprites(d);
  }

  changed(chunk: Chunk): void {
    const d = this.drawn.get(chunk.key);
    if (!d) return;
    this.settle(Infinity);
    this.writeUVs(d.mesh, chunk);
    this.releaseSprites(d);
    this.addDecos(d, chunk);
    this.collectLights(d, chunk);
  }

  private createMesh(): Mesh<MeshGeometry> {
    const geometry = new MeshGeometry({
      positions: this.positions,
      uvs: new Float32Array(CHUNK_AREA * 8),
      indices: this.indices,
    });
    return new Mesh({ geometry, texture: this.atlas });
  }

  /** Every light source in chunks in view, in world pixels. */
  lights(out: Light[]): void {
    for (const d of this.drawn.values()) {
      if (!d.inView) continue;
      for (const l of d.lights) out.push(l);
    }
  }

  private collectLights(d: Drawn, chunk: Chunk): void {
    d.lights.length = 0;
    const ox = chunk.cx * CHUNK_SIZE;
    const oy = chunk.cy * CHUNK_SIZE;
    for (let i = 0; i < CHUNK_AREA; i++) {
      const gx = ox + (i % CHUNK_SIZE);
      const gy = oy + Math.floor(i / CHUNK_SIZE);
      const glow = GLOWING[chunk.decos[i]];
      // A rift's light comes from its tear, hanging above the tile.
      const lift = chunk.decos[i] === Deco.Rift ? TEAR_MID_UP - TILE_SIZE / 2 : 0;
      if (glow) d.lights.push({ x: (gx + 0.5) * TILE_SIZE, y: (gy + 0.5) * TILE_SIZE - lift, radius: glow[0] * TILE_SIZE, warmth: glow[1], color: glow[2] });
      else if (chunk.tiles[i] === Tile.Facade && hash3(gx, gy, 17) % TILE_VARIANTS !== BLANK_FACADE) {
        d.lights.push({ x: (gx + 0.5) * TILE_SIZE, y: (gy + 0.5) * TILE_SIZE, radius: 1.8 * TILE_SIZE, warmth: 0.45 });
      }
    }
  }

  /** Redraws a drawn chunk's tiles, e.g. once the chunk below it appears. */
  private refreshFaces(cx: number, cy: number): void {
    const above = this.chunkOf.get(chunkKey(cx, cy));
    const d = above && this.drawn.get(above.key);
    if (d && above) this.writeUVs(d.mesh, above);
  }

  private writeUVs(mesh: Mesh<MeshGeometry>, chunk: Chunk): void {
    const uvs = mesh.geometry.uvs;
    const ox = chunk.cx * CHUNK_SIZE;
    const oy = chunk.cy * CHUNK_SIZE;
    for (let i = 0; i < CHUNK_AREA; i++) {
      const gx = ox + (i % CHUNK_SIZE);
      const gy = oy + Math.floor(i / CHUNK_SIZE);
      const variant = hash3(gx, gy, 17) % TILE_VARIANTS;
      let tile = chunk.tiles[i];
      const face = WALL_FACES[tile];
      if (face !== undefined) {
        const below = i + CHUNK_SIZE < CHUNK_AREA ? chunk.tiles[i + CHUNK_SIZE] : this.tileAt(gx, gy + 1);
        if (below !== tile) tile = face;
      }
      const [x, y] = tileCell(tile, variant);
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
    mesh.geometry.getBuffer('aUV').update();
  }

  private addDecos(d: Drawn, chunk: Chunk): void {
    const ox = chunk.cx * CHUNK_SIZE * TILE_SIZE;
    const oy = chunk.cy * CHUNK_SIZE * TILE_SIZE;
    for (let i = 0; i < CHUNK_AREA; i++) {
      const deco = chunk.decos[i];
      if (!deco || deco === Deco.Footprint) continue;
      const s = this.spritePool.pop() ?? new Sprite({ anchor: { x: 0.5, y: 1 } });
      s.texture = this.decoTextures[deco];
      const x = ox + (i % CHUNK_SIZE) * TILE_SIZE + TILE_SIZE / 2;
      const y = oy + (Math.floor(i / CHUNK_SIZE) + 1) * TILE_SIZE;
      s.position.set(x, y);
      s.zIndex = y;
      if (d.inView) this.entities.addChild(s);
      d.sprites.push(s);
      if (s.texture.height >= TALL) d.tall.push(s);
      if (deco === Deco.Rift) {
        s.texture = this.riftTextures[Math.floor(this.riftTime * RIFT_FPS) % RIFT_FRAMES];
        this.rifts.push(s);
        this.addRiftFx(d, x, y, true);
      } else if (deco === Deco.RiftScar) this.addRiftFx(d, x, y, false);
    }
  }

  /** A rift's scorched ground under it and, while open, its halo behind the
   *  tear; (x, y) is the bottom centre of its tile. */
  private addRiftFx(d: Drawn, x: number, y: number, open: boolean): void {
    const g = this.decalPool.pop() ?? new Sprite({ anchor: 0.5 });
    g.texture = this.groundTextures[open ? 0 : 1];
    g.position.set(x, y - TILE_SIZE / 2);
    g.zIndex = GROUND_Z;
    d.fx.push(g);
    if (d.inView) this.entities.addChild(g);
    if (!open) return;
    const h = this.haloPool.pop() ?? new Sprite({ texture: this.haloTexture, anchor: 0.5, blendMode: 'add' });
    h.position.set(x, y - TEAR_MID_UP);
    h.zIndex = y - 0.5;
    d.fx.push(h);
    this.halos.push(h);
    if (d.inView) this.entities.addChild(h);
  }

  private releaseSprites(d: Drawn): void {
    this.settle(Infinity);
    for (const s of d.sprites) {
      if (this.rifts.length) {
        const r = this.rifts.indexOf(s);
        if (r >= 0) {
          this.rifts.splice(r, 1);
          s.scale.set(1);
        }
      }
      s.alpha = 1;
      if (d.inView) this.entities.removeChild(s);
      this.spritePool.push(s);
    }
    d.sprites.length = 0;
    d.tall.length = 0;
    for (const s of d.fx) {
      if (d.inView) this.entities.removeChild(s);
      const h = this.halos.indexOf(s);
      if (h >= 0) {
        this.halos.splice(h, 1);
        this.haloPool.push(s);
      } else this.decalPool.push(s);
    }
    d.fx.length = 0;
  }
}
