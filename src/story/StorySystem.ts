// The World That Forgets: the story's stages, objectives, people and endings,
// woven into the world's own forgetting.

import { chunkKey, inRect, tileToChunk } from '../coords';
import { Npc } from '../entities/NPC';
import { hashString } from '../generation/Random';
import { Deco } from '../generation/Tiles';
import { Items } from '../items/Items';
import type { NpcSystem } from '../systems/NpcSystem';
import type { Inventory } from '../systems/InventorySystem';
import type { DialogOption } from '../ui/Dialog';
import type { KnownPlace, WorldManager } from '../world/WorldManager';
import type { WorldObject } from '../world/WorldObject';
import { PLACE_ORDER, placeStory, type PlaceId } from './StoryPlaces';
import { ECHOES, ENDINGS, FRAGMENTS, INSCRIPTIONS, QUIET_BOOK, SPEECH, VISIONS, WHISPERS, type Ending, type Speech, type Vision } from './StoryScript';

export type Stage = 'waking' | 'bell' | 'village' | 'night' | 'observatory' | 'archive' | 'return' | 'anchor' | 'epilogue';
export const STAGES: readonly Stage[] = ['waking', 'bell', 'village', 'night', 'observatory', 'archive', 'return', 'anchor', 'epilogue'];

/** A place the world forgot, kept by the lantern. */
export interface Memory {
  name: string;
  x: number;
  y: number;
  w: number;
  h: number;
  /** 1 where the place had something built, row-major. */
  mask: Uint8Array;
  day: number;
}

export interface StorySave {
  stage: Stage;
  flags: string[];
  ending: Ending | null;
  memories: Memory[];
}

export interface StoryHooks {
  notify(text: string): void;
  vision(v: Vision, then?: () => void): void;
  talk(name: string, text: string, options: DialogOption[]): void;
  closeDialog(): void;
  bell(): void;
  grantXp(xp: number): void;
  /** Nudges the player off anything solid, e.g. after the village vanishes. */
  unstick(): void;
  day(): number;
}

const MAX_MEMORIES = 40;
const STORY_XP = 80;

const DEFAULT_RULES = { regenChance: 1, rareBoost: 1 };

/** World rules each ending leaves behind. */
const ENDING_RULES: Record<Ending, { regenChance: number; rareBoost: number }> = {
  remembered: { regenChance: 0.25, rareBoost: 1 },
  living: { regenChance: 1, rareBoost: 3 },
  memory: { regenChance: 1, rareBoost: 1 },
};

/** Where each stage points the player. */
export const STAGE_TARGET: Partial<Record<Stage, PlaceId>> = {
  waking: 'monument',
  bell: 'graves',
  village: 'graves',
  night: 'graves',
  observatory: 'observatory',
  archive: 'archive',
  return: 'observatory',
  anchor: 'anchor',
};

interface StoryNpc {
  key: keyof typeof SPEECH;
  place: PlaceId;
  /** Offset from the place's top-left, in tiles. */
  dx: number;
  dy: number;
  outfit: string;
  scale?: number;
  ghost?: boolean;
  /** Present during these stages. */
  stages: readonly Stage[];
}

const PEOPLE: readonly StoryNpc[] = [
  { key: 'elder', place: 'graves', dx: 0.5, dy: 0.5, outfit: 'merchant', stages: ['bell', 'village', 'night'] },
  { key: 'merchant', place: 'graves', dx: 0.6, dy: 0.45, outfit: 'trader', stages: ['bell', 'village', 'night'] },
  { key: 'child', place: 'graves', dx: 0.4, dy: 0.6, outfit: 'villager-a', scale: 0.75, stages: ['bell', 'village', 'night'] },
  { key: 'oldman', place: 'observatory', dx: 0.5, dy: 0.62, outfit: 'lost', stages: ['waking', 'bell', 'village', 'night', 'observatory', 'archive'] },
  { key: 'younger', place: 'observatory', dx: 0.5, dy: 0.62, outfit: 'player', ghost: true, stages: ['return'] },
];

export class StorySystem {
  stage: Stage = 'waking';
  ending: Ending | null = null;
  memories: Memory[] = [];
  /** Story playground: places sit near the spawn. */
  compact = false;
  private flags = new Set<string>();
  private readonly people = new Map<string, Npc>();
  private readonly whispered = new Set<Memory>();

  constructor(
    private readonly world: WorldManager,
    private readonly npcs: NpcSystem,
    private readonly inventory: Inventory,
    private readonly hooks: StoryHooks,
  ) {
    world.onForget = (o) => this.remember(o);
    // A known place that vanished while the game was closed: remembered whole.
    world.onLost = (p) => this.remember(p);
  }

  get lanternDark(): boolean {
    return this.flags.has('lantern-dark');
  }

  get cabinFound(): boolean {
    return this.flags.has('cabin');
  }

  /** Places the story's landmarks; a new story also opens with the prologue. */
  begin(isNew: boolean): void {
    for (const id of PLACE_ORDER) {
      if (id === 'graves' && this.flags.has('village-gone')) continue;
      if (!this.world.objects.objects.has(`story:${id}`)) this.world.addObject(placeStory(id, this.world.seed, this.world.fields, this.compact));
    }
    if (this.ending) Object.assign(this.world.rules, ENDING_RULES[this.ending]);
    if (isNew) {
      if (!this.inventory.count(Items.wanderersLantern)) this.inventory.add(Items.wanderersLantern, 1);
      this.hooks.vision(VISIONS.prologue);
    }
  }

  /** Story playground: starts `stage` afresh, as if every part before it
   *  were done. The places are rebuilt, so nothing is left half-finished. */
  jumpTo(stage: Stage): void {
    const done = (s: Stage) => STAGES.indexOf(s) < STAGES.indexOf(stage);
    for (const key of [...this.people.keys()]) this.removePerson(key);
    for (const id of PLACE_ORDER) {
      const o = this.world.objects.objects.get(`story:${id}`);
      if (o) this.world.removeObject(o);
    }
    // Removing found places makes the lantern remember them; start clean.
    this.memories = [];
    this.whispered.clear();
    this.flags.clear();
    this.ending = null;
    this.world.rules = { ...DEFAULT_RULES };
    if (done('village')) {
      for (const key of ['elder', 'merchant', 'child']) this.flags.add(`talked-${key}`);
      this.flags.add('read-grave');
    }
    if (done('night')) this.flags.add('village-gone');
    if (done('observatory')) this.flags.add('talked-oldman');
    if (done('archive')) for (const n of [1, 2, 3]) this.flags.add(`pedestal-${n}`);
    if (done('return')) this.flags.add('talked-younger').add('lantern-dark');
    this.stage = stage;
    this.begin(false);
    // The monument crumbles once read.
    const monument = this.world.objects.objects.get('story:monument');
    if (monument && done('waking')) {
      const i = monument.layout.decos.indexOf(Deco.Monument);
      if (i >= 0) monument.layout.decos[i] = Deco.Clear;
      this.world.refreshObject(monument);
    }
  }

  /** Story playground: plays an ending's vision and ends the story with it. */
  chooseEnding(e: Ending): void {
    if (this.stage !== 'anchor') this.jumpTo('anchor');
    this.hooks.vision(ENDINGS[e].vision, () => this.end(e));
  }

  /** Every flag, for the playground's readout. */
  get flagList(): string[] {
    return [...this.flags];
  }

  /** The current objective, and where it points. */
  objective(): { text: string; x: number; y: number } | null {
    const texts: Record<Stage, string> = {
      waking: 'Read the monument',
      bell: 'Follow the bell',
      village: this.villageTalked() < 3 ? `Talk to the villagers (${this.villageTalked()}/3)` : 'Visit the cemetery',
      night: 'Rest by the village fire tonight',
      observatory: 'Seek the observatory and speak to the old man',
      archive: this.pedestals() < 3 ? `Read the memories in the Sunken Archive (${this.pedestals()}/3)` : 'Enter the Hall of Lanterns',
      return: 'Return to the observatory',
      anchor: 'Find the Original Anchor',
      epilogue: '',
    };
    const place = STAGE_TARGET[this.stage];
    const o = place && this.world.objects.objects.get(`story:${place}`);
    if (!texts[this.stage] || !o) return null;
    return { text: texts[this.stage], x: o.x + o.w / 2, y: o.y + o.h / 2 };
  }

  update(px: number, py: number): void {
    this.syncPeople();
    const gx = Math.floor(px);
    const gy = Math.floor(py);
    const here = this.placeAt(gx, gy);
    if (this.stage === 'bell' && here === 'graves') {
      this.stage = 'village';
      this.hooks.notify('A village beneath enormous trees. Something about it feels familiar.');
    }
    // The lantern recognises places the world has forgotten.
    for (const m of this.memories) {
      if (this.whispered.has(m) || gx < m.x || gy < m.y || gx >= m.x + m.w || gy >= m.y + m.h) continue;
      this.whispered.add(m);
      this.hooks.notify(`The lantern remembers: ${m.name} stood here, once.`);
    }
  }

  /** Prompt text for a story thing on a tile, if any. */
  promptAt(gx: number, gy: number): string | null {
    const hit = this.thingAt(gx, gy);
    if (!hit) return null;
    const { kind, deco } = hit;
    if (deco === Deco.Monument) return 'E  Read';
    if (deco === Deco.Gravestone) return 'E  Read the gravestone';
    if (deco === Deco.Book) return 'E  Read';
    if (deco === Deco.Pedestal) return 'E  Touch the memory';
    if (deco === Deco.LanternRack && kind === 'story-archive') return 'E  Look into the lanterns';
    if (deco === Deco.AnchorCore) return 'E  Touch the Anchor';
    return null;
  }

  /** Handles a story interaction on a tile; returns true if it did. */
  interactAt(gx: number, gy: number): boolean {
    const hit = this.thingAt(gx, gy);
    if (!hit || !this.promptAt(gx, gy)) return false;
    const { object, deco, index } = hit;
    switch (object.kind) {
      case 'story-monument':
        this.readMonument(object, index);
        return true;
      case 'story-graves':
        this.readGrave();
        return true;
      case 'story-observatory':
        this.hooks.talk('The journal', this.stage === 'return' || this.stage === 'anchor' || this.stage === 'epilogue' ? INSCRIPTIONS.observatoryEmpty : INSCRIPTIONS.journal, []);
        return true;
      case 'story-archive':
        if (deco === Deco.Pedestal) this.readPedestal(object, index);
        else this.enterHall();
        return true;
      case 'story-anchor':
        this.touchAnchor();
        return true;
      case 'echo-monument':
        this.hooks.talk('A familiar monument', ECHOES[hashString(object.id) % ECHOES.length], []);
        return true;
      case 'memory-fragment':
        this.hooks.talk('A preserved memory', FRAGMENTS[hashString(object.id) % FRAGMENTS.length], []);
        return true;
      case 'quiet-cabin':
        this.flags.add('cabin');
        this.hooks.talk('A book on the table', QUIET_BOOK, []);
        return true;
    }
    return false;
  }

  /** Talks to a story NPC; returns false for anyone else. */
  talk(npc: Npc): boolean {
    const key = [...this.people].find(([, n]) => n === npc)?.[0] as keyof typeof SPEECH | undefined;
    if (!key) return false;
    this.say(SPEECH[key], () => {
      this.flags.add(`talked-${key}`);
      if (key === 'oldman' && this.stage === 'observatory') {
        this.stage = 'archive';
        this.hooks.grantXp(STORY_XP);
      }
      if (key === 'younger' && this.stage === 'return') {
        this.hooks.vision(VISIONS.truth, () =>
          this.hooks.vision(VISIONS.dark, () => {
            this.flags.add('lantern-dark');
            this.stage = 'anchor';
            this.removePerson('younger');
          }),
        );
      }
    });
    return true;
  }

  /** NPCs with something new to say get a mark. */
  hasNews(npc: Npc): boolean {
    let key: string | undefined;
    for (const [k, n] of this.people) if (n === npc) key = k;
    if (!key) return false;
    // The old man moves the story on at the observatory, even if met before.
    if (key === 'oldman' && this.stage === 'observatory') return true;
    return !this.flags.has(`talked-${key}`);
  }

  /** The night in the Village of Graves. Returns true if resting here moved the story. */
  rest(gx: number, gy: number): boolean {
    if (this.stage !== 'night' || this.placeAt(gx, gy) !== 'graves') return false;
    this.hooks.vision(VISIONS.revision, () => this.revise());
    return true;
  }

  /** The world forgot a place the player had found: the lantern keeps it. */
  remember(o: WorldObject | KnownPlace): void {
    const mask = new Uint8Array(o.w * o.h);
    const layout = 'layout' in o ? o.layout : null;
    for (let i = 0; i < mask.length; i++) mask[i] = !layout || layout.tiles[i] || layout.decos[i] ? 1 : 0;
    this.memories.push({ name: o.name, x: o.x, y: o.y, w: o.w, h: o.h, mask, day: this.hooks.day() });
    if (this.memories.length > MAX_MEMORIES) this.memories.shift();
  }

  /** A whisper now and then when something is discovered. */
  whisper(o: WorldObject): void {
    if (hashString(o.id) % 5 === 0) this.hooks.notify(WHISPERS[hashString(o.id) % WHISPERS.length]);
  }

  save(): StorySave {
    return { stage: this.stage, flags: [...this.flags], ending: this.ending, memories: this.memories };
  }

  load(s: StorySave): void {
    // An unknown stage would strand the story with no objective: let the game
    // keep the save aside and start the living world afresh instead.
    if (!STAGES.includes(s.stage)) throw new Error(`Unknown story stage ${String(s.stage)}`);
    this.stage = s.stage;
    this.flags = new Set(s.flags);
    this.ending = s.ending && Object.hasOwn(ENDINGS, s.ending) ? s.ending : null;
    this.memories = s.memories;
  }

  private say(speech: Speech, then?: () => void, page = 0): void {
    const last = page === speech.pages.length - 1;
    this.hooks.talk(speech.name, speech.pages[page], [
      {
        label: last ? 'Farewell' : 'Continue',
        action: () => {
          if (last) {
            this.hooks.closeDialog();
            then?.();
          } else this.say(speech, then, page + 1);
        },
      },
    ]);
  }

  private readMonument(o: WorldObject, index: number): void {
    if (this.stage !== 'waking') return;
    this.hooks.talk('The monument', INSCRIPTIONS.monument, [
      {
        label: 'Continue',
        action: () => {
          this.hooks.closeDialog();
          // The monument crumbles.
          o.layout.decos[index] = Deco.Clear;
          this.world.refreshObject(o);
          this.hooks.bell();
          this.hooks.vision(VISIONS.bell, () => {
            this.stage = 'bell';
          });
        },
      },
    ]);
  }

  private readGrave(): void {
    const first = !this.flags.has('read-grave');
    this.hooks.talk('A gravestone', first ? INSCRIPTIONS.grave : INSCRIPTIONS.grave2, []);
    if (first && this.stage === 'village' && this.villageTalked() >= 3) {
      this.flags.add('read-grave');
      this.stage = 'night';
      this.hooks.grantXp(STORY_XP);
    }
  }

  private readPedestal(o: WorldObject, index: number): void {
    // Pedestals are numbered by where they sit in the archive.
    const order = [...o.layout.decos.keys()].filter((i) => o.layout.decos[i] === Deco.Pedestal);
    const n = order.indexOf(index) + 1;
    const vision = [VISIONS.memory1, VISIONS.memory2, VISIONS.memory3][n - 1] ?? VISIONS.memory1;
    this.hooks.vision(vision);
    if (this.stage === 'archive') this.flags.add(`pedestal-${n}`);
  }

  private enterHall(): void {
    if (this.stage !== 'archive' || this.pedestals() < 3) {
      this.hooks.notify('The lanterns are dark. Not yet.');
      return;
    }
    this.hooks.vision(VISIONS.hall, () => {
      this.stage = 'return';
      this.hooks.grantXp(STORY_XP * 2);
    });
  }

  private touchAnchor(): void {
    if (this.ending) {
      this.hooks.talk('The Original Anchor', INSCRIPTIONS.anchorAfter, []);
      return;
    }
    if (this.stage !== 'anchor') {
      this.hooks.notify('The Anchor is silent. You are not ready to answer it.');
      return;
    }
    const options: DialogOption[] = (Object.keys(ENDINGS) as Ending[]).map((e) => ({
      label: ENDINGS[e].choice,
      action: () => {
        this.hooks.closeDialog();
        this.hooks.vision(ENDINGS[e].vision, () => this.end(e));
      },
    }));
    const text = (Object.keys(ENDINGS) as Ending[]).map((e) => `${ENDINGS[e].choice}: ${ENDINGS[e].summary}`).join(' ');
    this.hooks.talk('The Original Anchor', `Every region, every memory, every version of you is wired into this machine. It offers three futures. ${text}`, [
      ...options,
    ]);
  }

  private end(e: Ending): void {
    this.ending = e;
    this.stage = 'epilogue';
    Object.assign(this.world.rules, ENDING_RULES[e]);
    // Only the Living World leaves the lantern dark for good.
    if (e !== 'living') this.flags.delete('lantern-dark');
    this.hooks.grantXp(STORY_XP * 5);
    this.hooks.notify(`${ENDINGS[e].name}. The world goes on, and so can you.`);
  }

  /** The village disappears overnight. Only the lantern remembers it. */
  private revise(): void {
    const village = this.world.objects.objects.get('story:graves');
    if (village) {
      // Discovered places are remembered by the world's own forgetting hook.
      if (!village.discovered) this.remember(village);
      this.world.removeObject(village);
    }
    for (const key of ['elder', 'merchant', 'child'] as const) this.removePerson(key);
    this.flags.add('village-gone');
    this.stage = 'observatory';
    this.hooks.unstick();
    this.hooks.grantXp(STORY_XP);
  }

  /** Story people appear while their place is simulated and their part is on. */
  private syncPeople(): void {
    const sim = this.world.chunks.simRect;
    if (!sim) return;
    for (const p of PEOPLE) {
      const o = this.world.objects.objects.get(`story:${p.place}`);
      const want = !!o && p.stages.includes(this.stage) && inRect(sim, tileToChunk(o.x + o.w / 2), tileToChunk(o.y + o.h / 2));
      const have = this.people.get(p.key);
      if (want && (!have || !this.npcs.npcs.includes(have))) {
        const x = o!.x + o!.w * p.dx;
        const y = o!.y + o!.h * p.dy;
        const n = new Npc('villager', SPEECH[p.key].name, p.outfit, x, y, x, y);
        n.scale = p.scale ?? 1;
        n.ghost = !!p.ghost;
        n.stayOut = true;
        this.npcs.add(n);
        this.people.set(p.key, n);
      } else if (!want && have) {
        this.removePerson(p.key);
      }
    }
  }

  private removePerson(key: string): void {
    const n = this.people.get(key);
    if (n) this.npcs.remove(n);
    this.people.delete(key);
  }

  private villageTalked(): number {
    return ['elder', 'merchant', 'child'].filter((k) => this.flags.has(`talked-${k}`)).length;
  }

  private pedestals(): number {
    return [1, 2, 3].filter((n) => this.flags.has(`pedestal-${n}`)).length;
  }

  private placeAt(gx: number, gy: number): PlaceId | null {
    for (const o of this.world.objects.inChunk(chunkKey(tileToChunk(gx), tileToChunk(gy)))) {
      if (o.kind.startsWith('story-') && o.contains(gx, gy)) return o.kind.slice(6) as PlaceId;
    }
    return null;
  }

  /** The story decoration on a tile, with the object it belongs to. */
  private thingAt(gx: number, gy: number): { object: WorldObject; deco: number; index: number; kind: string } | null {
    const deco = this.world.tileAt(gx, gy)?.deco;
    if (!deco) return null;
    for (const object of this.world.objects.inChunk(chunkKey(tileToChunk(gx), tileToChunk(gy)))) {
      if (!object.contains(gx, gy)) continue;
      const index = (gy - object.y) * object.w + (gx - object.x);
      if (object.layout.decos[index] === deco && (object.kind.startsWith('story-') || PLACES_EXTRA.has(object.kind))) {
        return { object, deco, index, kind: object.kind };
      }
    }
    return null;
  }
}

/** Post-ending finds the story also answers for. */
const PLACES_EXTRA = new Set(['echo-monument', 'memory-fragment', 'quiet-cabin']);
