import { describe, expect, it } from 'vitest';
import { RUN_SPEED } from '../config';
import { Items } from '../items/Items';
import { characterSave } from '../save/SaveManager';
import { Allowance, maxBlow, MoveGuard } from './guard';
import { itemId } from './ids';
import { NetChunkGenerator } from './NetChunkGenerator';

describe('what a host believes of a guest', () => {
  it('follows a walk and a run, not a teleport, until the new spot holds', () => {
    const g = new MoveGuard();
    let t = 0;
    expect(g.check(0, 0, t)).toBe(true);
    // Running, 20 times a second.
    for (let i = 1; i <= 40; i++) expect(g.check((i * RUN_SPEED) / 20, 0, (t = i * 50))).toBe(true);
    const x = g.x;
    // Thirty tiles in a twentieth of a second: not believed; they are played where they were.
    expect(g.check(x + 30, 0, (t += 50))).toBe(false);
    expect(g.x).toBe(x);
    // Held there steadily, it is believed after a moment (a stall, a respawn).
    let believed = false;
    for (let i = 0; i < 40 && !believed; i++) believed = g.check(x + 30, 0, (t += 50));
    expect(believed).toBe(true);
    expect(t).toBeGreaterThan(1500);
  });

  it('takes a jump back to a spot held lately (a fall caught) and one the game vouches for', () => {
    const g = new MoveGuard();
    g.check(0, 0, 0);
    for (let i = 1; i <= 20; i++) g.check(i * 0.4, 0, i * 50);
    expect(g.check(0.5, 0, 1100)).toBe(true);
    expect(g.check(80, 80, 1150, (x, y) => x === 80 && y === 80)).toBe(true);
    // Changing place starts afresh: the next report is believed.
    g.reset();
    expect(g.check(-500, 9, 1200)).toBe(true);
    expect(g.check(NaN, 0, 1250)).toBe(false);
  });

  it('caps a blow at what the weapon in hand could strike', () => {
    expect(maxBlow(-1)).toBe(45);
    expect(maxBlow(itemId(Items.ironSword))).toBe(Math.ceil(20 * 9));
    expect(maxBlow(itemId(Items.wood))).toBe(45);
  });

  it('gives a steady allowance', () => {
    const a = new Allowance(2, 3);
    expect([a.take(0), a.take(0), a.take(0), a.take(0)]).toEqual([true, true, true, false]);
    expect(a.take(500)).toBe(true);
    expect(a.take(500)).toBe(false);
  });
});

describe('a guest’s chunk requests', () => {
  it('lets go of requests whose chunk was let go, answering them as cancelled', () => {
    const asked: string[] = [];
    const gen = new NetChunkGenerator((cx, cy) => asked.push(`${cx},${cy}`));
    const results: number[] = [];
    gen.onResult((r) => results.push(r.token));
    gen.request({ token: 1, cx: 0, cy: 0, worldSeed: 0, visit: 0, biomes: [] });
    gen.request({ token: 2, cx: 5, cy: 5, worldSeed: 0, visit: 0, biomes: [] });
    gen.request({ token: 3, cx: 0, cy: 0, worldSeed: 0, visit: 0, biomes: [] });
    expect(gen.pending).toBe(2);
    // The manager still waits only on token 2.
    gen.prune((_cx, _cy, token) => token === 2);
    expect(results.sort()).toEqual([1, 3]);
    expect(gen.pending).toBe(1);
    expect(gen.wants(0, 0)).toBe(false);
    // Asked again later only for what is still wanted.
    gen.later(5, 5, 0);
    gen.update(10_000);
    expect(asked).toEqual(['0,0', '5,5', '5,5']);
  });
});

describe('a visitor’s character save', () => {
  it('keeps quests taken and handed in while visiting', () => {
    const quests = [{ id: 'q1' }] as never;
    const own = characterSave(null, { inventory: [], equipment: {}, vitals: null, progression: null, story: {} as never, quests }, 7);
    expect(own.living?.quests).toEqual(quests);
    const again = characterSave(own, { inventory: [], equipment: {}, vitals: null, progression: null, story: {} as never }, 7);
    expect(again.living?.quests).toEqual(quests);
  });
});
