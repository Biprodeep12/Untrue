// What happens inside a dimension, without any rendering: a state machine per
// challenge chamber, and `DimensionRun`, which sequences them, seals and opens
// the doors, catches falls, and reports everything as events for the game to
// act on (spawning enemies, moving the player, granting rewards).
//
// Per frame the game calls `update(dt, px, py)` with the player's feet, then
// drains `takeEvents()`. It tells the run when one of the enemies it asked for
// dies (`enemyKilled`) and, for the boss, its health (`enemyHealth`). Nothing
// here allocates per frame; events are only made when something changes.

import type { Species } from '../entities/Species';
import { hash, Rng } from '../generation/Random';
import type { BossPhase, Chamber, ChamberKind, DimensionDef, DimensionLayout, HazardTuning, Point, Rect, WaveSpec } from './Dimension';
import { DimTile, isSolidDim, NO_GLYPH } from './DimTile';

export type DimEvent =
  /** Make an enemy of `species` at (x, y) (feet, tiles) and report its death with this id. */
  | { type: 'spawn'; id: number; species: Species; x: number; y: number; boss: boolean }
  /** Remove an enemy the run asked for, without a kill (a reset or a fallen boss's adds). */
  | { type: 'despawn'; id: number }
  /** `doors[door]` sealed or opened. */
  | { type: 'door'; door: number; open: boolean }
  | { type: 'started'; chamber: number; kind: ChamberKind }
  | { type: 'cleared'; chamber: number; kind: ChamberKind }
  | { type: 'wave'; wave: number; of: number }
  /** The player fell into the void: hurt them by `damage` and move them to (x, y) now. */
  | { type: 'fell'; damage: number; x: number; y: number }
  | { type: 'checkpoint'; x: number; y: number }
  | { type: 'plate'; step: number; of: number }
  | { type: 'puzzleReset' }
  /** The boss entered a new phase; scale its attack cooldown and speed by these. */
  | { type: 'bossPhase'; phase: number; cooldownScale: number; speedScale: number }
  /** Add these to the player's bag (item ids; see `HOLLOW_REWARDS`). */
  | { type: 'reward'; items: ReadonlyArray<{ item: string; count: number }> }
  /** The player walked through the open portal: the rift is closed, take them home. */
  | { type: 'closed' }
  /** The player stepped back onto the rift they came in by: take them home, rift still open. */
  | { type: 'leave' }
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
  setDoor(door: number, sealed: boolean): void;
  setCheckpoint(p: Point): void;
}

/** Seconds between one wave falling and the next arriving. */
const WAVE_PAUSE = 1.5;
/** Seconds per glyph of the mural's hint. */
const HINT_SLOT = 0.7;
/** Falls are ignored this long after one, while the player is moved. */
const FALL_GRACE = 0.5;
/** Spawns keep this far from the player. */
const SPAWN_GAP = 4;

/** Feet inside a chamber's floor, at least `margin` tiles in from its walls. */
function inside(r: Rect, px: number, py: number, margin: number): boolean {
  return px >= r.x + 1 + margin && px < r.x + r.w - 1 - margin && py >= r.y + 1 + margin && py < r.y + r.h - 1 - margin;
}

export abstract class Challenge {
  state: ChallengeState = 'idle';

  constructor(
    readonly chamber: number,
    readonly room: Chamber,
  ) {}

  get done(): boolean {
    return this.state === 'done';
  }

  /** `tile` is the index of the tile under the player's feet. */
  abstract update(dt: number, run: RunHooks, px: number, py: number, tile: number): void;

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

  /** Back to the start, e.g. after the player died: its enemies leave and its doors open. */
  reset(_run: RunHooks): void {}

  protected finish(run: RunHooks): void {
    this.state = 'done';
    if (this.chamber < run.layout.doors.length) run.setDoor(this.chamber, false);
    run.emit({ type: 'cleared', chamber: this.chamber, kind: this.room.kind });
  }

  /** Requests a group of enemies at the chamber's spawn spots away from the player. */
  protected spawnGroup(run: RunHooks, wave: WaveSpec, px: number, py: number, out: number[], cap = Infinity): void {
    const spots = this.room.spawns;
    let cursor = hash(Math.floor(run.time * 10), this.chamber, out.length) % Math.max(1, spots.length);
    for (const [species, count] of wave) {
      for (let n = 0; n < count && out.length < cap; n++) {
        let spot = this.room.center;
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

/** Waves of rift creatures; the doors seal until the last one falls. */
export class WaveChallenge extends Challenge {
  wave = 0;
  readonly live: number[] = [];
  private pause = 0;

  constructor(chamber: number, room: Chamber, readonly waves: readonly WaveSpec[]) {
    super(chamber, room);
  }

  update(dt: number, run: RunHooks, px: number, py: number): void {
    if (this.state === 'idle') {
      if (!inside(this.room.rect, px, py, 2)) return;
      this.state = 'active';
      run.setDoor(this.chamber - 1, true);
      run.emit({ type: 'started', chamber: this.chamber, kind: 'combat' });
      run.emit({ type: 'notice', text: 'The doors seal. Something crawls out of the cracks…' });
      this.send(run, px, py);
      return;
    }
    if (this.state !== 'active' || this.live.length) return;
    this.pause -= dt;
    if (this.pause > 0) return;
    if (++this.wave < this.waves.length) {
      this.send(run, px, py);
      return;
    }
    run.setDoor(this.chamber - 1, false);
    run.emit({ type: 'notice', text: 'The chamber falls quiet. The doors open.' });
    this.finish(run);
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

  reset(run: RunHooks): void {
    if (this.state !== 'active') return;
    for (const id of this.live) run.emit({ type: 'despawn', id });
    this.live.length = 0;
    this.wave = 0;
    this.state = 'idle';
    run.setDoor(this.chamber - 1, false);
  }
}

/** A path over the void: crumbling tiles fall a moment after they are stepped
 *  on and reform later; glitching tiles blink in and out on a timer. Reaching
 *  the far ledge finishes it. Falls return the player to the last pad. */
export class CrumblePath extends Challenge {
  /** Seconds since each path tile was stepped on; 0 while untouched. */
  readonly timers: Float32Array;
  /** Last checkpoint touched, an index into `room.checkpoints`. */
  checkpoint = 0;
  /** Path index of each tile, or -1. */
  private readonly index: Int16Array;

  constructor(chamber: number, room: Chamber, layout: DimensionLayout, readonly tuning: HazardTuning) {
    super(chamber, room);
    this.timers = new Float32Array(room.path.length);
    this.index = new Int16Array(layout.w * layout.h).fill(-1);
    room.path.forEach((t, i) => (this.index[t] = i));
  }

  update(dt: number, run: RunHooks, px: number, py: number, tile: number): void {
    const { crumbleDelay, reform } = this.tuning;
    const timers = this.timers;
    for (let i = 0; i < timers.length; i++) {
      if (timers[i] === 0) continue;
      timers[i] += dt;
      if (timers[i] >= crumbleDelay + reform) timers[i] = 0;
    }
    if (this.state === 'idle' && inside(this.room.rect, px, py, 0)) {
      this.state = 'active';
      run.setCheckpoint(this.room.checkpoints[0]);
      run.emit({ type: 'started', chamber: this.chamber, kind: 'hazard' });
    }
    if (this.state === 'idle') return;
    const i = tile >= 0 ? this.index[tile] : -1;
    if (i >= 0 && timers[i] === 0 && run.layout.tiles[tile] === DimTile.Crumble) timers[i] = 1e-4;
    const cps = this.room.checkpoints;
    for (let k = this.checkpoint + 1; k < cps.length; k++) {
      if (Math.abs(cps[k].x - px) < 1.2 && Math.abs(cps[k].y - 0.5 - py) < 1.2) {
        this.checkpoint = k;
        run.setCheckpoint(cps[k]);
        run.emit({ type: 'checkpoint', x: cps[k].x, y: cps[k].y });
      }
    }
    const g = this.room.goal!;
    const gx = Math.floor(px);
    const gy = Math.floor(py - 0.15);
    if (this.state === 'active' && gx >= g.x && gy >= g.y && gx < g.x + g.w && gy < g.y + g.h) {
      run.emit({ type: 'notice', text: 'Solid ground again.' });
      this.finish(run);
    }
  }

  /** Crumbling tiles: 0 whole, between 0 and 1 cracking, 1 fallen. */
  tileState(t: number): number {
    const i = this.index[t];
    const s = i < 0 ? 0 : this.timers[i];
    if (s === 0) return 0;
    return s < this.tuning.crumbleDelay ? s / this.tuning.crumbleDelay : 1;
  }

  /** Glitch state of a path tile, with its phase. */
  glitch(t: number, time: number, phase: number): number {
    return this.index[t] < 0 ? 0 : glitchState(time, this.tuning, phase);
  }

  /** A fall puts every tile back, so the way is always open again. */
  restore(): void {
    this.timers.fill(0);
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
  private last = -1;

  update(_dt: number, run: RunHooks, px: number, py: number, tile: number): void {
    if (this.state === 'done') return;
    if (this.state === 'idle') {
      if (!inside(this.room.rect, px, py, 1)) return;
      this.state = 'active';
      run.emit({ type: 'started', chamber: this.chamber, kind: 'puzzle' });
      run.emit({ type: 'notice', text: 'Glyph stones glow, one after another…' });
    }
    if (tile === this.last) return;
    this.last = tile;
    const { tiles, glyphs } = run.layout;
    if (tile < 0 || tiles[tile] !== DimTile.Plate) return;
    const g = glyphs[tile];
    if (this.pressed[g]) return;
    const order = this.room.order;
    if (g === order[this.step]) {
      this.pressed[g] = 1;
      this.step++;
      run.emit({ type: 'plate', step: this.step, of: order.length });
      if (this.step === order.length) {
        run.emit({ type: 'notice', text: 'The glyphs blaze. A door grinds open.' });
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
    const room = this.room;
    const k = room.mural.indexOf(t);
    if (k < 0) {
      const g = room.plates.indexOf(t);
      return g >= 0 ? this.pressed[g] : 0;
    }
    if (this.done || k < this.step) return 1;
    // The hint lights the stones in order, then rests for two beats.
    return Math.floor(time / HINT_SLOT) % (room.order.length + 2) === k ? 0.5 : 0;
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

  constructor(
    chamber: number,
    room: Chamber,
    readonly species: Species,
    readonly phases: readonly BossPhase[],
    readonly addCap: number,
  ) {
    super(chamber, room);
  }

  update(_dt: number, run: RunHooks, px: number, py: number): void {
    if (this.state === 'idle') {
      if (!inside(this.room.rect, px, py, 3)) return;
      this.state = 'active';
      this.share = 1;
      this.phase = 0;
      run.setDoor(this.chamber - 1, true);
      const c = this.room.center;
      this.bossId = run.spawn(this.species, c.x, c.y, true);
      run.emit({ type: 'started', chamber: this.chamber, kind: 'boss' });
      run.emit({ type: 'notice', text: `${this.species.name} awakens!` });
      return;
    }
    if (this.state !== 'active') return;
    while (this.phase < this.phases.length && this.share <= this.phases[this.phase].below) {
      const ph = this.phases[this.phase++];
      run.emit({ type: 'bossPhase', phase: this.phase, cooldownScale: ph.cooldownScale, speedScale: ph.speedScale });
      run.emit({ type: 'notice', text: ph.text });
      this.spawnGroup(run, ph.adds, px, py, this.adds, this.addCap);
    }
  }

  health(id: number, share: number): void {
    if (id === this.bossId) this.share = share;
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
    run.setDoor(this.chamber - 1, false);
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
    run.setDoor(this.chamber - 1, false);
  }
}

/** One trip into a dimension, from the arrival to the closed rift. */
export class DimensionRun implements RunHooks {
  readonly layout: DimensionLayout;
  /** Challenge per chamber; null for the arrival and the vault. */
  readonly challenges: ReadonlyArray<Challenge | null>;
  time = 0;
  /** The portal was taken: the rift is closed. */
  closed = false;
  chestOpened = false;
  /** Where a fall returns the player (feet). */
  checkpoint: Point;
  /** Sealed state per door. */
  private readonly sealed: Uint8Array;
  /** Door index of each tile, or -1. */
  private readonly doorOf: Int8Array;
  /** Chamber whose challenge owns a tile (path, plates, mural), or -1. */
  private readonly owner: Int8Array;
  private queue: DimEvent[] = [];
  private spare: DimEvent[] = [];
  private nextId = 1;
  private lastTile = -1;
  /** The player has stepped off the rift since arriving. */
  private offRift = false;
  private fallGrace = 0;
  private readonly bossChamber: number;

  constructor(
    readonly def: DimensionDef,
    readonly seed: number,
  ) {
    const L = (this.layout = def.generate(seed));
    this.checkpoint = L.arrival;
    const n = L.w * L.h;
    this.doorOf = new Int8Array(n).fill(-1);
    this.owner = new Int8Array(n).fill(-1);
    L.doors.forEach((d, k) => d.forEach((t) => (this.doorOf[t] = k)));
    this.challenges = L.chambers.map((ch, i) => {
      switch (ch.kind) {
        case 'combat':
          return new WaveChallenge(i, ch, def.waves);
        case 'hazard':
          return new CrumblePath(i, ch, L, def.hazard);
        case 'puzzle':
          return new PlatePuzzle(i, ch);
        case 'boss':
          return new BossChallenge(i, ch, def.boss.species, def.boss.phases, def.boss.addCap);
        default:
          return null;
      }
    });
    L.chambers.forEach((ch, i) => {
      for (const t of ch.path) this.owner[t] = i;
      for (const t of ch.plates) if (t >= 0) this.owner[t] = i;
      for (const t of ch.mural) this.owner[t] = i;
    });
    this.bossChamber = L.chambers.findIndex((c) => c.kind === 'boss');
    // A door is open from the start if the chamber before it has nothing to do.
    this.sealed = new Uint8Array(L.doors.length);
    for (let k = 0; k < L.doors.length; k++) this.sealed[k] = this.challenges[k] ? 1 : 0;
  }

  // Per-frame input ------------------------------------------------------------

  /** Steps the run with the player's feet (tiles). */
  update(dt: number, px: number, py: number): void {
    if (this.closed) return;
    this.time += dt;
    this.fallGrace = Math.max(0, this.fallGrace - dt);
    const L = this.layout;
    const gx = Math.floor(px);
    const gy = Math.floor(py - 0.15);
    const tile = gx >= 0 && gy >= 0 && gx < L.w && gy < L.h ? gy * L.w + gx : -1;
    for (const c of this.challenges) c?.update(dt, this, px, py, tile);

    if (tile >= 0 && this.fallGrace === 0 && this.hole(tile)) this.fall();
    const t = tile >= 0 ? L.tiles[tile] : DimTile.Void;
    if (t !== DimTile.Rift) this.offRift = true;
    else if (tile !== this.lastTile && this.offRift) this.emit({ type: 'leave' });
    if (tile === L.portal && this.portalOpen) {
      if (!this.chestOpened) this.openChest();
      this.closed = true;
      this.emit({ type: 'notice', text: `The rift to ${this.def.name} seals behind you.` });
      this.emit({ type: 'closed' });
    }
    this.lastTile = tile;
  }

  /** An enemy the run spawned died. */
  enemyKilled(id: number): void {
    for (const c of this.challenges) if (c?.killed(id, this)) return;
  }

  /** An enemy's health share (0–1); the boss's drives its phases. */
  enemyHealth(id: number, share: number): void {
    for (const c of this.challenges) c?.health(id, share);
  }

  /** The player pressed interact facing a tile; true if something happened. */
  interact(gx: number, gy: number): boolean {
    if (!this.canInteract(gx, gy)) return false;
    this.openChest();
    return true;
  }

  canInteract(gx: number, gy: number): boolean {
    return this.index(gx, gy) === this.layout.chest && this.portalOpen && !this.chestOpened;
  }

  /** The active fight starts over: its enemies leave and its doors open. Move the
   *  player to `safePoint` (e.g. after they died). */
  resetActive(): void {
    for (const c of this.challenges) c?.reset(this);
  }

  /** For testing (the playground): every challenge before `chamber` counts as
   *  done and its doors open. Move the player to that chamber's `entry`. */
  skipTo(chamber: number): void {
    const n = Math.min(chamber, this.challenges.length);
    for (let i = 0; i < n; i++) {
      const c = this.challenges[i];
      if (c && !c.done) {
        c.reset(this);
        c.state = 'done';
      }
      if (i < this.layout.doors.length) this.setDoor(i, false);
    }
    this.checkpoint = this.layout.chambers[Math.min(chamber, this.layout.chambers.length - 1)].entry;
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

  /** Index of the first chamber still to be done (the vault once all are). */
  get current(): number {
    const cs = this.challenges;
    for (let i = 0; i < cs.length; i++) if (cs[i] && !cs[i]!.done) return i;
    return cs.length - 1;
  }

  /** Outside the current chamber's door: where to put the player back after a death. */
  get safePoint(): Point {
    return this.layout.chambers[this.current].entry;
  }

  get portalOpen(): boolean {
    return this.bossChamber < 0 || !!this.challenges[this.bossChamber]?.done;
  }

  /** The boss's challenge, for a health bar or phase. */
  get boss(): BossChallenge | null {
    const c = this.bossChamber >= 0 ? this.challenges[this.bossChamber] : null;
    return c instanceof BossChallenge ? c : null;
  }

  /** The tile at a spot; `Void` outside the space. */
  tileAt(gx: number, gy: number): number {
    const i = this.index(gx, gy);
    return i < 0 ? DimTile.Void : this.layout.tiles[i];
  }

  /** Glyph shown on a plate or mural stone, or `NO_GLYPH`. */
  glyphAt(gx: number, gy: number): number {
    const i = this.index(gx, gy);
    return i < 0 ? NO_GLYPH : this.layout.glyphs[i];
  }

  /** Collision for the player: walls and props, sealed doors, and everything
   *  outside the space. The void is open: walking onto it is a fall. */
  isSolid(gx: number, gy: number): boolean {
    const i = this.index(gx, gy);
    if (i < 0) return true;
    const t = this.layout.tiles[i];
    if (t === DimTile.Door) return this.sealed[this.doorOf[i]] === 1;
    return isSolidDim(t);
  }

  /** Collision for walking enemies: the player's, plus the void and gaps in the path. */
  blocksEnemies(gx: number, gy: number): boolean {
    return this.isSolid(gx, gy) || this.hole(this.index(gx, gy));
  }

  /** Nothing to stand on: the void, a fallen tile or a glitched-out one. */
  isHole(gx: number, gy: number): boolean {
    return this.hole(this.index(gx, gy));
  }

  /** Live state of a tile, by kind. Doors: 1 sealed. Crumbling: 0 whole,
   *  between 0 and 1 cracking, 1 fallen. Glitching: 0 there, between 0 and 1
   *  flickering, 1 gone. Plates: 1 pressed. Mural stones: 1 done, 0.5 hinted.
   *  Portal: 1 open. Chest: 0 locked, 1 ready, 2 opened. */
  state(gx: number, gy: number): number {
    return this.stateOf(this.index(gx, gy));
  }

  /** `state` by tile index. */
  stateOf(i: number): number {
    if (i < 0) return 0;
    const L = this.layout;
    switch (L.tiles[i]) {
      case DimTile.Door:
        return this.sealed[this.doorOf[i]];
      case DimTile.Portal:
        return this.portalOpen ? 1 : 0;
      case DimTile.Chest:
        return this.chestOpened ? 2 : this.portalOpen ? 1 : 0;
      case DimTile.Glitch: {
        const c = this.challenges[this.owner[i]];
        return c instanceof CrumblePath ? c.glitch(i, this.time, L.phase[i]) : 0;
      }
      case DimTile.Crumble:
      case DimTile.Plate:
      case DimTile.Glyph: {
        const o = this.owner[i];
        return o >= 0 ? (this.challenges[o]?.tileState(i, this.time) ?? 0) : 0;
      }
      default:
        return 0;
    }
  }

  doorSealed(door: number): boolean {
    return this.sealed[door] === 1;
  }

  // RunHooks ---------------------------------------------------------------------

  emit(e: DimEvent): void {
    this.queue.push(e);
  }

  spawn(species: Species, x: number, y: number, boss: boolean): number {
    const id = this.nextId++;
    this.emit({ type: 'spawn', id, species, x, y, boss });
    return id;
  }

  setDoor(door: number, sealed: boolean): void {
    if (door < 0 || door >= this.sealed.length || (this.sealed[door] === 1) === sealed) return;
    this.sealed[door] = sealed ? 1 : 0;
    this.emit({ type: 'door', door, open: !sealed });
  }

  setCheckpoint(p: Point): void {
    this.checkpoint = p;
  }

  // ------------------------------------------------------------------------------

  private index(gx: number, gy: number): number {
    const L = this.layout;
    return gx >= 0 && gy >= 0 && gx < L.w && gy < L.h ? gy * L.w + gx : -1;
  }

  private hole(i: number): boolean {
    if (i < 0) return true;
    const t = this.layout.tiles[i];
    if (t === DimTile.Void) return true;
    return (t === DimTile.Crumble || t === DimTile.Glitch) && this.stateOf(i) >= 1;
  }

  private fall(): void {
    this.fallGrace = FALL_GRACE;
    // A fall on the path puts its tiles back, so the way is open again.
    for (const c of this.challenges) if (c instanceof CrumblePath && c.state !== 'idle') c.restore();
    const p = this.checkpoint;
    this.emit({ type: 'fell', damage: this.def.hazard.fallDamage, x: p.x, y: p.y });
    this.emit({ type: 'notice', text: 'You fall through the void…' });
  }

  private openChest(): void {
    if (this.chestOpened) return;
    this.chestOpened = true;
    const rng = new Rng(hash(this.seed, 0x7e3a));
    const items: Array<{ item: string; count: number }> = [];
    for (const r of this.def.rewards) if (rng.chance(r.chance)) items.push({ item: r.item, count: rng.int(r.min, r.max) });
    this.emit({ type: 'reward', items });
  }
}
