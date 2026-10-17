import { describe, expect, it } from 'vitest';
import { Npc } from './NPC';

const ctx = (hour: number) => ({ hour, playerX: 0, playerY: 0, isSolid: () => false, random: () => 0.5 });

describe('npcs at night', () => {
  it('villagers go in through their door', () => {
    const n = new Npc('villager', 'Ivy', 'villager-a', 10.5, 10.9, 10, 10, 10, 9);
    for (let t = 0; t < 200 && !n.hidden; t++) n.update(0.1, ctx(23));
    expect(n.hidden).toBe(true);
    n.update(0.1, ctx(8));
    expect(n.hidden).toBe(false);
  });

  it('homebodies stay in, day and night', () => {
    const n = new Npc('villager', 'Wren', 'villager-b', 10.5, 10.9, 10, 9);
    n.homebody = n.hidden = true;
    for (const hour of [8, 13, 23]) {
      for (let t = 0; t < 50; t++) n.update(0.1, ctx(hour));
      expect(n.hidden).toBe(true);
    }
  });
});
