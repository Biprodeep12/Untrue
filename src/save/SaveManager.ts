// Save system (spec 8.4). Only the seed, the player and persistent objects are
// stored; everything else regenerates. Saves live in IndexedDB.

import { Layout, type BuildingSpec, type Persistence } from '../generation/StructureGenerator';
import type { EquipSlot } from '../items/Items';
import type { SavedSlot } from '../systems/InventorySystem';
import type { LivingSave } from '../game/LivingWorld';
import type { ExplorationSave } from '../systems/ExplorationSystem';
import type { ProgressionSave } from '../systems/Progression';
import type { VitalValues } from '../systems/Vitals';
import type { SavedGroundItem } from '../world/GroundItems';
import type { KnownPlace, WorldManager } from '../world/WorldManager';
import { WorldObject } from '../world/WorldObject';

export const SAVE_VERSION = 7;

export interface SavedObject {
  id: string;
  kind: string;
  name: string;
  persistence: Persistence;
  x: number;
  y: number;
  w: number;
  h: number;
  tiles: Uint8Array;
  decos: Uint8Array;
  discovered: boolean;
  anchor: string;
  /** Layout indices of opened chests, and interior chest ids. */
  opened: number[];
  buildings: BuildingSpec[];
  /** For semi-persistent objects: the world minute they were last left. */
  idleSince?: number;
}

/** Everything about the player that survives a reload. */
export interface PlayerSave {
  x: number;
  y: number;
  inventory: SavedSlot[];
  /** Worn armour and the off-hand item; missing in older saves. */
  equipment?: Partial<Record<EquipSlot, SavedSlot>>;
  vitals: VitalValues | null;
  progression: ProgressionSave | null;
  /** Where the player wakes after collapsing; missing in older saves (the start). */
  respawn?: { x: number; y: number };
  /** Moonwells already drunk from; missing in older saves. */
  moonwells?: string[];
}

export interface SaveData {
  version: number;
  seed: number;
  savedAt: number;
  player: PlayerSave;
  /** Rare landmarks and other persistent objects, with their discovered flag. */
  objects: SavedObject[];
  /** Anchors whose chests were looted, so they never refill. */
  lootedAnchors: string[];
  /** Dungeons, arenas and legendary spots that stay cleared. */
  clearedAnchors: string[];
  /** Clock, weather and quests; null before the living world existed. */
  living: LivingSave | null;
  /** Explored chunks and map markers. */
  exploration: ExplorationSave | null;
  /** Region visit counters, as flat pairs, so regions stay as the player left them. */
  regions: number[];
  /** Gathered decorations per chunk, valid for their region's visit. */
  harvested: Array<{ key: number; visit: number; cells: number[] }>;
  /** Items dropped on the ground. */
  ground: SavedGroundItem[];
  /** Discovered places, so the map keeps them; missing in older saves. */
  known?: KnownPlace[];
}

export function snapshot(
  world: WorldManager,
  player: PlayerSave,
  living: LivingSave | null = null,
  exploration: ExplorationSave | null = null,
): SaveData {
  const objects: SavedObject[] = [];
  for (const o of world.objects.objects.values()) {
    // Persistent objects, and semi-persistent ones the world is keeping.
    if (!world.objects.keeps(o)) continue;
    const { id, kind, name, persistence, x, y, w, h, discovered, anchor } = o;
    const { tiles, decos } = o.layout;
    objects.push({
      id,
      kind,
      name,
      persistence,
      x,
      y,
      w,
      h,
      tiles: tiles.slice(),
      decos: decos.slice(),
      discovered,
      anchor,
      opened: [...o.opened],
      buildings: o.layout.buildings,
      idleSince: o.activeChunks > 0 ? world.now() : o.idleSince,
    });
  }
  return {
    version: SAVE_VERSION,
    seed: world.seed,
    savedAt: Date.now(),
    player,
    objects,
    lootedAnchors: [...world.lootedAnchors],
    clearedAnchors: [...world.clearedAnchors],
    living,
    exploration,
    regions: world.regions.save(),
    harvested: world.saveHarvest(),
    ground: world.ground.save(),
    known: [...world.known.values()],
  };
}

/** Puts saved objects back into a fresh world built from the same seed. */
export function restore(world: WorldManager, data: SaveData): void {
  for (const s of data.objects) {
    const layout = new Layout(s.w, s.h);
    layout.tiles.set(s.tiles);
    layout.decos.set(s.decos);
    layout.buildings = s.buildings;
    const o = new WorldObject(s.id, s.kind, s.name, s.persistence, s.x, s.y, layout);
    o.discovered = s.discovered;
    o.anchor = s.anchor;
    for (const i of s.opened) o.opened.add(i);
    o.idleSince = s.idleSince ?? 0;
    world.addObject(o);
  }
  for (const a of data.lootedAnchors) world.lootedAnchors.add(a);
  for (const a of data.clearedAnchors) world.clearedAnchors.add(a);
  world.regions.load(data.regions);
  world.loadHarvest(data.harvested);
  world.ground.load(data.ground);
  for (const p of data.known ?? []) world.addKnown(p);
  // Older saves: at least the discovered persistent places.
  for (const s of data.objects) if (s.discovered && !world.known.has(s.id)) world.know(world.objects.objects.get(s.id)!);
}

/** Brings older saves up to the current format. */
function migrate(data: SaveData): SaveData | null {
  if (data.version === 1) {
    data.player = { ...data.player, inventory: [], vitals: null, progression: null };
    data.objects = data.objects.map((o) => ({ ...o, anchor: '', opened: [] }));
    data.lootedAnchors = [];
    data.version = 2;
  }
  if (data.version === 2) {
    data.player = { ...data.player, progression: null };
    data.clearedAnchors = [];
    data.version = 3;
  }
  if (data.version === 3) {
    data.living = null;
    data.version = 4;
  }
  if (data.version === 4) {
    data.exploration = null;
    data.version = 5;
  }
  if (data.version === 5) {
    data.objects = data.objects.map((o) => ({ ...o, buildings: [] }));
    data.regions = [];
    data.harvested = [];
    data.version = 6;
  }
  if (data.version === 6) {
    data.ground = [];
    data.version = 7;
  }
  return data.version === SAVE_VERSION ? data : null;
}

/** A save is stored but cannot be used (e.g. from a newer version). It has
 *  been backed up before this is thrown. */
export class UnreadableSave extends Error {}

const DB_NAME = 'untrue';
const STORE = 'saves';
const SLOT = 'main';

export class SaveManager {
  private db: Promise<IDBDatabase> | null = null;

  async load(): Promise<SaveData | null> {
    const data = await this.run<SaveData | undefined>('readonly', (s) => s.get(SLOT));
    if (!data) return null;
    let save: SaveData | null = null;
    try {
      if (typeof data === 'object' && typeof data.version === 'number') save = migrate(data);
    } catch {
      // Malformed: handled below like any unreadable save.
    }
    if (save) return save;
    // Never let a new world autosave over a save it could not read.
    await this.backup(data);
    throw new UnreadableSave(`Save version ${String((data as { version?: unknown }).version)} cannot be read`);
  }

  async save(data: SaveData): Promise<void> {
    await this.run('readwrite', (s) => s.put(data, SLOT));
  }

  async clear(): Promise<void> {
    await this.run('readwrite', (s) => s.delete(SLOT));
  }

  /** Keeps a save that could not be loaded, so a later fix can recover it. */
  async backup(data: unknown): Promise<void> {
    await this.run('readwrite', (s) => s.put(data, `backup-${Date.now()}`));
  }

  private open(): Promise<IDBDatabase> {
    this.db ??= new Promise((resolve, reject) => {
      if (typeof indexedDB === 'undefined') throw new Error('IndexedDB is not available');
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
      req.onblocked = () => reject(new Error('Save storage is blocked by another tab'));
    });
    // A failed open is retried next time instead of failing forever.
    this.db.catch(() => (this.db = null));
    return this.db;
  }

  private async run<T>(mode: IDBTransactionMode, op: (store: IDBObjectStore) => IDBRequest): Promise<T> {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      const req = op(tx.objectStore(STORE));
      // Writes count once the transaction commits, not when the request succeeds.
      if (mode === 'readonly') req.onsuccess = () => resolve(req.result as T);
      else tx.oncomplete = () => resolve(req.result as T);
      req.onerror = () => reject(req.error);
      tx.onabort = () => reject(tx.error ?? new Error('Save aborted'));
    });
  }
}
