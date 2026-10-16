// Exploration (spec 6.4): which chunks the player has seen, the player's own
// map markers, and small rewards for exploring.

import { chunkKey } from '../coords';
import { paletteOf } from '../generation/Tiles';
import type { WorldManager } from '../world/WorldManager';

/** Experience for every this many newly explored chunks. */
export const EXPLORE_STEP = 50;
export const EXPLORE_XP = 20;

export interface Marker {
  id: number;
  x: number;
  y: number;
  label: string;
}

export interface ExplorationSave {
  /** Flat pairs: chunk key, biome palette + 1. */
  explored: number[];
  markers: Marker[];
  tracked: number | null;
}

export class ExplorationSystem {
  /** Chunk key → biome palette + 1, as the player saw it. */
  readonly explored = new Map<number, number>();
  markers: Marker[] = [];
  /** The marker the compass and tracker point to. */
  tracked: number | null = null;
  onMilestone?: (chunks: number) => void;
  private nextId = 1;

  /** Marks every chunk in the render area as seen. */
  update(world: WorldManager): void {
    const r = world.chunks.renderRect;
    if (!r) return;
    for (let cy = r.y0; cy <= r.y1; cy++) {
      for (let cx = r.x0; cx <= r.x1; cx++) {
        const key = chunkKey(cx, cy);
        if (this.explored.has(key)) continue;
        const b = world.biomes.at(key);
        if (!b) continue;
        this.explored.set(key, paletteOf(b.type, b.variant) + 1);
        if (this.explored.size % EXPLORE_STEP === 0) this.onMilestone?.(this.explored.size);
      }
    }
  }

  addMarker(x: number, y: number, label = `Marker ${this.nextId}`): Marker {
    const m = { id: this.nextId++, x, y, label };
    this.markers.push(m);
    return m;
  }

  removeMarker(id: number): void {
    this.markers = this.markers.filter((m) => m.id !== id);
    if (this.tracked === id) this.tracked = null;
  }

  get trackedMarker(): Marker | undefined {
    return this.markers.find((m) => m.id === this.tracked);
  }

  save(): ExplorationSave {
    const explored: number[] = [];
    for (const [k, v] of this.explored) explored.push(k, v);
    return { explored, markers: this.markers, tracked: this.tracked };
  }

  load(s: ExplorationSave): void {
    this.explored.clear();
    for (let i = 0; i + 1 < s.explored.length; i += 2) this.explored.set(s.explored[i], s.explored[i + 1]);
    // Markers with a broken id or position would never draw and break new ids.
    this.markers = s.markers.filter((m) => Number.isFinite(m.id) && Number.isFinite(m.x) && Number.isFinite(m.y));
    this.tracked = s.tracked;
    this.nextId = Math.max(0, ...this.markers.map((m) => m.id)) + 1;
  }
}
