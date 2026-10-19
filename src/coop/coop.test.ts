import { afterEach, describe, expect, it } from 'vitest';
import { bakeHollow } from '../dimension/bake/hollowMap';
import type { DimEvent } from '../dimension/Challenges';
import { LOCAL } from '../dimension/Contribution';
import { decodeDimension } from '../dimension/DimensionData';
import { DimensionWorld } from '../dimension/DimensionWorld';
import { HOLLOW } from '../dimension/Hollow';
import { Enemy } from '../entities/Enemy';
import { SPECIES } from '../entities/Species';
import { Rng } from '../generation/Random';
import { riftDoorstep, RiftTrip } from '../game/RiftTrip';
import { Items, type ItemDef } from '../items/Items';
import { FakeSwitch } from '../net/fake';
import { FakeRelay } from '../net/fakeRelay';
import { Net } from '../net/index';
import { CombatSystem } from '../systems/CombatSystem';
import { Inventory } from '../systems/InventorySystem';
import { Progression } from '../systems/Progression';
import { Vitals } from '../systems/Vitals';
import { WorldEvents } from '../systems/WorldEvents';
import { SyncGenerator } from '../world/SyncGenerator';
import { WorldManager } from '../world/WorldManager';
import type { WorldObject } from '../world/WorldObject';
import { InstanceLink, type CoopGame } from './InstanceLink';
import { TickClock, Track } from './interp';
import { packRun, runEventIn, runEventOut, unpackRun } from './runSync';

const LAYOUT = decodeDimension(bakeHollow());
const MAP = new Uint8Array(32).fill(7);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function until(check: () => boolean, ms = 4000, tick?: () => void): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error('Timed out waiting');
    tick?.();
    await sleep(10);
  }
}

/** One world with a rift, shared by every player's game (each has its own fight and trip). */
let shared: { world: WorldManager; rift: WorldObject } | null = null;
function theRift() {
  if (shared) return shared;
  const world = new WorldManager(4321, new SyncGenerator());
  world.update({ minX: 285, minY: 291, maxX: 315, maxY: 309, playerX: 300, playerY: 300, dirX: 0, dirY: 0 });
  const events = new WorldEvents(world, new Rng(5), { notify: () => {}, meteor: () => {}, bandits: () => {}, invasion: () => {}, merchant: () => {}, waypoint: () => {} });
  const rift = events.openRift({ x: 300, y: 300, now: 60 }, 6, 12)!;
  shared = { world, rift };
  return shared;
}

interface Player {
  name: string;
  net: Net;
  trip: RiftTrip;
  combat: CombatSystem;
  vitals: Vitals;
  me: { x: number; y: number; facing: number; frame: number; moving: boolean; hurt: number; guarding: boolean; holding: number; health: number };
  link: InstanceLink | null;
  got: Array<[ItemDef, number]>;
  xp: number;
  notes: string[];
  heard: DimEvent[];
}

const players: Player[] = [];
afterEach(() => {
  for (const p of players) {
    p.link?.session.dispose();
    p.net.close();
  }
  players.length = 0;
});

function player(name: string, sw: FakeSwitch, relay: FakeRelay): Player {
  const { world, rift } = theRift();
  const vitals = new Vitals();
  const combat = new CombatSystem(world, new Inventory(), vitals, new Progression(), { damage: () => {}, swing: () => {}, playerHurt: () => {}, notify: () => {} });
  const p = { name, combat, vitals, link: null, got: [], xp: 0, notes: [], heard: [] } as unknown as Player;
  p.trip = new RiftTrip(HOLLOW, new DimensionWorld(LAYOUT, 99), 99, rift, riftDoorstep(rift), 0, combat, {
    event: (e) => {
      p.heard.push(e);
      p.link?.tripEvent(e);
      if (e.type === 'claim') p.link?.claim();
    },
  });
  p.trip.begin();
  const a = LAYOUT.arrival;
  p.me = { x: a.x, y: a.y, facing: 0, frame: 0, moving: false, hurt: 0, guarding: false, holding: -1, health: 1 };
  p.net = new Net({ gameVersion: 't', storage: null, linker: sw.linker(name), socket: () => relay.socket(), relays: ['wss://fake'], iterations: 10 });
  p.net.identity.name = name;
  players.push(p);
  return p;
}

function game(p: Player): CoopGame {
  return {
    get trip() {
      return p.trip;
    },
    combat: p.combat,
    player: () => p.me,
    notify: (t) => p.notes.push(t),
    runEvent: (e) => p.heard.push(e),
    give: (item, count) => p.got.push([item, count]),
    grantXp: (xp) => (p.xp += xp),
    replicaGone: () => {},
  };
}

async function host(p: Player): Promise<void> {
  const h = await p.net.hostInstance('hollow', MAP);
  p.link = new InstanceLink(h.session, game(p), h.code, h.stop);
}

async function join(p: Player): Promise<void> {
  const list = await p.net.findInstances('hollow', 1000);
  const session = await p.net.joinInstance(list[0], MAP);
  p.link = new InstanceLink(session, game(p), list[0].code, () => session.leave());
}

/** One frame for everyone: fights, runs and links, at 60 a second. */
function frame(ps: readonly Player[], dt = 1 / 60): void {
  for (const p of ps) {
    if (!p.link) continue;
    p.combat.update(dt, { x: p.me.x, y: p.me.y, faceX: 1, faceY: 0, blocking: false, invulnerable: false });
    p.trip.update(dt, p.me.x, p.me.y);
    p.link.update(dt);
  }
}

/** Frames for `ms` of real time, letting messages through between them. */
async function run(ps: readonly Player[], ms: number): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    frame(ps);
    await sleep(8);
  }
}

const siteOf = (kind: string) => LAYOUT.sites.findIndex((s) => s.kind === kind);

describe('interpolation', () => {
  it('draws between the two updates around the moment shown, never past the newest', () => {
    const t = new Track();
    t.push(10, 0, 0);
    t.push(11, 2, 4);
    t.sample(10.5);
    expect([t.x, t.y]).toEqual([1, 2]);
    t.sample(20);
    expect([t.x, t.y]).toEqual([2, 4]);
    t.sample(5);
    expect([t.x, t.y]).toEqual([0, 0]);
    // Older news is ignored.
    t.push(9, 50, 50);
    t.sample(10);
    expect([t.x, t.y]).toEqual([0, 0]);
  });

  it('maps the sender\'s ticks onto this clock, a little in the past', () => {
    const c = new TickClock();
    c.observe(100, 10_000);
    c.observe(101, 10_080);
    expect(c.at(10_000)).toBeCloseTo(98, 1);
    // A late arrival hardly moves the clock.
    expect(c.at(10_050)).toBeCloseTo(99, 1);
  });
});

describe('run state on the wire', () => {
  it('packs a host\'s run and a mirror takes it on', () => {
    const p = { trip: null as unknown as RiftTrip };
    p.trip = new RiftTrip(HOLLOW, new DimensionWorld(LAYOUT, 1), 1, theRift().rift, { x: 0, y: 0 }, 2, new CombatSystem(theRift().world, new Inventory(), new Vitals(), new Progression(), { damage: () => {}, swing: () => {}, playerHurt: () => {}, notify: () => {} }), { event: () => {} });
    const run = p.trip.run;
    run.skipTo(siteOf('boss'));
    const key = 'ab'.repeat(32);
    run.join(key, 1, 1);
    run.contribution.damage(key, 40);
    const state = packRun(run, 3, 2, 1234, 'cd'.repeat(32), () => false);
    const x = unpackRun(state)!;
    expect(x.band).toBe(2);
    expect(x.runStart).toBe(1234);
    expect(x.shared.sites.map((s) => s.state)).toEqual(run.exportShared().sites.map((s) => s.state));
    expect(state.contributions.map((c) => c.score).sort()).toEqual([0, 40]);

    const mirror = new RiftTrip(HOLLOW, new DimensionWorld(LAYOUT, 1), 1, theRift().rift, { x: 0, y: 0 }, 2, new CombatSystem(theRift().world, new Inventory(), new Vitals(), new Progression(), { damage: () => {}, swing: () => {}, playerHurt: () => {}, notify: () => {} }), { event: () => {} }).run;
    mirror.authority = false;
    expect(mirror.bossOpen).toBe(false);
    mirror.applyShared(x.shared);
    expect(mirror.trialsDone).toBe(3);
    expect(mirror.bossOpen).toBe(true);
    // Junk is refused.
    expect(unpackRun({ ...state, extra: new Uint8Array([1, 2, 3]) })).toBeNull();
  });

  it('carries the run\'s news, and keeps a player\'s own events at home', () => {
    for (const e of [
      { type: 'door', site: 2, open: true },
      { type: 'wave', wave: 2, of: 3 },
      { type: 'bossPhase', phase: 1, cooldownScale: 0.55, speedScale: 1.35 },
      { type: 'notice', text: 'A seal breaks.' },
      { type: 'cleared', site: 1, kind: 'puzzle' },
    ] as DimEvent[]) expect(runEventIn(runEventOut(e)!)).toEqual(e);
    expect(runEventOut({ type: 'slip', damage: 15, x: 1, y: 2 })).toBeNull();
    expect(runEventOut({ type: 'closed', player: LOCAL, xp: 3 })).toBeNull();
  });
});

describe('a shared instance (fake links)', () => {
  it('shows each the other, sends the host\'s creatures to the guest, and lands the guest\'s blows on the host', async () => {
    const sw = new FakeSwitch({ latency: 3, openDelay: 5 });
    const relay = new FakeRelay();
    const h = player('Hana', sw, relay);
    const g = player('Gus', sw, relay);
    await host(h);
    await sleep(30);
    await join(g);
    expect(g.trip.run.authority).toBe(false);
    expect(h.trip.run.shared && g.trip.run.shared).toBe(true);

    // A creature of the host's, right by the guest.
    const wolf = new Enemy(SPECIES.glitchling, g.me.x + 1, g.me.y, 0, false);
    h.combat.add(wolf);
    h.trip.adopt(wolf, 4000);
    await until(() => h.link!.players.length === 1 && g.link!.players.length === 1 && g.combat.enemies.some((e) => e.replica), 4000, () => frame([h, g]));
    expect(h.link!.players[0].name).toBe('Gus');
    expect(g.link!.players[0].name).toBe('Hana');
    const replica = g.combat.enemies.find((e) => e.replica && e.species === SPECIES.glitchling)!;
    expect(Math.abs(replica.x - wolf.x)).toBeLessThan(1.5);

    // The guest strikes its copy: the host's creature takes it.
    const before = wolf.hp;
    g.combat.onReplicaHit!(replica, 5, false, 1, 0, false);
    await until(() => wolf.hp < before, 2000, () => frame([h, g]));
    expect(before - wolf.hp).toBe(5);
    // A blow from out of reach is refused (once the host believes they went:
    // a jump is believed only once held a moment).
    g.me.x += 20;
    await run([h, g], 1800);
    const hp = wolf.hp;
    g.combat.onReplicaHit!(replica, 5, false, 1, 0, false);
    await run([h, g], 150);
    expect(wolf.hp).toBe(hp);
  });

  it('lets the host\'s creatures strike the guest, through the guest\'s own armour and health', async () => {
    const sw = new FakeSwitch({ latency: 3, openDelay: 5 });
    const relay = new FakeRelay();
    const h = player('Hana', sw, relay);
    const g = player('Gus', sw, relay);
    await host(h);
    await sleep(30);
    await join(g);
    // The guest wanders off; a creature waits by them, far from the host.
    g.me.x += 30;
    await until(() => h.combat.others.length === 1 && Math.abs(h.combat.others[0].x - g.me.x) < 0.1, 3000, () => frame([h, g]));
    const e = new Enemy(SPECIES.glitchling, g.me.x + 0.6, g.me.y, 0, false);
    e.provoke();
    h.combat.add(e);
    h.trip.adopt(e, 4001);
    const health = g.vitals.health;
    await until(() => g.vitals.health < health, 4000, () => frame([h, g]));
    expect(h.vitals.health).toBe(h.vitals.maxHealth);
  });

  it('settles the Warden by who fought it, and gives the guest its share of the vault', async () => {
    const sw = new FakeSwitch({ latency: 3, openDelay: 5 });
    const relay = new FakeRelay();
    const h = player('Hana', sw, relay);
    const g = player('Gus', sw, relay);
    await host(h);
    await sleep(30);
    await join(g);
    // On to the Warden: everyone in its arena wakes it.
    h.trip.run.skipTo(siteOf('boss'));
    const c = LAYOUT.sites[siteOf('boss')].center;
    h.me.x = g.me.x = c.x;
    h.me.y = g.me.y = c.y + 4;
    await until(() => !!h.combat.boss, 3000, () => frame([h, g]));
    const boss = h.combat.boss!;
    await until(() => g.combat.enemies.some((e) => e.replica && e.species.boss), 3000, () => frame([h, g]));
    const key = h.link!.session.members().find((m) => m.name === 'Gus')!;
    const gusKey = [...key.key].map((b) => b.toString(16).padStart(2, '0')).join('');
    // The guest does a quarter of the work; the host the rest (as its own blows would).
    h.combat.strike(boss, 50, false, 1, 0, gusKey);
    h.trip.run.damage(LOCAL, h.trip.netIdOf(boss), 150);
    h.combat.strike(boss, 10_000, false, 1, 0, gusKey);
    await until(() => g.trip.run.portalOpen && g.trip.run.share(LOCAL).attuned, 3000, () => frame([h, g]));
    // The killing blow was the guest's: its experience went there.
    expect(g.xp).toBeGreaterThan(0);
    const mine = h.trip.run.share(LOCAL).share;
    expect(mine).toBeGreaterThan(0);
    expect(g.trip.run.share(LOCAL).share).toBeCloseTo(1 - mine, 3);

    // The guest opens the vault: the host decides, and sends its share.
    const cx = LAYOUT.chest % LAYOUT.w;
    const cy = Math.floor(LAYOUT.chest / LAYOUT.w);
    expect(g.trip.run.interact(cx, cy)).toBe(true);
    g.trip.update(0, g.me.x, g.me.y);
    await until(() => g.trip.run.chestOpened, 3000, () => frame([h, g]));
    expect(g.got.some(([item]) => item === Items.riftShard)).toBe(true);
    expect(g.trip.run.chestOpened).toBe(true);
    expect(h.trip.run.chestOpened).toBe(false);
    // Asked again, it does not pay twice.
    const had = g.got.length;
    g.link!.claim();
    await run([h, g], 150);
    expect(g.got.length).toBe(had);
  });

  it('tells a guest who comes back after the Warden fell what it is owed, so its portal answers', async () => {
    const sw = new FakeSwitch({ latency: 3, openDelay: 5 });
    const relay = new FakeRelay();
    const h = player('Hana', sw, relay);
    const g = player('Gus', sw, relay);
    await host(h);
    // Gus fought the Warden, then his link dropped: the host's tally keeps him.
    const gusKey = g.net.identity.keys.pubkey;
    h.trip.run.join(gusKey, LAYOUT.arrival.x, LAYOUT.arrival.y);
    h.trip.run.skipTo(siteOf('boss'));
    const c = LAYOUT.sites[siteOf('boss')].center;
    h.me.x = c.x;
    h.me.y = c.y + 4;
    await until(() => !!h.combat.boss, 3000, () => frame([h]));
    h.combat.strike(h.combat.boss!, 10_000, false, 1, 0, gusKey);
    await until(() => h.trip.run.portalOpen, 3000, () => frame([h]));
    // He comes back: the host tells him at once.
    await join(g);
    await until(() => g.trip.run.share(LOCAL).attuned, 3000, () => frame([h, g]));
    expect(g.trip.run.share(LOCAL).attuned).toBe(true);
  });

  it('carries on when the host goes: the longest-connected guest runs the instance', async () => {
    const sw = new FakeSwitch({ latency: 3, openDelay: 5 });
    const relay = new FakeRelay();
    const h = player('Hana', sw, relay);
    const a = player('Ari', sw, relay);
    const b = player('Bea', sw, relay);
    await host(h);
    await sleep(30);
    await join(a);
    await join(b);
    const all = [h, a, b];
    await until(() => a.link!.players.length === 2 && b.link!.players.length === 2, 4000, () => frame(all));
    // The host wakes the nest; its first wave goes out to everyone.
    const nest = LAYOUT.sites[siteOf('combat')];
    for (const p of all) {
      p.me.x = nest.center.x;
      p.me.y = nest.center.y;
    }
    await until(() => h.trip.run.challenges[siteOf('combat')]!.state === 'active' && b.combat.enemies.filter((e) => e.replica).length >= 4 && a.trip.run.challenges[siteOf('combat')]!.state === 'active', 4000, () => frame(all));
    const ids = h.combat.enemies.map((e) => h.trip.netIdOf(e)).filter((id) => id > 0 && id < 0x4000);

    // The host's tab dies.
    h.link!.session.dispose();
    sw.drop('Hana');
    players.splice(players.indexOf(h), 1);
    h.net.close();
    await until(() => a.trip.run.authority && a.link!.isHost, 8000, () => frame([a, b]));
    // Its copies are the creatures now, by the same ids; the nest carries on.
    for (const id of ids) expect(a.trip.enemyByNet(id)?.replica).toBe(false);
    expect(a.trip.run.challenges[siteOf('combat')]!.state).toBe('active');
    expect(a.notes.some((t) => t.includes('holds on through you'))).toBe(true);
    // The other guest goes on seeing them, now from the new host.
    await run([a, b], 400);
    expect(b.trip.run.authority).toBe(false);
    expect(b.combat.enemies.filter((e) => e.replica).length).toBeGreaterThanOrEqual(ids.length);
    expect(b.link!.players.map((p) => p.name)).toEqual(['Ari']);
    // Killing one on the new host is seen by the other.
    const target = a.trip.enemyByNet(ids[0])!;
    a.combat.strike(target, 10_000, false, 1, 0, 'ff'.repeat(32));
    await run([a, b], 300);
    expect(b.combat.enemies.filter((e) => e.replica).length).toBe(a.combat.enemies.length);
  }, 30_000);
});
