// Ties streaming, biomes, objects and visit counters together. Renderer-agnostic,
// so tests can drive it with a synchronous generator.

import { CHUNK_SIZE } from '../config';
import { dimensionForRift } from '../dimension/Dimension';
import { chunkKey, keyX, keyY, regionKey, tileToChunk } from '../coords';
import { hash, hashString, Stream } from '../generation/Random';
import { rollAnchor } from '../generation/StructureGenerator';
import { TerrainFields, type ChunkRequest } from '../generation/TerrainGenerator';
import { Deco, isSolid, paletteOf, type BiomeType } from '../generation/Tiles';
import { BiomeManager, type BiomeRecord } from './BiomeManager';
import { ChunkManager, type ChunkGenerator, type View } from './ChunkManager';
import { ObjectManager } from './ObjectManager';
import { GroundItems } from './GroundItems';
import { driftKey, parseDriftKey, RegionTracker } from './Regions';
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

/** What changes in a world: a host tells its guests, a guest asks its host.
 *  Nobody listens alone, so it costs nothing then. */
export interface WorldChanges {
  objectAdded?(o: WorldObject): void;
  objectRemoved?(o: WorldObject): void;
  /** A chest opened, a rift closed. */
  objectChanged?(o: WorldObject): void;
  /** A decoration was gathered (or burned) on this tile. */
  harvested?(gx: number, gy: number, deco: number): void;
  /** A chunk's harvest log changed by itself: plants grew back. */
  regrown?(key: number): void;
}

/** A guest's copy of what the host gathered in one chunk: flat triples of
 *  cell, decoration and minute. */
export type HarvestCells = readonly number[];

export class WorldManager {
  readonly fields: TerrainFields;
  readonly biomes: BiomeManager;
  readonly objects = new ObjectManager();
  readonly regions = new RegionTracker();
  readonly chunks: ChunkManager;
  /** Anchors whose chests the player has looted, per region visit
   *  (`driftKey`): they stay empty until their region drifts. */
  readonly lootedAnchors = new Set<string>();
  /** Dungeons, arenas and legendary spots the player has cleared, per region
   *  visit, and closed rifts by object id (which holds the visit too): they
   *  stay cleared until their region drifts, then something new may be there. */
  readonly clearedAnchors = new Set<string>();
  /** Decorations the player removed, per chunk, valid for one region visit. */
  private readonly harvested = new Map<number, { visit: number; cells: Map<number, Cut> }>();
  /** Items dropped on the ground. */
  readonly ground = new GroundItems();
  /** The dimension a new rift opens onto, by its object id; the game leans
   *  it by the player's story (`dimensionForRift`). */
  riftDestination: (riftId: string) => string = (id) => dimensionForRift(hash(this.seed, hashString(id)));
  /** In-game minutes since the world began; set by the game clock. */
  now: () => number = () => 0;
  onDiscover?: (o: WorldObject) => void;
  /** Hears every change (a host's guests, or a guest's host); null alone. */
  changes: WorldChanges | null = null;

  /** `replica`: a guest's copy of a host's world. It never rolls biomes,
   *  structures or region visits, or lets plants grow back: the host's come
   *  with each chunk (`adoptChunk`, `adoptObject`, `setHarvest`). */
  constructor(
    readonly seed: number,
    generator: ChunkGenerator,
    readonly replica = false,
  ) {
    this.fields = new TerrainFields(seed);
    this.biomes = new BiomeManager(this.fields);
    this.regions.replica = replica;
    this.objects.onRemove = (o) => this.changes?.objectRemoved?.(o);
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
    // A guest's ground is the host's: only the host lets it drift.
    if (!replica) this.ground.drift = this.driftClock;
  }

  /** Region of a spot and its visit, for what lies on the ground. */
  private readonly driftClock = {
    region: (x: number, y: number) => regionKey(tileToChunk(Math.floor(x)), tileToChunk(Math.floor(y))),
    visit: (region: number) => this.regions.visitOf(region),
  };

  /** `others`: guests' views, when this world is shared (see `ChunkManager`). */
  update(view: View, others?: readonly View[]): void {
    this.chunks.update(view, others);
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
    this.changes?.harvested?.(gx, gy, deco);
  }

  /** A chunk's harvest log as cells for the wire: flat triples of cell,
   *  decoration, minute; empty if nothing was gathered there this visit. */
  harvestOf(key: number): number[] {
    const cut = this.harvested.get(key);
    if (!cut || cut.visit !== this.regions.visit(keyX(key), keyY(key))) return [];
    const out: number[] = [];
    for (const [i, c] of cut.cells) out.push(i, c.deco, c.at);
    return out;
  }

  /** A guest takes the host's harvest log for a chunk, and redraws it. */
  setHarvest(key: number, cells: HarvestCells): void {
    const visit = this.regions.visit(keyX(key), keyY(key));
    if (!cells.length) this.harvested.delete(key);
    else {
      const map = new Map<number, Cut>();
      for (let i = 0; i + 2 < cells.length; i += 3) map.set(cells[i], { deco: cells[i + 1], at: cells[i + 2] });
      this.harvested.set(key, { visit, cells: map });
    }
    const chunk = this.chunks.chunks.get(key);
    if (chunk) this.chunks.refresh(chunk);
  }

  /** A guest takes what the host says of a chunk: its region's visit and its
   *  biome. Before the chunk's terrain is composed. */
  adoptChunk(cx: number, cy: number, visit: number, biome: { id: number; type: number; variant: number; seed: number } | null): void {
    this.regions.setVisit(regionKey(cx, cy), visit);
    if (biome) this.biomes.adopt(chunkKey(cx, cy), biome.id, biome.type as BiomeType, biome.variant, biome.seed);
  }

  /** A guest takes one of the host's objects, and redraws what it covers. If
   *  none of its chunks is still loaded here, it is let go at once. */
  adoptObject(o: WorldObject): void {
    const old = this.objects.objects.get(o.id);
    if (old) this.objects.remove(old);
    this.objects.add(o, this.chunks.isCached);
    if (o.activeChunks <= 0) this.objects.remove(o);
    this.refreshObject(o);
  }

  /** Lets plants whose time has come grow back. Call once per in-game hour. */
  regrow(): void {
    // A guest's plants grow back when the host says so.
    if (this.replica) return;
    for (const [key, cut] of this.harvested) {
      let grew = false;
      for (const [i, c] of cut.cells) {
        if (!this.regrown(c)) continue;
        cut.cells.delete(i);
        grew = true;
      }
      // Everything grew back: nothing left to remember or save.
      if (cut.cells.size === 0) this.harvested.delete(key);
      if (!grew) continue;
      const chunk = this.chunks.chunks.get(key);
      if (chunk) this.chunks.refresh(chunk);
      this.changes?.regrown?.(key);
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
    this.changes?.objectChanged?.(object);
  }

  /** Closes a rift for as long as its object lives (and its id is rolled again). */
  closeRift(o: WorldObject): void {
    o.closed = true;
    this.clearedAnchors.add(o.id);
    this.refreshObject(o);
    this.changes?.objectChanged?.(o);
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
    if (o.kind === 'rift' && !o.dimension) o.dimension = this.riftDestination(o.id);
    this.objects.add(o, this.chunks.isCached);
    this.refreshObject(o);
    this.changes?.objectAdded?.(o);
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
    // A guest's biomes and structures are the host's, and come with its chunks.
    if (this.replica) return;
    // Biomes before anchors: structure rolls depend on the anchor's biome.
    for (const key of keys) {
      const cx = keyX(key);
      const cy = keyY(key);
      this.biomes.ensure(cx, cy, this.regions.visit(cx, cy), isCached);
    }
    for (const key of keys) this.resolveAnchor(keyX(key), keyY(key));
  }

  private cacheLeave(keys: number[]): void {
    let drifted = false;
    for (const key of keys) {
      this.objects.chunkLeft(key);
      if (this.replica) {
        this.biomes.release(key);
        this.harvested.delete(key);
      } else this.biomes.chunkLeft(key);
      if (this.regions.leave(keyX(key), keyY(key))) drifted = true;
    }
    if (!drifted) return;
    // A region drifted: its harvest records no longer apply, and what lay on
    // its ground is gone with it.
    for (const [key, cut] of this.harvested) {
      if (cut.visit !== this.regions.visit(keyX(key), keyY(key))) this.harvested.delete(key);
    }
    this.ground.sweep();
  }

  /** What the world remembers of places, without what has drifted: looted
   *  chests and cleared lairs of past visits, and events no longer standing.
   *  For saving; costs a pass over the keys, never per frame. */
  liveMemory(keys: ReadonlySet<string>): string[] {
    const out: string[] = [];
    for (const key of keys) {
      const at = parseDriftKey(key);
      if (at ? this.regions.visit(at.cx, at.cy) === at.visit : this.objects.objects.has(key)) out.push(key);
    }
    return out;
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
      // Remembered for this visit of the region only: once it drifts, a fresh
      // roll here has fresh chests and lairs.
      o.anchor = driftKey(p.anchor, this.regions.visit(cx, cy));
      o.emptyChests = this.lootedAnchors.has(o.anchor);
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
