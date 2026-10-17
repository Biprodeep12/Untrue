import { describe, expect, it } from 'vitest';
import { CHUNK_SIZE } from '../config';
import type { DimEvent } from '../dimension/Challenges';
import { HOLLOW, HOLLOW_REWARDS, RIFT_SHARD } from '../dimension/Hollow';
import { Enemy } from '../entities/Enemy';
import { SPECIES } from '../entities/Species';
import { Rng } from '../generation/Random';
import { RIFT, rift, rollAnchor } from '../generation/StructureGenerator';
import { TerrainFields } from '../generation/TerrainGenerator';
import { BiomeType, Deco, Tile } from '../generation/Tiles';
import { difficultyBand } from '../generation/WorldRules';
import { itemById, Items } from '../items/Items';
import { migrate, restore, snapshot } from '../save/SaveManager';
import { RiftStory } from '../story/RiftStory';
import { CombatSystem } from '../systems/CombatSystem';
import { Inventory } from '../systems/InventorySystem';
import { Progression } from '../systems/Progression';
import { Vitals } from '../systems/Vitals';
import { WorldEvents } from '../systems/WorldEvents';
import { SyncGenerator } from '../world/SyncGenerator';
import { WorldManager } from '../world/WorldManager';
import { riftDoorstep, riftTile, RiftTrip } from './RiftTrip';

function view(px: number, py: number) {
  return { minX: px - 15, minY: py - 9, maxX: px + 15, maxY: py + 9, playerX: px, playerY: py, dirX: 0, dirY: 0 };
}

function setup(seed = 4321) {
  const world = new WorldManager(seed, new SyncGenerator());
  const inv = new Inventory();
  const vitals = new Vitals();
  const notes: string[] = [];
  const combat = new CombatSystem(world, inv, vitals, new Progression(), {
    damage: () => {},
    swing: () => {},
    playerHurt: () => {},
    notify: (t) => notes.push(t),
  });
  const events = new WorldEvents(world, new Rng(5), { notify: () => {}, meteor: () => {}, bandits: () => {}, invasion: () => {}, merchant: () => {}, waypoint: () => {} });
  return { world, inv, vitals, combat, events, notes };
}

/** A world with a rift torn open near (x, y). */
function withRift(x = 300, y = 300) {
  const s = setup();
  s.world.update(view(x, y));
  const o = s.events.openRift({ x, y, now: 60 }, 6, 12)!;
  expect(o).toBeTruthy();
  return { ...s, rift: o };
}

/** A trip into the rift; `seen` collects every event the game is told of. */
function tripInto(s: ReturnType<typeof withRift>) {
  const seen: DimEvent[] = [];
  const trip = new RiftTrip(HOLLOW, 99, s.rift, riftDoorstep(s.rift), 0, s.combat, {
    event: (e) => {
      seen.push(e);
      if (e.type === 'closed') s.world.closeRift(s.rift);
    },
    drop: (stack) => s.world.ground.drop(stack, trip.outside.x, trip.outside.y),
  });
  return { trip, seen };
}

const body = (x: number, y: number) => ({ x, y, faceX: 1, faceY: 0, blocking: false, invulnerable: false });

describe('rift structures', () => {
  it('are a small patch of scorched ground with the tear in the middle', () => {
    const l = rift({ rng: new Rng(3), palette: 0, biome: BiomeType.Forest });
    expect(l.decos[3 * l.w + 3]).toBe(Deco.Rift);
    expect(l.tileAt(3, 4)).toBe(Tile.RiftGround);
    expect(l.w * l.h).toBeLessThanOrEqual(64);
  });

  it('roll the same for the same seed, never near home, and more often far out', () => {
    const seed = 77;
    const fields = new TerrainFields(seed);
    const roll = (cx: number, cy: number, visit = 0) =>
      rollAnchor({ worldSeed: seed, cx, cy, visit, biome: BiomeType.Forest, palette: 0, fields }).filter((p) => p.def.kind === 'rift');
    const count = (x0: number, y0: number) => {
      let n = 0;
      for (let cy = 0; cy < 24; cy++) for (let cx = 0; cx < 24; cx++) n += roll(x0 + cx, y0 + cy).length;
      return n;
    };
    // Home: within the minimum distance of the origin.
    for (let cy = -2; cy <= 2; cy++) for (let cx = -2; cx <= 2; cx++) if (Math.hypot(cx * CHUNK_SIZE + 16, cy * CHUNK_SIZE + 16) < RIFT.minDistance) expect(roll(cx, cy)).toEqual([]);
    const near = count(4, 4);
    const far = count(400, 0);
    expect(difficultyBand(400 * CHUNK_SIZE, 0)).toBe(3);
    expect(far).toBeGreaterThan(near);
    // Deterministic, with the tear on the layout; another visit rolls anew.
    let found = null;
    for (let cx = 400; cx < 424 && !found; cx++) for (let cy = 0; cy < 24 && !found; cy++) found = roll(cx, cy)[0] ? { cx, cy, p: roll(cx, cy)[0] } : null;
    expect(found).toBeTruthy();
    const again = roll(found!.cx, found!.cy)[0];
    expect(again.id).toBe(found!.p.id);
    expect([again.x, again.y]).toEqual([found!.p.x, found!.p.y]);
    expect(again.layout.decos).toContain(Deco.Rift);
    expect(roll(found!.cx, found!.cy, 1)[0]?.id).not.toBe(found!.p.id);
  });

  it('stay closed while their object lives, and show a scar', () => {
    const s = withRift();
    const t = riftTile(s.rift);
    expect(s.world.tileAt(t.x, t.y)?.deco).toBe(Deco.Rift);
    expect(s.world.isSolidAt(t.x, t.y)).toBe(true);
    expect(s.world.nearestRift(300, 300)).toBe(s.rift);
    s.world.closeRift(s.rift);
    expect(s.world.tileAt(t.x, t.y)?.deco).toBe(Deco.RiftScar);
    expect(s.world.isSolidAt(t.x, t.y)).toBe(false);
    expect(s.world.clearedAnchors.has(s.rift.id)).toBe(true);
    expect(s.world.nearestRift(300, 300)).toBeNull();
  });
});

describe('trips into a rift', () => {
  it('stash the overworld, fight on the dimension, and put everything back', () => {
    const s = withRift();
    const wolf = new Enemy(SPECIES.wolf, 305, 305, 0, false);
    s.combat.add(wolf);
    s.combat.projectiles.push({ x: 0, y: 0, vx: 1, vy: 0, kind: 'arrow', damage: 1, fromPlayer: true, ttl: 1 });
    const { trip, seen } = tripInto(s);
    trip.begin();
    expect(s.combat.arena).toBe(trip);
    expect(s.combat.enemies).toEqual([]);
    expect(s.combat.projectiles).toEqual([]);

    // Walking into the combat chamber wakes its first wave.
    const room = trip.run.layout.chambers[1];
    trip.run.skipTo(1);
    for (let k = 0; k < 3; k++) trip.update(1 / 60, room.center.x, room.center.y);
    const spawns = seen.filter((e) => e.type === 'spawn');
    expect(spawns.length).toBeGreaterThan(0);
    expect(s.combat.enemies.length).toBe(spawns.length);
    // Nothing of the overworld spawns or despawns while away.
    for (let k = 0; k < 200; k++) s.combat.update(1 / 60, body(room.center.x, room.center.y));
    expect(s.combat.enemies.every((e) => e.species === SPECIES.glitchling || e.species === SPECIES.shardWisp)).toBe(true);
    expect(s.combat.enemies).not.toContain(wolf);
    // The void blocks walkers.
    expect(trip.blocksEnemies(-1, -1)).toBe(true);
    // An overworld ambush while away waits in the overworld.
    s.combat.spawnGroup(SPECIES.bandit, 305, 305, 2);
    expect(s.combat.enemies.some((e) => e.species === SPECIES.bandit)).toBe(false);

    trip.end();
    expect(s.combat.arena).toBe(s.combat.overworld);
    expect(s.combat.enemies).toContain(wolf);
    expect(s.combat.enemies.filter((e) => e.species === SPECIES.bandit).length).toBeGreaterThan(0);
    expect(s.combat.enemies.some((e) => e.species === SPECIES.glitchling)).toBe(false);
    // Once ended, later events are ignored.
    trip.update(1 / 60, room.center.x, room.center.y);
    expect(s.combat.enemies.some((e) => e.species === SPECIES.glitchling)).toBe(false);
  });

  it('report kills to the run, and boss phases scale the boss, not its species', () => {
    const s = withRift();
    const { trip, seen } = tripInto(s);
    trip.begin();
    const boss = trip.run.layout.chambers.findIndex((c) => c.kind === 'boss');
    trip.run.skipTo(boss);
    const c = trip.run.layout.chambers[boss].center;
    trip.update(1 / 60, c.x, c.y + 3);
    const warden = s.combat.enemies.find((e) => e.species === SPECIES.riftWarden)!;
    expect(warden).toBeTruthy();
    warden.hp = Math.floor(warden.maxHp * 0.2);
    for (let k = 0; k < 3; k++) trip.update(1 / 60, c.x, c.y + 3);
    expect(seen.some((e) => e.type === 'bossPhase')).toBe(true);
    expect(warden.speedScale).toBeGreaterThan(1);
    expect(SPECIES.riftWarden.speed).toBe(2.8);
    // The player's blows finish it: the run hears of it, and the portal opens.
    warden.hp = 1;
    s.combat.update(1 / 60, { ...body(warden.x - 0.8, warden.y), faceX: 1, faceY: 0 });
    expect(s.combat.attack(1, 0, null)).toBe(true);
    expect(s.combat.enemies).not.toContain(warden);
    trip.update(1 / 60, c.x, c.y + 3);
    expect(trip.portalOpen).toBe(true);
  });

  it('close the rift through the portal, after the vault pays out', () => {
    const s = withRift();
    const { trip, seen } = tripInto(s);
    trip.begin();
    const vault = trip.run.layout.chambers.length - 1;
    trip.run.skipTo(vault);
    const w = trip.run.layout.w;
    const p = trip.run.layout.portal;
    trip.update(1 / 60, (p % w) + 0.5, Math.floor(p / w) + 0.9);
    const reward = seen.find((e) => e.type === 'reward');
    expect(reward).toBeTruthy();
    expect(seen.some((e) => e.type === 'closed')).toBe(true);
    expect(s.rift.closed).toBe(true);
    // Every reward is a real item.
    for (const r of HOLLOW_REWARDS) expect(itemById(r.item), r.item).toBeTruthy();
    expect(Items.riftShard.name).toBe(RIFT_SHARD.name);
  });

  it('save the spot outside the rift, so a reload starts there', () => {
    const s = withRift();
    const { trip } = tripInto(s);
    trip.begin();
    const data = snapshot(s.world, { x: trip.spot.x, y: trip.spot.y, inventory: [], vitals: null, progression: null });
    const loaded = migrate(JSON.parse(JSON.stringify(data)))!;
    expect(loaded.player.x).toBe(riftDoorstep(s.rift).x);
    expect(loaded.player.y).toBe(riftDoorstep(s.rift).y);
    // Nothing of the run is kept: the reload starts outside, from scratch.
    expect(JSON.stringify(loaded)).not.toContain('hollow');
    const fresh = new WorldManager(loaded.seed, new SyncGenerator());
    restore(fresh, loaded);
    expect(fresh.clearedAnchors.has(s.rift.id)).toBe(false);
  });
});

describe('dying behind a rift', () => {
  it('loses the bag and the hotbar, but keeps what is worn', () => {
    const inv = new Inventory();
    inv.add(Items.ironHelmet, 1);
    inv.equip(inv.slots.findIndex((x) => x?.item === Items.ironHelmet));
    inv.add(Items.ironSword, 1);
    inv.add(Items.wood, 30);
    inv.add(Items.coin, 120);
    expect(inv.clearCarried()).toBe(151);
    expect(inv.slots.every((x) => x === null)).toBe(true);
    expect(inv.equipment.head?.item).toBe(Items.ironHelmet);
  });
});

describe('the rift story', () => {
  it('leads from finding a rift to closing it, then counts the rifts closed', () => {
    const shown: string[] = [];
    const story = new RiftStory((v) => shown.push(v.title));
    const at = { x: 0, y: 0 };
    expect(story.objective(at, null, null)).toEqual({ text: 'Find a rift', angle: null });
    expect(story.objective(at, { x: 100, y: 0 }, null)).toEqual({ text: 'Find a rift', angle: 0 });
    expect(story.objective(at, { x: 0, y: 5 }, null).text).toBe('Enter the rift');
    const run = { name: 'The Hollow', chambersDone: 1, chambers: 4, portalOpen: false };
    story.onEnter();
    expect(story.objective(at, null, run).text).toBe('Survive The Hollow: 1/4 chambers');
    expect(story.objective(at, null, { ...run, chambersDone: 4, portalOpen: true }).text).toBe('Close the rift: step through the portal');
    story.onClosed();
    expect(shown.length).toBe(1);
    story.onClosed();
    expect(shown.length).toBe(1);
    expect(story.objective(at, { x: 0, y: 5 }, null).text).toBe('Rifts closed: 2');

    const again = new RiftStory(() => {});
    again.load(JSON.parse(JSON.stringify(story.save())));
    expect([again.closed, again.entered]).toEqual([2, true]);
    // Saves from before the rifts start at the beginning, without the intro.
    const old = new RiftStory((v) => shown.push(v.title));
    old.load(undefined);
    expect(old.objective(at, null, null).text).toBe('Find a rift');
    expect(shown.length).toBe(1);
  });
});
