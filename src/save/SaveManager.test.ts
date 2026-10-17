import { describe, expect, it } from 'vitest';
import { Items } from '../items/Items';
import { Inventory } from '../systems/InventorySystem';
import { SyncGenerator } from '../world/SyncGenerator';
import { WorldManager } from '../world/WorldManager';
import { migrate, restore, SAVE_VERSION, snapshot, type SaveData } from './SaveManager';

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
    world.lootedAnchors.add('0,0/structure');
    const data = snapshot(world, { x: 12.5, y: -3.1, inventory: [], vitals: null, progression: null });
    expect(data.seed).toBe(1234);
    expect(data.version).toBe(SAVE_VERSION);
    expect(data.player).toMatchObject({ x: 12.5, y: -3.1 });
    expect(data).not.toHaveProperty('objects');

    const fresh = new WorldManager(data.seed, new SyncGenerator());
    restore(fresh, data);
    expect(fresh.objects.objects.size).toBe(0);
    expect(fresh.lootedAnchors.has('0,0/structure')).toBe(true);
  });

  it('upgrades version 7: drops the old story, kept places and known places, and swaps the lantern', () => {
    const data = migrate(version7())!;
    expect(data.version).toBe(8);
    for (const field of ['objects', 'known']) expect(data).not.toHaveProperty(field);
    expect(data.living).not.toHaveProperty('story');
    expect(data.living!.time.day).toBe(3);
    expect(data.lootedAnchors).toEqual(['1,1/structure']);
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
});
