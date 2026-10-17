// Ties streaming, biomes, objects and visit counters together. Renderer-agnostic,
// so tests can drive it with a synchronous generator.

import { CHUNK_SIZE } from '../config';
import { chunkKey, keyX, keyY, tileToChunk } from '../coords';
import { hash, Stream } from '../generation/Random';
import { rollAnchor } from '../generation/StructureGenerator';
import { TerrainFields, type ChunkRequest } from '../generation/TerrainGenerator';
import { Deco, isSolid, paletteOf } from '../generation/Tiles';
import { BiomeManager, type BiomeRecord } from './BiomeManager';
import { ChunkManager, type ChunkGenerator, type View } from './ChunkManager';
import { ObjectManager } from './ObjectManager';
import { GroundItems } from './GroundItems';
import { RegionTracker } from './Regions';
import { WorldObject } from './WorldObject';

/** Plants that grow back, after this many in-game minutes, while their region
 *  stays loaded (spec 6.2, resource regeneration). */
const REGROW_MINUTES: Partial<Record<number, number>> = {
  [Deco.Bush]: 1440,
  [Deco.Flowers]: 1440,
  [Deco.Mushroom]: 2160,
  [Deco.Crop]: 1440,
};

interface Cut {
  deco: number;
  /** In-game minute it was gathered. */
  at: number;
}

export class WorldManager {
  readonly fields: TerrainFields;
  readonly biomes: BiomeManager;
  readonly objects = new ObjectManager();
  readonly regions = new RegionTracker();
  readonly chunks: ChunkManager;
  /** Anchors whose chests the player has looted: chests never refill there. */
  readonly lootedAnchors = new Set<string>();
  /** Dungeons, arenas and legendary spots the player has cleared: they stay
   *  cleared. Closed rifts are kept by object id instead, which changes when
   *  their region regenerates, so a new rift may open there. */
  readonly clearedAnchors = new Set<string>();
  /** Decorations the player removed, per chunk, valid for one region visit. */
  private readonly harvested = new Map<number, { visit: number; cells: Map<number, Cut> }>();
  /** Items dropped on the ground. */
  readonly ground = new GroundItems();
  /** In-game minutes since the world began; set by the game clock. */
  now: () => number = () => 0;
  onDiscover?: (o: WorldObject) => void;

  constructor(
    readonly seed: number,
    generator: ChunkGenerator,
  ) {
    this.fields = new TerrainFields(seed);
    this.biomes = new BiomeManager(this.fields);
    this.chunks = new ChunkManager(generator, {
      cacheEnter: (keys) => this.cacheEnter(keys),
      cacheLeave: (keys) => this.cacheLeave(keys),
      buildRequest: (cx, cy, token) => this.buildRequest(cx, cy, token),
      compose: (chunk) => {
        chunk.tiles.set(chunk.baseTiles);
        chunk.decos.set(chunk.baseDecos);
        for (const o of this.objects.inChunk(chunk.key)) o.stamp(chunk);
        const cut = this.harvested.get(chunk.key);
        if (cut?.visit !== this.regions.visit(chunk.cx, chunk.cy)) return;
        for (const [i, c] of cut.cells) if (!this.regrown(c)) chunk.decos[i] = 0;
      },
    });
  }

  update(view: View): void {
    this.chunks.update(view);
    this.discover(Math.floor(view.playerX), Math.floor(view.playerY));
  }

  /** Biome of the chunk containing a tile, if loaded. */
  biomeAt(gx: number, gy: number): BiomeRecord | undefined {
    return this.biomes.at(chunkKey(tileToChunk(gx), tileToChunk(gy)));
  }

  /** Composed tile and decoration, or null while the chunk is not generated. */
  tileAt(gx: number, gy: number): { tile: number; deco: number } | null {
    const chunk = this.chunks.get(tileToChunk(gx), tileToChunk(gy));
    if (!chunk?.ready) return null;
    const i = (gy - chunk.cy * CHUNK_SIZE) * CHUNK_SIZE + (gx - chunk.cx * CHUNK_SIZE);
    return { tile: chunk.tiles[i], deco: chunk.decos[i] };
  }

  /** Unloaded ground counts as solid so the player cannot walk into the void.
   *  Called many times a frame by every walker: reads the chunk directly
   *  instead of allocating a tile object. */
  isSolidAt(gx: number, gy: number): boolean {
    const chunk = this.chunks.get(tileToChunk(gx), tileToChunk(gy));
    if (!chunk?.ready) return true;
    const i = (gy - chunk.cy * CHUNK_SIZE) * CHUNK_SIZE + (gx - chunk.cx * CHUNK_SIZE);
    return isSolid(chunk.tiles[i], chunk.decos[i]);
  }

  /** Seeds what gathering a tile gives; changes when its region regenerates. */
  seedAt(gx: number, gy: number): number {
    return hash(Stream.Loot, this.seed, gx, gy, this.regions.visit(tileToChunk(gx), tileToChunk(gy)));
  }

  /** Removes a decoration the player gathered. It stays gone until the
   *  region fully unloads and regenerates, or until a plant grows back. */
  harvest(gx: number, gy: number): void {
    const cx = tileToChunk(gx);
    const cy = tileToChunk(gy);
    const key = chunkKey(cx, cy);
    const visit = this.regions.visit(cx, cy);
    let cut = this.harvested.get(key);
    if (cut?.visit !== visit) this.harvested.set(key, (cut = { visit, cells: new Map() }));
    const deco = this.tileAt(gx, gy)?.deco ?? 0;
    cut.cells.set((gy - cy * CHUNK_SIZE) * CHUNK_SIZE + (gx - cx * CHUNK_SIZE), { deco, at: this.now() });
    const chunk = this.chunks.get(cx, cy);
    if (chunk) this.chunks.refresh(chunk);
  }

  /** Lets plants whose time has come grow back. Call once per in-game hour. */
  regrow(): void {
    for (const [key, cut] of this.harvested) {
      let grew = false;
      for (const [i, c] of cut.cells) {
        if (!this.regrown(c)) continue;
        cut.cells.delete(i);
        grew = true;
      }
      // Everything grew back: nothing left to remember or save.
      if (cut.cells.size === 0) this.harvested.delete(key);
      const chunk = grew ? this.chunks.chunks.get(key) : undefined;
      if (chunk) this.chunks.refresh(chunk);
    }
  }

  /** The harvest log, for saving: per chunk, flat triples of cell, decoration, minute. */
  saveHarvest(): Array<{ key: number; visit: number; cells: number[] }> {
    return [...this.harvested].map(([key, cut]) => ({ key, visit: cut.visit, cells: [...cut.cells].flatMap(([i, c]) => [i, c.deco, c.at]) }));
  }

  loadHarvest(saved: Array<{ key: number; visit: number; cells: number[] }>): void {
    for (const s of saved) {
      const cells = new Map<number, Cut>();
      for (let i = 0; i + 2 < s.cells.length; i += 3) cells.set(s.cells[i], { deco: s.cells[i + 1], at: s.cells[i + 2] });
      this.harvested.set(s.key, { visit: s.visit, cells });
    }
  }

  private regrown(c: Cut): boolean {
    const wait = REGROW_MINUTES[c.deco];
    return wait !== undefined && this.now() - c.at >= wait;
  }

  /** The unopened chest on a tile, as its object and layout index. */
  chestAt(gx: number, gy: number): { object: WorldObject; index: number } | null {
    if (this.tileAt(gx, gy)?.deco !== Deco.Chest) return null;
    for (const object of this.objects.inChunk(chunkKey(tileToChunk(gx), tileToChunk(gy)))) {
      if (!object.contains(gx, gy)) continue;
      const index = (gy - object.y) * object.w + (gx - object.x);
      if (object.layout.decos[index] === Deco.Chest) return { object, index };
    }
    return null;
  }

  /** Marks a chest looted, for this object and for every later regeneration. */
  openChest(object: WorldObject, index: number): void {
    object.opened.add(index);
    if (object.anchor) this.lootedAnchors.add(object.anchor);
    this.refreshObject(object);
  }

  /** Closes a rift for as long as its object lives (and its id is rolled again). */
  closeRift(o: WorldObject): void {
    o.closed = true;
    this.clearedAnchors.add(o.id);
    this.refreshObject(o);
  }

  /** The nearest open rift among the live objects, if any. */
  nearestRift(x: number, y: number): WorldObject | null {
    let best: WorldObject | null = null;
    let bestD = Infinity;
    for (const o of this.objects.ofKind('rift')) {
      if (o.closed) continue;
      const d = (o.x + o.w / 2 - x) ** 2 + (o.y + o.h / 2 - y) ** 2;
      if (d < bestD) {
        bestD = d;
        best = o;
      }
    }
    return best;
  }

  /** True if a decoration of this type lies within `radius` tiles. */
  near(gx: number, gy: number, radius: number, deco: number): boolean {
    for (let y = gy - radius; y <= gy + radius; y++) {
      for (let x = gx - radius; x <= gx + radius; x++) if (this.tileAt(x, y)?.deco === deco) return true;
    }
    return false;
  }

  /** Takes an object out of the world and redraws what was under it. */
  removeObject(o: WorldObject): void {
    this.objects.remove(o);
    this.refreshObject(o);
  }

  /** Registers an object and redraws any loaded chunk it covers. */
  addObject(o: WorldObject): void {
    this.objects.add(o, this.chunks.isCached);
    this.refreshObject(o);
  }

  /** Re-stamps the loaded chunks under an object, e.g. after its layout changed. */
  refreshObject(o: WorldObject): void {
    for (const key of o.chunks) {
      const chunk = this.chunks.chunks.get(key);
      if (chunk) this.chunks.refresh(chunk);
    }
  }

  private cacheEnter(keys: number[]): void {
    const isCached = this.chunks.isCached;
    for (const key of keys) {
      this.regions.enter(keyX(key), keyY(key));
      this.biomes.chunkEntered(key);
      this.objects.chunkEntered(key);
    }
    // Biomes before anchors: structure rolls depend on the anchor's biome.
    for (const key of keys) {
      const cx = keyX(key);
      const cy = keyY(key);
      this.biomes.ensure(cx, cy, this.regions.visit(cx, cy), isCached);
    }
    for (const key of keys) this.resolveAnchor(keyX(key), keyY(key));
  }

  private cacheLeave(keys: number[]): void {
    for (const key of keys) {
      this.objects.chunkLeft(key);
      this.biomes.chunkLeft(key);
      this.regions.leave(keyX(key), keyY(key));
    }
    // Harvest records from a region that has regenerated no longer apply.
    for (const [key, cut] of this.harvested) {
      if (cut.visit !== this.regions.visit(keyX(key), keyY(key))) this.harvested.delete(key);
    }
  }

  /** Rolls the structures anchored in a chunk that just entered the cache radius. */
  private resolveAnchor(cx: number, cy: number): void {
    const biome = this.biomes.at(chunkKey(cx, cy));
    if (!biome) return;
    const placements = rollAnchor({
      worldSeed: this.seed,
      cx,
      cy,
      visit: this.regions.visit(cx, cy),
      biome: biome.type,
      palette: paletteOf(biome.type, biome.variant),
      fields: this.fields,
    });
    for (const p of placements) {
      const { w, h } = p.layout;
      if (this.objects.objects.has(p.id)) continue;
      if (this.objects.collides(p.x, p.y, w, h, 2)) continue;
      if (p.def.spacing && this.objects.crowded(p.def.kind, p.x + w / 2, p.y + h / 2, p.def.spacing)) continue;
      const o = new WorldObject(p.id, p.def.kind, p.def.name, p.x, p.y, p.layout);
      o.anchor = p.anchor;
      o.emptyChests = this.lootedAnchors.has(p.anchor);
      o.closed = this.clearedAnchors.has(p.id);
      // Redraws only chunks at the cache edge, outside the render area.
      this.addObject(o);
    }
  }

  private buildRequest(cx: number, cy: number, token: number): ChunkRequest {
    const biomes: number[] = [];
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const b = this.biomes.at(chunkKey(cx + dx, cy + dy));
        biomes.push(b ? b.type : -1, b ? b.variant : 0, b ? b.seed : 0);
      }
    }
    return { token, cx, cy, worldSeed: this.seed, visit: this.regions.visit(cx, cy), biomes };
  }

  private discover(gx: number, gy: number): void {
    for (const o of this.objects.inChunk(chunkKey(tileToChunk(gx), tileToChunk(gy)))) {
      if (!o.discovered && o.contains(gx, gy)) {
        o.discovered = true;
        this.onDiscover?.(o);
      }
    }
  }
}
