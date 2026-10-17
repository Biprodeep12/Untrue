// Populates villages inside the simulation radius and runs every NPC.
// Villagers are temporary: they come and go with their village.

import { chunkKey, inRect, tileToChunk } from '../coords';
import { Npc, type NpcRole } from '../entities/NPC';
import { hashString, Rng } from '../generation/Random';
import { Deco, Tile } from '../generation/Tiles';
import type { WorldManager } from '../world/WorldManager';
import type { WorldObject } from '../world/WorldObject';

const NAMES = [
  'Abigail', 'Bram', 'Cora', 'Dillon', 'Elsie', 'Finn', 'Greta', 'Hollis', 'Ivy', 'Jasper', 'Keira', 'Linus',
  'Mabel', 'Nico', 'Odette', 'Pip', 'Quinn', 'Rosa', 'Silas', 'Tamsin', 'Ulric', 'Vera', 'Wren', 'Yara',
];
const VILLAGER_OUTFITS = ['villager-a', 'villager-b', 'villager-c', 'villager-d', 'villager-e', 'villager-f'];
/** Lone buildings someone may live in. */
const LONE_HOMES = new Set(['house', 'cabin']);
/** Chance a lone house or cabin is lived in. */
const LIVED_IN = 0.5;

export function randomName(rng: Rng): string {
  return rng.pick(NAMES);
}

export class NpcSystem {
  readonly npcs: Npc[] = [];
  private readonly populated = new Set<string>();
  private readonly rng: Rng;

  constructor(private readonly world: WorldManager) {
    this.rng = new Rng(world.seed ^ 0x9c5);
  }

  add(npc: Npc): void {
    this.npcs.push(npc);
  }

  remove(npc: Npc): void {
    const i = this.npcs.indexOf(npc);
    if (i >= 0) this.npcs.splice(i, 1);
  }

  /** The nearest NPC the player can talk to. */
  near(x: number, y: number, radius: number): Npc | undefined {
    let best: Npc | undefined;
    let bestD = radius;
    for (const n of this.npcs) {
      const d = Math.hypot(n.x - x, n.y - y);
      if (!n.hidden && d < bestD) {
        best = n;
        bestD = d;
      }
    }
    return best;
  }

  update(dt: number, hour: number, playerX: number, playerY: number, now: number): void {
    const sim = this.world.chunks.simRect;
    if (!sim) return;
    // Villages entering the simulation radius get their people.
    for (let cy = sim.y0; cy <= sim.y1; cy++) {
      for (let cx = sim.x0; cx <= sim.x1; cx++) {
        for (const o of this.world.objects.inChunk(chunkKey(cx, cy))) {
          if ((o.kind === 'village' || o.kind === 'nomad-camp' || LONE_HOMES.has(o.kind)) && !this.populated.has(o.id)) this.populate(o);
        }
      }
    }
    // People leave with their village; merchants leave when their time is up.
    for (let i = this.npcs.length - 1; i >= 0; i--) {
      const n = this.npcs[i];
      if (n.following || n.role === 'lost') continue;
      const gone = !inRect(sim, tileToChunk(n.homeX), tileToChunk(n.homeY)) || now >= n.leaveAt;
      if (!gone) continue;
      this.npcs.splice(i, 1);
      if (n.village && !this.npcs.some((m) => m.village === n.village)) this.populated.delete(n.village);
    }
    const ctx = {
      hour,
      playerX,
      playerY,
      isSolid: (gx: number, gy: number) => this.world.isSolidAt(gx, gy),
      random: () => this.rng.next(),
    };
    for (const n of this.npcs) n.update(dt, ctx);
  }

  /** Three villagers, one of them handing out quests, a trader by the well,
   *  and someone at home in every house. A lone house or cabin is lived in
   *  half the time. */
  private populate(village: WorldObject): void {
    this.populated.add(village.id);
    const rng = new Rng(hashString(village.id));
    const paths: Array<[number, number]> = [];
    const doors: Array<[number, number]> = [];
    let well: [number, number] = [village.x + village.w / 2, village.y + village.h / 2];
    for (let i = 0; i < village.w * village.h; i++) {
      const gx = village.x + (i % village.w);
      const gy = village.y + Math.floor(i / village.w);
      const t = village.layout.tiles[i] - 1;
      if (t === Tile.Path) paths.push([gx, gy]);
      if (village.layout.decos[i] === Deco.Well) well = [gx, gy];
    }
    for (const b of village.layout.buildings) doors.push([village.x + b.x + b.door, village.y + b.y + b.h - 1]);
    const used = new Set<string>();
    const name = () => {
      let n = randomName(rng);
      for (let k = 0; used.has(n) && k < 10; k++) n = randomName(rng);
      used.add(n);
      return n;
    };
    // Someone who stays in, met inside behind their door.
    const resident = (door: [number, number]) => {
      const npc = new Npc('villager', name(), rng.pick(VILLAGER_OUTFITS), door[0] + 0.5, door[1] + 1.9, door[0], door[1]);
      npc.village = village.id;
      npc.homebody = npc.hidden = true;
      this.npcs.push(npc);
    };
    if (LONE_HOMES.has(village.kind)) {
      if (doors.length && rng.chance(LIVED_IN)) resident(doors[0]);
      return;
    }
    if (!paths.length) return;
    const make = (role: NpcRole, outfit: string, home: [number, number]) => {
      const n = name();
      const [sx, sy] = rng.pick(paths);
      const door = doors.length ? rng.pick(doors) : home;
      const npc = new Npc(role, n, outfit, sx + 0.5, sy + 0.9, home[0], home[1], door[0], door[1]);
      npc.village = village.id;
      this.npcs.push(npc);
      return npc;
    };
    const centre: [number, number] = [village.x + village.w / 2, village.y + village.h / 2];
    // A nomad camp: one traveller with work, and a trader by the fire.
    if (village.kind === 'nomad-camp') {
      make('villager', rng.pick(VILLAGER_OUTFITS), centre).questGiver = true;
      make('trader', 'trader', [centre[0] + 1.5, centre[1] + 1]);
      return;
    }
    for (let k = 0; k < 3; k++) make('villager', rng.pick(VILLAGER_OUTFITS), centre).questGiver = k === 0;
    make('trader', 'trader', [well[0] + 1.5, well[1] + 2]);
    for (const door of doors) resident(door);
  }
}
