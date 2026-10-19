import { describe, expect, it } from 'vitest';
import { bakeHollow } from './bake/hollowMap';
import { DimensionRun, WARDEN_RETURN, type DimEvent } from './Challenges';
import { Contribution, LOCAL, TRIAL_SCORE } from './Contribution';
import type { Point, SiteKind } from './Dimension';
import { decodeDimension } from './DimensionData';
import { HOLLOW } from './Hollow';

const L = decodeDimension(bakeHollow());
const siteOf = (kind: SiteKind) => L.sites.findIndex((s) => s.kind === kind);
const ARENA = siteOf('boss');
const feetOf = (t: number): Point => ({ x: (t % L.w) + 0.5, y: Math.floor(t / L.w) + 0.9 });

function stand(run: DimensionRun, p: Point, seconds = 1 / 60, dt = 1 / 60): DimEvent[] {
  const out: DimEvent[] = [];
  for (let t = 0; t < seconds - 1e-9; t += dt) {
    run.update(dt, p.x, p.y);
    out.push(...run.takeEvents());
  }
  return out;
}
const ofType = <T extends DimEvent['type']>(es: DimEvent[], type: T) => es.filter((e): e is Extract<DimEvent, { type: T }> => e.type === type);

/** Breaks the trials (as the playground does), wakes the Warden with the
 *  local player in its arena, and returns its id. */
function wakeWarden(run: DimensionRun): number {
  run.skipTo(ARENA);
  const c = L.sites[ARENA].center;
  const es = stand(run, { x: c.x, y: c.y + 4 });
  return ofType(es, 'spawn').find((e) => e.boss)!.id;
}

describe('Contribution', () => {
  it('gives a lone player everything', () => {
    const c = new Contribution();
    c.join(LOCAL);
    expect(c.share(LOCAL)).toBe(1);
    c.damage(LOCAL, 40);
    const s = c.settle([{ item: 'rift-shard', count: 4 }], 150).get(LOCAL)!;
    expect(s).toEqual({ share: 1, attuned: true, xp: 150, items: [{ item: 'rift-shard', count: 4 }] });
  });

  it('shares by score: trials split among those there, damage point for point', () => {
    const c = new Contribution();
    for (const p of ['a', 'b', 'c']) c.join(p);
    c.trial(['a', 'b']);
    expect([c.score('a'), c.score('b')]).toEqual([TRIAL_SCORE / 2, TRIAL_SCORE / 2]);
    c.damage('a', 250);
    c.damage('c', 10);
    c.damage('c', -5);
    c.damage('c', Number.NaN);
    const s = c.settle([{ item: 'rift-shard', count: 5 }, { item: 'coin', count: 40 }], 150);
    const a = s.get('a')!;
    const b = s.get('b')!;
    const x = s.get('c')!;
    expect(a.share).toBeCloseTo(300 / 360);
    // Rounding's leftovers go to the top scorer.
    expect(a.items).toEqual([{ item: 'rift-shard', count: 5 }, { item: 'coin', count: 34 }]);
    expect(b.items).toEqual([{ item: 'coin', count: 5 }]);
    expect(x.items).toEqual([{ item: 'coin', count: 1 }]);
    // Every item is handed out, no more.
    for (const [item, count] of [['rift-shard', 5], ['coin', 40]] as const) {
      expect([a, b, x].reduce((n, p) => n + (p.items.find((i) => i.item === item)?.count ?? 0), 0)).toBe(count);
    }
    // Attuned by share or by a trial broken; experience by share, with a floor for the attuned.
    expect([a.attuned, b.attuned, x.attuned]).toEqual([true, true, false]);
    expect([a.xp, b.xp, x.xp]).toEqual([125, 38, 4]);
  });

  it('shares alike when nobody scored, and starts over on reset', () => {
    const c = new Contribution();
    c.join('a');
    c.join('b');
    expect([c.share('a'), c.share('b'), c.share('stranger')]).toEqual([0.5, 0.5, 0]);
    c.trial(['a']);
    c.reset();
    expect([c.score('a'), c.attuned('a'), c.share('a')]).toEqual([0, true, 0.5]);
    expect(c.players).toEqual(['a', 'b']);
  });
});

describe('a run with several players', () => {
  it('settles the Warden by who fought it: shares of the vault, and who the portal answers', () => {
    const run = new DimensionRun(HOLLOW, L, 77);
    run.join('guest', L.arrival.x, L.arrival.y);
    const boss = wakeWarden(run);
    run.damage(LOCAL, boss, 300);
    run.damage('guest', boss, 100);
    // Roamers and strangers' blows on anything else count for nothing.
    run.damage('guest', 9999, 500);
    run.enemyKilled(boss);
    run.takeEvents();
    expect(run.portalOpen).toBe(true);
    const mine = run.share(LOCAL);
    const theirs = run.share('guest');
    expect([mine.share, theirs.share]).toEqual([0.75, 0.25]);
    expect([mine.attuned, theirs.attuned]).toEqual([true, true]);
    const es = stand(run, feetOf(L.portal));
    const reward = ofType(es, 'reward');
    expect(reward.map((e) => e.player)).toEqual([LOCAL]);
    expect(reward[0].items).toEqual(mine.items);
    const closed = ofType(es, 'closed')[0];
    expect(closed).toEqual({ type: 'closed', player: LOCAL, xp: Math.round(HOLLOW.closeXp * 0.75) });
  });

  it('keeps the portal shut to a player who took no part', () => {
    const run = new DimensionRun(HOLLOW, L, 77);
    run.join('guest', L.arrival.x, L.arrival.y);
    const boss = wakeWarden(run);
    run.damage('guest', boss, 500);
    run.enemyKilled(boss);
    run.takeEvents();
    expect(run.share(LOCAL).attuned).toBe(false);
    const es = stand(run, feetOf(L.portal), 0.5);
    expect(ofType(es, 'closed')).toEqual([]);
    expect(ofType(es, 'notice').length).toBe(1);
    expect(run.closed).toBe(false);
  });

  it('scores a trial for the players who took part in it', () => {
    const run = new DimensionRun(HOLLOW, L, 77);
    run.shared = true;
    const site = L.sites[siteOf('puzzle')];
    run.join('guest', site.center.x, site.center.y);
    run.join('far', L.arrival.x, L.arrival.y);
    // The guest spent a while in the hall; the others were elsewhere.
    run.challenges[siteOf('puzzle')]!.present.set('guest', 10);
    run.challenges[siteOf('puzzle')]!.present.set('far', 1);
    // As the hall's challenge reports its trial broken.
    run.emit({ type: 'cleared', site: siteOf('puzzle'), kind: 'puzzle' });
    expect(run.contribution.score('guest')).toBe(TRIAL_SCORE);
    expect(run.contribution.score(LOCAL)).toBe(0);
    expect(run.contribution.score('far')).toBe(0);
  });
});

describe('a shared instance', () => {
  it('brings the Warden back a while after it falls, for a new tally', () => {
    const run = new DimensionRun(HOLLOW, L, 5);
    run.shared = true;
    const boss = wakeWarden(run);
    run.damage(LOCAL, boss, 50);
    run.enemyKilled(boss);
    run.takeEvents();
    expect(run.portalOpen).toBe(true);
    expect(run.wardenFellAt).toBeGreaterThan(0);
    const away = L.arrival;
    stand(run, away, WARDEN_RETURN - 5, 1);
    expect(run.portalOpen).toBe(true);
    const es = stand(run, away, 10, 1);
    expect(run.portalOpen).toBe(false);
    expect(run.bossOpen).toBe(true);
    expect(run.contribution.score(LOCAL)).toBe(0);
    expect(ofType(es, 'notice').length).toBe(1);
  });

  it('keeps the Warden down for good when alone', () => {
    const run = new DimensionRun(HOLLOW, L, 5);
    const boss = wakeWarden(run);
    run.enemyKilled(boss);
    stand(run, L.arrival, WARDEN_RETURN + 60, 1);
    expect(run.portalOpen).toBe(true);
  });

  it('starts over once everyone has left', () => {
    const run = new DimensionRun(HOLLOW, L, 5);
    const boss = wakeWarden(run);
    run.enemyKilled(boss);
    expect(run.empty).toBe(false);
    run.leave(LOCAL);
    expect(run.empty).toBe(true);
    run.restart();
    expect([run.trialsDone, run.bossOpen, run.portalOpen, run.chestOpened, run.closed]).toEqual([0, false, false, false, false]);
    expect(run.doorSealed(ARENA)).toBe(true);
  });
});
