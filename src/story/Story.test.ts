import { describe, expect, it } from 'vitest';
import { Deco } from '../generation/Tiles';
import { Items } from '../items/Items';
import { Inventory } from '../systems/InventorySystem';
import { NpcSystem } from '../systems/NpcSystem';
import type { DialogOption } from '../ui/Dialog';
import { SyncGenerator } from '../world/SyncGenerator';
import { SEMI_KEEP_MINUTES, WorldManager } from '../world/WorldManager';
import type { WorldObject } from '../world/WorldObject';
import { restore, snapshot } from '../save/SaveManager';
import { PLACES } from './StoryPlaces';
import { StorySystem } from './StorySystem';

function view(px: number, py: number) {
  return { minX: px - 15, minY: py - 9, maxX: px + 15, maxY: py + 9, playerX: px, playerY: py, dirX: 0, dirY: 0 };
}

function setup(seed = 1234) {
  const world = new WorldManager(seed, new SyncGenerator());
  const npcs = new NpcSystem(world);
  const inventory = new Inventory();
  let options: DialogOption[] = [];
  const visions: string[] = [];
  let bells = 0;
  const story = new StorySystem(world, npcs, inventory, {
    notify: () => {},
    vision: (v, then) => {
      visions.push(v.title);
      then?.();
    },
    talk: (_n, _t, o) => (options = o),
    closeDialog: () => {},
    bell: () => bells++,
    grantXp: () => {},
    unstick: () => {},
    day: () => 1,
  });
  const choose = (label: string) => {
    const o = options.find((x) => x.label.startsWith(label));
    expect(o, `no option "${label}"`).toBeDefined();
    o!.action();
  };
  /** Clicks Continue through a conversation. */
  const listen = () => {
    for (let k = 0; k < 10; k++) {
      const next = options.find((o) => o.label === 'Continue' || o.label === 'Farewell');
      if (!next) return;
      options = [];
      next.action();
    }
  };
  const place = (id: string) => world.objects.objects.get(`story:${id}`)!;
  /** Loads the area around a story place and returns its centre. */
  const go = (o: WorldObject): [number, number] => {
    const cx = o.x + o.w / 2;
    const cy = o.y + o.h / 2;
    world.update(view(cx, cy));
    npcs.update(0.01, 12, cx, cy, 0);
    story.update(cx, cy);
    return [cx, cy];
  };
  /** Tile of the n-th decoration of a kind in a place's layout. */
  const decoAt = (o: WorldObject, deco: number, n = 0): [number, number] => {
    const hits = [...o.layout.decos.keys()].filter((i) => o.layout.decos[i] === deco);
    const i = hits[n];
    return [o.x + (i % o.w), o.y + Math.floor(i / o.w)];
  };
  const people = () => npcs.npcs.filter((n) => story.hasNews(n));
  return { world, npcs, inventory, story, choose, listen, place, go, decoAt, people, visions, bells: () => bells };
}

describe('story places', () => {
  it('stand at their distances, persist, and keep generated structures off them', () => {
    const { world, story, place } = setup();
    story.begin(true);
    for (const [id, p] of Object.entries(PLACES)) {
      const o = place(id);
      expect(o.persistence).toBe('persistent');
      const d = Math.hypot(o.x + o.w / 2, o.y + o.h / 2);
      expect(d).toBeGreaterThanOrEqual(p.distance - 60);
    }
    const graves = place('graves');
    world.update(view(graves.x + graves.w / 2, graves.y + graves.h / 2));
    for (const o of world.objects.objects.values()) {
      if (o === graves || o.kind.startsWith('story-')) continue;
      expect(o.overlaps(graves.x, graves.y, graves.w, graves.h, 0)).toBe(false);
    }
  });

  it('gives a new wanderer the lantern', () => {
    const { story, inventory } = setup();
    story.begin(true);
    expect(inventory.count(Items.wanderersLantern)).toBe(1);
  });
});

describe('the story, start to finish', () => {
  it('plays through every chapter to an ending', () => {
    const s = setup();
    const { story, world, place, go, decoAt, choose, listen } = s;
    story.begin(true);
    expect(story.stage).toBe('waking');

    // Prologue: the monument crumbles and the bell rings.
    const monument = place('monument');
    go(monument);
    expect(story.interactAt(...decoAt(monument, Deco.Monument))).toBe(true);
    choose('Continue');
    expect(s.bells()).toBe(1);
    expect(story.stage).toBe('bell');

    // Chapters I and II: the village, its people, the graves, the night.
    const graves = place('graves');
    go(graves);
    expect(story.stage).toBe('village');
    const villagers = s.people();
    expect(villagers).toHaveLength(3);
    for (const n of villagers) {
      story.talk(n);
      listen();
    }
    expect(story.interactAt(...decoAt(graves, Deco.Gravestone))).toBe(true);
    expect(story.stage).toBe('night');
    const [gx, gy] = decoAt(graves, Deco.Campfire);
    expect(story.rest(gx, gy)).toBe(true);
    expect(world.objects.objects.has('story:graves')).toBe(false);
    expect(story.memories.map((m) => m.name)).toContain('Village of Graves');
    expect(story.stage).toBe('observatory');

    // Chapter III: the astronomer.
    go(place('observatory'));
    const [oldman] = s.people();
    story.talk(oldman);
    listen();
    expect(story.stage).toBe('archive');

    // Chapter IV: three memories, then the Hall of Lanterns.
    const archive = place('archive');
    go(archive);
    for (let n = 0; n < 3; n++) story.interactAt(...decoAt(archive, Deco.Pedestal, n));
    expect(story.interactAt(...decoAt(archive, Deco.LanternRack))).toBe(true);
    expect(story.stage).toBe('return');

    // Chapters V and VI: the younger self, and the lantern goes dark.
    go(place('observatory'));
    const younger = s.people().find((n) => n.ghost)!;
    story.talk(younger);
    listen();
    expect(story.lanternDark).toBe(true);
    expect(story.stage).toBe('anchor');

    // Chapter VII: the choice.
    const anchor = place('anchor');
    go(anchor);
    story.interactAt(...decoAt(anchor, Deco.AnchorCore));
    choose('Destroy');
    expect(story.ending).toBe('living');
    expect(story.stage).toBe('epilogue');
    expect(world.rules.rareBoost).toBe(3);
    expect(story.lanternDark).toBe(true);
    expect(s.visions).toContain('The Living World');
  });

  it('remembers its progress across a save, and the village stays gone', () => {
    const a = setup();
    a.story.begin(true);
    a.story.stage = 'observatory';
    a.story.remember(a.place('graves'));
    a.world.removeObject(a.place('graves'));
    a.story.load({ ...a.story.save(), flags: ['village-gone'] });
    const saved = a.story.save();

    const b = setup();
    b.story.load(saved);
    b.story.begin(false);
    expect(b.story.stage).toBe('observatory');
    expect(b.world.objects.objects.has('story:graves')).toBe(false);
    expect(b.story.memories).toHaveLength(1);
  });
});

describe('endings change the world', () => {
  it('the Remembered World mostly stops regenerating', () => {
    const { story, world } = setup();
    story.begin(true);
    story.load({ ...story.save(), ending: 'remembered', stage: 'epilogue' });
    story.begin(false);
    expect(world.rules.regenChance).toBe(0.25);
    let renewed = 0;
    for (let x = 0; x < 40; x++) {
      world.update(view(x * 300, 0));
      world.update(view(x * 300 + 20000, 0));
      if (world.regions.visit(Math.floor((x * 300) / 32), 0) > 0) renewed++;
    }
    expect(renewed).toBeLessThan(25);
  });

  it('the lantern keeps places the world forgets', () => {
    const { world, story } = setup();
    let found: WorldObject | undefined;
    for (let x = 0; x < 4000 && !found; x += 32) {
      world.update(view(x, 0));
      found = [...world.objects.objects.values()].find((o) => o.persistence === 'temporary');
    }
    found!.discovered = true;
    world.update(view(found!.x + 30000, 0));
    expect(story.memories.map((m) => m.name)).toContain(found!.name);
  });

  it('forgets a discovered place once it is left behind, and the map lets it go', () => {
    const { world, story } = setup();
    let found: WorldObject | undefined;
    for (let x = 0; x < 4000 && !found; x += 32) {
      world.update(view(x, 0));
      found = [...world.objects.objects.values()].find((o) => o.persistence === 'temporary');
    }
    const o = found!;
    o.discovered = true;
    world.know(o);
    world.update(view(o.x + 30000, 0));
    expect(world.objects.objects.has(o.id)).toBe(false);
    expect(world.known.has(o.id)).toBe(false);
    expect(story.memories.some((m) => m.name === o.name && m.x === o.x && m.y === o.y)).toBe(true);
  });

  it('keeps a discovered village for three days, then forgets it like any other place', () => {
    const { world, story } = setup();
    let minutes = 0;
    world.now = () => minutes;
    let village: WorldObject | undefined;
    for (let x = 0; x < 60000 && !village; x += 32) {
      world.update(view(x, 0));
      village = [...world.objects.objects.values()].find((o) => o.kind === 'village');
    }
    const v = village!;
    expect(v.persistence).toBe('semi-persistent');
    v.discovered = true;
    world.know(v);
    // Walk far away: the village unloads, but is kept.
    world.update(view(v.x + 30000, v.y));
    expect(world.objects.objects.get(v.id)).toBe(v);
    expect(story.memories.some((m) => m.name === v.name && m.x === v.x)).toBe(false);
    // Back within the three days: the same village, as it was.
    minutes += SEMI_KEEP_MINUTES - 60;
    world.update(view(v.x + v.w / 2, v.y + v.h / 2));
    expect(world.objects.objects.get(v.id)).toBe(v);
    // Away for longer than three days: forgotten, and remembered by the lantern.
    world.update(view(v.x + 30000, v.y));
    minutes += SEMI_KEEP_MINUTES + 60;
    world.update(view(v.x + 30000, v.y));
    expect(world.objects.objects.has(v.id)).toBe(false);
    expect(world.known.has(v.id)).toBe(false);
    expect(story.memories.some((m) => m.name === v.name && m.x === v.x)).toBe(true);
  });

  it('an undiscovered village is not kept', () => {
    const { world } = setup();
    let village: WorldObject | undefined;
    for (let x = 0; x < 60000 && !village; x += 32) {
      world.update(view(x, 0));
      village = [...world.objects.objects.values()].find((o) => o.kind === 'village');
    }
    world.update(view(village!.x + 30000, village!.y));
    expect(world.objects.objects.has(village!.id)).toBe(false);
  });

  it('remembers a known place that changed while the game was closed', () => {
    const { world } = setup();
    world.update(view(0, 0));
    const data = snapshot(world, { x: 0, y: 0, inventory: [], vitals: null, progression: null });
    // A place known from before that will not come back.
    data.known = [{ id: 'house@gone', name: 'Old House', x: 200, y: 10, w: 8, h: 8, story: false }];
    const fresh = setup();
    restore(fresh.world, data);
    fresh.world.update(view(204, 14));
    expect(fresh.world.known.has('house@gone')).toBe(false);
    expect(fresh.story.memories.some((m) => m.name === 'Old House')).toBe(true);
  });
});
