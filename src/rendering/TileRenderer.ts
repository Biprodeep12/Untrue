// Draws chunks: one batched mesh per chunk over a single atlas texture, plus
// pooled, y-sorted sprites for decorations. Chunks are loaded a chunk beyond
// the screen; those outside the camera's view are culled, so their meshes are
// not drawn and their sprites leave the sorted container.

import { Container, Mesh, MeshGeometry, Rectangle, Sprite, Texture } from 'pixi.js';
import { CHUNK_AREA, CHUNK_SIZE, TILE_SIZE } from '../config';
import { chunkKey } from '../coords';
import { hash3 } from '../generation/Random';
import { Deco, DECO_COUNT, Tile } from '../generation/Tiles';
import type { Chunk } from '../world/Chunk';
import type { ChunkListener } from '../world/ChunkManager';
import { ATLAS_H, ATLAS_W, decoFrame, tileCell, TILE_VARIANTS } from './Atlas';
import type { Light } from './Lighting';

/** Decorations that glow at night: radius in tiles and warmth. */
export const GLOWING: Partial<Record<number, [number, number]>> = {
  [Deco.Fireplace]: [5, 1],
  [Deco.Lamp]: [3.5, 0.8],
  [Deco.Campfire]: [5, 1],
  [Deco.Meteorite]: [2.5, 0.6],
  [Deco.Pedestal]: [2.5, 0.1],
  [Deco.AnchorCore]: [7, 0.3],
  [Deco.Monument]: [1.5, 0],
  [Deco.Book]: [2, 0.6],
  [Deco.Moonwell]: [6, 0],
};
/** Facade variant without a window; the rest glow at night. */
const BLANK_FACADE = 3;
/** Walls with something else below them show their front face. */
const WALL_FACES: Partial<Record<number, number>> = {
  [Tile.StoneWall]: Tile.StoneWallFace,
  [Tile.WoodWall]: Tile.WoodWallFace,
};

/** Pulls UVs in slightly so neighbouring atlas cells never bleed when zoomed out. */
const INSET = 0.02;
/** Culling margin in pixels: tall decorations reach above their tile, and lights glow past the edge. */
const CULL_PAD = 6 * TILE_SIZE;
const CHUNK_PX = CHUNK_SIZE * TILE_SIZE;

interface Drawn {
  mesh: Mesh<MeshGeometry>;
  sprites: Sprite[];
  lights: Light[];
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
        for (const s of d.sprites) {
          if (s.zIndex <= py || s.height < 24) continue;
          const half = s.width / 2;
          // The player's body, from feet to head, overlaps the sprite.
          if (px > s.x - half && px < s.x + half && py > s.y - s.height && py - 20 < s.y) {
            s.alpha = 0.45;
            this.faded.push(s);
          }
        }
      }
    }
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
  }

  show(chunk: Chunk): void {
    const mesh = this.meshPool.pop() ?? this.createMesh();
    this.writeUVs(mesh, chunk);
    mesh.position.set(chunk.cx * CHUNK_SIZE * TILE_SIZE, chunk.cy * CHUNK_SIZE * TILE_SIZE);
    this.ground.addChild(mesh);
    const d: Drawn = { mesh, sprites: [], lights: [], inView: true, cx: chunk.cx, cy: chunk.cy };
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
      if (glow) d.lights.push({ x: (gx + 0.5) * TILE_SIZE, y: (gy + 0.5) * TILE_SIZE, radius: glow[0] * TILE_SIZE, warmth: glow[1] });
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
      const y = oy + (Math.floor(i / CHUNK_SIZE) + 1) * TILE_SIZE;
      s.position.set(ox + (i % CHUNK_SIZE) * TILE_SIZE + TILE_SIZE / 2, y);
      s.zIndex = y;
      if (d.inView) this.entities.addChild(s);
      d.sprites.push(s);
    }
  }

  private releaseSprites(d: Drawn): void {
    for (const s of d.sprites) {
      s.alpha = 1;
      if (d.inView) this.entities.removeChild(s);
      this.spritePool.push(s);
    }
    d.sprites.length = 0;
  }
}
