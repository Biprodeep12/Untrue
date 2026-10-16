import { describe, expect, it } from 'vitest';
import { CHUNK_SIZE } from '../config';
import { Enemy, type EnemyContext } from '../entities/Enemy';
import { SPECIES } from '../entities/Species';
import { SAFE_RADIUS } from '../generation/EnemyGenerator';
import { Items } from '../items/Items';
import { SyncGenerator } from '../world/SyncGenerator';
import { WorldManager } from '../world/WorldManager';
import { CombatSystem, incomingDamage, playerHitDamage, type PlayerBody } from './CombatSystem';
import { Inventory } from './InventorySystem';
import { Progression } from './Progression';
import { Vitals } from './Vitals';

function view(px: number, py: number) {
  return { minX: px - 15, minY: py - 9, maxX: px + 15, maxY: py + 9, playerX: px, playerY: py, dirX: 0, dirY: 0 };
}

function body(x: number, y: number, over: Partial<PlayerBody> = {}): PlayerBody {
  return { x, y, faceX: 1, faceY: 0, blocking: false, invulnerable: false, ...over };
}

/** An open field with the player at the origin. */
function field(over: Partial<EnemyContext> = {}): EnemyContext & { hits: number; shots: number } {
  const ctx = {
    playerX: 0,
    playerY: 0,
    hits: 0,
    shots: 0,
    isSolid: () => false,
    alert: () => {},
    hitPlayer: () => ctx.hits++,
    shoot: () => ctx.shots++,
    random: () => 0.5,
    ...over,
  };
  return ctx;
}

function setup(seed = 1234) {
  const world = new WorldManager(seed, new SyncGenerator());
  const inv = new Inventory();
  const vitals = new Vitals();
  const progression = new Progression();
  const notes: string[] = [];
  const combat = new CombatSystem(world, inv, vitals, progression, {
    damage: () => {},
    swing: () => {},
    playerHurt: () => {},
    notify: (t) => notes.push(t),
  });
  return { world, inv, vitals, progression, combat, notes };
}

describe('damage', () => {
  it('doubles on a crit, and armor and blocking soak it up', () => {
    expect(playerHitDamage(10, 1, true)).toBe(20);
    expect(playerHitDamage(10, 1.5, false)).toBe(15);
    expect(incomingDamage(20, 0.35, false)).toBe(13);
    expect(incomingDamage(20, 0, true)).toBe(6);
    expect(incomingDamage(1, 0.9, true)).toBe(1);
  });

  it('scales enemies with distance and for elites', () => {
    const near = new Enemy(SPECIES.wolf, 0, 0, 0, false);
    const far = new Enemy(SPECIES.wolf, 0, 0, 3, false);
    const elite = new Enemy(SPECIES.wolf, 0, 0, 0, true);
    expect(far.maxHp).toBeGreaterThan(near.maxHp);
    expect(far.damage).toBeGreaterThan(near.damage);
    expect(elite.maxHp).toBe(Math.round(near.maxHp * 2.5));
    expect(elite.xp).toBeGreaterThan(near.xp);
  });
});

describe('enemy AI', () => {
  it('notices, chases and attacks', () => {
    const e = new Enemy(SPECIES.bear, 4, 0, 0, false);
    const ctx = field();
    e.update(0.1, ctx);
    expect(e.state).toBe('aggro');
    for (let t = 0; t < 40 && ctx.hits === 0; t++) e.update(0.1, ctx);
    expect(e.x).toBeLessThan(2);
    expect(ctx.hits).toBe(1);
  });

  it('flees when badly hurt, and ambushers wait underground', () => {
    const wolf = new Enemy(SPECIES.wolf, 3, 0, 0, false);
    wolf.takeHit(wolf.maxHp * 0.9);
    expect(wolf.state).toBe('flee');

    const lurker = new Enemy(SPECIES.lurker, 5, 0, 0, false);
    lurker.update(0.1, field());
    expect(lurker.state).toBe('burrowed');
    lurker.update(0.1, field({ playerX: 3 }));
    expect(lurker.state).toBe('aggro');
  });

  it('keeps its distance and shoots when ranged', () => {
    const spider = new Enemy(SPECIES.spider, 4, 0, 0, false);
    const ctx = field();
    for (let t = 0; t < 30 && ctx.shots === 0; t++) spider.update(0.1, ctx);
    expect(ctx.shots).toBe(1);
  });
});

describe('combat system', () => {
  it('spawns no enemies in the safe zone, only wildlife, and biome enemies outside it', () => {
    const { world, combat } = setup();
    world.update(view(10, 10));
    for (let t = 0; t < 20; t++) combat.update(0.5, body(10, 10));
    expect(combat.enemies.filter((e) => !e.species.passive)).toHaveLength(0);
    expect(combat.enemies.length).toBeGreaterThan(0);

    const x = SAFE_RADIUS + 3000;
    world.update(view(x, 0));
    combat.enemies.length = 0;
    for (let t = 0; t < 20 && !combat.enemies.some((e) => !e.species.passive); t++) combat.update(0.5, body(x, 0));
    expect(combat.enemies.some((e) => !e.species.passive)).toBe(true);
    for (const e of combat.enemies) {
      const biome = world.biomeAt(Math.floor(e.x), Math.floor(e.y))!.type;
      expect(e.species.biomes).toContain(biome);
    }
  });

  it('has wildlife that flees, or fights back only when hurt', () => {
    const ctx = { playerX: 0, playerY: 0, isSolid: () => false, alert: () => {}, hitPlayer: () => { throw new Error('attacked'); }, shoot: () => {}, random: () => 0.5 };
    const deer = new Enemy(SPECIES.deer, 3, 0, 0, false);
    deer.update(0.1, ctx);
    expect(deer.state).toBe('flee');
    for (let t = 0; t < 10; t++) deer.update(0.1, ctx);
    expect(deer.x).toBeGreaterThan(3);
    const boar = new Enemy(SPECIES.boar, 1, 0, 0, false);
    for (let t = 0; t < 20; t++) boar.update(0.1, ctx);
    expect(boar.state).toBe('patrol');
    boar.takeHit(1);
    expect(boar.state).toBe('aggro');
  });

  it('wears weapons, needs arrows, and pays out on a kill', () => {
    const { world, inv, combat, progression } = setup();
    world.update(view(0, 0));
    inv.add(Items.woodenSword, 1);
    const wolf = new Enemy(SPECIES.wolf, 1, 0, 0, false);
    wolf.hp = 1;
    combat.enemies.push(wolf);
    combat.update(0, body(0, 0));
    expect(combat.attack(1, 0, 0)).toBe(true);
    expect(combat.enemies).toHaveLength(0);
    expect(inv.slots[0]!.durability).toBe(Items.woodenSword.weapon!.durability - 1);
    expect(progression.xp).toBeGreaterThan(0);
    expect(inv.count(Items.rawMeat)).toBeGreaterThan(0);

    inv.add(Items.bow, 1);
    const bowSlot = inv.slots.findIndex((s) => s?.item === Items.bow);
    combat.update(1, body(0, 0));
    expect(combat.attack(1, 0, bowSlot)).toBe(false);
    inv.add(Items.arrow, 2);
    combat.update(1, body(0, 0));
    expect(combat.attack(1, 0, bowSlot)).toBe(true);
    expect(inv.count(Items.arrow)).toBe(1);
    expect(combat.projectiles).toHaveLength(1);
  });

  it('lands one hit per frame on the player', () => {
    const { world, vitals, combat } = setup();
    world.update(view(0, 0));
    for (let k = 0; k < 3; k++) combat.projectiles.push({ x: 0, y: -0.4, vx: 0, vy: 0, kind: 'arrow', damage: 10, fromPlayer: false, ttl: 1 });
    combat.update(0.01, body(0, 0));
    expect(vitals.health).toBe(90);
  });

  it('wakes dungeon guards once, and a cleared dungeon stays cleared', () => {
    const { world, combat } = setup();
    let dungeon;
    for (let x = 0; x < 40000 && !dungeon; x += CHUNK_SIZE) {
      world.update(view(x, 0));
      dungeon = [...world.objects.objects.values()].find((o) => o.kind === 'dungeon');
    }
    expect(dungeon).toBeDefined();
    const d = dungeon!;
    // Load its chunks, then stand on an open tile inside it.
    world.update(view(d.x + d.w / 2, d.y + d.h / 2));
    let inside: [number, number] = [0, 0];
    for (let i = 0; i < d.w * d.h; i++) {
      const gx = d.x + (i % d.w);
      const gy = d.y + Math.floor(i / d.w);
      if (!world.isSolidAt(gx, gy)) inside = [gx + 0.5, gy + 0.9];
    }
    world.update(view(inside[0], inside[1]));
    combat.update(0.1, body(...inside, { invulnerable: true }));
    const guards = combat.enemies.filter((e) => e.tag === d.id);
    expect(guards.length).toBeGreaterThanOrEqual(3);

    for (const g of guards) {
      g.hp = 1;
      const me = body(g.x - 0.8, g.y, { invulnerable: true });
      combat.update(1, me);
      combat.attack(g.x - me.x, g.y - me.y, null);
    }
    expect(world.clearedAnchors.has(d.anchor)).toBe(true);
    combat.update(1, body(...inside, { invulnerable: true }));
    expect(combat.enemies.filter((e) => e.tag === d.id)).toHaveLength(0);
  });
});

describe('progression', () => {
  it('levels up and raises max health', () => {
    const p = new Progression();
    expect(p.add(Progression.needed(1) + 5)).toBe(1);
    expect(p.level).toBe(2);
    expect(p.xp).toBe(5);
    expect(p.maxHealth).toBeGreaterThan(100);
  });
});
