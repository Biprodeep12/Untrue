// Ties streaming, biomes, objects and visit counters together. Renderer-agnostic,
// so tests can drive it with a synchronous generator.

import { CHUNK_SIZE } from '../config';
import { chunkKey, keyX, keyY, tileToChunk } from '../coords';
import { hash, Stream, unit } from '../generation/Random';
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

/** How long a discovered semi-persistent place is kept after the player leaves: three days. */
export const SEMI_KEEP_MINUTES = 3 * 24 * 60;

/** A place the player has discovered, kept for the map even while it is not
 *  loaded, and saved. */
export interface KnownPlace {
  id: string;
  name: string;
  x: number;
  y: number;
  w: number;
  h: number;
  story: boolean;
}

export class WorldManager {
  readonly fields: TerrainFields;
  readonly biomes: BiomeManager;
  readonly objects = new ObjectManager();
  readonly regions = new RegionTracker();
  readonly chunks: ChunkManager;
  /** Anchors whose chests the player has looted: chests never refill there. */
  readonly lootedAnchors = new Set<string>();
  /** Dungeons, arenas and legendary spots the player has cleared: they stay cleared. */
  readonly clearedAnchors = new Set<string>();
  /** Decorations the player removed, per chunk, valid for one region visit. */
  private readonly harvested = new Map<number, { visit: number; cells: Map<number, Cut> }>();
  /** Every discovered place still standing, by object id. Change it through
   *  `addKnown` and `dropKnown`, which keep the chunk index in step. */
  readonly known = new Map<string, KnownPlace>();
  /** Known place ids by the chunk at their centre, so loading a chunk only
   *  checks the places near it. */
  private readonly knownByChunk = new Map<number, Set<string>>();
  private lastSweep = -Infinity;
  /** A known place turned out to be gone when its area came back. */
  onLost?: (p: KnownPlace) => void;
  /** Items dropped on the ground. */
  readonly ground = new GroundItems();
  /** In-game minutes since the world began; set by the game clock. */
  now: () => number = () => 0;
  onDiscover?: (o: WorldObject) => void;
  /** A place the player had discovered was discarded: the world forgot it. */
  onForget?: (o: WorldObject) => void;
  /** How the world behaves; the story's endings change these. */
  rules = {
    /** Chance a fully unloaded region regenerates differently. */
    regenChance: 1,
    /** Multiplies the odds of rare finds. */
    rareBoost: 1,
  };

  constructor(
    readonly seed: number,
    generator: ChunkGenerator,
  ) {
    this.fields = new TerrainFields(seed);
    this.biomes = new BiomeManager(this.fields);
    this.objects.onDiscard = (o) => {
      if (!o.discovered) return;
      this.dropKnown(o.id);
      this.onForget?.(o);
    };
    // Discovered semi-persistent places (villages, castles, mines) are kept
    // for a few days after the player leaves them.
    this.objects.keeps = (o) => o.persistence === 'persistent' || (o.persistence === 'semi-persistent' && o.discovered);
    this.objects.clock = () => this.now();
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
    // Kept places expire by the in-game clock; once a game minute is plenty.
    const now = this.now();
    if (now - this.lastSweep >= 1 || now < this.lastSweep) {
      this.lastSweep = now;
      this.objects.sweep(SEMI_KEEP_MINUTES);
    }
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

  /** Unloaded ground counts as solid so the player cannot walk into the void. */
  isSolidAt(gx: number, gy: number): boolean {
    const t = this.tileAt(gx, gy);
    return !t || isSolid(t.tile, t.deco);
  }

  /** Removes a decoration the player gathered. It stays gone until the
   *  region fully unloads and regenerates, or until a plant grows back. */
  /** Seeds what gathering a tile gives; changes when its region regenerates. */
  seedAt(gx: number, gy: number): number {
    return hash(Stream.Loot, this.seed, gx, gy, this.regions.visit(tileToChunk(gx), tileToChunk(gy)));
  }

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
    this.checkKnown(keys);
  }

  private cacheLeave(keys: number[]): void {
    for (const key of keys) {
      this.objects.chunkLeft(key);
      this.biomes.chunkLeft(key);
      this.regions.leave(keyX(key), keyY(key), (region, visit) => unit(hash(this.seed, region, visit, 0x4e9)) < this.rules.regenChance);
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
      rareBoost: this.rules.rareBoost,
    });
    for (const p of placements) {
      const { w, h } = p.layout;
      if (this.objects.objects.has(p.id)) continue;
      if (this.objects.collides(p.x, p.y, w, h, 2)) continue;
      if (p.def.spacing && this.objects.crowded(p.def.kind, p.x + w / 2, p.y + h / 2, p.def.spacing)) continue;
      const o = new WorldObject(p.id, p.def.kind, p.def.name, p.def.persistence, p.x, p.y, p.layout);
      o.anchor = p.anchor;
      o.emptyChests = this.lootedAnchors.has(p.anchor);
      // Found before (say, before a reload): it is still known, with no fanfare.
      if (this.known.has(p.id)) o.discovered = true;
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
        this.know(o);
        this.onDiscover?.(o);
      }
    }
  }

  /** Records a discovered place for the map. */
  know(o: WorldObject): void {
    this.addKnown({ id: o.id, name: o.name, x: o.x, y: o.y, w: o.w, h: o.h, story: o.kind.startsWith('story-') });
  }

  addKnown(p: KnownPlace): void {
    this.dropKnown(p.id);
    this.known.set(p.id, p);
    const key = this.knownKey(p);
    let ids = this.knownByChunk.get(key);
    if (!ids) this.knownByChunk.set(key, (ids = new Set()));
    ids.add(p.id);
  }

  private dropKnown(id: string): void {
    const p = this.known.get(id);
    if (!p) return;
    this.known.delete(id);
    const key = this.knownKey(p);
    const ids = this.knownByChunk.get(key);
    ids?.delete(id);
    if (ids?.size === 0) this.knownByChunk.delete(key);
  }

  private knownKey(p: KnownPlace): number {
    return chunkKey(tileToChunk(p.x + p.w / 2), tileToChunk(p.y + p.h / 2));
  }

  /** A known place whose whole neighbourhood is loaded but that did not come
   *  back has gone: the area regenerated while the game was closed. Only the
   *  places near the chunks that just loaded are checked. */
  private checkKnown(keys: readonly number[]): void {
    // Places reach at most a few chunks from their centre.
    const REACH = 4;
    const near = new Set<string>();
    for (const key of keys) {
      for (let dy = -REACH; dy <= REACH; dy++) {
        for (let dx = -REACH; dx <= REACH; dx++) {
          const ids = this.knownByChunk.get(chunkKey(keyX(key) + dx, keyY(key) + dy));
          if (ids) for (const id of ids) near.add(id);
        }
      }
    }
    for (const id of near) {
      const p = this.known.get(id);
      if (!p || this.objects.objects.has(p.id)) continue;
      let loaded = true;
      for (let cy = tileToChunk(p.y) - 1; cy <= tileToChunk(p.y + p.h - 1) + 1 && loaded; cy++) {
        for (let cx = tileToChunk(p.x) - 1; cx <= tileToChunk(p.x + p.w - 1) + 1 && loaded; cx++) loaded = this.chunks.isCached(chunkKey(cx, cy));
      }
      if (!loaded) continue;
      this.dropKnown(p.id);
      this.onLost?.(p);
    }
  }
}
