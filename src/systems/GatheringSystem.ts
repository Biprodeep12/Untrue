// Gathering and interaction: chopping, mining, picking, drinking and looting.
// Tools are used automatically: the best one carried sets speed and yield.

import { hashString, Rng, streamRng, Stream } from '../generation/Random';
import { Deco, Tile } from '../generation/Tiles';
import { difficultyBand } from '../generation/WorldRules';
import { Items, type ItemDef, type ToolKind } from '../items/Items';
import type { WorldManager } from '../world/WorldManager';
import type { WorldObject } from '../world/WorldObject';
import type { Inventory } from './InventorySystem';
import type { Progression } from './Progression';
import { rollBarrel, rollChest, type Drops } from './Loot';
import type { Vitals } from './Vitals';

/** Stamina each completed gathering costs. Too tired takes twice as long. */
const STAMINA_COST = 4;
const DRINK = { [Tile.Water]: 25, [Tile.WaterDeep]: 25, [Tile.Ice]: 12 } as Record<number, number>;

interface Harvest {
  /** Seconds with bare hands; each tool tier divides it. */
  seconds: number;
  tool?: ToolKind;
  /** Lowest tool tier that works at all. */
  minTier: number;
  /** Prompt word, and the word shown while it runs. */
  action: string;
  verb: string;
  /** `band`: the difficulty band where it grows; rare finds get likelier further out. */
  drops(rng: Rng, tier: number, band: number): Drops;
}

const tree: Harvest = {
  seconds: 4,
  tool: 'axe',
  minTier: 0,
  action: 'Chop',
  verb: 'Chopping',
  drops: (rng, tier) => [[Items.wood, rng.int(1, 2) + tier]],
};
const rock: Harvest = {
  seconds: 3.5,
  tool: 'pickaxe',
  minTier: 0,
  action: 'Mine',
  verb: 'Mining',
  drops: (rng, tier) => [[Items.stone, rng.int(1, 2) + tier]],
};
const pick = (item: ItemDef, min: number, max: number, extra?: [ItemDef, number]): Harvest => ({
  seconds: 0.7,
  minTier: 0,
  action: 'Pick',
  verb: 'Picking',
  drops: (rng) => {
    const d: Drops = [[item, rng.int(min, max)]];
    if (extra && rng.chance(extra[1])) d.push([extra[0], 1]);
    return d;
  },
});

const crystal: Harvest = {
  seconds: 5,
  tool: 'pickaxe',
  minTier: 2,
  action: 'Mine',
  verb: 'Mining',
  drops: (rng, _tier, band) => {
    const crystals = 1 + (rng.chance(0.15 * band) ? 1 : 0);
    return rng.chance(0.06 + 0.03 * band) ? [[Items.crystal, crystals], [Items.gem, 1]] : [[Items.crystal, crystals]];
  },
};

/** True if a decoration can be gathered, mined or broken at all. */
export const canHarvest = (deco: number): boolean => HARVESTS[deco] !== undefined;

const HARVESTS: Partial<Record<number, Harvest>> = {
  [Deco.Oak]: tree,
  [Deco.OakAutumn]: tree,
  [Deco.Pine]: tree,
  [Deco.PineSnow]: tree,
  [Deco.Palm]: tree,
  [Deco.DeadBush]: { ...pick(Items.wood, 1, 1), action: 'Gather', verb: 'Gathering' },
  [Deco.Bush]: pick(Items.berries, 1, 3, [Items.herb, 0.3]),
  [Deco.Flowers]: pick(Items.herb, 1, 2),
  [Deco.Mushroom]: pick(Items.mushroom, 1, 1),
  [Deco.Crop]: { ...pick(Items.vegetables, 1, 2, [Items.herb, 0.2]), action: 'Harvest', verb: 'Harvesting' },
  [Deco.Cactus]: { ...pick(Items.cactusFruit, 1, 2), seconds: 1.2 },
  [Deco.Stone]: rock,
  [Deco.RedRock]: rock,
  [Deco.SnowRock]: rock,
  [Deco.Ore]: {
    seconds: 4,
    tool: 'pickaxe',
    minTier: 1,
    action: 'Mine',
    verb: 'Mining',
    drops: (rng, tier, band) => {
      const roll = rng.next();
      const gold = 0.12 + 0.05 * band;
      const ore = tier >= 2 && roll < gold ? Items.goldOre : roll < gold + 0.4 ? Items.coal : Items.ironOre;
      return [[ore, rng.int(1, 2)]];
    },
  },
  [Deco.Crystal]: crystal,
  // The outer dimensions' land gives what the overworld's does.
  [Deco.HollowTree]: tree,
  [Deco.AshTree]: tree,
  [Deco.ShardGrass]: pick(Items.herb, 1, 1),
  [Deco.GlowCap]: pick(Items.mushroom, 1, 2),
  [Deco.RiftCrystal]: crystal,
  [Deco.Barrel]: { seconds: 0.8, minTier: 0, action: 'Break', verb: 'Breaking', drops: () => [] },
  [Deco.Treasure]: { seconds: 1.6, minTier: 0, action: 'Dig', verb: 'Digging', drops: (rng) => [[Items.coin, rng.int(10, 40)], ...rollChest(rng, 2)] },
  [Deco.Meteorite]: {
    seconds: 5,
    tool: 'pickaxe',
    minTier: 1,
    action: 'Mine',
    verb: 'Mining',
    drops: (rng, tier) => [[Items.starMetal, rng.int(2, 3) + tier]],
  },
};

/** Somewhere things can be gathered: the world outdoors, or inside a mine. */
export interface Ground {
  tileAt(gx: number, gy: number): { tile: number; deco: number } | null;
  /** Takes what was gathered from a tile. */
  harvest(gx: number, gy: number): void;
  seedAt(gx: number, gy: number): number;
  chestAt?(gx: number, gy: number): { object: WorldObject; index: number } | null;
}

export type Interaction =
  | { kind: 'chest'; gx: number; gy: number; object: WorldObject; index: number }
  | { kind: 'empty-chest'; gx: number; gy: number }
  | { kind: 'drink'; gx: number; gy: number; amount: number }
  | { kind: 'harvest'; gx: number; gy: number; deco: number; seconds: number; harvest: Harvest; tier: number }
  | { kind: 'locked'; gx: number; gy: number; reason: string };

/** What the player could do with a tile, if anything. `speed` multiplies how
 *  fast gathering goes (the Gatherer skill). */
export function interactionAt(ground: Ground, inv: Inventory, vitals: Vitals, gx: number, gy: number, speed = 1): Interaction | null {
  const here = ground.tileAt(gx, gy);
  if (!here) return null;
  if (here.deco === Deco.Chest && ground.chestAt) {
    const chest = ground.chestAt(gx, gy);
    if (chest) return { kind: 'chest', gx, gy, ...chest };
  }
  if (here.deco === Deco.ChestOpen) return { kind: 'empty-chest', gx, gy };
  const h = HARVESTS[here.deco];
  if (h) {
    const tier = h.tool ? inv.toolTier(h.tool) : 0;
    if (tier < h.minTier) {
      const tool = h.minTier >= 2 ? 'an iron pickaxe' : 'a pickaxe';
      return { kind: 'locked', gx, gy, reason: `Needs ${tool}` };
    }
    const tired = vitals.stamina < STAMINA_COST ? 2 : 1;
    return { kind: 'harvest', gx, gy, deco: here.deco, seconds: (h.seconds / (1 + tier) / speed) * tired, harvest: h, tier };
  }
  if (!here.deco && DRINK[here.tile]) return { kind: 'drink', gx, gy, amount: DRINK[here.tile] };
  return null;
}

export class GatheringSystem {
  /** The harvest in progress. */
  current: Extract<Interaction, { kind: 'harvest' }> | null = null;
  elapsed = 0;
  /** The difficulty band of a tile; indoors, the game points it at the door outside. */
  bandAt: (gx: number, gy: number) => number = difficultyBand;
  /** Something was gathered from this tile. */
  onGathered?: (deco: number, gx: number, gy: number) => void;
  onChest?: (gx: number, gy: number) => void;
  /** What does not fit in the bag goes here (on the ground); lost without it. */
  overflow?: (item: ItemDef, count: number) => void;
  /** Where gathering happens: the world, or the mine the player is in. */
  ground: Ground;
  /** For the Forager skill. */
  progression?: Progression;
  /** Visiting a friend's world: a chest is theirs to open, so the host is
   *  asked first; `open` runs if it says yes (false: it cannot be asked). */
  claim?: (object: WorldObject, index: number, open: () => void) => boolean;
  /** Visiting a friend's world: what was gathered there is theirs to give, so
   *  the host is asked; `give` runs if it says yes (two players on one tree
   *  get one tree's wood). The plant goes at once either way. */
  confirm?: (ground: Ground, gx: number, gy: number, deco: number, give: () => void) => void;

  constructor(
    private readonly world: WorldManager,
    private readonly inv: Inventory,
    private readonly vitals: Vitals,
    private readonly notify: (text: string) => void,
  ) {
    this.ground = world;
  }

  get progress(): number {
    return this.current ? Math.min(1, this.elapsed / this.current.seconds) : 0;
  }

  /** Starts an interaction; instant ones finish here. */
  begin(i: Interaction): void {
    switch (i.kind) {
      case 'chest': {
        const open = () => {
          const rng = streamRng(Stream.Loot, this.world.seed, hashString(i.object.id), i.index);
          this.world.openChest(i.object, i.index);
          this.onChest?.(i.gx, i.gy);
          this.give(rollChest(rng, difficultyBand(i.gx, i.gy)), 'The chest is empty');
        };
        if (!this.claim) open();
        else if (!this.claim(i.object, i.index, open)) this.notify('The chest will not open');
        break;
      }
      case 'empty-chest':
        this.notify('Already looted');
        break;
      case 'drink':
        this.vitals.consume({ thirst: i.amount });
        this.notify(i.amount >= 25 ? 'You drink deeply' : 'You chip off some ice');
        break;
      case 'locked':
        this.notify(i.reason);
        break;
      case 'harvest':
        this.current = i;
        this.elapsed = 0;
        break;
    }
  }

  cancel(): void {
    this.current = null;
  }

  update(dt: number): void {
    const c = this.current;
    if (!c) return;
    // The target may have changed under us, e.g. its chunk unloaded.
    if (this.ground.tileAt(c.gx, c.gy)?.deco !== c.deco) {
      this.current = null;
      return;
    }
    this.elapsed += dt;
    if (this.elapsed < c.seconds) return;
    this.current = null;
    this.vitals.spend(Math.min(STAMINA_COST, this.vitals.stamina));
    const rng = new Rng(this.ground.seedAt(c.gx, c.gy));
    const drops = c.deco === Deco.Barrel ? rollBarrel(rng) : c.harvest.drops(rng, c.tier, this.bandAt(c.gx, c.gy));
    // Foragers find a little more on plants.
    const forager = 0.3 * (this.progression?.rank('forager') ?? 0);
    const plant = c.harvest.action === 'Pick' || c.harvest.action === 'Harvest';
    if (plant && drops.length && rng.chance(forager)) drops[0] = [drops[0][0], drops[0][1] + 1];
    this.ground.harvest(c.gx, c.gy);
    this.onGathered?.(c.deco, c.gx, c.gy);
    const give = () => this.give(drops, c.deco === Deco.Barrel ? 'Nothing inside' : undefined);
    if (this.confirm) this.confirm(this.ground, c.gx, c.gy, c.deco, give);
    else give();
  }

  /** Puts drops in the bag, with notes for what fit and what did not. */
  give(drops: Drops, emptyMessage?: string): void {
    if (!drops.length && emptyMessage) this.notify(emptyMessage);
    for (const [item, count] of drops) {
      const left = this.inv.add(item, count);
      if (count - left > 0) this.notify(`+${count - left} ${item.name}`);
      if (left <= 0) continue;
      if (this.overflow) this.overflow(item, left);
      else this.notify(`Bag full: lost ${left} ${item.name}`);
    }
  }
}
