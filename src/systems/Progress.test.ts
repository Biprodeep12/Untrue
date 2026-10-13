import { describe, expect, it } from 'vitest';
import { elementFactor, SPECIES } from '../entities/Species';
import { Rng } from '../generation/Random';
import { BiomeType } from '../generation/Tiles';
import { ITEM_LIST, Items } from '../items/Items';
import { legendFor } from './CombatSystem';
import { craft, RECIPES, unknownRare } from './CraftingSystem';
import { HOTBAR_SIZE, Inventory } from './InventorySystem';
import { Progression } from './Progression';
import { generateQuest, QuestSystem } from './QuestSystem';
import { sell } from './TradeSystem';

describe('the bag', () => {
  it('sorts below the hotbar, merging stacks, weapons first', () => {
    const inv = new Inventory();
    inv.slots[HOTBAR_SIZE + 5] = { item: Items.wood, count: 30 };
    inv.slots[HOTBAR_SIZE + 1] = { item: Items.ironSword, count: 1, durability: 100 };
    inv.slots[HOTBAR_SIZE + 9] = { item: Items.wood, count: 40 };
    inv.slots[0] = { item: Items.berries, count: 3 };
    inv.sort();
    expect(inv.slots[0]?.item).toBe(Items.berries);
    expect(inv.slots[HOTBAR_SIZE]?.item).toBe(Items.ironSword);
    expect(inv.slots[HOTBAR_SIZE]?.durability).toBe(100);
    expect(inv.slots[HOTBAR_SIZE + 1]).toEqual({ item: Items.wood, count: 70 });
    expect(inv.count(Items.wood)).toBe(70);
  });

  it('sells a whole stack at once', () => {
    const inv = new Inventory();
    inv.add(Items.hide, 5);
    expect(sell(inv, Items.hide, 5)).toBe('ok');
    expect(inv.count(Items.hide)).toBe(0);
    expect(inv.count(Items.coin)).toBe(15);
  });
});

describe('damage types', () => {
  it('hurt the weak more and the resistant less', () => {
    expect(elementFactor(SPECIES.scorpion, 'frost')).toBe(1.5);
    expect(elementFactor(SPECIES.golem, 'frost')).toBe(0.5);
    expect(elementFactor(SPECIES.wraith, 'spirit')).toBe(1.5);
    expect(elementFactor(SPECIES.wolf, undefined)).toBe(1);
  });

  it('give every variant a sprite to borrow', () => {
    for (const s of Object.values(SPECIES)) if (s.art) expect(Object.values(SPECIES).some((o) => o.id === s.art)).toBe(true);
  });
});

describe('legends', () => {
  it('belong to their land, further out', () => {
    expect(legendFor(BiomeType.Forest, 0, 0.9)).toBe(SPECIES.stag);
    expect(legendFor(BiomeType.Desert, 2, 0.2)).toBe(SPECIES.duneTyrant);
    expect([SPECIES.ancientGolem, SPECIES.alphaWolf]).toContain(legendFor(BiomeType.Snow, 3, 0.7));
  });

  it('are counted as trophies, kept in the save with learned recipes', () => {
    const p = new Progression();
    p.trophies['elder-stag'] = 2;
    p.recipes.add(Items.frostBlade.id);
    const copy = new Progression();
    copy.load(JSON.parse(JSON.stringify(p.save())));
    expect(copy.trophies['elder-stag']).toBe(2);
    expect(copy.recipes.has(Items.frostBlade.id)).toBe(true);
  });
});

describe('recipes', () => {
  it('use every rare material for something', () => {
    for (const item of [Items.goldOre, Items.crystal, Items.starMetal, Items.venom, Items.iceShard, Items.bone, Items.chitin, Items.spiritEssence]) {
      expect(RECIPES.some((r) => r.inputs.some(([i]) => i === item))).toBe(true);
    }
  });

  it('hide rare ones until a schematic teaches them', () => {
    const known = new Set<string>();
    const rare = unknownRare(known);
    expect(rare.length).toBeGreaterThan(0);
    known.add(rare[0].output.id);
    expect(unknownRare(known).length).toBe(rare.length - 1);
  });

  it('forge the star tier above iron', () => {
    const inv = new Inventory();
    inv.add(Items.starMetal, 1);
    inv.add(Items.goldOre, 2);
    inv.add(Items.coal, 1);
    const ingot = RECIPES.find((r) => r.output === Items.starIngot)!;
    expect(craft(inv, ingot, new Set(['hand', 'anvil']))).toBe('ok');
    expect(inv.count(Items.starIngot)).toBe(1);
    expect(Items.starSword.weapon!.damage).toBeGreaterThan(Items.ironSword.weapon!.damage);
    const star = [Items.starHelmet, Items.starArmor, Items.starGreaves, Items.starBoots].reduce((n, i) => n + i.armor!, 0);
    expect(star).toBeLessThanOrEqual(0.6);
  });

  it('give every item a unique id', () => {
    expect(new Set(ITEM_LIST.map((i) => i.id)).size).toBe(ITEM_LIST.length);
  });
});

describe('quests', () => {
  it('can be abandoned', () => {
    const qs = new QuestSystem();
    const q = generateQuest(new Rng(1), { giver: 'Ada', homeX: 0, homeY: 0, biome: BiomeType.Forest, band: 0 }, 'q1');
    qs.accept(q, 'k');
    expect(qs.abandon('q1')).toBe(true);
    expect(qs.active.length).toBe(0);
  });

  it('defend the village when the beasts are driven off', () => {
    const qs = new QuestSystem();
    let done = 0;
    qs.onComplete = () => done++;
    let defend;
    for (let seed = 1; seed < 400 && !defend; seed++) {
      const q = generateQuest(new Rng(seed), { giver: 'Ada', homeX: 0, homeY: 0, biome: BiomeType.Forest, band: 1, village: true }, `q${seed}`);
      if (q.objective.kind === 'defend') defend = q;
    }
    expect(defend).toBeDefined();
    qs.accept(defend!, 'k');
    qs.onCleared('dungeon');
    expect(done).toBe(0);
    qs.onCleared('invasion');
    expect(done).toBe(1);
  });

  it('never ask a giver outside a village to defend it', () => {
    for (let seed = 1; seed < 300; seed++) {
      const q = generateQuest(new Rng(seed), { giver: 'Ada', homeX: 0, homeY: 0, biome: BiomeType.Desert, band: 0 }, `q${seed}`);
      expect(q.objective.kind).not.toBe('defend');
    }
  });
});

describe('key bindings', () => {
  it('replace the main key and keep the extras', async () => {
    const { bindings, keyName } = await import('../game/Keys');
    const keys = bindings({ interact: 'KeyR' });
    expect(keys.interact).toEqual(['KeyR']);
    expect(keys.up).toEqual(['KeyW', 'ArrowUp']);
    expect(keyName('KeyR')).toBe('R');
    expect(keyName('ShiftLeft')).toBe('Shift');
  });
});

describe('the desert', () => {
  it('has nomad camps with a fire and an anvil', async () => {
    const { STRUCTURES } = await import('../generation/StructureGenerator');
    const { Deco } = await import('../generation/Tiles');
    const def = STRUCTURES.find((d) => d.kind === 'nomad-camp')!;
    expect(def.biomes).toEqual([BiomeType.Desert]);
    const l = def.build({ rng: new Rng(3), palette: 0, biome: BiomeType.Desert });
    expect([...l.decos]).toContain(Deco.Anvil);
    expect([...l.decos]).toContain(Deco.Campfire);
  });
});
