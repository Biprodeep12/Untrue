// Random world events (spec 6.3): meteor crash, bandit attack, monster
// invasion, treasure, rare merchant, an ancient structure rising, a rift
// tearing open, and the Moonwell, which rises only at night and fades at dawn.

import { SAFE_RADIUS } from '../generation/EnemyGenerator';
import type { Rng } from '../generation/Random';
import { Layout, rift } from '../generation/StructureGenerator';
import { BiomeType, Deco, isSolid, Tile } from '../generation/Tiles';
import { WorldObject } from '../world/WorldObject';
import type { WorldManager } from '../world/WorldManager';

export type EventKind = 'meteor' | 'bandits' | 'invasion' | 'treasure' | 'merchant' | 'ancient' | 'moonwell' | 'rift';

/** Structures that exist only at night: gone at dawn. */
export const NIGHT_ONLY = new Set(['moonwell']);

/** Chance each in-game hour that something happens, once off cooldown. */
const HOURLY_CHANCE = 0.22;
const COOLDOWN_HOURS = 3;
const DIRECTIONS = ['east', 'south-east', 'south', 'south-west', 'west', 'north-west', 'north', 'north-east'];

export interface EventContext {
  x: number;
  y: number;
  night: boolean;
  /** The village the player stands in, if any. */
  village: WorldObject | null;
  merchantNearby: boolean;
  now: number;
}

export interface EventHooks {
  notify(text: string): void;
  meteor(x: number, y: number): void;
  bandits(x: number, y: number): void;
  invasion(village: WorldObject): void;
  merchant(x: number, y: number): void;
  waypoint(label: string, x: number, y: number): void;
}

export class WorldEvents {
  private cooldown = COOLDOWN_HOURS;

  constructor(
    private readonly world: WorldManager,
    private readonly rng: Rng,
    private readonly hooks: EventHooks,
  ) {}

  /** Called once per in-game hour; returns the event that fired, if any. */
  onHour(ctx: EventContext): EventKind | null {
    if (!ctx.night) this.dawn();
    if (--this.cooldown > 0 || !this.rng.chance(HOURLY_CHANCE)) return null;
    const wild = Math.hypot(ctx.x, ctx.y) > SAFE_RADIUS;
    const options: Array<[EventKind, number]> = [
      ['meteor', ctx.night ? 2 : 0],
      ['bandits', wild && !ctx.village ? 2 : 0],
      ['invasion', ctx.village ? 3 : 0],
      ['treasure', 2],
      ['merchant', !ctx.night && !ctx.merchantNearby ? 1.5 : 0],
      ['ancient', wild ? 1 : 0],
      ['moonwell', ctx.night ? 1.5 : 0],
      ['rift', wild ? 0.5 : 0],
    ];
    const kind = this.rng.weighted(options, ([, w]) => w)?.[0];
    if (!kind || !this.trigger(kind, ctx)) return null;
    this.cooldown = COOLDOWN_HOURS;
    return kind;
  }

  trigger(kind: EventKind, ctx: EventContext): boolean {
    switch (kind) {
      case 'meteor': {
        const o = this.place(crater(), ctx, 10, 18, 'Meteor Crater');
        if (!o) return false;
        this.hooks.meteor(o.x + o.w / 2, o.y + o.h / 2);
        this.hooks.notify('A meteor streaks across the sky and crashes nearby!');
        return true;
      }
      case 'bandits': {
        const a = this.rng.range(0, Math.PI * 2);
        this.hooks.bandits(ctx.x + Math.cos(a) * 11, ctx.y + Math.sin(a) * 11);
        this.hooks.notify('Bandits! An ambush!');
        return true;
      }
      case 'invasion':
        if (!ctx.village) return false;
        this.hooks.invasion(ctx.village);
        this.hooks.notify(`Monsters are attacking the village! Defend it!`);
        return true;
      case 'treasure': {
        const marker = new Layout(1, 1);
        marker.deco(0, 0, Deco.Treasure);
        const o = this.place(marker, ctx, 18, 32, 'Buried Treasure');
        if (!o) return false;
        const dir = DIRECTIONS[Math.round((Math.atan2(o.y - ctx.y, o.x - ctx.x) / (Math.PI * 2)) * 8 + 8) % 8];
        this.hooks.waypoint('Buried treasure', o.x + 0.5, o.y + 0.5);
        this.hooks.notify(`You found a scrap of a treasure map. X marks a spot to the ${dir}.`);
        return true;
      }
      case 'merchant': {
        const a = this.rng.range(0, Math.PI * 2);
        for (let d = 6; d < 12; d++) {
          const x = ctx.x + Math.cos(a) * d;
          const y = ctx.y + Math.sin(a) * d;
          if (this.world.isSolidAt(Math.floor(x), Math.floor(y))) continue;
          this.hooks.merchant(x, y);
          this.hooks.notify('A travelling merchant has set up shop nearby.');
          return true;
        }
        return false;
      }
      case 'ancient': {
        const o = this.place(obelisk(), ctx, 12, 20, 'Risen Obelisk');
        if (!o) return false;
        this.hooks.notify('The ground shakes… an ancient structure rises nearby!');
        return true;
      }
      case 'rift':
        if (!this.openRift(ctx)) return false;
        this.hooks.notify('A rift tears open nearby.');
        return true;
      case 'moonwell': {
        if (!ctx.night) return false;
        const o = this.place(moonwell(this.rng), ctx, 14, 24, 'Moonwell');
        if (!o) return false;
        this.hooks.waypoint('Moonwell', o.x + o.w / 2, o.y + o.h / 2);
        this.hooks.notify('A pale light rises nearby… a Moonwell, here only until dawn.');
        return true;
      }
    }
  }

  /** Tears a rift open on open ground near the player (also the playground's tool). */
  openRift(ctx: Pick<EventContext, 'x' | 'y' | 'now'>, min = 14, max = 24): WorldObject | null {
    return this.place(rift({ rng: this.rng, palette: 0, biome: BiomeType.Forest }), ctx, min, max, 'Rift');
  }

  /** Night-only structures fade with the morning. */
  private dawn(): void {
    for (const o of [...this.world.objects.objects.values()]) {
      if (!NIGHT_ONLY.has(o.kind)) continue;
      this.world.removeObject(o);
      this.hooks.notify(`The ${o.name} fades with the dawn.`);
    }
  }

  /** Puts a temporary object on open, loaded ground at a distance from the player. */
  private place(layout: Layout, ctx: Pick<EventContext, 'x' | 'y' | 'now'>, min: number, max: number, name: string): WorldObject | null {
    for (let attempt = 0; attempt < 40; attempt++) {
      const a = this.rng.range(0, Math.PI * 2);
      const d = this.rng.range(min, max);
      const x = Math.floor(ctx.x + Math.cos(a) * d - layout.w / 2);
      const y = Math.floor(ctx.y + Math.sin(a) * d - layout.h / 2);
      if (this.world.objects.collides(x, y, layout.w, layout.h, 1)) continue;
      let open = true;
      for (let j = 0; j < layout.h && open; j++) {
        for (let i = 0; i < layout.w && open; i++) {
          // Trees and bushes are fine: the object's ground clears them.
          const t = this.world.tileAt(x + i, y + j);
          open = !!t && !isSolid(t.tile, 0);
        }
      }
      if (!open) continue;
      // Two of a kind within a minute (the playground's rifts) need their own ids.
      let id = `event-${name}@${Math.round(ctx.now)}`;
      while (this.world.objects.objects.has(id)) id += "'";
      const o = new WorldObject(id, name.toLowerCase().replace(/ /g, '-'), name, x, y, layout);
      o.anchor = o.id;
      this.world.addObject(o);
      return o;
    }
    return null;
  }
}

function moonwell(rng: Rng): Layout {
  const l = new Layout(9, 9);
  l.disc(4, 4, 4.3, Tile.StoneFloor);
  l.disc(4, 4, 2.6, Tile.TempleFloor);
  l.clearDecos(0, 0, 9, 9);
  l.deco(4, 4, Deco.Moonwell);
  for (let k = 0; k < 6; k++) {
    const a = (k / 6) * Math.PI * 2 + rng.range(-0.2, 0.2);
    l.deco(Math.round(4 + Math.cos(a) * 3.4), Math.round(4 + Math.sin(a) * 3.4), k % 2 ? Deco.Flowers : Deco.Mushroom);
  }
  return l;
}

function crater(): Layout {
  const l = new Layout(7, 7);
  l.disc(3, 3, 3.2, Tile.Rubble);
  l.disc(3, 3, 1.5, Tile.RockDark);
  l.tile(3, 3, Tile.Rubble);
  l.deco(3, 3, Deco.Meteorite);
  return l;
}

function obelisk(): Layout {
  const l = new Layout(9, 9);
  l.disc(4, 4, 4.2, Tile.StoneFloor);
  l.disc(4, 4, 2.5, Tile.TempleFloor);
  for (const [x, y] of [[1, 1], [7, 1], [1, 7], [7, 7]]) l.deco(x, y, Deco.Pillar);
  l.deco(4, 3, Deco.Statue);
  l.deco(4, 5, Deco.Chest);
  return l;
}
