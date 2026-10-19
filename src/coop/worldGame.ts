// What a shared overworld's link needs of the game, host or guest.

import type { Enemy } from '../entities/Enemy';
import type { Species } from '../entities/Species';
import type { ItemDef } from '../items/Items';
import type { CombatSystem } from '../systems/CombatSystem';
import type { WorldManager } from '../world/WorldManager';
import type { WorldObject } from '../world/WorldObject';
import type { ViewMsg } from './worldWire';

/** The local player as others see them, rewritten in place. */
export interface SeenAs {
  x: number;
  y: number;
  facing: number;
  frame: number;
  moving: boolean;
  hurt: number;
  guarding: boolean;
  holding: number;
  health: number;
}

/** Where the local player is: outdoors, in a room of a building, or behind a rift. */
export interface LocalWhere {
  place: number;
  object: WorldObject | null;
  index: number;
  floor: number;
}

export interface WorldGame {
  readonly world: WorldManager;
  readonly combat: CombatSystem;
  /** Feet in the player's place (a room's own tiles indoors). */
  player(): SeenAs;
  where(): LocalWhere;
  /** Guest: what the player sees, and where they stand in the world. */
  view(): ViewMsg;
  /** The player's spot in the world: where they stand outdoors, else the
   *  doorstep of their room or of their rift. */
  spot(): { x: number; y: number };
  notify(text: string): void;
  give(item: ItemDef, count: number, durability?: number): void;
  grantXp(xp: number): void;
  /** The player's blow felled this creature (on the host's machine). */
  killed(species: Species): void;
  /** A creature drawn here is gone: killed (show it), or out of sight. */
  replicaGone(e: Enemy, killed: boolean): void;
  /** Host: the clock and the weather, to share. */
  clock(): { day: number; minutes: number; weather: string };
  /** Guest: the host's clock and weather. */
  setClock(day: number, minutes: number, weather: string): void;
  /** Host: may this player come in? */
  joinRequest(name: string): Promise<boolean>;
  /** Someone came or went (the beacon's list). */
  peopleChanged(): void;
  /** Guest: the session is over; why. */
  ended(text: string): void;
  /** Guest: something given or put down: the character is saved soon, so
   *  closing the page cannot keep both the thing and its trace on the host. */
  saveSoon(): void;
  /** A friend in this world went behind a rift into a shared instance. */
  riftInstance(dimension: string, code: string): void;
}
