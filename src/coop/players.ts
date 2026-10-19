// The other players in a shared overworld, as this machine draws them: where
// each last said they were (outdoors, in which room, or behind a rift), and
// their movement, smoothed a tenth of a second in the past. Only those in the
// same place as this player are drawn.

import type { RemotePlayer } from '../rendering/EntityRenderer';
import type { OtherBody } from '../systems/CombatSystem';
import { readPlayerState, toHex, type Member, type PlayerState, type Reader } from '../net';
import { MoveGuard } from './guard';
import { itemAt, PlayerFlag } from './ids';
import { TickClock, Track } from './interp';
import { Place } from './worldWire';

/** Where a player is: outdoors, in a room (by the host's object id, building
 *  and floor), or behind a rift. */
export interface Whereabouts {
  place: number;
  object: number;
  index: number;
  floor: number;
  /** The state tick it changed at (see `WhereMsg`). */
  tick: number;
}

export const sameWhere = (a: Whereabouts, b: Whereabouts): boolean =>
  a.place === b.place && (a.place !== Place.Indoors || (a.object === b.object && a.index === b.index && a.floor === b.floor));

export interface Remote {
  slot: number;
  key: string;
  view: RemotePlayer;
  track: Track;
  clock: TickClock;
  /** Their feet as last reported, in their place's own coordinates. */
  x: number;
  y: number;
  heard: boolean;
  where: Whereabouts;
  /** Outdoors: their feet in the world, for creatures to hunt (a host's). */
  body: OtherBody;
  /** Where they last stood outdoors (to wake beside them when they are not). */
  outX: number;
  outY: number;
  wasOut: boolean;
  /** States older than this tick are from before their last change of place. */
  sinceTick: number;
  /** Host: where they may truly be (see `MoveGuard`). */
  readonly move: MoveGuard;
}

export class Players {
  readonly bySlot = new Map<number, Remote>();
  /** The same, walked every frame. */
  readonly list: Remote[] = [];
  /** Those drawn where this player is now; rebuilt each frame in place. */
  readonly drawn: RemotePlayer[] = [];
  private readonly heard: PlayerState;

  constructor(heard: PlayerState) {
    this.heard = heard;
  }

  add(m: Member, me: number): Remote | null {
    if (m.slot === me) return null;
    const key = toHex(m.key);
    let rm = this.bySlot.get(m.slot);
    if (rm && rm.key !== key) {
      this.remove(m.slot);
      rm = undefined;
    }
    if (!rm) {
      const view: RemotePlayer = { slot: m.slot, name: m.name, x: 0, y: 0, facing: 0, frame: 0, holding: -1, hurt: 0 };
      rm = {
        slot: m.slot,
        key,
        view,
        track: new Track(),
        clock: new TickClock(),
        x: 0,
        y: 0,
        heard: false,
        where: { place: Place.Outdoors, object: 0, index: 0, floor: 0, tick: 0 },
        body: { slot: m.slot, x: 0, y: 0 },
        outX: 0,
        outY: 0,
        wasOut: false,
        sinceTick: 0,
        move: new MoveGuard(),
      };
      this.bySlot.set(m.slot, rm);
      this.list.push(rm);
    }
    rm.view.name = m.name;
    return rm;
  }

  remove(slot: number): Remote | undefined {
    const rm = this.bySlot.get(slot);
    if (!rm) return undefined;
    this.bySlot.delete(slot);
    this.list.splice(this.list.indexOf(rm), 1);
    return rm;
  }

  /** Their link dropped: they vanish until heard from again. */
  away(slot: number): void {
    const rm = this.bySlot.get(slot);
    if (!rm) return;
    rm.heard = false;
    rm.track.restart();
  }

  /** A player's state message; the player it came from, or null. `guard`
   *  (on a host) is asked whether an outdoor position can be true; if not,
   *  they are still drawn there, but creatures and reach go by the last true one. */
  hear(r: Reader, data: Uint8Array, now: number, guard?: (rm: Remote, x: number, y: number) => boolean): Remote | null {
    const s = this.heard;
    if (!readPlayerState(r, data, s) || !Number.isFinite(s.x) || !Number.isFinite(s.y)) return null;
    const rm = this.bySlot.get(s.slot);
    // From before they last changed place: their coordinates mean another place.
    if (!rm || s.tick < rm.sinceTick) return null;
    rm.heard = true;
    rm.clock.observe(s.tick, now);
    rm.track.push(s.tick, s.x, s.y);
    rm.x = s.x;
    rm.y = s.y;
    const v = rm.view;
    v.facing = s.facing & 3;
    v.frame = s.flags & PlayerFlag.Moving ? s.anim & 3 : 0;
    v.holding = s.holding > 0 && itemAt(s.holding - 1) ? s.holding - 1 : -1;
    if (s.flags & PlayerFlag.Hurt && v.hurt <= 0) v.hurt = 0.4;
    if (rm.where.place === Place.Outdoors && (!guard || guard(rm, s.x, s.y))) {
      rm.body.x = rm.outX = s.x;
      rm.body.y = rm.outY = s.y;
      rm.wasOut = true;
    }
    return rm;
  }

  /** Moves everyone to where they should be drawn, and lists those here. */
  update(dt: number, now: number, mine: Whereabouts): void {
    const drawn = this.drawn;
    drawn.length = 0;
    for (const rm of this.list) {
      if (!rm.heard) continue;
      rm.track.sample(rm.clock.at(now));
      rm.view.x = rm.track.x;
      rm.view.y = rm.track.y;
      if (rm.view.hurt > 0) rm.view.hurt = Math.max(0, rm.view.hurt - dt);
      if (sameWhere(rm.where, mine)) drawn.push(rm.view);
    }
  }

  /** A player moved between places: their old positions mean nothing here. */
  moved(rm: Remote, w: Whereabouts): void {
    if (w.tick > rm.sinceTick) rm.sinceTick = w.tick;
    if (sameWhere(rm.where, w)) return;
    rm.where.place = w.place;
    rm.where.object = w.object;
    rm.where.index = w.index;
    rm.where.floor = w.floor;
    rm.where.tick = w.tick;
    rm.track.restart();
    rm.move.reset();
  }
}
