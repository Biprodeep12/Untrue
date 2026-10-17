import { afterEach, describe, expect, it, vi } from 'vitest';
import { SPECIES } from '../entities/Species';
import { BossChallenge, CrumblePath, DimensionRun, glitchState, PlatePuzzle, WaveChallenge, type DimEvent } from './Challenges';
import type { Chamber, Point } from './Dimension';
import { DimTile } from './DimTile';
import { HOLLOW } from './Hollow';

const SEED = 1234;

function feetOf(run: DimensionRun, t: number): Point {
  const w = run.layout.w;
  return { x: (t % w) + 0.5, y: Math.floor(t / w) + 0.9 };
}

/** Stands the player at `p` for `seconds`, in frames; returns every event. */
function stand(run: DimensionRun, p: Point, seconds = 1 / 60, dt = 1 / 60): DimEvent[] {
  const out: DimEvent[] = [];
  for (let t = 0; t < seconds - 1e-9; t += dt) {
    run.update(dt, p.x, p.y);
    out.push(...run.takeEvents());
  }
  return out;
}

const ofType = <T extends DimEvent['type']>(es: DimEvent[], type: T) => es.filter((e): e is Extract<DimEvent, { type: T }> => e.type === type);

/** Kills every enemy spawned in these events. */
function killAll(run: DimensionRun, es: DimEvent[]): void {
  for (const e of ofType(es, 'spawn')) run.enemyKilled(e.id);
}

function clearCombat(run: DimensionRun): DimEvent[] {
  const room = run.layout.chambers[1];
  const all: DimEvent[] = [];
  let es = stand(run, room.center);
  for (let guard = 0; guard < 20 && !run.challenges[1]!.done; guard++) {
    all.push(...es);
    killAll(run, es);
    es = stand(run, room.center, 2);
  }
  all.push(...es);
  return all;
}

/** Plain floor well inside a chamber (its centre may hold a plate or a pillar). */
function floorIn(run: DimensionRun, room: Chamber): Point {
  const r = room.rect;
  for (let y = r.y + 3; y < r.y + r.h - 3; y++) {
    for (let x = r.x + 3; x < r.x + r.w - 3; x++) if (run.tileAt(x, y) === DimTile.Floor) return { x: x + 0.5, y: y + 0.9 };
  }
  throw new Error('no floor');
}

function solvePuzzle(run: DimensionRun): DimEvent[] {
  const room = run.layout.chambers[3];
  const spot = floorIn(run, room);
  const es = stand(run, spot);
  for (const g of room.order) {
    es.push(...stand(run, feetOf(run, room.plates[g])));
    es.push(...stand(run, spot));
  }
  return es;
}

afterEach(() => vi.restoreAllMocks());

describe('doors and collision', () => {
  it('opens only the arrival door at first', () => {
    const run = new DimensionRun(HOLLOW, SEED);
    expect(run.doorSealed(0)).toBe(false);
    for (let k = 1; k < run.layout.doors.length; k++) expect(run.doorSealed(k)).toBe(true);
    const t = run.layout.doors[1][1];
    const w = run.layout.w;
    expect(run.isSolid(t % w, Math.floor(t / w))).toBe(true);
    expect(run.state(t % w, Math.floor(t / w))).toBe(1);
    expect(run.isSolid(-1, 0)).toBe(true);
    expect(run.tileAt(-1, 0)).toBe(DimTile.Void);
  });

  it('lets the void be walked onto, but not by enemies', () => {
    const run = new DimensionRun(HOLLOW, SEED);
    const r = run.layout.chambers[2].rect;
    let found = false;
    for (let y = r.y + 1; y < r.y + r.h - 1 && !found; y++) {
      for (let x = r.x + 1; x < r.x + r.w - 1 && !found; x++) {
        if (run.tileAt(x, y) !== DimTile.Void) continue;
        found = true;
        expect(run.isSolid(x, y)).toBe(false);
        expect(run.isHole(x, y)).toBe(true);
        expect(run.blocksEnemies(x, y)).toBe(true);
      }
    }
    expect(found).toBe(true);
  });
});

describe('WaveChallenge', () => {
  it('seals the doors, sends every wave, and opens them once the last falls', () => {
    const run = new DimensionRun(HOLLOW, SEED);
    const wave = run.challenges[1] as WaveChallenge;
    stand(run, run.layout.arrival);
    expect(wave.state).toBe('idle');
    const first = stand(run, run.layout.chambers[1].center);
    expect(ofType(first, 'door')).toEqual([{ type: 'door', door: 0, open: false }]);
    expect(ofType(first, 'spawn').length).toBe(4);
    expect(ofType(first, 'wave')[0]).toMatchObject({ wave: 1, of: 3 });
    // Nothing more comes while enemies live.
    expect(ofType(stand(run, run.layout.chambers[1].center, 3), 'spawn').length).toBe(0);
    killAll(run, first);
    const all = clearCombat(run);
    expect(ofType(all, 'wave').map((e) => e.wave)).toEqual([2, 3]);
    expect(wave.done).toBe(true);
    expect(run.doorSealed(0)).toBe(false);
    expect(run.doorSealed(1)).toBe(false);
    expect(ofType(all, 'cleared')[0]).toMatchObject({ chamber: 1, kind: 'combat' });
  });

  it('spawns away from the player, at the chamber spots', () => {
    const run = new DimensionRun(HOLLOW, SEED);
    const room = run.layout.chambers[1];
    for (const e of ofType(stand(run, room.center), 'spawn')) {
      expect(Math.hypot(e.x - room.center.x, e.y - room.center.y)).toBeGreaterThanOrEqual(4);
      expect(room.spawns.some((s) => s.x === e.x && s.y === e.y)).toBe(true);
      expect([SPECIES.glitchling, SPECIES.shardWisp]).toContain(e.species);
    }
  });

  it('starts over on reset, sending its enemies away', () => {
    const run = new DimensionRun(HOLLOW, SEED);
    const spawned = ofType(stand(run, run.layout.chambers[1].center), 'spawn');
    run.resetActive();
    const es = run.takeEvents() as DimEvent[];
    expect(ofType(es, 'despawn').map((e) => e.id).sort()).toEqual(spawned.map((e) => e.id).sort());
    expect(run.doorSealed(0)).toBe(false);
    expect(run.challenges[1]!.state).toBe('idle');
    expect(run.safePoint).toEqual(run.layout.chambers[1].entry);
  });
});

describe('CrumblePath', () => {
  function onHazard(): { run: DimensionRun; path: CrumblePath } {
    const run = new DimensionRun(HOLLOW, SEED);
    clearCombat(run);
    const path = run.challenges[2] as CrumblePath;
    stand(run, path.room.checkpoints[0]);
    expect(path.state).toBe('active');
    return { run, path };
  }

  it('crumbles a tile a moment after it is stepped on, and drops the player', () => {
    const { run, path } = onHazard();
    const t = path.room.path.find((i) => run.layout.tiles[i] === DimTile.Crumble)!;
    const p = feetOf(run, t);
    const w = run.layout.w;
    const gx = t % w;
    const gy = Math.floor(t / w);
    expect(run.state(gx, gy)).toBe(0);
    stand(run, p, 0.2);
    const cracking = run.state(gx, gy);
    expect(cracking).toBeGreaterThan(0);
    expect(cracking).toBeLessThan(1);
    expect(run.isHole(gx, gy)).toBe(false);
    let fell: DimEvent[] = [];
    for (let k = 0; k < 120 && !fell.length; k++) fell = ofType(stand(run, p), 'fell');
    expect(fell[0]).toMatchObject({ damage: HOLLOW.hazard.fallDamage, x: path.room.checkpoints[0].x, y: path.room.checkpoints[0].y });
    // The fall puts the path back.
    expect(run.state(gx, gy)).toBe(0);
  });

  it('reforms fallen tiles after a while', () => {
    const { run, path } = onHazard();
    const t = path.room.path.find((i) => run.layout.tiles[i] === DimTile.Crumble)!;
    const w = run.layout.w;
    stand(run, feetOf(run, t), 0.1);
    // Step off before it falls.
    stand(run, path.room.checkpoints[0], HOLLOW.hazard.crumbleDelay);
    expect(run.state(t % w, Math.floor(t / w))).toBe(1);
    stand(run, path.room.checkpoints[0], HOLLOW.hazard.reform);
    expect(run.state(t % w, Math.floor(t / w))).toBe(0);
  });

  it('returns a fall to the last pad touched', () => {
    const { run, path } = onHazard();
    const pad = path.room.checkpoints[1];
    const es = stand(run, pad);
    expect(ofType(es, 'checkpoint')[0]).toMatchObject({ x: pad.x, y: pad.y });
    const t = path.room.path.find((i) => run.layout.tiles[i] === DimTile.Crumble)!;
    const fell = ofType(stand(run, feetOf(run, t), 1), 'fell');
    expect(fell[0]).toMatchObject({ x: pad.x, y: pad.y });
  });

  it('blinks glitching tiles in and out', () => {
    const tu = HOLLOW.hazard;
    expect(glitchState(0, tu, 0)).toBe(0);
    const warn = glitchState(tu.glitchOn - tu.glitchWarn / 2, tu, 0);
    expect(warn).toBeGreaterThan(0);
    expect(warn).toBeLessThan(1);
    expect(glitchState(tu.glitchOn + 0.1, tu, 0)).toBe(1);
    expect(glitchState(tu.glitchOn + tu.glitchOff + 0.1, tu, 0)).toBe(0);
    // A phase shifts the cycle.
    expect(glitchState(0, tu, 128)).not.toBe(glitchState(0, tu, 0));
  });

  it('is finished by reaching the far ledge', () => {
    const { run, path } = onHazard();
    const g = path.room.goal!;
    const es = stand(run, { x: g.x + 0.5, y: g.y + 0.9 });
    expect(path.done).toBe(true);
    expect(ofType(es, 'door')).toContainEqual({ type: 'door', door: 2, open: true });
  });
});

describe('PlatePuzzle', () => {
  function atPuzzle(): { run: DimensionRun; puzzle: PlatePuzzle } {
    const run = new DimensionRun(HOLLOW, SEED);
    clearCombat(run);
    const g = run.layout.chambers[2].goal!;
    stand(run, run.layout.chambers[2].checkpoints[0]);
    stand(run, { x: g.x + 0.5, y: g.y + 0.9 });
    return { run, puzzle: run.challenges[3] as PlatePuzzle };
  }

  it('resets on a plate pressed out of order', () => {
    const { run, puzzle } = atPuzzle();
    const room = puzzle.room;
    stand(run, floorIn(run, room));
    stand(run, feetOf(run, room.plates[room.order[0]]));
    expect(puzzle.step).toBe(1);
    const w = run.layout.w;
    const p0 = room.plates[room.order[0]];
    expect(run.state(p0 % w, Math.floor(p0 / w))).toBe(1);
    const es = stand(run, feetOf(run, room.plates[room.order[2]]));
    expect(ofType(es, 'puzzleReset').length).toBe(1);
    expect(puzzle.step).toBe(0);
    expect(run.state(p0 % w, Math.floor(p0 / w))).toBe(0);
    expect(run.doorSealed(3)).toBe(true);
  });

  it('opens the arena door when pressed in the mural order', () => {
    const { run, puzzle } = atPuzzle();
    const es = solvePuzzle(run);
    expect(ofType(es, 'plate').map((e) => e.step)).toEqual(puzzle.room.order.map((_, k) => k + 1));
    expect(puzzle.done).toBe(true);
    expect(run.doorSealed(3)).toBe(false);
    const m = puzzle.room.mural[0];
    expect(run.stateOf(m)).toBe(1);
  });

  it('hints the order by lighting the mural stones one by one', () => {
    const { run, puzzle } = atPuzzle();
    const spot = floorIn(run, puzzle.room);
    stand(run, spot);
    const lit = new Set<number>();
    for (let k = 0; k < 60; k++) {
      stand(run, spot, 0.35);
      puzzle.room.mural.forEach((t, i) => run.stateOf(t) === 0.5 && lit.add(i));
    }
    expect(lit.size).toBe(puzzle.room.order.length);
  });
});

describe('BossChallenge', () => {
  function atArena(): { run: DimensionRun; boss: BossChallenge } {
    const run = new DimensionRun(HOLLOW, SEED);
    clearCombat(run);
    const hz = run.layout.chambers[2];
    stand(run, hz.checkpoints[0]);
    stand(run, { x: hz.goal!.x + 0.5, y: hz.goal!.y + 0.9 });
    solvePuzzle(run);
    return { run, boss: run.challenges[4] as BossChallenge };
  }

  it('wakes the Warden, then summons and quickens by health', () => {
    const { run, boss } = atArena();
    const room = boss.room;
    const es = stand(run, room.center);
    const spawn = ofType(es, 'spawn');
    expect(spawn).toHaveLength(1);
    expect(spawn[0]).toMatchObject({ species: SPECIES.riftWarden, boss: true, x: room.center.x, y: room.center.y });
    expect(run.doorSealed(3)).toBe(true);
    const id = spawn[0].id;

    run.enemyHealth(id, 0.8);
    expect(ofType(stand(run, room.center), 'bossPhase')).toHaveLength(0);
    run.enemyHealth(id, 0.6);
    let step = stand(run, room.center);
    expect(ofType(step, 'bossPhase')[0]).toMatchObject({ phase: 1, cooldownScale: 1 });
    expect(ofType(step, 'spawn').map((e) => e.species)).toEqual([SPECIES.glitchling, SPECIES.glitchling, SPECIES.glitchling]);
    run.enemyHealth(id, 0.2);
    step = stand(run, room.center);
    expect(ofType(step, 'bossPhase')[0]).toMatchObject({ phase: 2, cooldownScale: 0.55, speedScale: 1.35 });
    expect(boss.adds.length).toBe(5);
    expect(run.portalOpen).toBe(false);

    run.enemyKilled(id);
    const after = run.takeEvents() as DimEvent[];
    expect(ofType(after, 'despawn')).toHaveLength(5);
    expect(boss.done).toBe(true);
    expect(run.portalOpen).toBe(true);
    expect(run.doorSealed(3)).toBe(false);
    expect(run.doorSealed(4)).toBe(false);
  });

  it('keeps its summons under the cap', () => {
    const { run, boss } = atArena();
    const id = ofType(stand(run, boss.room.center), 'spawn')[0].id;
    run.enemyHealth(id, 0.1);
    stand(run, boss.room.center);
    expect(boss.adds.length).toBeLessThanOrEqual(HOLLOW.boss.addCap);
  });
});

describe('DimensionRun', () => {
  it('runs from the arrival to a closed rift, the same way for the same seed', () => {
    const play = () => {
      const run = new DimensionRun(HOLLOW, SEED);
      const L = run.layout;
      const log: DimEvent[] = [...stand(run, L.arrival, 0.5)];
      log.push(...clearCombat(run));
      const hz = L.chambers[2];
      log.push(...stand(run, hz.checkpoints[0]));
      log.push(...stand(run, { x: hz.goal!.x + 0.5, y: hz.goal!.y + 0.9 }));
      log.push(...solvePuzzle(run));
      const boss = ofType(stand(run, L.chambers[4].center), 'spawn')[0];
      run.enemyKilled(boss.id);
      log.push(...run.takeEvents());
      // The chest gives the reward once.
      const w = L.w;
      const cx = L.chest % w;
      const cy = Math.floor(L.chest / w);
      expect(run.canInteract(cx, cy)).toBe(true);
      expect(run.interact(cx, cy)).toBe(true);
      expect(run.interact(cx, cy)).toBe(false);
      expect(run.state(cx, cy)).toBe(2);
      log.push(...run.takeEvents());
      log.push(...stand(run, L.chambers[5].center));
      log.push(...stand(run, feetOf(run, L.portal)));
      expect(run.closed).toBe(true);
      return log;
    };
    const log = play();
    expect(ofType(log, 'cleared').map((e) => e.kind)).toEqual(['combat', 'hazard', 'puzzle', 'boss']);
    const rewards = ofType(log, 'reward');
    expect(rewards).toHaveLength(1);
    expect(rewards[0].items.find((i) => i.item === 'rift-shard')!.count).toBeGreaterThanOrEqual(3);
    expect(log[log.length - 1]).toEqual({ type: 'closed' });
    expect(play()).toEqual(log);
  });

  it('grants the reward on the way out if the chest was left', () => {
    const run = new DimensionRun(HOLLOW, SEED);
    clearCombat(run);
    const L = run.layout;
    const hz = L.chambers[2];
    stand(run, hz.checkpoints[0]);
    stand(run, { x: hz.goal!.x + 0.5, y: hz.goal!.y + 0.9 });
    solvePuzzle(run);
    run.enemyKilled(ofType(stand(run, L.chambers[4].center), 'spawn')[0].id);
    const es = stand(run, feetOf(run, L.portal));
    expect(ofType(es, 'reward')).toHaveLength(1);
    expect(ofType(es, 'closed')).toHaveLength(1);
  });

  it('does not open the portal early', () => {
    const run = new DimensionRun(HOLLOW, SEED);
    const es = stand(run, feetOf(run, run.layout.portal));
    expect(ofType(es, 'closed')).toHaveLength(0);
    expect(run.canInteract(run.layout.chest % run.layout.w, Math.floor(run.layout.chest / run.layout.w))).toBe(false);
  });

  it('lets the player leave by the rift they came in through', () => {
    const run = new DimensionRun(HOLLOW, SEED);
    const rift = feetOf(run, run.layout.rift);
    expect(ofType(stand(run, run.layout.arrival), 'leave')).toHaveLength(0);
    expect(ofType(stand(run, rift), 'leave')).toHaveLength(1);
    expect(ofType(stand(run, rift, 0.5), 'leave')).toHaveLength(0);
  });

  it('never uses Math.random', () => {
    const spy = vi.spyOn(Math, 'random');
    const run = new DimensionRun(HOLLOW, 9);
    clearCombat(run);
    stand(run, run.layout.chambers[2].checkpoints[0], 3);
    expect(spy).not.toHaveBeenCalled();
  });
});
