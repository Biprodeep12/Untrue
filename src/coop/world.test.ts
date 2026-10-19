import { afterEach, describe, expect, it } from 'vitest';
import { CHUNK_SIZE } from '../config';
import { Enemy } from '../entities/Enemy';
import { SPECIES, type Species } from '../entities/Species';
import { Rng } from '../generation/Random';
import { Deco } from '../generation/Tiles';
import { Items, type ItemDef } from '../items/Items';
import { FakeSwitch } from '../net/fake';
import { Net } from '../net/index';
import { MemoryHub } from '../net/signaling';
import { CombatSystem } from '../systems/CombatSystem';
import { Inventory } from '../systems/InventorySystem';
import { Progression } from '../systems/Progression';
import { Vitals } from '../systems/Vitals';
import { WorldEvents } from '../systems/WorldEvents';
import type { View } from '../world/ChunkManager';
import { SyncGenerator } from '../world/SyncGenerator';
import { WorldManager } from '../world/WorldManager';
import type { WorldObject } from '../world/WorldObject';
import type { WorldGame } from './worldGame';
import { WorldGuest } from './WorldGuest';
import { WorldHost } from './WorldHost';
import { Place } from './worldWire';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function until(check: () => boolean, ms = 6000, tick?: () => void): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error('Timed out waiting');
    tick?.();
    await sleep(5);
  }
}

interface Side {
  world: WorldManager;
  combat: CombatSystem;
  vitals: Vitals;
  me: { x: number; y: number };
  game: WorldGame;
  got: Array<[ItemDef, number]>;
  killed: Species[];
  notes: string[];
  ended: string | null;
  clock: { day: number; minutes: number };
  where: { place: number; object: WorldObject | null; index: number; floor: number };
}

function side(world: WorldManager): Side {
  const vitals = new Vitals();
  const combat = new CombatSystem(world, new Inventory(), vitals, new Progression(), { damage: () => {}, swing: () => {}, playerHurt: () => {}, notify: () => {} });
  const s = { world, combat, vitals, me: { x: 0, y: 0 }, got: [], killed: [], notes: [], ended: null, clock: { day: 1, minutes: 600 }, where: { place: Place.Outdoors, object: null, index: 0, floor: 0 } } as unknown as Side;
  const seen = { x: 0, y: 0, facing: 0, frame: 0, moving: false, hurt: 0, guarding: false, holding: -1, health: 1 };
  s.game = {
    world,
    combat,
    player: () => {
      seen.x = s.me.x;
      seen.y = s.me.y;
      return seen;
    },
    where: () => s.where,
    view: () => ({ x: s.me.x, y: s.me.y, px: s.me.x, py: s.me.y, halfW: 15, halfH: 9, dirX: 0, dirY: 0 }),
    spot: () => s.me,
    notify: (t) => s.notes.push(t),
    give: (item, count) => s.got.push([item, count]),
    grantXp: () => {},
    killed: (sp) => s.killed.push(sp),
    replicaGone: () => {},
    clock: () => ({ ...s.clock, weather: '{}' }),
    setClock: (day, minutes) => (s.clock = { day, minutes }),
    joinRequest: async () => true,
    peopleChanged: () => {},
    ended: (t) => (s.ended = t),
    saveSoon: () => {},
    riftInstance: () => {},
  };
  return s;
}

const viewAt = (x: number, y: number): View => ({ minX: x - 15, minY: y - 9, maxX: x + 15, maxY: y + 9, playerX: x, playerY: y, dirX: 0, dirY: 0 });

const nets: Net[] = [];
afterEach(() => {
  for (const n of nets) n.close();
  nets.length = 0;
});

/** A host at the origin and a guest joined to it, both stepping. */
async function pair(hostAt = { x: 0, y: 0 }) {
  const sw = new FakeSwitch({ latency: 2, openDelay: 5 });
  const hub = new MemoryHub();
  const make = (name: string) => {
    const net = new Net({ gameVersion: 'w', storage: null, linker: sw.linker(name), bus: hub.bus(), iterations: 10 });
    net.identity.name = name;
    nets.push(net);
    return net;
  };
  const hostNet = make('Hana');
  const guestNet = make('Gil');
  const host = side(new WorldManager(1234, new SyncGenerator()));
  host.me = { ...hostAt };
  host.world.update(viewAt(host.me.x, host.me.y));
  const opened = await hostNet.hostWorld();
  const link = new WorldHost(opened.session, host.game, opened.code, opened.stop);
  const session = await guestNet.joinWorld(opened.code);
  const guestLink = new WorldGuest(session, opened.code);
  const info = await guestLink.hello();
  const guest = side(new WorldManager(info.seed, guestLink.generator, true));
  guest.me = { x: info.x + 2, y: info.y };
  guestLink.attach(guest.game);
  const frame = (dt = 1 / 60) => {
    const v = viewAt(guest.me.x, guest.me.y);
    guestLink.view(v);
    guest.world.update(v);
    host.world.update(viewAt(host.me.x, host.me.y), link.views);
    host.combat.update(dt, { x: host.me.x, y: host.me.y, faceX: 0, faceY: 1, blocking: false, invulnerable: true });
    link.update(dt);
    guest.combat.update(dt, { x: guest.me.x, y: guest.me.y, faceX: 1, faceY: 0, blocking: false, invulnerable: false });
    guestLink.update(dt);
  };
  /** Moves the guest to `to`, and waits until the host believes it (a jump is
   *  believed once held steadily: see `MoveGuard`). */
  const moveTo = async (to: { x: number; y: number }) => {
    guest.me = { ...to };
    await until(() => link.players.list.some((rm) => Math.hypot(rm.body.x - to.x, rm.body.y - to.y) < 0.05), 4000, frame);
  };
  return { host, guest, link, guestLink, info, frame, moveTo };
}

/** Every ready guest chunk in its render area, and whether the host's is the same. */
function sameChunks(host: WorldManager, guest: WorldManager): { ready: number; same: number } {
  let ready = 0;
  let same = 0;
  for (const c of guest.chunks.chunks.values()) {
    if (!c.ready) continue;
    ready++;
    const h = host.chunks.chunks.get(c.key);
    if (h?.ready && h.tiles.every((t, i) => t === c.tiles[i]) && h.decos.every((d, i) => d === c.decos[i])) same++;
  }
  return { ready, same };
}

function findDeco(world: WorldManager, decos: readonly number[], near: { x: number; y: number }, within = 12): [number, number] | null {
  for (let r = 1; r <= within; r++) {
    for (let y = near.y - r; y <= near.y + r; y++) {
      for (let x = near.x - r; x <= near.x + r; x++) {
        if (decos.includes(world.tileAt(Math.floor(x), Math.floor(y))?.deco ?? -1)) return [Math.floor(x), Math.floor(y)];
      }
    }
  }
  return null;
}

describe('a shared overworld (fake links)', () => {
  it('streams the host’s land: the guest’s chunks are the host’s, byte for byte', async () => {
    const { host, guest, info, frame } = await pair({ x: 40, y: 20 });
    expect(info.seed).toBe(1234);
    expect(Math.round(info.x)).toBe(40);
    await until(() => sameChunks(host.world, guest.world).ready >= 12, 8000, frame);
    const { ready, same } = sameChunks(host.world, guest.world);
    expect(same).toBe(ready);
    // Biomes and region visits came with the chunks; nothing was rolled here.
    expect(guest.world.biomeAt(41, 20)?.id).toBe(host.world.biomeAt(41, 20)?.id);
    expect(guest.world.biomeAt(41, 20)?.type).toBe(host.world.biomeAt(41, 20)?.type);
    // And the structures over them, wherever they overlap.
    for (const o of guest.world.objects.objects.values()) expect(host.world.objects.objects.has(o.id)).toBe(true);
  });

  it('keeps streaming where the guest walks, far from the host, and the host keeps that land', async () => {
    const { host, guest, frame } = await pair();
    await until(() => sameChunks(host.world, guest.world).ready >= 9, 8000, frame);
    guest.me = { x: 6 * CHUNK_SIZE, y: 0 };
    await until(() => !!guest.world.tileAt(6 * CHUNK_SIZE, 0) && !!guest.world.tileAt(6 * CHUNK_SIZE + 20, 5), 8000, frame);
    // The host keeps the guest's area as well as its own.
    expect(host.world.tileAt(6 * CHUNK_SIZE, 0)).not.toBeNull();
    expect(host.world.tileAt(0, 0)).not.toBeNull();
    const { ready, same } = sameChunks(host.world, guest.world);
    expect(same).toBe(ready);
  });

  it('gathering on either side reaches the other; the host decides, and gives', async () => {
    const { host, guest, guestLink, frame, moveTo } = await pair();
    await until(() => sameChunks(host.world, guest.world).ready >= 9, 8000, frame);
    const trees = [Deco.Oak, Deco.OakAutumn, Deco.Pine, Deco.Bush, Deco.Stone];
    const t = findDeco(guest.world, trees, guest.me)!;
    expect(t).not.toBeNull();
    await moveTo({ x: t[0] + 0.5, y: t[1] + 1.5 });
    // As gathering does: gone here at once, given only once the host says so.
    const deco = guest.world.tileAt(t[0], t[1])!.deco;
    guest.world.harvest(t[0], t[1]);
    let gave = 0;
    guestLink.confirm(guest.world, t[0], t[1], deco, () => gave++);
    expect(guest.world.tileAt(t[0], t[1])!.deco).toBe(0);
    expect(gave).toBe(0);
    await until(() => host.world.tileAt(t[0], t[1])?.deco === 0 && gave === 1, 3000, frame);
    // The same tree again (another player got there too): nothing more.
    guestLink.confirm(guest.world, t[0], t[1], deco, () => gave++);
    await until(() => guest.notes.includes('Someone got to it first'), 3000, frame);
    expect(gave).toBe(1);

    // The host gathers too: the guest sees it go.
    const u = findDeco(host.world, trees, guest.me)!;
    host.world.harvest(u[0], u[1]);
    await until(() => guest.world.tileAt(u[0], u[1])?.deco === 0, 3000, frame);
    const { ready, same } = sameChunks(host.world, guest.world);
    expect(same).toBe(ready);
  });

  it('a guest’s gathering out of reach is put right, and gives nothing', async () => {
    const { host, guest, guestLink, frame, moveTo } = await pair();
    await until(() => sameChunks(host.world, guest.world).ready >= 9, 8000, frame);
    await moveTo(guest.me);
    const t = findDeco(guest.world, [Deco.Oak, Deco.OakAutumn, Deco.Pine, Deco.Bush, Deco.Stone], { x: guest.me.x + 12, y: guest.me.y }, 6)!;
    const before = guest.world.tileAt(t[0], t[1])!.deco;
    guest.world.harvest(t[0], t[1]);
    let gave = 0;
    guestLink.confirm(guest.world, t[0], t[1], before, () => gave++);
    await until(() => guest.world.tileAt(t[0], t[1])?.deco === before, 3000, frame);
    expect(host.world.tileAt(t[0], t[1])!.deco).toBe(before);
    await until(() => guest.notes.includes('Someone got to it first'), 3000, frame);
    expect(gave).toBe(0);
  });

  it('a chest opens for one player only', async () => {
    const { host, guest, link, guestLink, frame, moveTo } = await pair();
    await until(() => sameChunks(host.world, guest.world).ready >= 9, 8000, frame);
    // A world event raises an obelisk with a chest beside the guest.
    const events = new WorldEvents(host.world, new Rng(3), { notify: () => {}, meteor: () => {}, bandits: () => {}, invasion: () => {}, merchant: () => {}, waypoint: () => {} });
    expect(events.trigger('ancient', { x: guest.me.x, y: guest.me.y, night: false, village: null, merchantNearby: false, now: 600 })).toBe(true);
    const hostObelisk = [...host.world.objects.objects.values()].find((o) => o.kind === 'risen-obelisk')!;
    await until(() => guest.world.objects.objects.has(hostObelisk.id), 3000, frame);
    const o = guest.world.objects.objects.get(hostObelisk.id) as WorldObject;
    const index = o.layout.decos.indexOf(Deco.Chest);
    await moveTo({ x: o.x + (index % o.w) + 0.5, y: o.y + Math.floor(index / o.w) + 1.5 });
    let granted = 0;
    expect(guestLink.claimChest(o, index, () => granted++)).toBe(true);
    await until(() => granted === 1, 3000, frame);
    expect(hostObelisk.opened.has(index)).toBe(true);
    await until(() => o.opened.has(index), 3000, frame);
    // A second time: someone got to it first.
    guestLink.claimChest(o, index, () => granted++);
    await until(() => guest.notes.includes('Someone got to it first'), 3000, frame);
    expect(granted).toBe(1);
    expect(link.names()).toEqual(['Hana (you)', 'Gil']);
  });

  it('items on the ground: dropped by one, picked up by the other', async () => {
    const { host, guest, guestLink, frame } = await pair();
    await until(() => sameChunks(host.world, guest.world).ready >= 9, 8000, frame);
    host.world.ground.drop({ item: Items.wood, count: 3 }, guest.me.x + 3, guest.me.y);
    await until(() => guest.world.ground.items.length === 1, 3000, frame);
    // Walk away (so it arms) and onto it.
    guest.me = { x: guest.me.x + 6, y: guest.me.y };
    for (let i = 0; i < 3; i++) {
      frame();
      guest.world.ground.update(guest.me.x, guest.me.y, new Inventory());
    }
    guest.me = { x: guest.me.x - 3, y: guest.me.y };
    for (let i = 0; i < 3; i++) {
      frame();
      guest.world.ground.update(guest.me.x, guest.me.y, new Inventory());
    }
    await until(() => guest.got.some(([it, n]) => it === Items.wood && n === 3), 3000, frame);
    await until(() => host.world.ground.items.length === 0 && guest.world.ground.items.length === 0, 3000, frame);

    guestLink.drop({ item: Items.stone, count: 2 }, guest.me.x + 0.5, guest.me.y);
    await until(() => host.world.ground.items.some((g) => g.stack.item === Items.stone) && guest.world.ground.items.length === 1, 3000, frame);
  });

  it('creatures are the host’s: the guest sees them, strikes them, and is struck', async () => {
    const { host, guest, frame } = await pair();
    await until(() => sameChunks(host.world, guest.world).ready >= 9, 8000, frame);
    const [wolf] = host.combat.spawnGroup(SPECIES.wolf, guest.me.x + 1.2, guest.me.y, 1, { provoke: true });
    expect(wolf).toBeInstanceOf(Enemy);
    const replicaOf = () => guest.combat.enemies.find((e) => e.replica && e.species === SPECIES.wolf);
    // It comes for the guest, as the host runs it.
    await until(() => {
      const r = replicaOf();
      return !!r && Math.hypot(r.x - guest.me.x, r.y - guest.me.y) < 1.2;
    }, 4000, frame);
    const hp = wolf.hp;
    const replica = replicaOf()!;
    // Strike toward it.
    guest.combat.attack(replica.x - guest.me.x, replica.y - guest.me.y, null);
    await until(() => wolf.hp < hp, 3000, frame);
    // Only the host spawns creatures: everything the guest sees is the host's.
    expect(guest.combat.enemies.every((e) => e.replica)).toBe(true);
    // It bites back: the guest's own health goes down.
    const health = guest.vitals.health;
    await until(() => guest.vitals.health < health, 8000, frame);
  });

  it('sends the clock, and sends a guest home when kicked', async () => {
    const { host, guest, link, guestLink, frame } = await pair();
    host.clock = { day: 3, minutes: 900 };
    link.clockJumped();
    await until(() => guest.clock.day === 3, 3000, frame);
    expect(guest.clock.minutes).toBe(900);
    link.kick(guestLink.session.slot);
    await until(() => guest.ended !== null, 3000, frame);
    expect(guest.ended).toMatch(/sent you home/);
  });

  it('players are drawn only where they are: outdoors, or in the same room', async () => {
    const { host, guest, link, guestLink, frame } = await pair();
    await until(() => sameChunks(host.world, guest.world).ready >= 9, 8000, frame);
    await until(() => guestLink.players.drawn.length === 1 && link.players.drawn.length === 1, 3000, frame);
    // A building both have: the host goes in.
    let house: WorldObject | undefined;
    for (const o of host.world.objects.objects.values()) if (o.layout.buildings.length && guest.world.objects.objects.has(o.id)) house = o;
    if (!house) {
      // None near: any object both have stands in for a room.
      house = [...host.world.objects.objects.values()].find((o) => guest.world.objects.objects.has(o.id));
    }
    expect(house).toBeDefined();
    host.where = { place: Place.Indoors, object: house!, index: 0, floor: 0 };
    await until(() => guestLink.players.drawn.length === 0, 3000, frame);
    // The guest follows into the same room: they see each other there.
    guest.where = { place: Place.Indoors, object: guest.world.objects.objects.get(house!.id)!, index: 0, floor: 0 };
    await until(() => guestLink.players.drawn.length === 1 && link.players.drawn.length === 1, 3000, frame);
    // Another floor is another room.
    guest.where = { ...guest.where, floor: 1 };
    await until(() => guestLink.players.drawn.length === 0 && link.players.drawn.length === 0, 3000, frame);
  });

  it('gives back what may not be put down, and keeps what is put down while the host is away', async () => {
    const { host, guest, link, guestLink, frame, moveTo } = await pair();
    await until(() => sameChunks(host.world, guest.world).ready >= 9, 8000, frame);
    await moveTo(guest.me);
    // A bound beacon, and more than a stack: given back, never lost, never on the host's ground.
    guestLink.drop({ item: Items.driftBeacon, count: 1 }, guest.me.x, guest.me.y);
    guestLink.drop({ item: Items.wood, count: 5000 }, guest.me.x, guest.me.y);
    await until(() => guest.got.some(([it]) => it === Items.driftBeacon) && guest.got.some(([it, n]) => it === Items.wood && n === 5000), 3000, frame);
    expect(host.world.ground.items.length).toBe(0);
    // Too far from where they stand: back to them too.
    guestLink.drop({ item: Items.stone, count: 1 }, guest.me.x + 40, guest.me.y);
    await until(() => guest.got.some(([it]) => it === Items.stone), 3000, frame);
    expect(host.world.ground.items.length).toBe(0);
    expect(link.isClosed).toBe(false);
  });

  it('says why a visit ended, even if it ended while the game was loading', async () => {
    const sw = new FakeSwitch({ latency: 2, openDelay: 5 });
    const hub = new MemoryHub();
    const make = (name: string) => {
      const net = new Net({ gameVersion: 'w', storage: null, linker: sw.linker(name), bus: hub.bus(), iterations: 10 });
      net.identity.name = name;
      nets.push(net);
      return net;
    };
    const host = side(new WorldManager(1234, new SyncGenerator()));
    host.world.update(viewAt(0, 0));
    const opened = await make('Hana').hostWorld();
    const link = new WorldHost(opened.session, host.game, opened.code, opened.stop);
    const session = await make('Gil').joinWorld(opened.code);
    const guestLink = new WorldGuest(session, opened.code);
    const info = await guestLink.hello();
    // The host closes before the visitor's game has attached.
    link.close();
    await until(() => guestLink.isClosed, 3000);
    const guest = side(new WorldManager(info.seed, guestLink.generator, true));
    guestLink.attach(guest.game);
    expect(guest.ended).toMatch(/closed their world/);
  });
});
