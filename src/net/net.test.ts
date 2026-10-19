import { describe, expect, it } from 'vitest';
import { FakeSwitch } from './fake';
import { FakeRelay } from './fakeRelay';
import { Net } from './index';
import { MemoryHub } from './signaling';

const MAP = new Uint8Array(32).fill(3);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Waits until `check` holds, or fails after `ms`. */
async function until(check: () => boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error('Timed out waiting');
    await sleep(10);
  }
}

describe('the network, end to end (fake links, fake relay)', () => {
  it('joins a friend’s world by code, and rejoins after a drop', async () => {
    const sw = new FakeSwitch({ latency: 5, openDelay: 10 });
    const hub = new MemoryHub();
    const host = new Net({ gameVersion: '1', storage: null, linker: sw.linker('H'), bus: hub.bus(), iterations: 10 });
    const guest = new Net({ gameVersion: '1', storage: null, linker: sw.linker('G'), bus: hub.bus(), iterations: 10 });
    const world = await host.hostWorld();
    expect(world.code).toMatch(/^[0-9A-Z]{4}-[0-9A-Z]{4}$/);
    const session = await guest.joinWorld(world.code.toLowerCase());
    expect(session.members().length).toBe(2);
    const slot = session.slot;

    sw.drop('G');
    await until(() => world.session.peers.get(slot)?.away === true);
    // The guest rejoins by itself, into the same slot.
    await until(() => world.session.peers.get(slot)?.away === false && !!session.peers.get(0)?.link?.open);
    expect(session.slot).toBe(slot);

    world.stop();
    await until(() => session.ended === 'host-left');
    await expect(guest.joinWorld('nope!')).rejects.toMatchObject({ reason: 'bad-code' });
    host.close();
    guest.close();
  });

  it('finds an instance on the board, joins it, and keeps it listed after the host goes', async () => {
    const sw = new FakeSwitch({ latency: 5, openDelay: 10 });
    const relay = new FakeRelay();
    const make = (name: string) => {
      const net = new Net({ gameVersion: '1', storage: null, linker: sw.linker(name), socket: () => relay.socket(), relays: ['wss://fake'], iterations: 10 });
      net.identity.name = name;
      return net;
    };
    const [h, a, b, c] = ['Hana', 'Ari', 'Bea', 'Cal'].map(make);
    const inst = await h.hostInstance('hollow', MAP);
    await sleep(50);

    const list = await a.findInstances('hollow', 1000);
    expect(list.map((e) => e.name)).toEqual(['Hana']);
    const sa = await a.joinInstance(list[0], MAP);
    const sb = await b.joinInstance((await b.findInstances('hollow', 1000))[0], MAP);
    await until(() => sa.peers.get(sb.slot)?.link?.open === true);
    expect(sa.members().map((m) => m.name)).toEqual(['Hana', 'Ari', 'Bea']);

    // The host's tab dies: Ari (longest connected) takes over, and the
    // instance stays joinable by its code.
    sw.drop('Hana');
    inst.session.dispose();
    h.close();
    await until(() => sa.isHost && sb.hostSlot === sa.slot);
    await sleep(100);
    const after = await c.findInstances('hollow', 1000);
    expect(after.some((e) => e.name === 'Ari')).toBe(true);
    const sc = await c.joinInstance(after.find((e) => e.name === 'Ari')!, MAP);
    await until(() => sc.peers.get(sb.slot)?.link?.open === true);
    expect(sc.members().map((m) => m.name)).toEqual(['Ari', 'Bea', 'Cal']);

    for (const s of [sa, sb, sc]) s.leave();
    for (const n of [h, a, b, c]) n.close();
  });
});
