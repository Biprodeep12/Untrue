import { describe, expect, it } from 'vitest';
import { CHUNK_SIZE } from '../config';
import { Npc } from '../entities/NPC';
import { VILLAGER_TALK } from '../game/LivingWorld';
import { Rng } from '../generation/Random';
import { BiomeType, Deco } from '../generation/Tiles';
import { Items } from '../items/Items';
import { SyncGenerator } from '../world/SyncGenerator';
import { WorldManager } from '../world/WorldManager';
import { GatheringSystem, interactionAt } from './GatheringSystem';
import { HazardSystem } from './HazardSystem';
import { Inventory } from './InventorySystem';
import { NpcSystem } from './NpcSystem';
import { generateQuest, QuestSystem } from './QuestSystem';
import { TimeSystem } from './TimeSystem';
import { buy, sell, stockFor } from './TradeSystem';
import { Vitals } from './Vitals';
import { WEATHER, WeatherSystem } from './WeatherSystem';
import { WorldEvents, type EventContext } from './WorldEvents';

function view(px: number, py: number) {
  return { minX: px - 15, minY: py - 9, maxX: px + 15, maxY: py + 9, playerX: px, playerY: py, dirX: 0, dirY: 0 };
}

function findDeco(world: WorldManager, decos: number[]): [number, number] | null {
  for (const chunk of world.chunks.chunks.values()) {
    if (!chunk.ready) continue;
    for (let i = 0; i < chunk.decos.length; i++) {
      if (decos.includes(chunk.decos[i])) return [chunk.cx * CHUNK_SIZE + (i % CHUNK_SIZE), chunk.cy * CHUNK_SIZE + Math.floor(i / CHUNK_SIZE)];
    }
  }
  return null;
}

describe('time', () => {
  it('runs through dawn, day, dusk and night', () => {
    const t = new TimeSystem();
    expect(t.phase).toBe('day');
    expect(t.darkness).toBe(0);
    expect(t.skipTo(19)).toBe(11);
    expect(t.phase).toBe('dusk');
    expect(t.darkness).toBeCloseTo(0.5);
    t.skipTo(23);
    expect(t.isNight).toBe(true);
    expect(t.darkness).toBe(1);
    t.skipTo(6);
    expect(t.day).toBe(2);
    expect(t.phase).toBe('dawn');
    expect(t.label()).toBe('Day 2 · 6:00 am');
  });
});

describe('weather', () => {
  it('changes by biome and shapes survival', () => {
    const w = new WeatherSystem(new Rng(1));
    w.set(BiomeType.Desert, 'heat');
    expect(w.current(BiomeType.Desert, false)).toBe('heat');
    expect(w.current(BiomeType.Desert, true)).toBe('clear');
    const kinds = new Set<string>();
    for (let h = 0; h < 500; h++) {
      w.onHour();
      kinds.add(w.current(BiomeType.Snow, false));
    }
    expect([...kinds].sort()).toEqual(['blizzard', 'clear', 'fog', 'snow']);

    const dry = new Vitals();
    const wet = new Vitals();
    dry.update(60, false, BiomeType.Forest, WEATHER.heat);
    wet.update(60, false, BiomeType.Forest, WEATHER.rain);
    expect(dry.thirst).toBeLessThan(wet.thirst);
  });
});

describe('regrowth', () => {
  it('brings berry bushes back after a day, but not trees', () => {
    const world = new WorldManager(1234, new SyncGenerator());
    let now = 0;
    world.now = () => now;
    world.update(view(0, 0));
    const [bx, by] = findDeco(world, [Deco.Bush])!;
    const [tx, ty] = findDeco(world, [Deco.Oak, Deco.OakAutumn, Deco.Pine])!;
    world.harvest(bx, by);
    world.harvest(tx, ty);
    now += 1440;
    world.regrow();
    expect(world.tileAt(bx, by)!.deco).toBe(Deco.Bush);
    expect(world.tileAt(tx, ty)!.deco).toBe(0);
  });
});

describe('npcs', () => {
  it('villagers go indoors at night and come out in the morning', () => {
    const npc = new Npc('villager', 'Ivy', 'villager-a', 5, 5, 5, 5, 8, 5);
    const ctx = { hour: 22, playerX: 0, playerY: 0, isSolid: () => false, random: () => 0.5 };
    for (let t = 0; t < 60 && !npc.hidden; t++) npc.update(0.2, ctx);
    expect(npc.hidden).toBe(true);
    npc.update(0.2, { ...ctx, hour: 8 });
    expect(npc.hidden).toBe(false);
  });

  it('talk of the Drift as old and ordinary, and of the Fracture as new', () => {
    const fracture = VILLAGER_TALK.filter((l) => /\brifts?\b|tears in the air|isn't the Drift/i.test(l));
    const drift = VILLAGER_TALK.filter((l) => /drift/i.test(l) && !fracture.includes(l));
    expect(drift.length).toBeGreaterThanOrEqual(3);
    expect(fracture.length).toBeGreaterThanOrEqual(3);
  });

  it('fills villages with villagers, a quest giver and a trader', () => {
    const world = new WorldManager(1234, new SyncGenerator());
    const npcs = new NpcSystem(world);
    let village;
    for (let x = 0; x < 20000 && !village; x += 32) {
      world.update(view(x, 0));
      village = [...world.objects.objects.values()].find((o) => o.kind === 'village');
    }
    const v = village!;
    world.update(view(v.x + v.w / 2, v.y + v.h / 2));
    npcs.update(0.1, 12, v.x, v.y, 0);
    const all = npcs.npcs.filter((n) => n.village === v.id);
    const people = all.filter((n) => !n.homebody);
    expect(people).toHaveLength(4);
    // And someone at home behind every door.
    const homes = all.filter((n) => n.homebody);
    expect(homes).toHaveLength(v.layout.buildings.length);
    expect(homes.every((n) => n.hidden && !n.questGiver)).toBe(true);
    expect(new Set(homes.map((n) => `${n.doorX},${n.doorY}`)).size).toBe(homes.length);
    expect(people.filter((n) => n.questGiver)).toHaveLength(1);
    expect(people.filter((n) => n.role === 'trader')).toHaveLength(1);
  });
});

describe('quests', () => {
  const ctx = { giver: 'Ivy', homeX: 100, homeY: 100, biome: BiomeType.Forest, band: 0 };

  it('generates the same offer from the same seed', () => {
    expect(generateQuest(new Rng(5), ctx, 'q1')).toEqual(generateQuest(new Rng(5), ctx, 'q1'));
  });

  it('tracks slaying, collecting, discovering, clearing and rescues', () => {
    const qs = new QuestSystem();
    const done: string[] = [];
    qs.onComplete = (q) => done.push(q.objective.kind);
    const make = (objective: never) => ({ id: String(Math.random()), title: '', giver: '', text: '', objective, reward: { coins: 1, xp: 1, items: [] }, done: false });
    const slay = make({ kind: 'slay', species: 'wolf', count: 2, progress: 0 } as never);
    const collect = make({ kind: 'collect', item: 'wood', count: 3 } as never);
    const discover = make({ kind: 'discover', structure: 'temple', label: 'a temple', done: false } as never);
    const clear = make({ kind: 'clear', done: false } as never);
    const rescue = make({ kind: 'rescue', name: 'Mira', x: 300, y: 100, homeX: 100, homeY: 100, found: false } as never);
    for (const q of [slay, collect, discover, clear, rescue]) expect(qs.accept(q, q.id)).toBe(true);
    expect(qs.full).toBe(true);

    qs.onKill('wolf');
    qs.onKill('bear');
    qs.onKill('wolf');
    const inv = new Inventory();
    inv.add(Items.wood, 3);
    expect(qs.readyToHandIn(inv)).toEqual([collect]);
    expect(qs.handIn(collect, inv)).toBe(true);
    expect(inv.count(Items.wood)).toBe(0);
    qs.onDiscover('temple');
    qs.onCleared('dungeon');
    expect(qs.updateEscort(rescue.id, 105, 100)).toBeUndefined();
    qs.found(rescue.id);
    expect(qs.updateEscort(rescue.id, 200, 100)).toBeUndefined();
    expect(qs.updateEscort(rescue.id, 105, 100)).toBe(rescue);
    expect(done).toEqual(['slay', 'collect', 'discover', 'clear', 'rescue']);
  });
});

describe('trade', () => {
  it('buys with coins and sells treasure', () => {
    const inv = new Inventory();
    const offer = stockFor('trader-1', false)[0];
    expect(buy(inv, offer)).toBe('coins');
    inv.add(Items.coin, offer.price);
    expect(buy(inv, offer)).toBe('ok');
    expect(inv.count(Items.coin)).toBe(0);
    expect(inv.count(offer.item)).toBe(offer.count);
    inv.add(Items.gem, 1);
    expect(sell(inv, Items.gem)).toBe('ok');
    expect(inv.count(Items.coin)).toBe(60);
    expect(sell(inv, Items.wood)).toBe('none');
  });
});

describe('world events', () => {
  function setup() {
    const world = new WorldManager(1234, new SyncGenerator());
    world.update(view(0, 0));
    const notes: string[] = [];
    const events = new WorldEvents(world, new Rng(3), {
      notify: (t) => notes.push(t),
      meteor: () => {},
      bandits: () => {},
      invasion: () => {},
      merchant: () => {},
      waypoint: () => {},
    });
    const ctx: EventContext = { x: 0, y: 0, night: true, village: null, merchantNearby: false, now: 600 };
    return { world, events, ctx, notes };
  }

  it('buries treasure you can dig up', () => {
    const { world, events, ctx } = setup();
    expect(events.trigger('treasure', ctx)).toBe(true);
    const [gx, gy] = findDeco(world, [Deco.Treasure])!;
    const inv = new Inventory();
    const vitals = new Vitals();
    const gathering = new GatheringSystem(world, inv, vitals, () => {});
    gathering.begin(interactionAt(world, inv, vitals, gx, gy)!);
    gathering.update(5);
    expect(inv.count(Items.coin)).toBeGreaterThan(0);
    expect(world.tileAt(gx, gy)!.deco).toBe(0);
  });

  it('drops a meteorite and raises an obelisk with a chest', () => {
    const { world, events, ctx } = setup();
    expect(events.trigger('meteor', ctx)).toBe(true);
    expect(findDeco(world, [Deco.Meteorite])).not.toBeNull();
    expect(events.trigger('ancient', { ...ctx, now: 700 })).toBe(true);
    const obelisk = [...world.objects.objects.values()].find((o) => o.kind === 'risen-obelisk')!;
    expect(obelisk.layout.decos).toContain(Deco.Chest);
  });
});

describe('hazards', () => {
  it('burns a tree down, and fire spreads less in the wet', () => {
    const world = new WorldManager(1234, new SyncGenerator());
    world.update(view(0, 0));
    const [tx, ty] = findDeco(world, [Deco.Oak, Deco.OakAutumn, Deco.Pine])!;
    const vitals = new Vitals();
    const hazards = new HazardSystem(world, vitals, new Rng(1), { flash: () => {}, hurt: () => {}, notify: () => {} });
    expect(hazards.ignite(tx, ty)).toBe(true);
    for (let t = 0; t < 20; t++) hazards.update(0.5, false, false, 1e6, 1e6, false);
    expect(world.tileAt(tx, ty)!.deco).toBe(0);
    expect(hazards.ignite(tx, ty)).toBe(false);
  });
});
