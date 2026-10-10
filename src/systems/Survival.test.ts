import { describe, expect, it } from 'vitest';
import { CHUNK_SIZE, REGION_SIZE } from '../config';
import { tileToChunk } from '../coords';
import { BiomeType, Deco } from '../generation/Tiles';
import { Items } from '../items/Items';
import { restore, snapshot } from '../save/SaveManager';
import { SyncGenerator } from '../world/SyncGenerator';
import { WorldManager } from '../world/WorldManager';
import { craft, RECIPES } from './CraftingSystem';
import { GatheringSystem, interactionAt } from './GatheringSystem';
import { Inventory } from './InventorySystem';
import { Vitals } from './Vitals';

function view(px: number, py: number) {
  return { minX: px - 15, minY: py - 9, maxX: px + 15, maxY: py + 9, playerX: px, playerY: py, dirX: 0, dirY: 0 };
}

const recipe = (id: string) => RECIPES.find((r) => r.output.id === id)!;

/** First loaded tile holding one of these decorations. */
function findDeco(world: WorldManager, decos: number[]): [number, number] | null {
  for (const chunk of world.chunks.chunks.values()) {
    if (!chunk.ready) continue;
    for (let i = 0; i < chunk.decos.length; i++) {
      if (decos.includes(chunk.decos[i])) return [chunk.cx * CHUNK_SIZE + (i % CHUNK_SIZE), chunk.cy * CHUNK_SIZE + Math.floor(i / CHUNK_SIZE)];
    }
  }
  return null;
}

describe('inventory', () => {
  it('stacks, overflows, removes and moves', () => {
    const inv = new Inventory();
    expect(inv.add(Items.wood, 150)).toBe(0);
    expect(inv.slots[0]!.count).toBe(99);
    expect(inv.slots[1]!.count).toBe(51);
    expect(inv.remove(Items.wood, 100)).toBe(true);
    expect(inv.count(Items.wood)).toBe(50);
    expect(inv.remove(Items.wood, 51)).toBe(false);
    inv.add(Items.stoneAxe, 2);
    expect(inv.count(Items.stoneAxe)).toBe(2);
    expect(inv.toolTier('axe')).toBe(1);
    inv.move(0, 5);
    expect(inv.slots[5]?.item).toBe(Items.wood);
    const copy = new Inventory();
    copy.load(inv.save());
    expect(copy.save()).toEqual(inv.save());
  });

  it('reports what does not fit', () => {
    const inv = new Inventory();
    for (let i = 0; i < 24; i++) inv.add(Items.stoneAxe, 1);
    expect(inv.add(Items.wood, 3)).toBe(3);
  });
});

describe('crafting', () => {
  it('needs inputs and the right station', () => {
    const inv = new Inventory();
    expect(craft(inv, recipe('stone-axe'), new Set(['hand']))).toBe('missing');
    inv.add(Items.wood, 3);
    inv.add(Items.stone, 2);
    expect(craft(inv, recipe('stone-axe'), new Set(['hand']))).toBe('ok');
    expect(inv.count(Items.stoneAxe)).toBe(1);
    expect(inv.count(Items.wood)).toBe(0);
    inv.add(Items.ironOre, 2);
    inv.add(Items.coal, 1);
    expect(craft(inv, recipe('iron-ingot'), new Set(['hand']))).toBe('station');
    expect(craft(inv, recipe('iron-ingot'), new Set(['hand', 'anvil']))).toBe('ok');
  });
});

describe('vitals', () => {
  it('drains faster in the desert and hurts when starving', () => {
    const forest = new Vitals();
    const desert = new Vitals();
    forest.update(60, false, BiomeType.Forest);
    desert.update(60, false, BiomeType.Desert);
    expect(desert.thirst).toBeLessThan(forest.thirst);

    const v = new Vitals();
    v.hunger = 0;
    v.thirst = 0;
    let collapsed = false;
    for (let t = 0; t < 60 && !collapsed; t++) collapsed = v.update(1, false, BiomeType.Forest);
    expect(collapsed).toBe(true);
    v.revive();
    expect(v.health).toBeGreaterThan(0);
  });

  it('caps what food restores', () => {
    const v = new Vitals();
    v.hunger = 95;
    v.consume(Items.stew.food!);
    expect(v.hunger).toBe(100);
  });
});

describe('gathering', () => {
  it('chops a tree that stays gone until the region regenerates', () => {
    const world = new WorldManager(1234, new SyncGenerator());
    const inv = new Inventory();
    const vitals = new Vitals();
    const gathering = new GatheringSystem(world, inv, vitals, () => {});
    world.update(view(0, 0));
    const [gx, gy] = findDeco(world, [Deco.Oak, Deco.OakAutumn, Deco.Pine])!;

    const i = interactionAt(world, inv, vitals, gx, gy)!;
    expect(i.kind).toBe('harvest');
    gathering.begin(i);
    gathering.update(10);
    expect(inv.count(Items.wood)).toBeGreaterThan(0);
    expect(world.tileAt(gx, gy)!.deco).toBe(0);

    // Unload the tree's chunk while part of its region stays loaded: still cut.
    // Walk five chunks toward the far side of the region.
    const cx = tileToChunk(gx);
    const inRegion = ((cx % REGION_SIZE) + REGION_SIZE) % REGION_SIZE;
    world.update(view(gx + (inRegion < REGION_SIZE / 2 ? 5 : -5) * CHUNK_SIZE, gy));
    expect(world.chunks.get(cx, tileToChunk(gy))).toBeUndefined();
    expect(world.regions.visit(cx, tileToChunk(gy))).toBe(0);
    world.update(view(0, 0));
    expect(world.tileAt(gx, gy)!.deco).toBe(0);
  });

  it('needs a pickaxe for ore', () => {
    const world = new WorldManager(1234, new SyncGenerator());
    const inv = new Inventory();
    const vitals = new Vitals();
    let spot: [number, number] | null = null;
    for (let x = 0; x < 20000 && !spot; x += 64) {
      world.update(view(x, 0));
      spot = findDeco(world, [Deco.Ore]);
    }
    const [gx, gy] = spot!;
    expect(interactionAt(world, inv, vitals, gx, gy)!.kind).toBe('locked');
    inv.add(Items.stonePickaxe, 1);
    expect(interactionAt(world, inv, vitals, gx, gy)!.kind).toBe('harvest');
  });
});

describe('chests never refill', () => {
  it('loots once, and the same anchor regenerates empty', () => {
    const world = new WorldManager(1234, new SyncGenerator());
    const inv = new Inventory();
    const vitals = new Vitals();
    const gathering = new GatheringSystem(world, inv, vitals, () => {});
    let spot: [number, number] | null = null;
    let x = 0;
    for (; x < 40000 && !spot; x += 64) {
      world.update(view(x, 0));
      spot = findDeco(world, [Deco.Chest]);
    }
    const [gx, gy] = spot!;
    const chest = world.chestAt(gx, gy)!;
    gathering.begin(interactionAt(world, inv, vitals, gx, gy)!);
    expect(inv.slots.some(Boolean)).toBe(true);
    expect(world.tileAt(gx, gy)!.deco).toBe(Deco.ChestOpen);
    expect(interactionAt(world, inv, vitals, gx, gy)!.kind).toBe('empty-chest');

    const anchor = chest.object.anchor;
    expect(world.lootedAnchors.has(anchor)).toBe(true);
    world.update(view(x + 30000, 0));
    world.update(view(x - 64, 0));
    for (const o of world.objects.objects.values()) {
      if (o.anchor === anchor) expect(o.emptyChests).toBe(true);
    }
  });

  it('remembers looted anchors and opened chests in the save', () => {
    const world = new WorldManager(1234, new SyncGenerator());
    world.lootedAnchors.add('3,4/structure');
    const inv = new Inventory();
    inv.add(Items.berries, 5);
    const data = snapshot(world, { x: 0, y: 0, inventory: inv.save(), vitals: new Vitals().save(), progression: null });
    const fresh = new WorldManager(1234, new SyncGenerator());
    restore(fresh, data);
    expect(fresh.lootedAnchors.has('3,4/structure')).toBe(true);
    const back = new Inventory();
    back.load(data.player.inventory);
    expect(back.count(Items.berries)).toBe(5);
  });
});
