// Where the player is: the overworld, a room behind a door, or an outer
// dimension behind a rift. The game asks the current place for the player's
// collision, what fights happen on, and the player's spot in the overworld
// (saving, streaming, the clock and the HUD all go by it), instead of
// checking which kind of place it is at every turn.

import type { Arena } from '../systems/CombatSystem';
import type { Collider } from './Player';

export type PlaceKind = 'world' | 'interior' | 'dimension';

export interface Place extends Collider {
  readonly kind: PlaceKind;
  /** The player's spot in the overworld, in world tiles (feet): the player
   *  outdoors, the doorstep or the rift otherwise. */
  readonly spot: { readonly x: number; readonly y: number };
  /** What enemies, shots and knockback collide with; null where nothing fights. */
  readonly arena: Arena | null;
}
