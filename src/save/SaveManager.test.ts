import { describe, expect, it } from 'vitest';
import { regionKey } from '../coords';
import { Items } from '../items/Items';
import { Inventory } from '../systems/InventorySystem';
import { SyncGenerator } from '../world/SyncGenerator';
import { WorldManager } from '../world/WorldManager';
import { characterSave, migrate, restore, SAVE_VERSION, snapshot, type SaveData } from './SaveManager';

function view(px: number, py: number) {
  return { minX: px - 15, minY: py - 9, maxX: px + 15, maxY: py + 9, playerX: px, playerY: py, dirX: 0, dirY: 0 };
}

/** A save as version 7 wrote it, with the old story, kept places and the known register. */
function version7(): SaveData {
  const object = (id: string, kind: string, persistence: string) => ({
    id, kind, name: kind, persistence, x: 0, y: -40, w: 2, h: 2,
    tiles: new Uint8Array(4), decos: new Uint8Array(4), discovered: true, anchor: '', opened: [], buildings: [], idleSince: 50,
  });
  const inventory = Array.from({ length: 24 }, () => null) as SaveData['player']['inventory'];
  inventory[0] = { id: 'wanderers-lantern', count: 1 };
  inventory[1] = { id: 'wood', count: 7 };
  return {
    version: 7,
    seed: 1234,
    savedAt: 0,
    player: { x: 3, y: 4, inventory, equipment: { offhand: { id: 'wanderers-lantern', count: 1 } }, vitals: null, progression: null },
    objects: [object('story:monument', 'story-monument', 'persistent'), object('village@1,1#0/structure', 'village', 'semi-persistent')],
    lootedAnchors: ['1,1/structure'],
    clearedAnchors: [],
    living: {
      time: { day: 3, minutes: 600 },
      weather: {},
      quests: [],
      story: { stage: 'epilogue', flags: ['lantern-dark'], ending: 'living', memories: [{ name: 'Village', x: 0, y: 0, w: 1, h: 1, mask: new Uint8Array(1), day: 2 }] },
    },
    exploration: { explored: [], markers: [], tracked: null },
    regions: [],
    harvested: [],
    ground: [],
    known: [{ id: 'story:monument', name: 'Waking Monument', x: 0, y: -40, w: 7, h: 7, story: true }],
  } as SaveData;
}

describe('save', () => {
  it('round-trips the seed and the player, and keeps no structures', () => {
    const world = new WorldManager(1234, new SyncGenerator());
    world.update(view(0, 0));
    expect(world.objects.objects.size).toBeGreaterThan(0);
    world.lootedAnchors.add('0,0/structure#0');
    // Drifted memories are not saved: a past visit, an event long gone.
    world.lootedAnchors.add('0,0/rare#3');
    world.clearedAnchors.add('event-Rift@12');
    const data = snapshot(world, { x: 12.5, y: -3.1, inventory: [], vitals: null, progression: null });
    expect(data.lootedAnchors).toEqual(['0,0/structure#0']);
    expect(data.clearedAnchors).toEqual([]);
    expect(data.seed).toBe(1234);
    expect(data.version).toBe(SAVE_VERSION);
    expect(data.player).toMatchObject({ x: 12.5, y: -3.1 });
    expect(data).not.toHaveProperty('objects');

    const fresh = new WorldManager(data.seed, new SyncGenerator());
    restore(fresh, data);
    expect(fresh.objects.objects.size).toBe(0);
    expect(fresh.lootedAnchors.has('0,0/structure#0')).toBe(true);
  });

  it('upgrades version 7: drops the old story, kept places and known places, and swaps the lantern', () => {
    const data = migrate(version7())!;
    expect(data.version).toBe(SAVE_VERSION);
    for (const field of ['objects', 'known']) expect(data).not.toHaveProperty(field);
    expect(data.living).not.toHaveProperty('story');
    expect(data.living!.time.day).toBe(3);
    expect(data.lootedAnchors).toEqual(['1,1/structure#0']);
    expect(data.player.inventory[0]).toEqual({ id: 'lantern', count: 1 });
    expect(data.player.inventory[1]).toEqual({ id: 'wood', count: 7 });
    expect(data.player.equipment!.offhand).toEqual({ id: 'lantern', count: 1 });

    // It loads cleanly: no story places come back, and the player keeps a light.
    const world = new WorldManager(data.seed, new SyncGenerator());
    restore(world, data);
    world.update(view(0, -40));
    expect([...world.objects.objects.keys()].some((id) => id.startsWith('story:'))).toBe(false);
    const inv = new Inventory();
    inv.load(data.player.inventory);
    inv.loadEquipment(data.player.equipment!);
    expect(inv.count(Items.lantern)).toBe(2);
  });

  it('upgrades the oldest saves all the way', () => {
    const old = { version: 1, seed: 5, savedAt: 0, player: { x: 0, y: 0 }, objects: [] } as unknown as SaveData;
    const data = migrate(old)!;
    expect(data.version).toBe(SAVE_VERSION);
    expect(data).not.toHaveProperty('objects');
    expect(() => restore(new WorldManager(data.seed, new SyncGenerator()), data)).not.toThrow();
  });

  it('upgrades version 8: memories of places take the visit their region was on', () => {
    const data = migrate({
      ...version7(),
      version: 8,
      lootedAnchors: ['1,1/structure', '40,40/rare'],
      clearedAnchors: ['2,3/structure', 'legend@-4,9', 'rift@1,1#0/rare', 'event-Rift@12'],
      regions: [regionKey(1, 1), 2],
      ground: [{ id: 'wood', count: 3, x: 1, y: 1 }],
    } as unknown as SaveData)!;
    expect(data.version).toBe(SAVE_VERSION);
    expect(data.lootedAnchors).toEqual(['1,1/structure#2', '40,40/rare#0']);
    expect(data.clearedAnchors).toEqual(['2,3/structure#2', 'legend@-4,9#0', 'rift@1,1#0/rare', 'event-Rift@12']);
    // Ground items without a visit are taken as from the current one.
    const world = new WorldManager(data.seed, new SyncGenerator());
    restore(world, data);
    expect(world.ground.items).toHaveLength(1);
    expect(world.ground.items[0].visit).toBe(2);
  });
});

describe('the Drift', () => {
  /** Walks far enough away for everything around the start to unload, then back. */
  function driftAway(world: WorldManager): void {
    for (let x = 0; x <= 3000; x += 24) world.update(view(x, 0));
    for (let x = 3000; x >= 0; x -= 24) world.update(view(x, 0));
  }

  it('takes items on the ground with their region when it drifts', () => {
    const world = new WorldManager(1234, new SyncGenerator());
    world.update(view(0, 0));
    world.ground.drop({ item: Items.wood, count: 4 }, 2, 2);
    expect(world.ground.items).toHaveLength(1);
    // Moving about inside the active area changes nothing.
    world.update(view(40, 0));
    world.update(view(0, 0));
    expect(world.ground.items).toHaveLength(1);
    driftAway(world);
    expect(world.ground.items).toHaveLength(0);
    // And a save of an item from a visit that has since drifted does not bring it back.
    const data = snapshot(world, { x: 0, y: 0, inventory: [], vitals: null, progression: null });
    data.ground = [{ id: 'wood', count: 1, x: 2, y: 2, visit: 0 }, { id: 'stone', count: 1, x: 2, y: 2, visit: 1 }];
    const fresh = new WorldManager(1234, new SyncGenerator());
    restore(fresh, data);
    expect(fresh.ground.items.map((g) => g.stack.item.id)).toEqual(['stone']);
  }, 30000);

  it('forgets looted chests and cleared lairs once their region drifts', () => {
    const world = new WorldManager(1234, new SyncGenerator());
    world.update(view(0, 0));
    const o = [...world.objects.objects.values()].find((x) => x.anchor)!;
    expect(o.anchor).toMatch(/#0$/);
    world.lootedAnchors.add(o.anchor);
    world.clearedAnchors.add(o.anchor);
    expect(world.liveMemory(world.lootedAnchors)).toEqual([o.anchor]);
    const base = o.anchor.slice(0, o.anchor.indexOf('#'));
    driftAway(world);
    // Nothing remembered of the past visit is saved, and whatever stands there now is new.
    expect(world.liveMemory(world.lootedAnchors)).toEqual([]);
    expect(world.liveMemory(world.clearedAnchors)).toEqual([]);
    for (const x of world.objects.objects.values()) {
      if (!x.anchor.startsWith(`${base}#`)) continue;
      expect(x.anchor).not.toBe(o.anchor);
      expect(x.emptyChests).toBe(false);
    }
  }, 30000);
});

describe('a guest’s character save', () => {
  const character = {
    inventory: [{ id: 'wood', count: 7 }],
    equipment: {},
    vitals: { health: 50, hunger: 40, thirst: 30, stamina: 20 } as never,
    progression: { level: 4, xp: 12 } as never,
    story: { version: 3, closed: 2, entered: true, cleared: ['hollow'], read: {} } as never,
  };

  it('takes only the character from a visit: the player’s own world is kept as it was', () => {
    const world = new WorldManager(1234, new SyncGenerator());
    world.update(view(0, 0));
    world.lootedAnchors.add('3,4/structure#0');
    const own = snapshot(world, { x: 812, y: -40, inventory: [{ id: 'stone', count: 1 }], vitals: null, progression: null, respawn: { x: 5, y: 6 } }, { time: { day: 9, minutes: 100 }, weather: {}, quests: [], rift: undefined }, null);
    const out = characterSave(own, character, 99);
    // The character is the visit's.
    expect(out.player.inventory).toEqual(character.inventory);
    expect(out.player.progression).toEqual(character.progression);
    expect(out.living?.rift).toEqual(character.story);
    // Everything of the world, and where the player stood in it, is their own.
    expect(out.seed).toBe(1234);
    expect(out.player.x).toBe(812);
    expect(out.player.y).toBe(-40);
    expect(out.player.respawn).toEqual({ x: 5, y: 6 });
    expect(out.lootedAnchors).toEqual(own.lootedAnchors);
    expect(out.regions).toEqual(own.regions);
    expect(out.ground).toEqual(own.ground);
    expect(out.living?.time).toEqual({ day: 9, minutes: 100 });
    // The save it came from is not changed.
    expect(own.player.inventory).toEqual([{ id: 'stone', count: 1 }]);
  });

  it('gives a player with no world of their own a new one to come home to', () => {
    const out = characterSave(null, character, 4242);
    expect(out.seed).toBe(4242);
    expect(out.version).toBe(SAVE_VERSION);
    expect(out.player.inventory).toEqual(character.inventory);
    expect(migrate(structuredClone(out) as never)).not.toBeNull();
  });
});
