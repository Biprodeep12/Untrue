// What happens inside a dimension, without any rendering: a state machine per
// challenge site, and `DimensionRun`, which keeps them, seals and opens their
// gates, sends the player back to safe ground when the ground goes from under
// them (nobody falls into the void: it is a wall), and reports everything as
// events for the game to act on (spawning enemies, moving the player,
// granting rewards).
//
// The sites stand in an open land and can be done in any order, except the
// boss: its gate stays sealed until every other trial is done. Its fall wakes
// the portal home.
//
// A run is one instance of its dimension, ready to hold several players (a
// host feeds it each guest's position and hits by player id; alone, the
// player is `LOCAL`). Who broke the trials and who hurt the Warden is tallied
// (`Contribution`), and settled when it falls: each player's share of the
// vault and of the rift's experience, and whether the portal answers them. A
// shared instance brings the Warden back a while after it falls, and starts
// over once everyone has left (`restart`).
//
// Per frame the game calls `update(dt, px, py)` with the player's feet, then
// drains `takeEvents()`. It tells the run when one of the enemies it asked for
// dies (`enemyKilled`) and, for the boss, its health (`enemyHealth`). Nothing
// here allocates per frame; events are only made when something changes.
//
// In an instance shared over the network one machine runs the run (the host:
// `authority`) and every challenge sees every player's feet; the others hold
// a mirror of it (`applyShared`), kept only for what is their own: slips,
// checkpoints, the map, the portal. A guest's mirror becomes the run
// (`becomeAuthority`) when its host leaves.

import type { Species } from '../entities/Species';
import { hash, Rng } from '../generation/Random';
import { Contribution, LOCAL, type ItemCount, type Settlement } from './Contribution';
import type { BossPhase, DimensionDef, DimensionLayout, HazardTuning, Point, Rect, Site, SiteKind, WaveSpec } from './Dimension';
import { DimTile, isSolidDim, NO_GLYPH } from './DimTile';

export type DimEvent =
  /** Make an enemy of `species` at (x, y) (feet, tiles) and report its death with this id. */
  | { type: 'spawn'; id: number; species: Species; x: number; y: number; boss: boolean }
  /** Remove an enemy the run asked for, without a kill (a reset or a fallen boss's adds). */
  | { type: 'despawn'; id: number }
  /** The gate of `site` sealed or opened. */
  | { type: 'door'; site: number; open: boolean }
  | { type: 'started'; site: number; kind: SiteKind }
  | { type: 'cleared'; site: number; kind: SiteKind }
  | { type: 'wave'; wave: number; of: number }
  /** The ground went from under the player (a slab gave way, the water came
   *  in): hurt them by `damage` and move them back to safe ground at (x, y) now. */
  | { type: 'slip'; damage: number; x: number; y: number }
  | { type: 'checkpoint'; x: number; y: number }
  | { type: 'plate'; step: number; of: number }
  | { type: 'puzzleReset' }
  /** The boss entered a new phase; scale its attack cooldown and speed by these. */
  | { type: 'bossPhase'; phase: number; cooldownScale: number; speedScale: number }
  /** Add these to `player`'s bag (item ids; see `HOLLOW_REWARDS`): their share of the vault. */
  | { type: 'reward'; player: string; items: readonly ItemCount[] }
  /** `player` walked through the open portal attuned: their rift is closed, take
   *  them home, with their share of the rift's experience. */
  | { type: 'closed'; player: string; xp: number }
  /** The player stepped back into the rift they came in by: take them home, rift still open. */
  | { type: 'leave' }
  /** A mirror's player wants their share of the vault: the host decides. */
  | { type: 'claim' }
  /** A line for the HUD's notifications. */
  | { type: 'notice'; text: string };

export type ChallengeState = 'idle' | 'active' | 'done';

/** What a challenge can ask of the run. */
export interface RunHooks {
  readonly time: number;
  readonly layout: DimensionLayout;
  emit(e: DimEvent): void;
  /** Requests an enemy; returns its id. */
  spawn(species: Species, x: number, y: number, boss: boolean): number;
  setDoor(site: number, sealed: boolean): void;
  setCheckpoint(p: Point): void;
  /** Something others in a shared instance must see has changed. */
  touch(): void;
}

/** One site's state as a host shares it (see `DimensionRun.exportShared`). */
export interface SharedSite {
  /** 0 idle, 1 active, 2 done. */
  state: number;
  /** Waves: the wave under way and its live enemies. */
  wave: number;
  live: number[];
  /** The path: each tile's crumble timer, in twentieths of a second past 1 (0 untouched). */
  timers: Uint8Array | null;
  /** Plates: how far along, and which glyphs are pressed (a bit each).
   *  Tides: `step` is the water's level, `share` how long it holds (0–1). */
  step: number;
  pressed: number;
  /** The boss: its id, phase, health share and summons. */
  bossId: number;
  phase: number;
  share: number;
  adds: number[];
}

/** What a host shares of its run, for mirrors (and for a new host). */
export interface SharedRun {
  sites: SharedSite[];
  /** Sealed gates, a bit per site. */
  sealed: number;
  nextId: number;
  /** Run time the Warden fell at, or -1. */
  wardenFellAt: number;
}

/** A player's standing in a run: feet, and the tile under them last frame. */
interface Standing {
  x: number;
  y: number;
  prev: number;
}

export const emptySite = (): SharedSite => ({ state: 0, wave: 0, live: [], timers: null, step: 0, pressed: 0, bossId: 0, phase: 0, share: 1, adds: [] });

const STATE_CODE: Record<ChallengeState, number> = { idle: 0, active: 1, done: 2 };
const CODE_STATE: readonly ChallengeState[] = ['idle', 'active', 'done'];
/** Events everyone in a shared instance sees, not only the player they befall. */
const SHARED_EVENTS = new Set<DimEvent['type']>(['door', 'started', 'cleared', 'wave', 'plate', 'puzzleReset', 'bossPhase', 'notice']);
/** Seconds a mirror waits in the portal for its share of the vault. */
const CLAIM_WAIT = 3;
/** Crumble timers travel in twentieths of a second. */
const TIMER_STEP = 20;
const NO_SETTLEMENT: Map<string, Settlement> = new Map();

/** Seconds between one wave falling and the next arriving. */
const WAVE_PAUSE = 1.5;
/** Seconds per glyph of the mural's hint. */
const HINT_SLOT = 0.7;
/** Slips are ignored this long after one, while the player is moved. */
const SLIP_GRACE = 0.5;
/** Spawns keep this far from the player. */
const SPAWN_GAP = 4;
/** In a shared instance, seconds from the Warden's fall to its return. */
export const WARDEN_RETURN = 20 * 60;
/** A trial's score goes to the players who spent at least this long inside
 *  its site while it was under way (and, for waves, struck its creatures). */
const PRESENCE = 4;
/** A wave or boss fight with nobody left inside its site resets after this
 *  long, so its sealed gate never locks a shared instance for good. */
const ABANDON = 5;

/** Feet inside a site's floor, at least `margin` tiles in from its edge. */
function inside(r: Rect, px: number, py: number, margin: number): boolean {
  return px >= r.x + 1 + margin && px < r.x + r.w - 1 - margin && py >= r.y + 1 + margin && py < r.y + r.h - 1 - margin;
}

export abstract class Challenge {
  state: ChallengeState = 'idle';
  /** Seconds each player has spent inside the site while it was under way. */
  readonly present = new Map<string, number>();
  /** Seconds the site has been under way with nobody inside. */
  unattended = 0;

  constructor(
    readonly index: number,
    readonly site: Site,
  ) {}

  get done(): boolean {
    return this.state === 'done';
  }

  /** Once a frame, on the machine that runs the run: timers, and what follows
   *  from them. */
  tick(_dt: number, _run: RunHooks): void {}

  /** Once a frame for each player, standing at (px, py): `tile` is the index
   *  of the tile under their feet (-1 off the map), `prev` last frame's.
   *  Without `authority` (a mirror) only the local player's own concerns run. */
  abstract visit(run: RunHooks, player: string, px: number, py: number, tile: number, prev: number, authority: boolean): void;

  /** Once a frame on a mirror: what it keeps moving between the host's word. */
  mirrorTick(_dt: number): void {}

  /** Its share of the host's state, for mirrors. */
  exportShared(out: SharedSite): void {
    out.state = STATE_CODE[this.state];
  }

  /** Takes on the host's state. */
  applyShared(s: SharedSite): void {
    this.state = CODE_STATE[s.state] ?? 'idle';
  }

  /** One of the enemies it asked for died; false if it was not its own. */
  killed(_id: number, _run: RunHooks): boolean {
    return false;
  }

  /** An enemy's health share, 0–1. */
  health(_id: number, _share: number): void {}

  /** Live state of a tile it owns; see `DimensionRun.state`. */
  tileState(_t: number, _time: number): number {
    return 0;
  }

  /** Back to the start: its enemies leave and its gate opens. */
  reset(_run: RunHooks): void {}

  /** As new, done or not (an instance starting over): its enemies leave. */
  restart(run: RunHooks): void {
    this.reset(run);
    this.state = 'idle';
    this.present.clear();
    this.unattended = 0;
  }

  /** Whether `player` took part in breaking it. */
  tookPart(player: string): boolean {
    return (this.present.get(player) ?? 0) >= PRESENCE;
  }

  /** Forgets enemies nobody runs any more (a host left without handing them
   *  on): `alive` says whether an id still has a creature. */
  prune(_alive: (id: number) => boolean, _run: RunHooks): void {}

  /** Counts as done at once (the playground's skips). */
  skip(run: RunHooks): void {
    if (this.done) return;
    this.reset(run);
    this.state = 'done';
    run.setDoor(this.index, false);
  }

  protected finish(run: RunHooks): void {
    this.state = 'done';
    run.setDoor(this.index, false);
    run.emit({ type: 'cleared', site: this.index, kind: this.site.kind });
  }

  /** Requests a group of enemies at the site's spawn spots away from the player. */
  protected spawnGroup(run: RunHooks, wave: WaveSpec, px: number, py: number, out: number[], cap = Infinity): void {
    const spots = this.site.spawns;
    let cursor = hash(Math.floor(run.time * 10), this.index, out.length) % Math.max(1, spots.length);
    for (const [species, count] of wave) {
      for (let n = 0; n < count && out.length < cap; n++) {
        let spot = this.site.center;
        for (let tries = 0; tries < spots.length; tries++) {
          const s = spots[(cursor + tries) % spots.length];
          if (Math.hypot(s.x - px, s.y - py) >= SPAWN_GAP) {
            spot = s;
            cursor = (cursor + tries + 1) % spots.length;
            break;
          }
        }
        out.push(run.spawn(species, spot.x, spot.y, false));
      }
    }
  }
}

/** Waves of rift creatures; the gate seals until the last one falls. */
export class WaveChallenge extends Challenge {
  wave = 0;
  readonly live: number[] = [];
  /** Players who struck one of its creatures. */
  readonly fought = new Set<string>();
  private pause = 0;
  /** Where a player inside stood last: waves come out away from them. */
  private nearX = 0;
  private nearY = 0;

  constructor(index: number, site: Site, readonly waves: readonly WaveSpec[]) {
    super(index, site);
  }

  tick(dt: number, run: RunHooks): void {
    if (this.state !== 'active' || this.live.length) return;
    this.pause -= dt;
    if (this.pause > 0) return;
    if (++this.wave < this.waves.length) {
      this.send(run, this.nearX, this.nearY);
      return;
    }
    run.emit({ type: 'notice', text: 'The nest falls quiet. The gate opens.' });
    this.finish(run);
  }

  visit(run: RunHooks, _player: string, px: number, py: number, _tile: number, _prev: number, authority: boolean): void {
    if (!authority || this.state === 'done' || !inside(this.site.rect, px, py, 2)) return;
    this.nearX = px;
    this.nearY = py;
    if (this.state !== 'idle') return;
    this.state = 'active';
    run.setDoor(this.index, true);
    run.emit({ type: 'started', site: this.index, kind: 'combat' });
    run.emit({ type: 'notice', text: 'The gate seals. Something crawls out of the cracks…' });
    this.send(run, px, py);
  }

  exportShared(out: SharedSite): void {
    super.exportShared(out);
    out.wave = this.wave;
    out.live = this.live.slice();
  }

  applyShared(s: SharedSite): void {
    super.applyShared(s);
    this.wave = s.wave;
    this.live.length = 0;
    for (const id of s.live) this.live.push(id);
    this.pause = 0;
  }

  private send(run: RunHooks, px: number, py: number): void {
    run.emit({ type: 'wave', wave: this.wave + 1, of: this.waves.length });
    this.spawnGroup(run, this.waves[this.wave], px, py, this.live);
    this.pause = WAVE_PAUSE;
  }

  killed(id: number): boolean {
    const i = this.live.indexOf(id);
    if (i < 0) return false;
    this.live.splice(i, 1);
    return true;
  }

  owns(id: number): boolean {
    return this.state === 'active' && this.live.includes(id);
  }

  tookPart(player: string): boolean {
    return super.tookPart(player) && this.fought.has(player);
  }

  prune(alive: (id: number) => boolean): void {
    for (let i = this.live.length - 1; i >= 0; i--) if (!alive(this.live[i])) this.live.splice(i, 1);
  }

  reset(run: RunHooks): void {
    if (this.state !== 'active') return;
    for (const id of this.live) run.emit({ type: 'despawn', id });
    this.live.length = 0;
    this.wave = 0;
    this.state = 'idle';
    this.fought.clear();
    run.setDoor(this.index, false);
  }

  restart(run: RunHooks): void {
    super.restart(run);
    this.wave = 0;
    this.pause = 0;
    this.fought.clear();
  }
}

/** A path over the void: crumbling slabs give way a moment after they are
 *  stepped on and reform later; glitching slabs blink in and out on a timer.
 *  A slab that is gone is a gap nobody can step into, and the void beside
 *  the path is a wall, so nobody falls: but a slab that goes while someone
 *  stands on it throws them back to the last pad they touched, hurt. It is a
 *  race: keep moving, and wait out the glitches on the steps before them.
 *  Reaching the far side finishes it, and from then on the path holds firm. */
export class CrumblePath extends Challenge {
  /** Seconds since each path tile was stepped on; 0 while untouched. */
  readonly timers: Float32Array;
  /** Last checkpoint touched, an index into `site.checkpoints`. */
  checkpoint = 0;
  /** Path index of each tile, or -1. */
  private readonly index_: Int16Array;
  /** The local player is over the chasm, as of the last update. */
  private on = false;
  /** The local player has set out on the path: slips go back to its pads. */
  private setOut = false;

  constructor(index: number, site: Site, layout: DimensionLayout, readonly tuning: HazardTuning) {
    super(index, site);
    this.timers = new Float32Array(site.path.length);
    this.index_ = new Int16Array(layout.w * layout.h).fill(-1);
    site.path.forEach((t, i) => (this.index_[t] = i));
  }

  /** The local player is out on the path: slips go back to its pads. */
  get holding(): boolean {
    return this.state !== 'done' && this.setOut && this.on;
  }

  tick(dt: number): void {
    if (this.state !== 'done') this.advance(dt);
  }

  mirrorTick(dt: number): void {
    if (this.state !== 'done') this.advance(dt);
  }

  private advance(dt: number): void {
    const { crumbleDelay, reform } = this.tuning;
    const timers = this.timers;
    for (let i = 0; i < timers.length; i++) {
      if (timers[i] === 0) continue;
      timers[i] += dt;
      if (timers[i] >= crumbleDelay + reform) timers[i] = 0;
    }
  }

  visit(run: RunHooks, player: string, px: number, py: number, tile: number, _prev: number, authority: boolean): void {
    if (this.state === 'done') return;
    const local = player === LOCAL;
    const on = inside(this.site.rect, px, py, 0);
    if (local) this.on = on;
    if (authority && this.state === 'idle') {
      if (!on) return;
      this.state = 'active';
      run.emit({ type: 'started', site: this.index, kind: 'hazard' });
    }
    if (local && on && !this.setOut) {
      this.setOut = true;
      this.checkpoint = 0;
      run.setCheckpoint(this.site.checkpoints[0]);
    }
    if (authority ? this.state !== 'active' : !local) return;
    // A mirror cracks the slab under its own player at once; the host's word follows.
    const i = tile >= 0 ? this.index_[tile] : -1;
    if (i >= 0 && this.timers[i] === 0 && run.layout.tiles[tile] === DimTile.Crumble) {
      this.timers[i] = 1e-4;
      if (authority) run.touch();
    }
    if (local && this.setOut) {
      const cps = this.site.checkpoints;
      for (let k = this.checkpoint + 1; k < cps.length; k++) {
        if (Math.abs(cps[k].x - px) < 1.2 && Math.abs(cps[k].y - 0.5 - py) < 1.2) {
          this.checkpoint = k;
          run.setCheckpoint(cps[k]);
          run.emit({ type: 'checkpoint', x: cps[k].x, y: cps[k].y });
        }
      }
    }
    if (!authority) return;
    const g = this.site.goal!;
    const gx = Math.floor(px);
    const gy = Math.floor(py - 0.15);
    if (gx >= g.x && gy >= g.y && gx < g.x + g.w && gy < g.y + g.h) {
      run.emit({ type: 'notice', text: 'Solid ground again. Behind you, the path settles and holds.' });
      this.timers.fill(0);
      this.finish(run);
    }
  }

  exportShared(out: SharedSite): void {
    super.exportShared(out);
    const t = (out.timers ??= new Uint8Array(this.timers.length));
    for (let i = 0; i < t.length; i++) t[i] = this.timers[i] === 0 ? 0 : Math.min(255, 1 + Math.floor(this.timers[i] * TIMER_STEP));
  }

  /** The host's timers; a slab this side cracked a moment ago keeps cracking
   *  until the host's word on it comes back. */
  applyShared(s: SharedSite): void {
    super.applyShared(s);
    const t = s.timers;
    if (!t || t.length !== this.timers.length) return;
    for (let i = 0; i < t.length; i++) {
      if (t[i]) this.timers[i] = (t[i] - 1) / TIMER_STEP + 1e-4;
      else if (this.timers[i] > 0.5) this.timers[i] = 0;
    }
  }

  /** Crumbling tiles: 0 whole, between 0 and 1 cracking, 1 fallen. */
  tileState(t: number): number {
    if (this.state === 'done') return 0;
    const i = this.index_[t];
    const s = i < 0 ? 0 : this.timers[i];
    if (s === 0) return 0;
    return s < this.tuning.crumbleDelay ? s / this.tuning.crumbleDelay : 1;
  }

  /** Glitch state of a path tile, with its phase; still once the path is done. */
  glitch(t: number, time: number, phase: number): number {
    return this.state === 'done' || this.index_[t] < 0 ? 0 : glitchState(time, this.tuning, phase);
  }

  /** A slip puts every slab back, so the way is always open again. */
  restore(): void {
    this.timers.fill(0);
  }

  restart(run: RunHooks): void {
    super.restart(run);
    this.timers.fill(0);
    this.checkpoint = 0;
    this.on = false;
    this.setOut = false;
  }
}

/** Where a glitching tile is in its cycle; `phase` is 0–255 of one cycle. */
export function glitchState(time: number, tu: HazardTuning, phase: number): number {
  const cycle = tu.glitchOn + tu.glitchOff;
  const u = (((time + (phase / 256) * cycle) % cycle) + cycle) % cycle;
  if (u < tu.glitchOn - tu.glitchWarn) return 0;
  if (u < tu.glitchOn) return Math.max(1e-3, (u - (tu.glitchOn - tu.glitchWarn)) / tu.glitchWarn);
  return 1;
}

/** Pressure plates pressed in the order the mural shows; a wrong one resets them all. */
export class PlatePuzzle extends Challenge {
  /** Plates pressed so far, by glyph. */
  readonly pressed = new Uint8Array(8);
  step = 0;

  visit(run: RunHooks, _player: string, px: number, py: number, tile: number, prev: number, authority: boolean): void {
    if (!authority || this.state === 'done') return;
    if (this.state === 'idle') {
      if (!inside(this.site.rect, px, py, 1)) return;
      this.state = 'active';
      run.emit({ type: 'started', site: this.index, kind: 'puzzle' });
      run.emit({ type: 'notice', text: this.site.hint === 'text' ? 'The glyph stones wait, dark. The order must be written down somewhere…' : 'Glyph stones glow, one after another…' });
    }
    // A plate goes down as a player steps onto it, not while they stand there.
    if (tile === prev) return;
    const { tiles, glyphs } = run.layout;
    // Only this site's own plates count.
    if (tile < 0 || tiles[tile] !== DimTile.Plate || !this.site.plates.includes(tile)) return;
    const g = glyphs[tile];
    if (this.pressed[g]) return;
    const order = this.site.order;
    if (g === order[this.step]) {
      this.pressed[g] = 1;
      this.step++;
      run.emit({ type: 'plate', step: this.step, of: order.length });
      if (this.step === order.length) {
        run.emit({ type: 'notice', text: 'The glyphs blaze, every one.' });
        this.finish(run);
      }
      return;
    }
    this.pressed.fill(0);
    this.step = 0;
    run.emit({ type: 'puzzleReset' });
    run.emit({ type: 'notice', text: 'The plates spring back up. Wrong order.' });
  }

  /** Plates: 1 pressed. Mural stones: 1 done, 0.5 lit by the hint, 0 dark. */
  tileState(t: number, time: number): number {
    const site = this.site;
    const k = site.mural.indexOf(t);
    if (k < 0) {
      if (this.done) return 1;
      const g = site.plates.indexOf(t);
      return g >= 0 ? this.pressed[g] : 0;
    }
    if (this.done || k < this.step) return 1;
    // Written down elsewhere: the stones only show what is done.
    if (site.hint === 'text') return 0;
    // The hint lights the stones in order, then rests for two beats.
    return Math.floor(time / HINT_SLOT) % (site.order.length + 2) === k ? 0.5 : 0;
  }

  skip(run: RunHooks): void {
    super.skip(run);
    this.step = this.site.order.length;
  }

  exportShared(out: SharedSite): void {
    super.exportShared(out);
    out.step = this.step;
    let bits = 0;
    for (let g = 0; g < this.pressed.length; g++) if (this.pressed[g]) bits |= 1 << g;
    out.pressed = bits;
  }

  applyShared(s: SharedSite): void {
    super.applyShared(s);
    this.step = s.step;
    for (let g = 0; g < this.pressed.length; g++) this.pressed[g] = (s.pressed >> g) & 1;
  }

  restart(run: RunHooks): void {
    super.restart(run);
    this.pressed.fill(0);
    this.step = 0;
  }
}

/** A tide hall: a flooded floor between a ledge and the far side, and a row
 *  of sluice valves. Stepping onto the next valve in turn lowers the water a
 *  stage, uncovering the floor down to the next valve; but the water holds
 *  low only so long (`tideHold`) before it rises a stage again, so the way
 *  across is a race from valve to valve. Water rising over someone throws
 *  them back to the ledge, hurt. Reaching the far side finishes it, and the
 *  hall drains for good. */
export class TideChallenge extends Challenge {
  /** How high the water stands: the number of valves when full, 0 drained. */
  level: number;
  /** Seconds until the water rises a stage; 0 while full. */
  hold = 0;
  /** Valve index per tile, or -1. */
  private readonly valveOf: Int16Array;
  private readonly full: number;
  /** The local player has come in: slips go back to the ledge. */
  private inside = false;

  constructor(index: number, site: Site, layout: DimensionLayout, readonly tuning: HazardTuning) {
    super(index, site);
    this.full = site.valves.length;
    this.level = this.full;
    this.valveOf = new Int16Array(layout.w * layout.h).fill(-1);
    site.valves.forEach((t, i) => (this.valveOf[t] = i));
  }

  tick(dt: number, run: RunHooks): void {
    if (this.state !== 'active' || this.level >= this.full) return;
    this.hold -= dt;
    if (this.hold > 0) return;
    this.level++;
    this.hold = this.level < this.full ? this.tuning.tideHold : 0;
    run.emit({ type: 'notice', text: this.level < this.full ? 'The water surges back up a stage!' : 'The hall floods again. Back to the first valve.' });
    run.touch();
  }

  mirrorTick(dt: number): void {
    if (this.state === 'active' && this.level < this.full && this.hold > 0) this.hold = Math.max(0, this.hold - dt);
  }

  visit(run: RunHooks, player: string, px: number, py: number, tile: number, prev: number, authority: boolean): void {
    if (this.state === 'done') return;
    const local = player === LOCAL;
    const r = this.site.rect;
    const within = px >= r.x && px < r.x + r.w && py >= r.y && py < r.y + r.h;
    if (local && within && !this.inside) {
      this.inside = true;
      run.setCheckpoint(this.site.checkpoints[0]);
    } else if (local && !within) this.inside = false;
    if (!authority) return;
    if (this.state === 'idle') {
      if (!within) return;
      this.state = 'active';
      run.emit({ type: 'started', site: this.index, kind: 'tide' });
      run.emit({ type: 'notice', text: 'Black water fills the hall. Sluice valves glint in the floor…' });
    }
    // A valve turns as someone steps onto it, if it is the next one down.
    if (tile !== prev && tile >= 0) {
      const v = this.valveOf[tile];
      if (v >= 0 && v === this.full - this.level) {
        this.level--;
        this.hold = this.tuning.tideHold;
        run.emit({ type: 'plate', step: this.full - this.level, of: this.full });
        run.emit({ type: 'notice', text: this.level > 0 ? 'The valve turns. The water drains a stage.' : 'The last valve turns. The hall drains to the floor!' });
        run.touch();
      }
    }
    const g = this.site.goal!;
    const gx = Math.floor(px);
    const gy = Math.floor(py - 0.15);
    if (gx >= g.x && gy >= g.y && gx < g.x + g.w && gy < g.y + g.h) {
      run.emit({ type: 'notice', text: 'Dry stone underfoot. Behind you the sluices groan and the hall drains for good.' });
      this.level = 0;
      this.hold = 0;
      this.finish(run);
    }
  }

  /** Flood tiles: 0 dry, between 0 and 1 about to flood, 1 flooded.
   *  Valves: 1 turned. */
  tileState(t: number): number {
    if (this.state === 'done') return this.valveOf[t] >= 0 ? 1 : 0;
    const v = this.valveOf[t];
    if (v >= 0) return v < this.full - this.level ? 1 : 0;
    return -1;
  }

  /** A flood tile's state, by its depth. */
  floodState(depth: number): number {
    if (this.state === 'done') return 0;
    if (this.level >= depth) return 1;
    // The next stage up, in its last seconds: the water creeps over it.
    if (this.level + 1 === depth && this.hold > 0 && this.hold < this.tuning.tideWarn) return Math.max(1e-3, 1 - this.hold / this.tuning.tideWarn);
    return 0;
  }

  /** The local player is in the hall: slips go back to its ledge. */
  get holding(): boolean {
    return this.state !== 'done' && this.inside;
  }

  exportShared(out: SharedSite): void {
    super.exportShared(out);
    out.step = this.level;
    out.share = this.tuning.tideHold > 0 ? Math.min(1, Math.max(0, this.hold / this.tuning.tideHold)) : 0;
  }

  applyShared(s: SharedSite): void {
    super.applyShared(s);
    this.level = Math.min(this.full, Math.max(0, s.step));
    this.hold = s.share * this.tuning.tideHold;
  }

  skip(run: RunHooks): void {
    super.skip(run);
    this.level = 0;
    this.hold = 0;
  }

  restart(run: RunHooks): void {
    super.restart(run);
    this.level = this.full;
    this.hold = 0;
    this.inside = false;
  }
}

/** The boss: wakes when the player walks into the arena and seals it; its
 *  health drives the phases, each summoning adds and quickening it. */
export class BossChallenge extends Challenge {
  bossId = 0;
  /** 0 before any of `phases`, then 1, 2… */
  phase = 0;
  share = 1;
  readonly adds: number[] = [];
  /** Where a player in the arena stood last: summons come out away from them. */
  private nearX = 0;
  private nearY = 0;

  constructor(
    index: number,
    site: Site,
    readonly species: Species,
    readonly phases: readonly BossPhase[],
    readonly addCap: number,
  ) {
    super(index, site);
  }

  visit(run: RunHooks, _player: string, px: number, py: number, _tile: number, _prev: number, authority: boolean): void {
    if (!authority || this.state === 'done' || !inside(this.site.rect, px, py, 3)) return;
    this.nearX = px;
    this.nearY = py;
    if (this.state !== 'idle') return;
    this.state = 'active';
    this.share = 1;
    this.phase = 0;
    run.setDoor(this.index, true);
    const c = this.site.center;
    this.bossId = run.spawn(this.species, c.x, c.y, true);
    run.emit({ type: 'started', site: this.index, kind: 'boss' });
    run.emit({ type: 'notice', text: `${this.species.name} awakens!` });
  }

  tick(_dt: number, run: RunHooks): void {
    if (this.state !== 'active') return;
    while (this.phase < this.phases.length && this.share <= this.phases[this.phase].below) {
      const ph = this.phases[this.phase++];
      run.emit({ type: 'bossPhase', phase: this.phase, cooldownScale: ph.cooldownScale, speedScale: ph.speedScale });
      run.emit({ type: 'notice', text: ph.text });
      this.spawnGroup(run, ph.adds, this.nearX, this.nearY, this.adds, this.addCap);
    }
  }

  exportShared(out: SharedSite): void {
    super.exportShared(out);
    out.bossId = this.bossId;
    out.phase = this.phase;
    out.share = this.share;
    out.adds = this.adds.slice();
  }

  applyShared(s: SharedSite): void {
    super.applyShared(s);
    this.bossId = s.bossId;
    this.phase = s.phase;
    this.share = s.share;
    this.adds.length = 0;
    for (const id of s.adds) this.adds.push(id);
  }

  health(id: number, share: number): void {
    if (id === this.bossId) this.share = share;
  }

  /** The boss or one of its summons, while the fight is on. */
  owns(id: number): boolean {
    return this.state === 'active' && (id === this.bossId || this.adds.includes(id));
  }

  /** Summons nobody runs are gone; a boss nobody runs waits in its arena
   *  again, at full strength, for whoever walks in next. */
  prune(alive: (id: number) => boolean, run: RunHooks): void {
    for (let i = this.adds.length - 1; i >= 0; i--) if (!alive(this.adds[i])) this.adds.splice(i, 1);
    if (this.state === 'active' && !alive(this.bossId)) {
      this.bossId = 0;
      this.reset(run);
      this.phase = 0;
      this.share = 1;
    }
  }

  killed(id: number, run: RunHooks): boolean {
    const i = this.adds.indexOf(id);
    if (i >= 0) {
      this.adds.splice(i, 1);
      return true;
    }
    if (id !== this.bossId || this.state !== 'active') return false;
    this.bossId = 0;
    this.share = 0;
    // Its summons fade with it.
    for (const a of this.adds) run.emit({ type: 'despawn', id: a });
    this.adds.length = 0;
    run.emit({ type: 'notice', text: `${this.species.name} shatters. The way home opens.` });
    this.finish(run);
    return true;
  }

  reset(run: RunHooks): void {
    if (this.state !== 'active') return;
    run.emit({ type: 'despawn', id: this.bossId });
    for (const a of this.adds) run.emit({ type: 'despawn', id: a });
    this.adds.length = 0;
    this.bossId = 0;
    this.state = 'idle';
    run.setDoor(this.index, false);
  }

  /** Fallen or not, back to waiting in its arena, at full strength. */
  restart(run: RunHooks): void {
    super.restart(run);
    this.phase = 0;
    this.share = 1;
  }
}

/** One trip into a dimension, from the arrival to the closed rift. */
export class DimensionRun implements RunHooks {
  /** Challenge per site; null for the vault. */
  readonly challenges: ReadonlyArray<Challenge | null>;
  time = 0;
  /** The portal was taken: the rift is closed. */
  closed = false;
  /** Who did what, settled when the Warden falls. */
  readonly contribution = new Contribution();
  /** Other players may be here: the Warden returns a while after it falls. */
  shared = false;
  /** Run time the Warden fell at, or -1. */
  wardenFellAt = -1;
  /** This machine runs the run (alone, or as an instance's host); otherwise
   *  it mirrors the host's and keeps only its own player's concerns. */
  authority = true;
  /** In a shared instance, the run's time in seconds, the same for everyone;
   *  otherwise the run counts its own frames. */
  clock: (() => number) | null = null;
  /** Rises whenever something others in the instance must see has changed. */
  version = 0;
  /** Each player's feet, `LOCAL` among them. */
  private readonly where = new Map<string, Standing>();
  /** Each player's share, once the Warden has fallen. On a mirror, the local
   *  player's, as the host settled it (`adoptSettlement`). */
  private settlement: Map<string, Settlement> | null = null;
  /** Events everyone in the instance sees, for the host to pass on. */
  private sharedQueue: DimEvent[] = [];
  private sharedSpare: DimEvent[] = [];
  /** In the local player's own part of a frame (slips, the portal): what
   *  happens there is theirs alone, not the instance's. */
  private localOnly = false;
  /** Players who have taken their share of the vault. */
  private readonly chestTaken = new Set<string>();
  /** Where a slip on the hazard path or in a tide hall returns the player (feet). */
  checkpoint: Point;
  /** Sealed state per site's gate. */
  private readonly sealed: Uint8Array;
  /** Site of each gate tile, or -1. */
  private readonly doorOf: Int8Array;
  /** Site whose challenge owns a tile (path, plates, mural), or -1. */
  private readonly owner: Int8Array;
  private queue: DimEvent[] = [];
  private spare: DimEvent[] = [];
  private nextId = 1;
  /** A mirror stepped into the portal before taking its share of the vault:
   *  seconds left to wait for the host's answer before going anyway. */
  private claimWait = -1;
  private slipGrace = 0;
  private lastTile = -1;
  private readonly bossSite: number;

  constructor(
    readonly def: DimensionDef,
    readonly layout: DimensionLayout,
    readonly seed: number,
  ) {
    const L = layout;
    this.checkpoint = { x: L.arrival.x, y: L.arrival.y };
    const n = L.w * L.h;
    this.doorOf = new Int8Array(n).fill(-1);
    this.owner = new Int8Array(n).fill(-1);
    this.challenges = L.sites.map((site, i) => {
      for (const t of site.gates) this.doorOf[t] = i;
      for (const t of site.path) this.owner[t] = i;
      for (const t of site.plates) if (t >= 0) this.owner[t] = i;
      for (const t of site.mural) this.owner[t] = i;
      for (const t of site.valves) this.owner[t] = i;
      for (const t of site.flood) this.owner[t] = i;
      switch (site.kind) {
        case 'combat':
          return new WaveChallenge(i, site, def.waves);
        case 'hazard':
          return new CrumblePath(i, site, L, def.hazard);
        case 'puzzle':
          return new PlatePuzzle(i, site);
        case 'tide':
          return new TideChallenge(i, site, L, def.hazard);
        case 'boss':
          return new BossChallenge(i, site, def.boss.species, def.boss.phases, def.boss.addCap);
        default:
          return null;
      }
    });
    this.bossSite = L.sites.findIndex((s) => s.kind === 'boss');
    // Every gate is open, but the boss's: it waits for the trials.
    this.sealed = new Uint8Array(L.sites.length);
    if (this.bossSite >= 0 && this.trials > 0) this.sealed[this.bossSite] = 1;
    this.join(LOCAL, L.arrival.x, L.arrival.y);
  }

  // Per-frame input ------------------------------------------------------------

  /** Steps the run with the player's feet (tiles). */
  update(dt: number, px: number, py: number): void {
    if (this.closed) return;
    this.time = this.clock ? this.clock() : this.time + dt;
    let me = this.where.get(LOCAL);
    if (!me) this.where.set(LOCAL, (me = { x: px, y: py, prev: -1 }));
    me.x = px;
    me.y = py;
    this.slipGrace = Math.max(0, this.slipGrace - dt);
    const L = this.layout;
    const tile = this.index(Math.floor(px), Math.floor(py - 0.15));
    if (this.authority) this.step(dt);
    else {
      for (const c of this.challenges) c?.mirrorTick(dt);
      for (const c of this.challenges) c?.visit(this, LOCAL, px, py, tile, me.prev, false);
      me.prev = tile;
    }

    this.localOnly = true;
    if (this.slipGrace === 0 && this.holeAt(tile)) this.slip();
    if (this.claimWait > 0) this.claimWait = Math.max(0, this.claimWait - dt);
    if (tile === L.portal && this.portalOpen) {
      if (this.share(LOCAL).attuned || (this.authority && this.contribution.attuned(LOCAL))) {
        if (!this.chestOpened) {
          // A mirror asks the host for its share first, and waits (a moment
          // at most) for the answer, so it is not lost on the way out.
          if (!this.authority) {
            if (this.claimWait < 0) {
              this.claimWait = CLAIM_WAIT;
              this.openChest();
            }
            if (this.claimWait > 0) {
              this.localOnly = false;
              this.lastTile = tile;
              return;
            }
          } else this.openChest();
        }
        this.closed = true;
        this.emit({ type: 'notice', text: `The rift to ${L.name} seals behind you.` });
        this.emit({ type: 'closed', player: LOCAL, xp: this.share(LOCAL).xp });
      } else if (tile !== this.lastTile) {
        this.emit({ type: 'notice', text: "The portal does not answer you. You had no part in the Warden's fall." });
      }
    }
    this.localOnly = false;
    this.lastTile = tile;
  }

  /** The run's own step, on the machine that runs it: timers, then every
   *  player's feet through every challenge. */
  private step(dt: number): void {
    if (this.shared && this.wardenFellAt >= 0 && this.time - this.wardenFellAt >= WARDEN_RETURN) this.returnWarden();
    const trialsBefore = this.trialsDone;
    for (const c of this.challenges) c?.tick(dt, this);
    for (const player of this.where.keys()) {
      const p = this.where.get(player)!;
      const tile = this.index(Math.floor(p.x), Math.floor(p.y - 0.15));
      for (const c of this.challenges) c?.visit(this, player, p.x, p.y, tile, p.prev, true);
      p.prev = tile;
    }
    this.attend(dt);
    if (this.trialsDone !== trialsBefore) this.trialDone();
  }

  /** Who is in each site under way, and how long; a fight nobody is left in
   *  (they died, or went home) resets, opening its gate. */
  private attend(dt: number): void {
    for (const c of this.challenges) {
      if (!c || c.state !== 'active') continue;
      const r = c.site.rect;
      let anyone = false;
      for (const player of this.where.keys()) {
        const p = this.where.get(player)!;
        if (p.x < r.x || p.y < r.y || p.x >= r.x + r.w || p.y >= r.y + r.h) continue;
        anyone = true;
        c.present.set(player, (c.present.get(player) ?? 0) + dt);
      }
      c.unattended = anyone ? 0 : c.unattended + dt;
      if (c.unattended >= ABANDON && (c instanceof WaveChallenge || c instanceof BossChallenge)) {
        c.unattended = 0;
        c.reset(this);
        if (c instanceof BossChallenge) {
          c.phase = 0;
          c.share = 1;
        }
        this.emit({ type: 'notice', text: `${c.site.name} falls still, its gate open again.` });
      }
    }
  }

  /** An enemy the run spawned died. */
  enemyKilled(id: number): void {
    for (const c of this.challenges) if (c?.killed(id, this)) return;
  }

  /** An enemy's health share (0–1); the boss's drives its phases. */
  enemyHealth(id: number, share: number): void {
    for (const c of this.challenges) c?.health(id, share);
  }

  /** `player` dealt `amount` to an enemy the run spawned: hurting the Warden
   *  or its summons counts toward their share. */
  damage(player: string, id: number, amount: number): void {
    if (this.boss?.owns(id)) {
      this.contribution.damage(player, amount);
      return;
    }
    for (const c of this.challenges) if (c instanceof WaveChallenge && c.owns(id)) c.fought.add(player);
  }

  /** A new host's word on which of the run's creatures it still runs: the
   *  rest are forgotten (a wave carries on without them, a boss nobody runs
   *  waits in its arena again). */
  prune(alive: (id: number) => boolean): void {
    for (const c of this.challenges) c?.prune(alive, this);
  }

  // Players ----------------------------------------------------------------------

  /** A player is in the instance, standing at (x, y). */
  join(player: string, x: number, y: number): void {
    this.contribution.join(player);
    const p = this.where.get(player);
    if (p) {
      p.x = x;
      p.y = y;
    } else this.where.set(player, { x, y, prev: -1 });
  }

  /** Another player's feet (the local player's come with `update`). */
  move(player: string, x: number, y: number): void {
    const p = this.where.get(player);
    if (p) {
      p.x = x;
      p.y = y;
    }
  }

  /** A player left the instance; their share stays theirs until settled. */
  leave(player: string): void {
    this.where.delete(player);
  }

  /** Nobody is left in the instance: time to `restart` it. */
  get empty(): boolean {
    return this.where.size === 0;
  }

  /** The players in the instance. */
  get players(): IterableIterator<string> {
    return this.where.keys();
  }

  /** Every player's feet. */
  standings(): IterableIterator<Readonly<Point>> {
    return this.where.values();
  }

  /** How far (x, y) is from the nearest player in the instance, in tiles. */
  nearestPlayer(x: number, y: number): number {
    let best = Infinity;
    for (const p of this.where.values()) best = Math.min(best, (p.x - x) ** 2 + (p.y - y) ** 2);
    return Math.sqrt(best);
  }

  /** The host gives `player` their share of the vault (once): a `reward` event
   *  for them. False if the vault is shut to them, or already taken. */
  claimChest(player: string): boolean {
    if (!this.portalOpen || this.chestTaken.has(player)) return false;
    this.openChest(player);
    this.touch();
    return true;
  }

  /** The vault has been taken by `player` (as the host says). */
  markClaimed(player: string): void {
    this.chestTaken.add(player);
    if (player === LOCAL && this.claimWait > 0) this.claimWait = 0;
  }

  /** The host would not give the local player a share: stop waiting for one. */
  claimDenied(): void {
    if (this.claimWait > 0) this.claimWait = 0;
  }

  /** Whether `player` has taken their share of the vault. */
  hasClaimed(player: string): boolean {
    return this.chestTaken.has(player);
  }

  // Sharing over the network --------------------------------------------------------

  /** What a host shares with mirrors (and a new host would carry on from). */
  exportShared(): SharedRun {
    const sites = this.challenges.map((c) => {
      const s = emptySite();
      c?.exportShared(s);
      return s;
    });
    let sealed = 0;
    for (let i = 0; i < this.sealed.length; i++) if (this.sealed[i]) sealed |= 1 << i;
    return { sites, sealed, nextId: this.nextId, wardenFellAt: this.wardenFellAt };
  }

  /** A mirror takes on the host's state. */
  applyShared(s: SharedRun): void {
    if (s.sites.length !== this.challenges.length) return;
    this.challenges.forEach((c, i) => c?.applyShared(s.sites[i]));
    for (let i = 0; i < this.sealed.length; i++) this.sealed[i] = (s.sealed >> i) & 1;
    this.nextId = Math.max(this.nextId, s.nextId);
    // The Warden came back: last fight's shares are gone.
    if (s.wardenFellAt < 0 && this.wardenFellAt >= 0) {
      this.settlement = null;
      this.chestTaken.clear();
    }
    this.wardenFellAt = s.wardenFellAt;
  }

  /** A mirror's player's share, as the host settled it. */
  adoptSettlement(s: Settlement | null): void {
    this.settlement = s ? new Map([[LOCAL, s]]) : null;
  }

  /** This mirror's host has gone and it runs the run now: the tally carries
   *  on from the host's last word (`entries`, by player). */
  becomeAuthority(entries: ReadonlyArray<{ player: string; score: number; breaker: boolean; claimed: boolean }>): void {
    this.authority = true;
    this.contribution.restore(entries);
    this.chestTaken.clear();
    for (const e of entries) if (e.claimed) this.chestTaken.add(e.player);
    // Settled again from the tally, when next asked.
    this.settlement = null;
    for (const p of this.where.values()) p.prev = -1;
  }

  /** Events everyone in the instance sees, since the last call. Reused like `takeEvents`. */
  takeShared(): readonly DimEvent[] {
    const out = this.sharedQueue;
    this.sharedSpare.length = 0;
    this.sharedQueue = this.sharedSpare;
    this.sharedSpare = out;
    return out;
  }

  /** What a player is owed (once the Warden has fallen), else a share of nothing. */
  share(player: string): Settlement {
    return this.settled().get(player) ?? { share: 0, attuned: false, xp: 0, items: [] };
  }

  /** Back to how it was when first opened: every trial, the Warden, the vault
   *  and the tally. For a shared instance everyone has left. */
  restart(): void {
    for (const c of this.challenges) c?.restart(this);
    this.sealed.fill(0);
    if (this.bossSite >= 0 && this.trials > 0) this.sealed[this.bossSite] = 1;
    this.contribution.reset(this.where.keys());
    this.settlement = null;
    this.chestTaken.clear();
    this.wardenFellAt = -1;
    this.closed = false;
  }

  /** The player pressed interact facing a tile: the vault's chest, or the
   *  rift home (back out, the rift left open). True if something happened. */
  interact(gx: number, gy: number): boolean {
    const i = this.index(gx, gy);
    if (i < 0) return false;
    if (i === this.layout.rift) {
      this.emit({ type: 'leave' });
      return true;
    }
    if (!this.canOpenChest(gx, gy)) return false;
    this.openChest();
    return true;
  }

  /** Something others in the instance must see has changed. */
  touch(): void {
    this.version++;
  }

  canOpenChest(gx: number, gy: number): boolean {
    return this.index(gx, gy) === this.layout.chest && this.portalOpen && !this.chestOpened;
  }

  /** The local player has taken their share of the vault. */
  get chestOpened(): boolean {
    return this.chestTaken.has(LOCAL);
  }

  /** For testing (the playground): every trial counts as done, and for the
   *  vault the boss too. Move the player to the site's `entry`. */
  skipTo(site: number): void {
    const kind = this.layout.sites[site]?.kind;
    if (kind !== 'boss' && kind !== 'vault') return;
    const before = this.trialsDone;
    for (const c of this.challenges) if (c && !(c instanceof BossChallenge)) c.skip(this);
    if (this.trialsDone !== before) this.trialDone();
    if (kind === 'vault') this.boss?.skip(this);
  }

  /** Events since the last call. The array is reused: read it before the next call. */
  takeEvents(): readonly DimEvent[] {
    const out = this.queue;
    this.spare.length = 0;
    this.queue = this.spare;
    this.spare = out;
    return out;
  }

  // Queries --------------------------------------------------------------------

  /** Challenges other than the boss. */
  get trials(): number {
    let n = 0;
    for (const c of this.challenges) if (c && !(c instanceof BossChallenge)) n++;
    return n;
  }

  get trialsDone(): number {
    let n = 0;
    for (const c of this.challenges) if (c?.done && !(c instanceof BossChallenge)) n++;
    return n;
  }

  /** The boss's gate is open: the trials are done. */
  get bossOpen(): boolean {
    return this.bossSite < 0 || this.sealed[this.bossSite] === 0 || this.challenges[this.bossSite]?.state === 'active';
  }

  get portalOpen(): boolean {
    return this.bossSite < 0 || !!this.challenges[this.bossSite]?.done;
  }

  /** The boss's challenge, for a health bar or phase. */
  get boss(): BossChallenge | null {
    const c = this.bossSite >= 0 ? this.challenges[this.bossSite] : null;
    return c instanceof BossChallenge ? c : null;
  }

  /** The site tile at a spot; `None` off the sites and the map. */
  tileAt(gx: number, gy: number): number {
    const i = this.index(gx, gy);
    return i < 0 ? DimTile.None : this.layout.tiles[i];
  }

  /** Glyph shown on a plate or mural stone, or `NO_GLYPH`. */
  glyphAt(gx: number, gy: number): number {
    const i = this.index(gx, gy);
    return i < 0 ? NO_GLYPH : this.layout.glyphs[i];
  }

  /** What the sites block: sealed gates, mural stones and the chest, slabs
   *  that are gone and flooded floor; off the map is solid too. The land's
   *  own walls, trees and void are the world's. */
  isSolid(gx: number, gy: number): boolean {
    const i = this.index(gx, gy);
    if (i < 0) return true;
    const t = this.layout.tiles[i];
    if (t === DimTile.Gate) return this.sealed[this.doorOf[i]] === 1;
    if (t === DimTile.Crumble || t === DimTile.Glitch || t === DimTile.Flood) return this.stateOf(i) >= 1;
    if (t === DimTile.Valve) return this.valveFlooded(i);
    return isSolidDim(t);
  }

  /** A hazard path's slab (there or not) lies on this tile, over the void. */
  isSlab(gx: number, gy: number): boolean {
    const i = this.index(gx, gy);
    if (i < 0) return false;
    const t = this.layout.tiles[i];
    return t === DimTile.Crumble || t === DimTile.Glitch;
  }

  /** Ground that has gone from under whoever stands there: a slab given way
   *  or glitched out, or floor the water has covered. */
  isHole(gx: number, gy: number): boolean {
    return this.holeAt(this.index(gx, gy));
  }

  /** Live state of a tile, by kind. Gates: 1 sealed. Crumbling: 0 whole,
   *  between 0 and 1 cracking, 1 fallen. Glitching: 0 there, between 0 and 1
   *  flickering, 1 gone. Plates: 1 pressed. Mural stones: 1 done, 0.5 hinted.
   *  Portal: 1 open. Chest: 0 locked, 1 ready, 2 opened. Flood: 0 dry,
   *  between 0 and 1 about to flood, 1 flooded. Valves: 1 turned. */
  state(gx: number, gy: number): number {
    return this.stateOf(this.index(gx, gy));
  }

  /** `state` by tile index. */
  stateOf(i: number): number {
    if (i < 0) return 0;
    const L = this.layout;
    switch (L.tiles[i]) {
      case DimTile.Gate:
        return this.sealed[this.doorOf[i]];
      case DimTile.Portal:
        return this.portalOpen ? 1 : 0;
      case DimTile.Chest:
        return this.chestOpened ? 2 : this.portalOpen ? 1 : 0;
      case DimTile.Glitch: {
        const c = this.challenges[this.owner[i]];
        return c instanceof CrumblePath ? c.glitch(i, this.time, L.phase[i]) : 0;
      }
      case DimTile.Flood: {
        const c = this.challenges[this.owner[i]];
        return c instanceof TideChallenge ? c.floodState(L.phase[i]) : 0;
      }
      case DimTile.Crumble:
      case DimTile.Plate:
      case DimTile.Glyph:
      case DimTile.Valve: {
        const o = this.owner[i];
        return o >= 0 ? (this.challenges[o]?.tileState(i, this.time) ?? 0) : 0;
      }
      default:
        return 0;
    }
  }

  doorSealed(site: number): boolean {
    return this.sealed[site] === 1;
  }

  // RunHooks ---------------------------------------------------------------------

  emit(e: DimEvent): void {
    this.queue.push(e);
    if (this.shared && this.authority && !this.localOnly && SHARED_EVENTS.has(e.type)) {
      this.sharedQueue.push(e);
      this.version++;
    }
    if (e.type !== 'cleared') return;
    // A trial's score goes to whoever was there; the Warden's fall settles all.
    if (e.kind === 'boss') this.wardenFell();
    else if (e.kind !== 'vault') this.contribution.trial(this.breakersOf(e.site));
  }

  spawn(species: Species, x: number, y: number, boss: boolean): number {
    const id = this.nextId++;
    this.emit({ type: 'spawn', id, species, x, y, boss });
    return id;
  }

  setDoor(site: number, sealed: boolean): void {
    if (site < 0 || site >= this.sealed.length || (this.sealed[site] === 1) === sealed) return;
    // The boss's gate stays shut until the trials are done.
    if (!sealed && site === this.bossSite && this.trialsDone < this.trials) return;
    this.sealed[site] = sealed ? 1 : 0;
    if (this.layout.sites[site].gates.length) this.emit({ type: 'door', site, open: !sealed });
  }

  setCheckpoint(p: Point): void {
    this.checkpoint = p;
  }

  // ------------------------------------------------------------------------------

  /** A trial was done: the last one opens the boss's gate. */
  private trialDone(): void {
    const left = this.trials - this.trialsDone;
    const boss = this.bossSite;
    if (left > 0) {
      this.emit({ type: 'notice', text: `A seal breaks. ${left} still bind${left === 1 ? 's' : ''} the Warden's gate.` });
      return;
    }
    if (boss < 0 || this.challenges[boss]?.state !== 'idle') return;
    this.setDoor(boss, false);
    this.emit({ type: 'notice', text: `The last seal breaks. Far off, the gate of ${this.layout.sites[boss].name} grinds open.` });
  }


  private index(gx: number, gy: number): number {
    const L = this.layout;
    return gx >= 0 && gy >= 0 && gx < L.w && gy < L.h ? gy * L.w + gx : -1;
  }

  /** `isHole` by tile index. */
  holeAt(i: number): boolean {
    if (i < 0) return false;
    const t = this.layout.tiles[i];
    if (t === DimTile.Crumble || t === DimTile.Glitch || t === DimTile.Flood) return this.stateOf(i) >= 1;
    if (t === DimTile.Valve) return this.valveFlooded(i);
    return false;
  }

  /** A valve standing in a band of the flood, under water now. */
  private valveFlooded(i: number): boolean {
    const depth = this.layout.phase[i];
    if (depth === 0) return false;
    const c = this.challenges[this.owner[i]];
    return c instanceof TideChallenge && c.floodState(depth) >= 1;
  }

  /** The ground went from under the player: back to the last safe spot of
   *  the site they are in, hurt. */
  private slip(): void {
    this.slipGrace = SLIP_GRACE;
    const tile = this.lastTile;
    const flooded = tile >= 0 && this.layout.tiles[tile] === DimTile.Flood;
    // A slip on the path puts its slabs back, so the way is open again.
    for (const c of this.challenges) if (c instanceof CrumblePath && c.state !== 'idle') c.restore();
    const p = this.checkpoint;
    this.emit({ type: 'slip', damage: this.def.hazard.slipDamage, x: p.x, y: p.y });
    this.emit({ type: 'notice', text: flooded ? 'The water knocks you off your feet and drags you back…' : 'The ground gives way! You scramble back to safe footing…' });
  }

  /** The local player takes their share of the vault. */
  private openChest(player = LOCAL): void {
    if (this.chestTaken.has(player)) return;
    // A mirror asks; the host's answer gives the reward and marks it taken.
    if (!this.authority) {
      this.emit({ type: 'claim' });
      return;
    }
    this.chestTaken.add(player);
    // Shared at once: a new host must know it was taken.
    this.touch();
    this.emit({ type: 'reward', player, items: this.share(player).items });
  }

  /** What the vault holds, rolled once from the run's seed. */
  private vault(): ItemCount[] {
    const rng = new Rng(hash(this.seed, 0x7e3a));
    const items: ItemCount[] = [];
    for (const r of this.def.rewards) if (rng.chance(r.chance)) items.push({ item: r.item, count: rng.int(r.min, r.max) });
    return items;
  }

  /** The shares, settled when the Warden fell (or now, if it was skipped). */
  private settled(): Map<string, Settlement> {
    // A mirror knows only what the host settled for its player.
    if (!this.authority) return this.settlement ?? NO_SETTLEMENT;
    return (this.settlement ??= this.contribution.settle(this.vault(), this.def.closeXp));
  }

  private wardenFell(): void {
    this.wardenFellAt = this.time;
    this.settlement = this.contribution.settle(this.vault(), this.def.closeXp);
  }

  /** In a shared instance, a while after its fall: the Warden reforms, the
   *  portal sleeps, and the vault fills again for a new fight and a new tally. */
  private returnWarden(): void {
    this.boss?.restart(this);
    this.contribution.reset(this.where.keys());
    this.settlement = null;
    this.chestTaken.clear();
    this.wardenFellAt = -1;
    this.emit({ type: 'notice', text: "Far off, something reforms in the Warden's arena. The portal falls dark." });
  }

  /** Who broke a trial: in a shared instance, those who took part in it (a
   *  while inside it, and for waves a blow struck); alone, the player. */
  private breakersOf(site: number): string[] {
    const c = this.challenges[site];
    if (!this.shared) return [LOCAL];
    const out: string[] = [];
    if (c) for (const player of this.contribution.players) if (c.tookPart(player)) out.push(player);
    return out;
  }
}
