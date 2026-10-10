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

  it('story characters with no house stay out', () => {
    const n = new Npc('villager', 'Elder Maren', 'merchant', 10.5, 10.9, 10.5, 10.9);
    n.stayOut = true;
    for (let t = 0; t < 200; t++) n.update(0.1, ctx(23));
    expect(n.hidden).toBe(false);
  });
});
