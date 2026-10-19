// What things are called on the wire: species, items, shots and enemy states
// travel as small indices, the same on every machine running the same game
// version (peers on another version are refused at the door).

import type { EnemyState } from '../entities/Enemy';
import { SPECIES_LIST, type ProjectileKind, type Species } from '../entities/Species';
import { ITEM_LIST, type ItemDef } from '../items/Items';

const speciesIndex = new Map<Species, number>(SPECIES_LIST.map((s, i) => [s, i]));

export const speciesId = (s: Species): number => speciesIndex.get(s) ?? 0;
export const speciesAt = (i: number): Species | undefined => SPECIES_LIST[i];

/** Items go by their icon, which is their place in the catalogue. */
export const itemId = (item: ItemDef): number => item.icon;
export const itemAt = (i: number): ItemDef | undefined => ITEM_LIST[i];

export const SHOT_KINDS: readonly ProjectileKind[] = ['arrow', 'web', 'ice', 'boulder', 'shard'];
export const shotKind = (k: ProjectileKind): number => Math.max(0, SHOT_KINDS.indexOf(k));

export const ENEMY_STATES: readonly EnemyState[] = ['patrol', 'aggro', 'chase', 'attack', 'flee', 'burrowed'];
export const enemyState = (s: EnemyState): number => Math.max(0, ENEMY_STATES.indexOf(s));

/** A snapshot entity's kind: an enemy's species, or (with this bit) a shot's kind. */
export const SHOT_KIND_BIT = 0x8000;

/** Snapshot entity flags. */
export const EntityFlag = { Elite: 1, Flash: 2, Windup: 4, Moving: 8 } as const;

/** Player state flags. */
export const PlayerFlag = { Moving: 1, Hurt: 2, Guarding: 4 } as const;

/** Game events (`Event` messages), host to guests. */
export const GameEvent = {
  /** Something in the run everyone sees: a gate, a wave, a notice… */
  Run: 1,
  /** An enemy struck you: raw damage ×100, species, from x, from y (1/32 tiles). */
  Damage: 2,
  /** Your blow killed it: xp, then item and count pairs. */
  Kill: 3,
  /** The Warden fell: your xp, whether you are attuned, your share ×10 000. */
  Settle: 4,
  /** Your share of the vault: item and count pairs. */
  Reward: 5,
  /** The vault would not open for you: a line of text. */
  Denied: 6,
  /** Overworld: your blow killed it: xp, species, then item and count pairs. */
  WorldKill: 7,
} as const;

/** The run's events as they travel, by type. */
export const RUN_EVENTS = ['door', 'started', 'cleared', 'wave', 'plate', 'puzzleReset', 'bossPhase', 'notice'] as const;
export const SITE_KINDS = ['combat', 'hazard', 'puzzle', 'boss', 'vault', 'tide'] as const;
