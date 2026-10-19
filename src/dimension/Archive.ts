// The Drowned Archive: the second outer dimension, opened once The Hollow is
// cleared. A library of the old network's keepers, who catalogued every place
// the world let go of, half under black water. Its map is fixed
// (public/dimensions/archive.json, baked by src/dimension/bake/archiveMap.ts);
// this is how it plays: shoals of drowned pages and ink wraiths, the Sluice
// Hall's tide, the Archivist and its phases, and the vault's rewards. Its plot
// (the keeper Ondine and the Ledger of the Drift) is in the map's data.

import { SPECIES } from '../entities/Species';
import type { DimensionDef, RewardSpec } from './Dimension';
import { RIFT_SHARD_ID } from './Hollow';

/** What the vault's chest holds: richer than the Hollow's. */
export const ARCHIVE_REWARDS: readonly RewardSpec[] = [
  { item: RIFT_SHARD_ID, min: 4, max: 7, chance: 1 },
  { item: 'coin', min: 40, max: 80, chance: 1 },
  { item: 'crystal', min: 2, max: 3, chance: 0.7 },
  { item: 'gem', min: 1, max: 2, chance: 0.45 },
  { item: 'star-metal', min: 1, max: 2, chance: 0.4 },
  { item: 'spirit-essence', min: 2, max: 4, chance: 0.6 },
];

export const ARCHIVE: DimensionDef = {
  id: 'archive',
  name: 'The Drowned Archive',
  roster: [SPECIES.drownedPage, SPECIES.inkWraith, SPECIES.nullShade, SPECIES.archivist],
  waves: [
    [[SPECIES.drownedPage, 5]],
    [[SPECIES.drownedPage, 3], [SPECIES.inkWraith, 2]],
    [[SPECIES.inkWraith, 3], [SPECIES.nullShade, 2]],
    [[SPECIES.drownedPage, 4], [SPECIES.inkWraith, 2], [SPECIES.nullShade, 1]],
  ],
  boss: {
    species: SPECIES.archivist,
    addCap: 7,
    phases: [
      { below: 0.7, adds: [[SPECIES.drownedPage, 4]], cooldownScale: 1, speedScale: 1, text: 'The Archivist tears pages from itself. They swarm!' },
      { below: 0.4, adds: [[SPECIES.inkWraith, 3]], cooldownScale: 0.7, speedScale: 1.2, text: 'Ink pours from the Archivist. The wraiths rise!' },
      { below: 0.15, adds: [[SPECIES.nullShade, 2]], cooldownScale: 0.5, speedScale: 1.4, text: 'The Archivist forgets itself. Only the hum is left!' },
    ],
  },
  hazard: { crumbleDelay: 0.5, reform: 5, glitchOn: 2, glitchOff: 1.3, glitchWarn: 0.5, slipDamage: 10, tideHold: 7, tideWarn: 2.5 },
  rewards: ARCHIVE_REWARDS,
  closeXp: 260,
};
