// The Hollow: the first outer dimension, an open land of violet moss, ash and
// ruins adrift in a void. Its map is fixed (public/dimensions/hollow.json,
// baked by src/dimension/bake/hollowMap.ts); this is how it plays: its
// creatures, the Glitch Nest's waves, the Rift Warden and its phases, the
// crumbling path's tuning and the vault's rewards. Its plot (the Lost
// Hamlet's bell, and its watchman) is in the map's data, like its lore.

import { SPECIES } from '../entities/Species';
import type { DimensionDef, RewardSpec } from './Dimension';

/** Glyph kinds the art has. */
export const GLYPH_COUNT = 6;

/** Item id of the dimension's own material, `Items.riftShard`. */
export const RIFT_SHARD_ID = 'rift-shard';
/** The Rift Shard's catalogue entry, as `Items.riftShard` has it. */
export const RIFT_SHARD = {
  id: RIFT_SHARD_ID,
  name: 'Rift Shard',
  description: 'A splinter of an outer dimension. It flickers, as if it cannot decide to exist.',
  rarity: 'Epic',
} as const;

/** What the vault's chest holds. */
export const HOLLOW_REWARDS: readonly RewardSpec[] = [
  { item: RIFT_SHARD_ID, min: 3, max: 5, chance: 1 },
  { item: 'coin', min: 20, max: 45, chance: 1 },
  { item: 'crystal', min: 1, max: 2, chance: 0.6 },
  { item: 'gem', min: 1, max: 1, chance: 0.3 },
  { item: 'star-metal', min: 1, max: 1, chance: 0.25 },
];

export const HOLLOW: DimensionDef = {
  id: 'hollow',
  name: 'The Hollow',
  roster: [SPECIES.glitchling, SPECIES.shardWisp, SPECIES.nullShade, SPECIES.riftWarden],
  waves: [
    [[SPECIES.glitchling, 4]],
    [[SPECIES.glitchling, 3], [SPECIES.shardWisp, 2]],
    [[SPECIES.glitchling, 3], [SPECIES.shardWisp, 3]],
  ],
  boss: {
    species: SPECIES.riftWarden,
    addCap: 6,
    phases: [
      { below: 0.66, adds: [[SPECIES.glitchling, 3]], cooldownScale: 1, speedScale: 1, text: 'The Warden tears the air open. Glitchlings pour out!' },
      { below: 0.33, adds: [[SPECIES.shardWisp, 2]], cooldownScale: 0.55, speedScale: 1.35, text: 'The Warden flickers with fury. Its blows quicken!' },
    ],
  },
  hazard: { crumbleDelay: 0.55, reform: 5, glitchOn: 2, glitchOff: 1.3, glitchWarn: 0.5, slipDamage: 8, tideHold: 14, tideWarn: 3 },
  rewards: HOLLOW_REWARDS,
  closeXp: 150,
};
