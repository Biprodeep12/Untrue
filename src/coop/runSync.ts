// A dimension run as it travels: what the host shares of its run (gates,
// trials, the Warden, the tally) packed into the session's `RunState`, and
// back. The session keeps the last one, so a new host carries on from it. The
// run's own details ride in `extra`; its events (a gate, a wave, a notice)
// travel as `Event` messages, a type and a few numbers.
//
// Run state goes out a few times a second at most, and only when something
// changed, so these allocate freely.

import { emptySite, WARDEN_RETURN, type DimEvent, type DimensionRun, type SharedRun, type SharedSite } from '../dimension/Challenges';
import { LOCAL } from '../dimension/Contribution';
import type { SiteKind } from '../dimension/Dimension';
import { fromHex, Reader, toHex, Writer } from '../net';
import type { Contribution, GameEvent as NetEvent, RunState } from '../net';
import { GameEvent, RUN_EVENTS, SITE_KINDS } from './ids';

/** Raised whenever `extra`'s layout changes (peers on another game version are refused anyway). */
const EXTRA_VERSION = 1;

export interface RunExtra {
  shared: SharedRun;
  /** Difficulty band of the instance: replicas are made as tough as the host's. */
  band: number;
  /** Session clock (ms) at the run's time 0: the run's time is the same everywhere. */
  runStart: number;
}

export interface TallyEntry {
  player: string;
  score: number;
  breaker: boolean;
  claimed: boolean;
}

/** The host's run as the session shares it. `myKey` is this player's key
 *  (hex), for the local player's line of the tally. */
export function packRun(run: DimensionRun, version: number, band: number, runStart: number, myKey: string, claimed: (player: string) => boolean): RunState {
  const shared = run.exportShared();
  const w = new Writer(512);
  w.u8(EXTRA_VERSION).u8(band).f64(runStart).u16(shared.nextId).f64(shared.wardenFellAt).u16(shared.sealed).u8(shared.sites.length);
  for (const s of shared.sites) writeSite(w, s);
  const boss = run.boss;
  const contributions: Contribution[] = [];
  for (const e of run.contribution.entries()) {
    const key = fromHex(e.player === LOCAL ? myKey : e.player);
    if (!key || key.length !== 32) continue;
    contributions.push({ key, score: e.score, attuned: e.breaker || run.contribution.attuned(e.player), claimed: claimed(e.player) });
  }
  // The trials only (the board counts their seals); every site rides in `extra`.
  const trials: number[] = [];
  shared.sites.forEach((s, i) => {
    const kind = run.layout.sites[i]?.kind;
    if (kind !== 'boss' && kind !== 'vault') trials.push(s.state);
  });
  return {
    version,
    trials,
    bossOpen: run.bossOpen,
    bossHealth: boss ? boss.share : 0,
    bossPhase: boss ? boss.phase : 0,
    bossAlive: boss?.state === 'active',
    summons: boss ? boss.adds.length : 0,
    bossReturnsAt: shared.wardenFellAt >= 0 ? runStart + (shared.wardenFellAt + WARDEN_RETURN) * 1000 : 0,
    contributions,
    extra: w.finish().slice(),
  };
}

function writeSite(w: Writer, s: SharedSite): void {
  w.u8(s.state).u8(s.wave).u8(Math.min(255, s.live.length));
  for (let i = 0; i < Math.min(255, s.live.length); i++) w.u16(s.live[i]);
  const t = s.timers;
  w.u16(t ? t.length : 0);
  if (t) for (let i = 0; i < t.length; i++) w.u8(t[i]);
  w.u8(s.step).u8(s.pressed).u16(s.bossId).u8(s.phase).f32(s.share).u8(Math.min(255, s.adds.length));
  for (let i = 0; i < Math.min(255, s.adds.length); i++) w.u16(s.adds[i]);
}

function readSite(r: Reader): SharedSite {
  const s = emptySite();
  s.state = r.u8();
  s.wave = r.u8();
  const live = r.u8();
  for (let i = 0; i < live && r.ok; i++) s.live.push(r.u16());
  const n = r.u16();
  if (n > 4096) r.fail();
  if (n && r.ok) {
    s.timers = new Uint8Array(n);
    for (let i = 0; i < n && r.ok; i++) s.timers[i] = r.u8();
  }
  s.step = r.u8();
  s.pressed = r.u8();
  s.bossId = r.u16();
  s.phase = r.u8();
  s.share = r.f32();
  const adds = r.u8();
  for (let i = 0; i < adds && r.ok; i++) s.adds.push(r.u16());
  if (s.state > 2 || !(s.share >= 0 && s.share <= 1)) r.fail();
  return s;
}

/** The run's details from a run state, or null if they are malformed. */
export function unpackRun(state: RunState): RunExtra | null {
  const r = new Reader().reset(state.extra);
  if (r.u8() !== EXTRA_VERSION) return null;
  const band = r.u8();
  const runStart = r.f64();
  const nextId = r.u16();
  const wardenFellAt = r.f64();
  const sealed = r.u16();
  const n = r.u8();
  const sites: SharedSite[] = [];
  for (let i = 0; i < n && r.ok; i++) sites.push(readSite(r));
  if (!r.done || !Number.isFinite(runStart) || !Number.isFinite(wardenFellAt)) return null;
  return { shared: { sites, sealed, nextId, wardenFellAt }, band, runStart };
}

/** The tally in a run state, by player: this player's key becomes `LOCAL`. */
export function tallyOf(state: RunState, myKey: string): TallyEntry[] {
  return state.contributions.map((c) => {
    const key = toHex(c.key);
    return { player: key === myKey ? LOCAL : key, score: c.score, breaker: c.attuned, claimed: c.claimed };
  });
}

/** A run event everyone sees, as an `Event` message; null for those that stay home. */
export function runEventOut(e: DimEvent): NetEvent | null {
  const type = (RUN_EVENTS as readonly string[]).indexOf(e.type);
  if (type < 0) return null;
  const ints = [type];
  let text = '';
  switch (e.type) {
    case 'door':
      ints.push(e.site, e.open ? 1 : 0);
      break;
    case 'started':
    case 'cleared':
      ints.push(e.site, SITE_KINDS.indexOf(e.kind));
      break;
    case 'wave':
      ints.push(e.wave, e.of);
      break;
    case 'plate':
      ints.push(e.step, e.of);
      break;
    case 'bossPhase':
      ints.push(e.phase, Math.round(e.cooldownScale * 1000), Math.round(e.speedScale * 1000));
      break;
    case 'notice':
      text = e.text;
      break;
  }
  return { kind: GameEvent.Run, ints, text };
}

/** Back from an `Event` message; null if it is not a run event, or malformed. */
export function runEventIn(m: NetEvent): DimEvent | null {
  if (m.kind !== GameEvent.Run || !m.ints.length) return null;
  const [type, a = 0, b = 0, c = 0] = m.ints;
  const kind = SITE_KINDS[b] as SiteKind | undefined;
  switch (RUN_EVENTS[type]) {
    case 'door':
      return { type: 'door', site: a, open: b === 1 };
    case 'started':
      return kind ? { type: 'started', site: a, kind } : null;
    case 'cleared':
      return kind ? { type: 'cleared', site: a, kind } : null;
    case 'wave':
      return { type: 'wave', wave: a, of: b };
    case 'plate':
      return { type: 'plate', step: a, of: b };
    case 'puzzleReset':
      return { type: 'puzzleReset' };
    case 'bossPhase':
      return { type: 'bossPhase', phase: a, cooldownScale: b / 1000, speedScale: c / 1000 };
    case 'notice':
      return m.text ? { type: 'notice', text: m.text } : null;
    default:
      return null;
  }
}
