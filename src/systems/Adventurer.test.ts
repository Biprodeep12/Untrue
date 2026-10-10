import { describe, expect, it } from 'vitest';
import { Rng } from '../generation/Random';
import { Layout } from '../generation/StructureGenerator';
import { Deco } from '../generation/Tiles';
import { Items, weightOf } from '../items/Items';
import { restore, snapshot } from '../save/SaveManager';
import { GroundItems } from '../world/GroundItems';
import { ObjectManager } from '../world/ObjectManager';
import { SyncGenerator } from '../world/SyncGenerator';
import { SEMI_KEEP_MINUTES, WorldManager } from '../world/WorldManager';
import { WorldObject } from '../world/WorldObject';
import { Inventory } from './InventorySystem';
import { MAX_RANK, Progression } from './Progression';
import { WorldEvents, type EventContext } from './WorldEvents';

function view(px: number, py: number) {
  return { minX: px - 15, minY: py - 9, maxX: px + 15, maxY: py + 9, playerX: px, playerY: py, dirX: 0, dirY: 0 };
}

describe('carrying', () => {
  it('weighs what is in the bag', () => {
    const inv = new Inventory();
    inv.add(Items.stone, 10);
    inv.add(Items.ironArmor, 1);
    expect(inv.weight()).toBeCloseTo(10 * weightOf(Items.stone) + weightOf(Items.ironArmor));
    expect(weightOf(Items.coin)).toBeLessThan(weightOf(Items.berries));
  });

  it('drops stacks and picks them up once the player walks back', () => {
    const inv = new Inventory();
    inv.add(Items.woodenSword, 1);
    inv.slots[0]!.durability = 7;
    const ground = new GroundItems();
    ground.drop(inv.takeSlot(0)!, 5, 5);
    expect(inv.count(Items.woodenSword)).toBe(0);
    // Standing on it right after dropping does nothing.
    expect(ground.update(5, 5, inv)).toHaveLength(0);
    ground.update(9, 5, inv);
    expect(ground.update(5, 5.2, inv)).toHaveLength(1);
    expect(inv.slots.find((s) => s?.item === Items.woodenSword)!.durability).toBe(7);
    expect(ground.items).toHaveLength(0);
  });

  it('saves what lies on the ground', () => {
    const world = new WorldManager(5, new SyncGenerator());
    world.ground.drop({ item: Items.herb, count: 4 }, 3.5, 7.5);
    const data = snapshot(world, { x: 0, y: 0, inventory: [], vitals: null, progression: null });
    const fresh = new WorldManager(5, new SyncGenerator());
    restore(fresh, data);
    expect(fresh.ground.items.map((g) => [g.stack.item.id, g.stack.count, g.x, g.y])).toEqual([['herb', 4, 3.5, 7.5]]);
  });
});

describe('skills', () => {
  it('get a point per level and cap at the top rank', () => {
    const p = new Progression();
    expect(p.learn('warrior')).toBe(false);
    p.add(10_000);
    const points = p.skillPoints;
    expect(points).toBe(p.level - 1);
    for (let k = 0; k < MAX_RANK + 1; k++) p.learn('warrior');
    expect(p.rank('warrior')).toBe(MAX_RANK);
    expect(p.skillPoints).toBe(points - MAX_RANK);
    expect(p.damageBonus).toBeGreaterThan(new Progression().damageBonus);
    const copy = new Progression();
    copy.load(p.save());
    expect(copy.rank('warrior')).toBe(MAX_RANK);
  });
});

describe('semi-persistent places', () => {
  const place = (persistence: 'semi-persistent' | 'temporary', discovered: boolean) => {
    const o = new WorldObject(`v-${persistence}-${discovered}`, 'village', 'Village', persistence, 0, 0, new Layout(4, 4));
    o.discovered = discovered;
    return o;
  };

  it('are kept for a while after the player leaves, if discovered', () => {
    let now = 100;
    const objects = new ObjectManager();
    objects.keeps = (o) => o.persistence === 'semi-persistent' && o.discovered;
    objects.clock = () => now;
    const kept = place('semi-persistent', true);
    const unseen = place('semi-persistent', false);
    const temp = place('temporary', true);
    for (const o of [kept, unseen, temp]) objects.add(o, () => true);
    objects.chunkLeft(kept.chunks[0]);
    expect([...objects.objects.keys()]).toEqual([kept.id]);
    expect(kept.idleSince).toBe(100);
    now += SEMI_KEEP_MINUTES - 1;
    objects.sweep(SEMI_KEEP_MINUTES);
    expect(objects.objects.has(kept.id)).toBe(true);
    now += 2;
    objects.sweep(SEMI_KEEP_MINUTES);
    expect(objects.objects.has(kept.id)).toBe(false);
  });
});

describe('the moonwell', () => {
  it('rises only at night and fades at dawn', () => {
    const world = new WorldManager(1234, new SyncGenerator());
    world.update(view(0, 0));
    const notes: string[] = [];
    const events = new WorldEvents(world, new Rng(9), {
      notify: (t) => notes.push(t),
      meteor: () => {},
      bandits: () => {},
      invasion: () => {},
      merchant: () => {},
      waypoint: () => {},
    });
    const ctx: EventContext = { x: 0, y: 0, night: false, village: null, merchantNearby: false, now: 600 };
    expect(events.trigger('moonwell', ctx)).toBe(false);
    expect(events.trigger('moonwell', { ...ctx, night: true })).toBe(true);
    const well = [...world.objects.objects.values()].find((o) => o.kind === 'moonwell')!;
    expect(well.layout.decos).toContain(Deco.Moonwell);
    for (let h = 0; h < 5; h++) events.onHour({ ...ctx, now: 700 + h * 60 });
    expect(world.objects.objects.has(well.id)).toBe(false);
  });
});

describe('equipment', () => {
  it('is worn in its slot, and armour adds up', () => {
    const inv = new Inventory();
    inv.add(Items.ironHelmet, 1);
    inv.add(Items.ironArmor, 1);
    inv.add(Items.leatherBoots, 1);
    expect(inv.armor()).toBe(0);
    for (const item of [Items.ironHelmet, Items.ironArmor, Items.leatherBoots]) inv.equip(inv.slots.findIndex((s) => s?.item === item));
    expect(inv.equipment.head?.item).toBe(Items.ironHelmet);
    expect(inv.equipment.feet?.item).toBe(Items.leatherBoots);
    expect(inv.armor()).toBeCloseTo(0.08 + 0.16 + 0.03);
    // Swapping puts the old piece back in the bag.
    inv.add(Items.leatherCap, 1);
    inv.equip(inv.slots.findIndex((s) => s?.item === Items.leatherCap));
    expect(inv.equipment.head?.item).toBe(Items.leatherCap);
    expect(inv.count(Items.ironHelmet)).toBe(1);
    expect(inv.unequip('feet')).toBe(true);
    expect(inv.equipment.feet).toBeNull();
  });

  it('holds shields and lights in the off hand, and saves', () => {
    const inv = new Inventory();
    inv.add(Items.torch, 3);
    inv.equip(0);
    expect(inv.equipment.offhand?.count).toBe(3);
    expect(inv.count(Items.torch)).toBe(3);
    expect(inv.remove(Items.torch, 1)).toBe(true);
    expect(inv.equipment.offhand?.count).toBe(2);
    inv.add(Items.ironShield, 1);
    inv.equip(inv.slots.findIndex((s) => s?.item === Items.ironShield));
    expect(inv.shield()?.pass).toBeLessThan(0.1);
    const copy = new Inventory();
    copy.load(inv.save());
    copy.loadEquipment(inv.saveEquipment());
    expect(copy.equipment.offhand?.item).toBe(Items.ironShield);
    expect(copy.count(Items.torch)).toBe(2);
  });

  it('puts on armour carried in older saves', () => {
    const inv = new Inventory();
    inv.add(Items.leatherArmor, 1);
    inv.add(Items.ironArmor, 1);
    inv.autoEquip();
    expect(inv.equipment.chest?.item).toBe(Items.ironArmor);
  });
});
