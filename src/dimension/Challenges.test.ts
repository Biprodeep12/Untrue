import { afterEach, describe, expect, it, vi } from 'vitest';
import { SPECIES } from '../entities/Species';
import { isSolid, isVoid, Tile } from '../generation/Tiles';
import { bakeHollow } from './bake/hollowMap';
import { BossChallenge, CrumblePath, DimensionRun, glitchState, PlatePuzzle, WaveChallenge, type DimEvent } from './Challenges';
import type { Point, Site, SiteKind } from './Dimension';
import { decodeDimension } from './DimensionData';
import { DimTile } from './DimTile';
import { HOLLOW } from './Hollow';

const SEED = 1234;
const L = decodeDimension(bakeHollow());
const siteOf = (kind: SiteKind) => L.sites.findIndex((s) => s.kind === kind);
const NEST = siteOf('combat');
const PATH = siteOf('hazard');
const HALL = siteOf('puzzle');
const ARENA = siteOf('boss');

function feetOf(t: number): Point {
  return { x: (t % L.w) + 0.5, y: Math.floor(t / L.w) + 0.9 };
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
const notices = (es: DimEvent[]) => ofType(es, 'notice').map((e) => e.text);

/** Kills every enemy spawned in these events. */
function killAll(run: DimensionRun, es: DimEvent[]): void {
  for (const e of ofType(es, 'spawn')) run.enemyKilled(e.id);
}

/** Open ground well inside a site: no site tile, nothing standing. */
function floorIn(site: Site): Point {
  const r = site.rect;
  for (let y = r.y + 3; y < r.y + r.h - 3; y++) {
    for (let x = r.x + 3; x < r.x + r.w - 3; x++) {
      const i = y * L.w + x;
      if (L.tiles[i] === DimTile.None && !isVoid(L.ground[i]) && !isSolid(L.ground[i], L.decos[i])) return { x: x + 0.5, y: y + 0.9 };
    }
  }
  throw new Error('no floor');
}

function clearNest(run: DimensionRun): DimEvent[] {
  const site = L.sites[NEST];
  const spot = floorIn(site);
  const all: DimEvent[] = [];
  let es = stand(run, spot);
  for (let guard = 0; guard < 20 && !run.challenges[NEST]!.done; guard++) {
    all.push(...es);
    killAll(run, es);
    es = stand(run, spot, 2);
  }
  all.push(...es);
  return all;
}

function solvePuzzle(run: DimensionRun): DimEvent[] {
  const site = L.sites[HALL];
  const spot = floorIn(site);
  const es = stand(run, spot);
  for (const g of site.order) {
    es.push(...stand(run, feetOf(site.plates[g])));
    es.push(...stand(run, spot));
  }
  return es;
}

/** Walks the path tile by tile, waiting out glitches, to the far side. */
function crossPath(run: DimensionRun): DimEvent[] {
  const site = L.sites[PATH];
  const es: DimEvent[] = [];
  for (const t of site.path) {
    for (let k = 0; k < 200 && run.stateOf(t) !== 0; k++) es.push(...stand(run, run.checkpoint, 0.05, 0.05));
    es.push(...stand(run, feetOf(t), 0.02, 0.02));
  }
  const g = site.goal!;
  es.push(...stand(run, { x: g.x + g.w / 2, y: g.y + g.h / 2 }));
  return es;
}

afterEach(() => vi.restoreAllMocks());

describe('gates and collision', () => {
  it('keeps every gate open but the Warden\'s, sealed until the trials are done', () => {
    const run = new DimensionRun(HOLLOW, L, SEED);
    expect(run.trials).toBe(3);
    expect(run.doorSealed(ARENA)).toBe(true);
    expect(run.bossOpen).toBe(false);
    const gate = L.sites[ARENA].gates[0];
    expect(run.isSolid(gate % L.w, Math.floor(gate / L.w))).toBe(true);
    for (let i = 0; i < L.sites.length; i++) if (i !== ARENA) expect(run.doorSealed(i)).toBe(false);
    const nestGate = L.sites[NEST].gates[0];
    expect(run.isSolid(nestGate % L.w, Math.floor(nestGate / L.w))).toBe(false);
  });

  it('never drops anyone into the void: it is no hole, and off the map is solid', () => {
    const run = new DimensionRun(HOLLOW, L, SEED);
    expect(isVoid(L.ground[0])).toBe(true);
    expect(run.isHole(0, 0)).toBe(false);
    expect(run.isHole(-5, 10)).toBe(false);
    expect(run.isSolid(-5, 10)).toBe(true);
    // Even standing on the void (as nobody can) is no slip.
    expect(stand(run, { x: 0.5, y: 0.9 }).some((e) => e.type === 'slip')).toBe(false);
  });
});

describe('WaveChallenge', () => {
  it('seals the gate, sends every wave, and opens it once the last falls', () => {
    const run = new DimensionRun(HOLLOW, L, SEED);
    const es = clearNest(run);
    expect(ofType(es, 'wave').map((e) => e.wave)).toEqual([1, 2, 3]);
    expect(ofType(es, 'door').map((e) => e.open)).toEqual([false, true]);
    const spawned = ofType(es, 'spawn');
    expect(spawned.length).toBe(4 + 5 + 6);
    expect(run.challenges[NEST]!.done).toBe(true);
    expect(run.trialsDone).toBe(1);
    expect(notices(es)).toContain("A seal breaks. 2 still bind the Warden's gate.");
  });

  it('spawns away from the player, at the nest\'s spots', () => {
    const run = new DimensionRun(HOLLOW, L, SEED);
    const site = L.sites[NEST];
    const p = floorIn(site);
    const es = stand(run, p);
    for (const s of ofType(es, 'spawn')) {
      expect(site.spawns.some((q) => q.x === s.x && q.y === s.y)).toBe(true);
      expect(Math.hypot(s.x - p.x, s.y - p.y)).toBeGreaterThanOrEqual(4);
    }
  });

  it('starts over on reset, sending its enemies away', () => {
    const run = new DimensionRun(HOLLOW, L, SEED);
    const es = stand(run, floorIn(L.sites[NEST]));
    const c = run.challenges[NEST] as WaveChallenge;
    c.reset(run);
    const out = run.takeEvents();
    expect(ofType([...out], 'despawn').length).toBe(ofType(es, 'spawn').length);
    expect(c.state).toBe('idle');
    expect(run.doorSealed(NEST)).toBe(false);
  });
});

describe('CrumblePath', () => {
  const site = L.sites[PATH];
  const crumble = site.path.find((t) => L.tiles[t] === DimTile.Crumble)!;

  it('crumbles a slab a moment after it is stepped on: it blocks the way, and whoever stood on it is thrown back to the ledge', () => {
    const run = new DimensionRun(HOLLOW, L, SEED);
    stand(run, site.checkpoints[0]);
    stand(run, feetOf(crumble));
    expect(run.stateOf(crumble)).toBeGreaterThan(0);
    expect(run.stateOf(crumble)).toBeLessThan(1);
    let slip: Extract<DimEvent, { type: 'slip' }> | undefined;
    for (let k = 0; k < 60 && !slip; k++) slip = ofType(stand(run, feetOf(crumble)), 'slip')[0];
    expect(slip).toBeTruthy();
    expect(slip!.damage).toBe(HOLLOW.hazard.slipDamage);
    expect([slip!.x, slip!.y]).toEqual([site.checkpoints[0].x, site.checkpoints[0].y]);
    // A slip puts the slabs back.
    expect(run.stateOf(crumble)).toBe(0);
  });

  it('reforms fallen tiles after a while', () => {
    const run = new DimensionRun(HOLLOW, L, SEED);
    stand(run, site.checkpoints[0]);
    stand(run, feetOf(crumble));
    stand(run, site.checkpoints[0], HOLLOW.hazard.crumbleDelay + 0.1);
    expect(run.stateOf(crumble)).toBe(1);
    stand(run, site.checkpoints[0], HOLLOW.hazard.reform);
    expect(run.stateOf(crumble)).toBe(0);
  });

  it('blinks glitching tiles in and out', () => {
    const tu = HOLLOW.hazard;
    expect(glitchState(0, tu, 0)).toBe(0);
    expect(glitchState(tu.glitchOn - tu.glitchWarn / 2, tu, 0)).toBeGreaterThan(0);
    expect(glitchState(tu.glitchOn + 0.1, tu, 0)).toBe(1);
    expect(site.path.some((t) => L.tiles[t] === DimTile.Glitch)).toBe(true);
  });

  it('is finished by reaching the far side, and then holds firm', () => {
    const run = new DimensionRun(HOLLOW, L, SEED);
    stand(run, site.checkpoints[0]);
    const es = crossPath(run);
    expect(run.challenges[PATH]!.done).toBe(true);
    expect(notices(es)).toContain('Solid ground again. Behind you, the path settles and holds.');
    for (const t of site.path) expect(run.stateOf(t)).toBe(0);
    stand(run, feetOf(crumble), 5);
    expect(run.stateOf(crumble)).toBe(0);
    expect(run.challenges[PATH]).toBeInstanceOf(CrumblePath);
  });
});

describe('PlatePuzzle', () => {
  const site = L.sites[HALL];

  it('resets on a plate pressed out of order', () => {
    const run = new DimensionRun(HOLLOW, L, SEED);
    stand(run, floorIn(site));
    const wrong = site.order[1];
    const es = stand(run, feetOf(site.plates[wrong]));
    expect(ofType(es, 'puzzleReset').length).toBe(1);
    expect((run.challenges[HALL] as PlatePuzzle).step).toBe(0);
  });

  it('counts as a trial when pressed in the mural order', () => {
    const run = new DimensionRun(HOLLOW, L, SEED);
    const es = solvePuzzle(run);
    expect(ofType(es, 'plate').map((e) => e.step)).toEqual(site.order.map((_, k) => k + 1));
    expect(run.challenges[HALL]!.done).toBe(true);
    expect(run.trialsDone).toBe(1);
    for (const t of site.mural) expect(run.stateOf(t)).toBe(1);
  });

  it('hints the order by lighting the mural stones one by one', () => {
    const run = new DimensionRun(HOLLOW, L, SEED);
    stand(run, floorIn(site));
    const lit = new Set<number>();
    for (let k = 0; k < 120; k++) {
      stand(run, floorIn(site), 0.1, 0.1);
      site.mural.forEach((t, j) => run.stateOf(t) === 0.5 && lit.add(j));
    }
    expect(lit.size).toBe(site.mural.length);
  });
});

describe('BossChallenge', () => {
  function readyForBoss(run: DimensionRun): DimEvent[] {
    const es = clearNest(run);
    es.push(...solvePuzzle(run));
    stand(run, L.sites[PATH].checkpoints[0]);
    es.push(...crossPath(run));
    return es;
  }

  it('opens the Warden\'s gate once the third seal breaks', () => {
    const run = new DimensionRun(HOLLOW, L, SEED);
    const es = readyForBoss(run);
    expect(run.trialsDone).toBe(3);
    expect(run.bossOpen).toBe(true);
    expect(run.doorSealed(ARENA)).toBe(false);
    expect(notices(es).some((t) => t.startsWith('The last seal breaks.'))).toBe(true);
  });

  it('wakes the Warden, then summons and quickens by health', () => {
    const run = new DimensionRun(HOLLOW, L, SEED);
    readyForBoss(run);
    const c = L.sites[ARENA].center;
    let es = stand(run, { x: c.x, y: c.y + 4 });
    const boss = ofType(es, 'spawn').find((e) => e.boss)!;
    expect(boss.species).toBe(SPECIES.riftWarden);
    expect(run.doorSealed(ARENA)).toBe(true);
    run.enemyHealth(boss.id, 0.5);
    es = stand(run, { x: c.x, y: c.y + 4 });
    expect(ofType(es, 'bossPhase').map((e) => e.phase)).toEqual([1]);
    run.enemyHealth(boss.id, 0.2);
    es = stand(run, { x: c.x, y: c.y + 4 });
    const ph = ofType(es, 'bossPhase')[0];
    expect(ph.speedScale).toBeGreaterThan(1);
    expect((run.challenges[ARENA] as BossChallenge).adds.length).toBeLessThanOrEqual(HOLLOW.boss.addCap);
    run.enemyKilled(boss.id);
    es = run.takeEvents() as DimEvent[];
    expect(run.portalOpen).toBe(true);
    expect(run.doorSealed(ARENA)).toBe(false);
  });
});

describe('DimensionRun', () => {
  it('runs from the arrival to a closed rift, the same way for the same seed', () => {
    const play = () => {
      const run = new DimensionRun(HOLLOW, L, SEED);
      run.skipTo(siteOf('vault'));
      expect(run.portalOpen).toBe(true);
      const es = stand(run, feetOf(L.portal));
      return { run, es };
    };
    const a = play();
    const b = play();
    expect(ofType(a.es, 'closed').length).toBe(1);
    expect(a.run.closed).toBe(true);
    expect(ofType(a.es, 'reward')).toEqual(ofType(b.es, 'reward'));
  });

  it('grants the reward from the chest, once', () => {
    const run = new DimensionRun(HOLLOW, L, SEED);
    const cx = L.chest % L.w;
    const cy = Math.floor(L.chest / L.w);
    expect(run.canOpenChest(cx, cy)).toBe(false);
    run.skipTo(siteOf('vault'));
    expect(run.interact(cx, cy)).toBe(true);
    expect(ofType([...run.takeEvents()], 'reward')[0].items.some((r) => r.item === 'rift-shard')).toBe(true);
    expect(run.interact(cx, cy)).toBe(false);
    // The portal does not pay twice.
    expect(ofType(stand(run, feetOf(L.portal)), 'reward').length).toBe(0);
  });

  it('does not open the portal early', () => {
    const run = new DimensionRun(HOLLOW, L, SEED);
    expect(ofType(stand(run, feetOf(L.portal)), 'closed').length).toBe(0);
    run.skipTo(siteOf('boss'));
    expect(run.bossOpen).toBe(true);
    expect(run.portalOpen).toBe(false);
  });

  it('lets the player leave by the rift they came in through', () => {
    const run = new DimensionRun(HOLLOW, L, SEED);
    stand(run, L.arrival);
    expect(run.interact(L.rift % L.w, Math.floor(L.rift / L.w))).toBe(true);
    expect(ofType([...run.takeEvents()], 'leave').length).toBe(1);
  });

  it('never uses Math.random', () => {
    const spy = vi.spyOn(Math, 'random');
    const run = new DimensionRun(HOLLOW, L, SEED);
    clearNest(run);
    solvePuzzle(run);
    run.skipTo(siteOf('vault'));
    stand(run, feetOf(L.portal));
    expect(spy).not.toHaveBeenCalled();
  });

  it('keeps the land under its sites as ground', () => {
    for (const s of L.sites) for (const t of s.gates) expect(L.ground[t]).toBe(Tile.RuinFloor);
  });
});
