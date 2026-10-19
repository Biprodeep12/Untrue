import { afterEach, describe, expect, it, vi } from 'vitest';
import shippedArchive from '../../public/dimensions/archive.json?raw';
import shippedHollow from '../../public/dimensions/hollow.json?raw';
import { fromHex } from '../net';
import { packRun, unpackRun } from '../coop/runSync';
import { OUTFITS } from '../rendering/Atlas';
import { RiftStory } from '../story/RiftStory';
import { Deco, isSolid, isVoid } from '../generation/Tiles';
import { ARCHIVE } from './Archive';
import { bakeArchive } from './bake/archiveMap';
import { bakeHollow } from './bake/hollowMap';
import { BossChallenge, DimensionRun, PlatePuzzle, TideChallenge, WaveChallenge, type DimEvent } from './Challenges';
import { LOCAL } from './Contribution';
import type { DimensionLayout, Point, SiteKind } from './Dimension';
import { decodeDimension, DimensionDataError, type DimensionFile } from './DimensionData';
import { DimensionCache, LocalDimensionSource } from './DimensionSource';
import { DimTile } from './DimTile';
import { HOLLOW } from './Hollow';

const A = decodeDimension(bakeArchive());
const L = decodeDimension(bakeHollow());
const hollowFile = (): DimensionFile => JSON.parse(shippedHollow) as DimensionFile;

const siteIn = (layout: DimensionLayout, kind: SiteKind) => layout.sites.findIndex((s) => s.kind === kind);
const feetOf = (layout: DimensionLayout, t: number): Point => ({ x: (t % layout.w) + 0.5, y: Math.floor(t / layout.w) + 0.9 });

function stand(run: DimensionRun, p: Point, seconds = 1 / 60, dt = 1 / 60): DimEvent[] {
  const out: DimEvent[] = [];
  for (let t = 0; t < seconds - 1e-9; t += dt) {
    run.update(dt, p.x, p.y);
    out.push(...run.takeEvents());
  }
  return out;
}
const ofType = <T extends DimEvent['type']>(es: DimEvent[], type: T) => es.filter((e): e is Extract<DimEvent, { type: T }> => e.type === type);

/** Open ground well inside a site's rect. */
function floorIn(layout: DimensionLayout, kind: SiteKind): Point {
  const r = layout.sites[siteIn(layout, kind)].rect;
  for (let y = r.y + 3; y < r.y + r.h - 3; y++) {
    for (let x = r.x + 3; x < r.x + r.w - 3; x++) {
      const i = y * layout.w + x;
      if (layout.tiles[i] === DimTile.None && !isVoid(layout.ground[i]) && !isSolid(layout.ground[i], layout.decos[i])) return { x: x + 0.5, y: y + 0.9 };
    }
  }
  throw new Error('no floor');
}

describe('The Drowned Archive', () => {
  it('bakes the same file every time, and the shipped one is that file', () => {
    expect(JSON.stringify(bakeArchive())).toBe(shippedArchive.trim());
    expect(shippedArchive.length).toBeLessThan(100 * 1024);
  });

  it('is the second world, with its three trials, its Archivist, its plot and its stones', () => {
    expect(A.id).toBe('archive');
    expect([A.w, A.h]).toEqual([256, 256]);
    expect(A.sites.map((s) => s.kind).sort()).toEqual(['boss', 'combat', 'puzzle', 'tide', 'vault']);
    expect(A.clues.length).toBe(6);
    expect(A.clues.map((c) => c.title.split('.')[0])).toEqual(['I', 'II', 'III', 'IV', 'V', 'VI']);
    expect(A.mood.music).toBe('archive');
    expect(ARCHIVE.boss.species.name).toBe('The Archivist');
    const plot = A.plot!;
    expect(plot.resident.name).toBe('Ondine');
    expect(plot.resident.look in OUTFITS).toBe(true);
    expect(plot.relics.length).toBe(3);
    for (const r of plot.relics) expect(A.decos[r.y * A.w + r.x]).toBe(Deco.Relic);
    for (const z of A.zones) for (const sp of z.species) expect(ARCHIVE.roster).toContain(sp);
  });

  it('writes the cipher gallery\'s order on the catalogue stone, and lights nothing on the mural', () => {
    const g = A.sites[siteIn(A, 'puzzle')];
    expect(g.hint).toBe('text');
    const names = ['ring', 'triangle', 'cross', 'diamond', 'moon', 'star'];
    const text = A.clues.find((c) => c.id === 'catalogue-stone')!.pages.join(' ');
    let at = -1;
    for (const glyph of g.order) {
      const k = text.indexOf(`the ${names[glyph]}`);
      expect(k).toBeGreaterThan(at);
      at = k;
    }
    const run = new DimensionRun(ARCHIVE, A, 3);
    const p = floorIn(A, 'puzzle');
    for (let k = 0; k < 120; k++) {
      stand(run, p, 0.1, 0.1);
      for (const t of g.mural) expect(run.stateOf(t)).toBe(0);
    }
  });
});

describe('tide halls', () => {
  const ti = siteIn(A, 'tide');
  const site = A.sites[ti];
  const ledge = site.checkpoints[0];
  const band = (depth: number) => site.flood.filter((t) => A.phase[t] === depth);
  const at = (t: number) => feetOf(A, t);
  const solid = (run: DimensionRun, t: number) => run.isSolid(t % A.w, Math.floor(t / A.w));

  it('drains a stage per valve, in order, and uncovers the floor down to the next', () => {
    const run = new DimensionRun(ARCHIVE, A, 1);
    let es = stand(run, ledge);
    expect(ofType(es, 'started').map((e) => e.kind)).toEqual(['tide']);
    const tide = run.challenges[ti] as TideChallenge;
    expect(tide.level).toBe(3);
    expect(band(3).every((t) => solid(run, t))).toBe(true);
    // A valve out of turn does nothing.
    stand(run, at(site.valves[2]));
    expect(tide.level).toBe(3);
    stand(run, ledge);
    es = stand(run, at(site.valves[0]));
    expect(tide.level).toBe(2);
    expect(ofType(es, 'plate').map((e) => e.step)).toEqual([1]);
    expect(band(3).some((t) => solid(run, t))).toBe(false);
    expect(band(2).every((t) => solid(run, t))).toBe(true);
    stand(run, at(site.valves[1]));
    expect(tide.level).toBe(1);
    stand(run, at(site.valves[2]));
    expect(tide.level).toBe(0);
    // Across to the far side: the hall drains for good.
    const g = site.goal!;
    es = stand(run, { x: g.x + 2.5, y: g.y + 3.9 });
    expect(ofType(es, 'cleared').map((e) => e.kind)).toEqual(['tide']);
    expect(run.trialsDone).toBe(1);
    stand(run, ledge, ARCHIVE.hazard.tideHold * 3);
    expect(site.flood.some((t) => solid(run, t))).toBe(false);
  });

  it('rises again when the hold runs out, throwing whoever it covers back to the ledge, hurt', () => {
    const run = new DimensionRun(ARCHIVE, A, 1);
    stand(run, ledge);
    stand(run, at(site.valves[0]));
    const dry = band(3)[40];
    // The water creeps over the band a little before it rises.
    let warned = false;
    let slip: Extract<DimEvent, { type: 'slip' }> | undefined;
    for (let k = 0; k < 60 * (ARCHIVE.hazard.tideHold + 1) && !slip; k++) {
      const s = run.stateOf(dry);
      if (s > 0 && s < 1) warned = true;
      slip = ofType(stand(run, at(dry)), 'slip')[0];
    }
    expect(warned).toBe(true);
    expect(slip).toBeTruthy();
    expect(slip!.damage).toBe(ARCHIVE.hazard.slipDamage);
    expect([slip!.x, slip!.y]).toEqual([ledge.x, ledge.y]);
    expect((run.challenges[ti] as TideChallenge).level).toBe(3);
  });

  it('takes a valve under with its band, so nobody is left on an island', () => {
    const run = new DimensionRun(ARCHIVE, A, 1);
    const v1 = site.valves[1];
    expect(A.phase[v1]).toBe(3);
    expect(A.phase[site.valves[0]]).toBe(0);
    stand(run, ledge);
    expect(solid(run, v1)).toBe(true);
    expect(run.holeAt(v1)).toBe(true);
    stand(run, at(site.valves[0]));
    expect(solid(run, v1)).toBe(false);
  });

  it('travels to a mirror in a shared instance', () => {
    const run = new DimensionRun(ARCHIVE, A, 1);
    run.shared = true;
    stand(run, ledge);
    stand(run, at(site.valves[0]));
    const key = 'ab'.repeat(32);
    const state = packRun(run, 1, 2, 1000, key, () => false);
    const x = unpackRun(state)!;
    expect(x).not.toBeNull();
    const mirror = new DimensionRun(ARCHIVE, A, 1);
    mirror.authority = false;
    mirror.applyShared(x.shared);
    const t = mirror.challenges[ti] as TideChallenge;
    expect(t.state).toBe('active');
    expect(t.level).toBe(2);
    expect(band(3).some((tile) => mirror.isSolid(tile % A.w, Math.floor(tile / A.w)))).toBe(false);
    expect(fromHex(key)!.length).toBe(32);
  });
});

describe('no falling', () => {
  it('lets a path slab bridge the void while it holds, and walls it off once it gives way', () => {
    const PATH = siteIn(L, 'hazard');
    const site = L.sites[PATH];
    const slab = site.path.find((t) => L.tiles[t] === DimTile.Crumble)!;
    const run = new DimensionRun(HOLLOW, L, 9);
    const sx = slab % L.w;
    const sy = Math.floor(slab / L.w);
    expect(isVoid(L.ground[slab])).toBe(true);
    expect(run.isSlab(sx, sy)).toBe(true);
    expect(run.isSolid(sx, sy)).toBe(false);
    stand(run, site.checkpoints[0]);
    stand(run, feetOf(L, slab), 0.2);
    // Stepped off in time: it gives way behind the player, and blocks the way.
    stand(run, site.checkpoints[0], HOLLOW.hazard.crumbleDelay);
    expect(run.isSolid(sx, sy)).toBe(true);
  });
});

describe('plots', () => {
  it('meets the resident, counts the relics, makes the lost thing whole once, and saves it', () => {
    const shown: string[] = [];
    const story = new RiftStory((v) => shown.push(v.title));
    const plot = A.plot!;
    const run = { name: A.name, layout: A, at: { x: 0, y: 0 }, trialsDone: 0, trials: 3, bossOpen: false, portalOpen: false, goalAngle: () => null };
    expect(story.plotLine(run)?.text).toBe('Someone waits here: seek out Ondine');
    const first = story.talk('archive', plot);
    expect(first.pages).toEqual(plot.talk.first);
    expect(first.restore).toBe(false);
    expect(story.talk('archive', plot).pages[0]).toContain('0 of 3');
    expect(story.findRelic('archive', plot.relics[0].id)).toBe(true);
    expect(story.findRelic('archive', plot.relics[0].id)).toBe(false);
    expect(story.plotLine(run)?.text).toBe('Restore the Ledger of the Drift: 1/3 pieces');
    expect(story.restore('archive', plot)).toBe(false);
    for (const r of plot.relics) story.findRelic('archive', r.id);
    expect(story.plotLine(run)?.text).toBe('Bring the pieces back to Ondine');
    const ready = story.talk('archive', plot);
    expect(ready.restore).toBe(true);
    expect(story.restore('archive', plot)).toBe(true);
    expect(shown).toEqual(['The Ledger Opens']);
    expect(story.restore('archive', plot)).toBe(false);
    expect(story.plotLine(run)).toBeNull();
    expect(story.talk('archive', plot).pages).toEqual([plot.talk.after]);
    // The world's own closing vision, the first time it is cleared only.
    story.onClosed('archive', plot.closing);
    story.onClosed('archive', plot.closing);
    expect(shown).toEqual(['The Ledger Opens', 'The Archive Sleeps']);
    expect(story.talk('archive', plot).pages).toEqual([plot.talk.cleared]);

    const back = new RiftStory(() => {});
    back.load(JSON.parse(JSON.stringify(story.save())));
    expect(back.save()).toEqual(story.save());
    expect(back.save().version).toBe(4);
    expect(back.canRestore('archive', plot)).toBe(false);
    expect(back.relicsFound('archive', plot)).toBe(3);
  });

  it('starts every plot afresh from an older save, and ignores junk', () => {
    const story = new RiftStory(() => {});
    story.load({ version: 3, closed: 2, entered: true, cleared: ['hollow'], lore: { hollow: ['first-stone'] } });
    expect(story.plot('hollow').met).toBe(false);
    expect(story.hasRead('hollow', 'first-stone')).toBe(true);
    story.load({ version: 4, closed: 1, entered: true, cleared: [], lore: {}, plots: { hollow: { met: 'yes', relics: [5, 'bell-lip', 'x'.repeat(99)], restored: 1 }, '': {}, archive: null } });
    expect(story.plot('hollow').met).toBe(false);
    expect([...story.plot('hollow').relics]).toEqual(['bell-lip']);
    expect(story.plot('hollow').restored).toBe(false);
  });

  it('gives The Hollow its bell: a resident, three relics, and a closing', () => {
    const plot = L.plot!;
    expect(plot.resident.name).toBe('Isolde');
    expect(plot.relics.map((r) => r.id)).toEqual(['bell-crown', 'bell-lip', 'bell-clapper']);
    for (const r of plot.relics) expect(L.decos[r.y * L.w + r.x]).toBe(Deco.Relic);
    expect(plot.closing.title).toBe('The Hollow Holds');
    expect(L.clues.length).toBe(7);
  });
});

describe('a shared instance does not lock or leak (review fixes)', () => {
  const NEST = siteIn(L, 'combat');
  const ARENA = siteIn(L, 'boss');
  const VAULT = siteIn(L, 'vault');

  it('resets a fight nobody is left in, opening its gate', () => {
    const run = new DimensionRun(HOLLOW, L, 4);
    run.shared = true;
    const es = stand(run, floorIn(L, 'combat'));
    expect(ofType(es, 'spawn').length).toBeGreaterThan(0);
    expect(run.doorSealed(NEST)).toBe(true);
    // Everyone left (they died, or went home): a moment later it gives up.
    const out = stand(run, L.arrival, 6);
    expect(run.challenges[NEST]!.state).toBe('idle');
    expect(run.doorSealed(NEST)).toBe(false);
    expect(ofType(out, 'despawn').length).toBe(ofType(es, 'spawn').length);
  });

  it('forgets creatures a new host never received, so neither waves nor the Warden wait forever', () => {
    const run = new DimensionRun(HOLLOW, L, 4);
    stand(run, floorIn(L, 'combat'));
    const nest = run.challenges[NEST] as WaveChallenge;
    expect(nest.live.length).toBeGreaterThan(0);
    run.prune(() => false);
    expect(nest.live.length).toBe(0);
    // The nest goes on to its next wave.
    const next = stand(run, floorIn(L, 'combat'), 2);
    expect(ofType(next, 'wave').map((e) => e.wave)).toEqual([2]);

    const run2 = new DimensionRun(HOLLOW, L, 4);
    run2.skipTo(ARENA);
    stand(run2, L.sites[ARENA].center);
    const boss = run2.challenges[ARENA] as BossChallenge;
    expect(boss.state).toBe('active');
    run2.prune(() => false);
    expect(boss.state).toBe('idle');
    expect(run2.doorSealed(ARENA)).toBe(false);
  });

  it('counts a trial only for players who took part: inside it a while, and for waves a blow struck', () => {
    const run = new DimensionRun(HOLLOW, L, 4);
    run.shared = true;
    const hall = L.sites[siteIn(L, 'puzzle')];
    // Just outside the hall, the whole time.
    run.join('lurker', hall.rect.x - 1, hall.rect.y + 3);
    stand(run, floorIn(L, 'puzzle'), 5);
    run.emit({ type: 'cleared', site: siteIn(L, 'puzzle'), kind: 'puzzle' });
    expect(run.contribution.attuned(LOCAL)).toBe(true);
    expect(run.contribution.score('lurker')).toBe(0);

    const run2 = new DimensionRun(HOLLOW, L, 4);
    run2.shared = true;
    const es = stand(run2, floorIn(L, 'combat'), 5);
    run2.emit({ type: 'cleared', site: NEST, kind: 'combat' });
    expect(run2.contribution.score(LOCAL)).toBe(0);
    const run3 = new DimensionRun(HOLLOW, L, 4);
    run3.shared = true;
    const es3 = stand(run3, floorIn(L, 'combat'), 5);
    run3.damage(LOCAL, ofType(es3, 'spawn')[0].id, 5);
    run3.emit({ type: 'cleared', site: NEST, kind: 'combat' });
    expect(run3.contribution.score(LOCAL)).toBeGreaterThan(0);
    expect(es.length).toBeGreaterThan(0);
  });

  it('marks the vault taken in what it shares, so a new host cannot pay twice', () => {
    const run = new DimensionRun(HOLLOW, L, 4);
    run.join('guest', L.arrival.x, L.arrival.y);
    run.skipTo(VAULT);
    const v = run.version;
    expect(run.claimChest('guest')).toBe(true);
    expect(run.version).toBeGreaterThan(v);
    expect(run.claimChest('guest')).toBe(false);
  });

  it('keeps a mirror in the portal until the host answers its claim (a moment at most)', () => {
    const run = new DimensionRun(HOLLOW, L, 4);
    run.skipTo(VAULT);
    run.authority = false;
    run.adoptSettlement({ share: 1, attuned: true, xp: 10, items: [] });
    const portal = feetOf(L, L.portal);
    let es = stand(run, portal, 0.5);
    expect(ofType(es, 'claim').length).toBe(1);
    expect(ofType(es, 'closed')).toEqual([]);
    run.markClaimed(LOCAL);
    es = stand(run, portal);
    expect(ofType(es, 'closed').length).toBe(1);
  });

  it('keeps the tally to the players still here when the Warden returns', () => {
    const run = new DimensionRun(HOLLOW, L, 4);
    for (let k = 0; k < 40; k++) run.join(`p${k}`, L.arrival.x, L.arrival.y);
    for (let k = 1; k < 40; k++) run.leave(`p${k}`);
    run.restart();
    expect(run.contribution.players).toEqual([LOCAL, 'p0']);
  });
});

describe('the map file is checked and fetched with care (review fixes)', () => {
  afterEach(() => vi.unstubAllGlobals());
  const refused = (change: (f: DimensionFile) => void, why: RegExp) => {
    const f = hollowFile();
    change(f);
    expect(() => decodeDimension(f)).toThrow(why);
  };

  it('refuses too many sites, too long a path, a missing boss, a portal outside the vault, and feet on the void', () => {
    refused((f) => {
      const vault = f.sites.find((s) => s.kind === 'vault')!;
      for (let k = 0; k < 16; k++) f.sites.push({ ...vault });
    }, /at most 16/);
    refused((f) => {
      const hazard = f.sites.find((s) => s.kind === 'hazard')!;
      const voids: Array<[number, number, number, number]> = [];
      for (let i = 0; i < L.w * L.h && voids.length < 601; i++) if (L.tiles[i] === DimTile.None && isVoid(L.ground[i])) voids.push([i % L.w, Math.floor(i / L.w), 0, 0]);
      hazard.path = voids;
    }, /more than 600/);
    refused((f) => (f.sites = f.sites.filter((s) => s.kind !== 'boss')), /exactly one boss/);
    refused((f) => (f.portal = [L.rift % L.w, Math.floor(L.rift / L.w) + 1]), /not inside a vault/);
    refused((f) => (f.sites[0].entry = [0.5, 0.9]), /entry is not on open ground/);
    refused((f) => (f.plot!.resident.look = 'nobody'), /look/);
    refused((f) => (f.plot!.relics[0].x += 1), /no relic/);
  });

  it('gives up a stalled fetch, refuses an oversized one before reading it, and does not ask again for a bad map', async () => {
    vi.stubGlobal('fetch', () => Promise.reject(Object.assign(new Error('late'), { name: 'TimeoutError' })));
    await expect(new LocalDimensionSource('/x/').load('hollow')).rejects.toThrow(/too long/);
    let read = false;
    vi.stubGlobal('fetch', () =>
      Promise.resolve({
        ok: true,
        status: 200,
        headers: new Headers({ 'content-length': String(64 * 1024 * 1024) }),
        text: () => {
          read = true;
          return Promise.resolve('{}');
        },
      }),
    );
    await expect(new LocalDimensionSource('/x/').load('hollow')).rejects.toThrow(DimensionDataError);
    expect(read).toBe(false);
    let asked = 0;
    const cache = new DimensionCache({
      load: () => {
        asked++;
        return Promise.reject(new DimensionDataError('bad'));
      },
    });
    await expect(cache.load('hollow')).rejects.toThrow('bad');
    await expect(cache.load('hollow')).rejects.toThrow('bad');
    cache.preload('hollow');
    expect(asked).toBe(1);
  });

  it('only counts its own plates in a gallery', () => {
    const run = new DimensionRun(HOLLOW, L, 4);
    const hall = run.challenges[siteIn(L, 'puzzle')] as PlatePuzzle;
    expect(hall.site.plates.length).toBeGreaterThan(0);
  });
});
