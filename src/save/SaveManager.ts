// Save system (spec 8.4). Only the seed, the player and what the player changed
// are stored; the world itself, every structure included, regenerates. Saves
// live in IndexedDB.

import type { EquipSlot } from '../items/Items';
import type { SavedSlot } from '../systems/InventorySystem';
import type { LivingSave } from '../game/LivingWorld';
import type { ExplorationSave } from '../systems/ExplorationSystem';
import type { ProgressionSave } from '../systems/Progression';
import type { VitalValues } from '../systems/Vitals';
import type { SavedGroundItem } from '../world/GroundItems';
import type { WorldManager } from '../world/WorldManager';

export const SAVE_VERSION = 8;

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
}

/** What saves before version 8 also held: kept objects, the register of
 *  known places and the old story (with its lantern memories). */
interface OldSave extends SaveData {
  objects?: Array<Record<string, unknown>>;
  known?: unknown;
  living: (LivingSave & { story?: unknown }) | null;
}

export function snapshot(
  world: WorldManager,
  player: PlayerSave,
  living: LivingSave | null = null,
  exploration: ExplorationSave | null = null,
): SaveData {
  return {
    version: SAVE_VERSION,
    seed: world.seed,
    savedAt: Date.now(),
    player,
    lootedAnchors: [...world.lootedAnchors],
    clearedAnchors: [...world.clearedAnchors],
    living,
    exploration,
    regions: world.regions.save(),
    harvested: world.saveHarvest(),
    ground: world.ground.save(),
  };
}

/** Puts what the player changed back into a fresh world built from the same seed. */
export function restore(world: WorldManager, data: SaveData): void {
  for (const a of data.lootedAnchors) world.lootedAnchors.add(a);
  for (const a of data.clearedAnchors) world.clearedAnchors.add(a);
  world.regions.load(data.regions);
  world.loadHarvest(data.harvested);
  world.ground.load(data.ground);
}

/** The old story's lantern: an ordinary lantern takes its place, so the player
 *  keeps a light that never burns out. */
const swapLantern = (s: SavedSlot): SavedSlot => (s?.id === 'wanderers-lantern' ? { id: 'lantern', count: 1 } : s);

/** Brings older saves up to the current format. */
export function migrate(data: OldSave): SaveData | null {
  if (data.version === 1) {
    data.player = { ...data.player, inventory: [], vitals: null, progression: null };
    data.objects = data.objects?.map((o) => ({ ...o, anchor: '', opened: [] }));
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
    data.objects = data.objects?.map((o) => ({ ...o, buildings: [] }));
    data.regions = [];
    data.harvested = [];
    data.version = 6;
  }
  if (data.version === 6) {
    data.ground = [];
    data.version = 7;
  }
  if (data.version === 7) {
    // Every structure now forgets, so kept objects (story places among them)
    // go; so do the known places, the old story and its world rules.
    delete data.objects;
    delete data.known;
    if (data.living) delete data.living.story;
    const { player } = data;
    player.inventory = player.inventory.map(swapLantern);
    if (player.equipment) {
      for (const slot of Object.keys(player.equipment) as EquipSlot[]) player.equipment[slot] = swapLantern(player.equipment[slot] ?? null);
    }
    data.version = 8;
  }
  return data.version === SAVE_VERSION ? data : null;
}

/** A save is stored but cannot be used (e.g. from a newer version). It has
 *  been backed up before this is thrown. */
export class UnreadableSave extends Error {}

const DB_NAME = 'untrue';
const STORE = 'saves';
const SLOT = 'main';
const MAX_BACKUPS = 5;

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
    await this.run('readwrite', (s) => {
      const put = s.put(data, `backup-${Date.now()}`);
      // Only the newest few are kept, so repeated failures cannot fill the quota.
      // Keys sort by time: Date.now() has 13 digits for centuries yet.
      const keys = s.getAllKeys(IDBKeyRange.bound('backup-', 'backup-￿'));
      keys.onsuccess = () => {
        for (const k of keys.result.slice(0, -MAX_BACKUPS)) s.delete(k);
      };
      return put;
    });
  }

  private open(): Promise<IDBDatabase> {
    this.db ??= new Promise((resolve, reject) => {
      if (typeof indexedDB === 'undefined') throw new Error('IndexedDB is not available');
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE);
      req.onsuccess = () => {
        const db = req.result;
        // Let another tab upgrade or delete the database, and reopen next time
        // instead of using a connection the browser has closed (e.g. site data cleared).
        db.onversionchange = () => {
          db.close();
          this.db = null;
        };
        db.onclose = () => (this.db = null);
        resolve(db);
      };
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
