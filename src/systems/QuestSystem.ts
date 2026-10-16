// Generated quests (spec 6.3): collect, find a rare item, slay, discover a
// place, clear a dungeon, defend the village, and find a lost traveller and
// bring them home. Quest records persist; the
// villagers who hand them out do not.

import { SPECIES_LIST } from '../entities/Species';
import { Rng } from '../generation/Random';
import { BiomeType } from '../generation/Tiles';
import { itemById, Items, type ItemDef } from '../items/Items';
import type { Inventory } from './InventorySystem';
import { rollChest } from './Loot';

export const MAX_QUESTS = 5;
/** Escorts count as home within this many tiles of the village. */
export const HOME_RADIUS = 12;

export type Objective =
  | { kind: 'collect'; item: string; count: number }
  | { kind: 'slay'; species: string; count: number; progress: number }
  | { kind: 'discover'; structure: string; label: string; done: boolean }
  | { kind: 'clear'; done: boolean }
  | { kind: 'defend'; done: boolean }
  | { kind: 'rescue'; name: string; x: number; y: number; homeX: number; homeY: number; found: boolean };

export interface Quest {
  id: string;
  title: string;
  giver: string;
  text: string;
  objective: Objective;
  reward: { coins: number; xp: number; items: Array<[string, number]> };
  done: boolean;
}

const COLLECT: Partial<Record<BiomeType, Array<[ItemDef, number, number]>>> = {
  [BiomeType.Forest]: [[Items.wood, 10, 20], [Items.berries, 5, 10], [Items.hide, 3, 5], [Items.silk, 3, 5], [Items.herb, 4, 8]],
  [BiomeType.Desert]: [[Items.cactusFruit, 4, 8], [Items.chitin, 3, 5], [Items.stone, 10, 20], [Items.venom, 1, 3]],
  [BiomeType.Snow]: [[Items.iceShard, 2, 4], [Items.wood, 10, 20], [Items.hide, 3, 5], [Items.coal, 4, 8]],
};
/** Rare finds to bring back, by difficulty band (more and rarer further out). */
const FIND: ReadonlyArray<ReadonlyArray<[ItemDef, number, number]>> = [
  [[Items.goldOre, 2, 3], [Items.spiritEssence, 2, 3], [Items.venom, 2, 3]],
  [[Items.goldOre, 3, 4], [Items.crystal, 1, 1], [Items.iceShard, 3, 4]],
  [[Items.crystal, 1, 2], [Items.gem, 1, 1], [Items.starMetal, 1, 2]],
];
const DISCOVER: Array<[string, string]> = [
  ['ruins', 'ruins'],
  ['dungeon', 'a dungeon'],
  ['nomad-camp', 'a nomad camp'],
  ['castle', 'a castle'],
  ['standing-stones', 'the standing stones'],
  ['tower', 'a tower'],
  ['temple', 'a temple'],
  ['mine', 'a mine'],
  ['cabin', 'a cabin'],
  ['lake', 'a lake'],
];
const DIRECTIONS = ['east', 'south-east', 'south', 'south-west', 'west', 'north-west', 'north', 'north-east'];

export interface QuestContext {
  giver: string;
  /** The giver's village, where escorts end. */
  homeX: number;
  homeY: number;
  biome: BiomeType;
  band: number;
  /** The giver lives in a village, which can be defended. */
  village?: boolean;
}

/** A quest offer, seeded so the same villager offers the same job. */
export function generateQuest(rng: Rng, ctx: QuestContext, id: string): Quest {
  const kind = rng.weighted(['collect', 'find', 'slay', 'discover', 'clear', 'rescue', 'defend'] as const, (k) =>
    ({ collect: 3, find: 1.5, slay: 3, discover: 2, clear: 1, rescue: 1.5, defend: ctx.village ? 1 : 0 })[k])!;
  const scale = 1 + ctx.band * 0.5;
  const coins = (base: number) => Math.round(base * scale * rng.range(0.8, 1.2));
  let quest: Omit<Quest, 'id' | 'giver' | 'reward' | 'done'> & { coins: number; xp: number };

  switch (kind) {
    case 'collect': {
      const [item, min, max] = rng.pick(COLLECT[ctx.biome] ?? COLLECT[BiomeType.Forest]!);
      const count = rng.int(min, max);
      quest = {
        title: `Bring ${count} ${item.name}`,
        text: `We're short on ${item.name.toLowerCase()}. Could you bring me ${count}?`,
        objective: { kind: 'collect', item: item.id, count },
        coins: coins(10 + count * 2),
        xp: 30 + count * 2,
      };
      break;
    }
    case 'find': {
      const [item, min, max] = rng.pick(FIND[Math.min(FIND.length - 1, ctx.band)]);
      const count = rng.int(min, max);
      quest = {
        title: `Find ${count > 1 ? `${count} ` : ''}${item.name}`,
        text: `I've heard there's ${item.name.toLowerCase()} out in the far places. Find me ${count} and I'll make it worth your while.`,
        objective: { kind: 'collect', item: item.id, count },
        coins: coins(40 + item.rarity * 25 * count),
        xp: 60 + item.rarity * 30,
      };
      break;
    }
    case 'defend':
      quest = {
        title: 'Defend the village',
        text: "Beasts have been circling the village, and they'll come for us soon. Stand with us and drive them off.",
        objective: { kind: 'defend', done: false },
        coins: coins(60),
        xp: 140,
      };
      break;
    case 'slay': {
      const pool = SPECIES_LIST.filter((s) => s.biomes.includes(ctx.biome) && !s.nightOnly);
      const species = rng.pick(pool.length ? pool : SPECIES_LIST.filter((s) => s.biomes.length && !s.nightOnly));
      const count = rng.int(3, 6);
      quest = {
        title: `Hunt ${count} ${species.name}s`,
        text: `${species.name}s have been bothering the village. Thin them out: ${count} should do.`,
        objective: { kind: 'slay', species: species.id, count, progress: 0 },
        coins: coins(15 + count * 6),
        xp: 40 + count * 10,
      };
      break;
    }
    case 'discover': {
      const [structure, label] = rng.pick(DISCOVER);
      quest = {
        title: `Find ${label}`,
        text: `Travellers speak of ${label} out in the wilds. Find one and tell me it's real.`,
        objective: { kind: 'discover', structure, label, done: false },
        coins: coins(30),
        xp: 60,
      };
      break;
    }
    case 'clear':
      quest = {
        title: 'Clear a dungeon',
        text: 'Something crawls out of the old dungeons at night. Clear one out, any one.',
        objective: { kind: 'clear', done: false },
        coins: coins(70),
        xp: 120,
      };
      break;
    case 'rescue': {
      const name = rng.pick(['Tobias', 'Mira', 'Arlo', 'Juniper', 'Cassius', 'Nell']);
      const dir = rng.int(0, 7);
      const dist = rng.int(150, 300);
      const a = (dir / 8) * Math.PI * 2;
      quest = {
        title: `Find ${name}`,
        text: `${name} went ${DIRECTIONS[dir]} days ago and never came back. Please find them and bring them home.`,
        objective: { kind: 'rescue', name, x: ctx.homeX + Math.cos(a) * dist, y: ctx.homeY + Math.sin(a) * dist, homeX: ctx.homeX, homeY: ctx.homeY, found: false },
        coins: coins(60),
        xp: 150,
      };
      break;
    }
  }
  const items = rollChest(rng, ctx.band).slice(0, 1).map(([item, n]): [string, number] => [item.id, n]);
  const { coins: c, xp, ...rest } = quest;
  return { id, giver: ctx.giver, ...rest, reward: { coins: c, xp, items }, done: false };
}

/** Progress shown in the journal and tracker. */
export function progressText(q: Quest, inv: Inventory): string {
  const o = q.objective;
  switch (o.kind) {
    case 'collect':
      return `${Math.min(inv.count(itemById(o.item)!), o.count)}/${o.count} · hand in to any villager`;
    case 'slay':
      return `${o.progress}/${o.count}`;
    case 'discover':
      return o.done ? 'Found' : 'Not yet found';
    case 'clear':
      return o.done ? 'Cleared' : 'Not yet cleared';
    case 'defend':
      return o.done ? 'Defended' : 'Drive off the beasts';
    case 'rescue':
      return o.found ? 'Bring them home' : 'Search for them';
  }
}

export class QuestSystem {
  quests: Quest[] = [];
  /** Offers already made, by giver id: one job per villager per day. */
  private readonly offered = new Set<string>();
  onComplete?: (q: Quest) => void;

  get active(): Quest[] {
    return this.quests.filter((q) => !q.done);
  }

  get full(): boolean {
    return this.active.length >= MAX_QUESTS;
  }

  hasOffered(key: string): boolean {
    return this.offered.has(key);
  }

  accept(q: Quest, offerKey: string): boolean {
    if (this.full) return false;
    this.offered.add(offerKey);
    this.quests.push(q);
    return true;
  }

  /** Gives up an unfinished quest, freeing its slot. */
  abandon(id: string): boolean {
    const i = this.quests.findIndex((q) => q.id === id && !q.done);
    if (i < 0) return false;
    this.quests.splice(i, 1);
    return true;
  }

  onKill(speciesId: string): void {
    for (const q of this.active) {
      const o = q.objective;
      if (o.kind === 'slay' && o.species === speciesId) {
        o.progress++;
        if (o.progress >= o.count) this.complete(q);
      }
    }
  }

  onDiscover(kind: string): void {
    for (const q of this.active) {
      const o = q.objective;
      if (o.kind === 'discover' && o.structure === kind) {
        o.done = true;
        this.complete(q);
      }
    }
  }

  onCleared(kind: string): void {
    for (const q of this.active) {
      const o = q.objective;
      if ((o.kind === 'clear' && kind === 'dungeon') || (o.kind === 'defend' && kind === 'invasion')) {
        o.done = true;
        this.complete(q);
      }
    }
  }

  /** Collect quests the player can hand in right now. */
  readyToHandIn(inv: Inventory): Quest[] {
    return this.active.filter((q) => q.objective.kind === 'collect' && inv.count(itemById(q.objective.item)!) >= q.objective.count);
  }

  handIn(q: Quest, inv: Inventory): boolean {
    const o = q.objective;
    if (o.kind !== 'collect' || !inv.remove(itemById(o.item)!, o.count)) return false;
    this.complete(q);
    return true;
  }

  /** The lost traveller was found and agreed to follow. */
  found(questId: string): void {
    const q = this.quests.find((x) => x.id === questId);
    if (q?.objective.kind === 'rescue') q.objective.found = true;
  }

  /** Escorts finish when the traveller reaches home. Returns the quest finished, if any. */
  updateEscort(questId: string, x: number, y: number): Quest | undefined {
    const q = this.quests.find((x) => x.id === questId && !x.done);
    if (q?.objective.kind !== 'rescue') return undefined;
    q.objective.x = x;
    q.objective.y = y;
    if (q.objective.found && Math.hypot(x - q.objective.homeX, y - q.objective.homeY) < HOME_RADIUS) {
      this.complete(q);
      return q;
    }
    return undefined;
  }

  /** New day: villagers have new jobs. */
  newDay(): void {
    this.offered.clear();
    // Keep the journal short: drop finished quests from earlier days.
    this.quests = this.quests.filter((q) => !q.done);
  }

  private complete(q: Quest): void {
    q.done = true;
    this.onComplete?.(q);
  }

  save(): Quest[] {
    return this.quests;
  }

  /** Quests whose objective cannot work (e.g. an item no longer in the game)
   *  are dropped, since the journal and hand-in would fail on them. */
  load(quests: Quest[]): void {
    this.quests = quests.filter((q) => q?.objective && q.reward && (q.objective.kind !== 'collect' || !!itemById(q.objective.item)));
  }
}
