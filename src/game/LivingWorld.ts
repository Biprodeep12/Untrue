// The living world (spec 6): time, weather, hazards, NPCs, quests and world
// events, plus the lighting and weather on screen. The game loop drives it.

import type { Container, Renderer } from 'pixi.js';
import type { AudioSystem } from '../audio/AudioSystem';
import { TILE_SIZE } from '../config';
import { inRect, tileToChunk } from '../coords';
import { Npc } from '../entities/NPC';
import { SPECIES } from '../entities/Species';
import { pickSpecies } from '../generation/EnemyGenerator';
import { hashString, Rng } from '../generation/Random';
import { BiomeType, Deco } from '../generation/Tiles';
import { difficultyBand } from '../generation/WorldRules';
import { itemById, Items, type ItemDef } from '../items/Items';
import { Effects } from '../rendering/Effects';
import type { Light } from '../rendering/Lighting';
import { Lighting } from '../rendering/Lighting';
import { ParticleSystem } from '../rendering/ParticleSystem';
import type { CombatSystem } from '../systems/CombatSystem';
import { HazardSystem } from '../systems/HazardSystem';
import type { Inventory } from '../systems/InventorySystem';
import { NpcSystem, randomName } from '../systems/NpcSystem';
import { generateQuest, progressText, QuestSystem, type Quest } from '../systems/QuestSystem';
import { TimeSystem, type TimeSave } from '../systems/TimeSystem';
import { buy, SELL_PRICES, sell, stockFor } from '../systems/TradeSystem';
import type { Vitals } from '../systems/Vitals';
import { WEATHER, WeatherSystem, type WeatherEffect, type WeatherKind, type WeatherSave } from '../systems/WeatherSystem';
import { WorldEvents } from '../systems/WorldEvents';
import { Dialog } from '../ui/Dialog';
import type { Hud } from '../ui/Hud';
import { Vision } from '../ui/Vision';
import { StorySystem, type StorySave } from '../story/StorySystem';
import type { QuestView } from '../ui/Menu';
import type { WorldManager } from '../world/WorldManager';
import type { WorldObject } from '../world/WorldObject';
import type { Player } from './Player';
import type { Settings } from './Settings';

const TALK_RANGE = 1.8;
const NO_LIGHTS: readonly Light[] = [];
/** Light around the player at night with nothing to carry, in tiles. */
const NIGHT_EYES = 2.4;
/** A torch burns out after this many hours of darkness. */
const TORCH_HOURS = 2;
const MERCHANT_STAY_MINUTES = 180;
const INVASION_REWARD = 30;

export interface LivingSave {
  time: TimeSave;
  weather: WeatherSave;
  quests: Quest[];
  /** Missing in saves from before the story. */
  story?: StorySave;
}

export interface LivingDeps {
  renderer: Renderer;
  world: WorldManager;
  inventory: Inventory;
  vitals: Vitals;
  combat: CombatSystem;
  hud: Hud;
  player: Player;
  settings: Settings;
  atlasCanvas: HTMLCanvasElement;
  ui: HTMLElement;
  /** Moves the player off anything solid. */
  unstick(): void;
  audio: AudioSystem;
  /** Puts what does not fit in the bag on the ground by the player. */
  overflow(item: ItemDef, count: number): void;
}

export class LivingWorld {
  readonly time = new TimeSystem();
  readonly quests = new QuestSystem();
  readonly weather: WeatherSystem;
  readonly hazards: HazardSystem;
  readonly npcs: NpcSystem;
  readonly events: WorldEvents;
  readonly lighting: Lighting;
  readonly particles: ParticleSystem;
  readonly effects = new Effects();
  private readonly marksCache = new Map<number, string>();
  private marksAt = -Infinity;
  readonly dialog: Dialog;
  /** The NPC the player is talking to. */
  private listener: Npc | null = null;
  readonly vision: Vision;
  readonly story: StorySystem;
  private readonly rng: Rng;
  private storyLoaded = false;
  /** Weather fades in and out instead of switching. */
  private shown: WeatherKind = 'clear';
  private strength = 0;
  private waypoint: { label: string; x: number; y: number } | null = null;
  private darkHours = 0;
  /** While the player is indoors: where they stand outside the door, in world tiles. */
  outside: { x: number; y: number } | null = null;

  constructor(private readonly d: LivingDeps) {
    this.rng = new Rng(d.world.seed ^ 0x11fe);
    this.weather = new WeatherSystem(new Rng(d.world.seed ^ 0x3ea7));
    this.npcs = new NpcSystem(d.world);
    this.lighting = new Lighting(d.renderer);
    this.particles = new ParticleSystem(d.renderer);
    this.dialog = new Dialog(d.ui, d.atlasCanvas);
    this.vision = new Vision(d.ui);
    this.story = new StorySystem(d.world, this.npcs, d.inventory, {
      notify: (t) => d.hud.notify(t),
      vision: (v, then) => this.vision.show(v, then),
      talk: (name, text, options) => this.dialog.talk(name, text, options),
      closeDialog: () => this.dialog.close(),
      bell: () => d.audio.bell(),
      grantXp: (xp) => d.combat.grantXp(xp),
      unstick: () => d.unstick(),
      day: () => this.time.day,
    });
    this.hazards = new HazardSystem(d.world, d.vitals, this.rng, {
      flash: () => {
        this.particles.lightning();
        d.audio.play('thunder');
      },
      hurt: (x, y) => {
        d.player.hurt(x, y, d.world);
        d.hud.flashHurt();
      },
      notify: (t) => d.hud.notify(t),
    });
    this.events = new WorldEvents(d.world, this.rng, {
      notify: (t) => d.hud.notify(t),
      meteor: (x, y) => this.effects.meteor(x, y),
      bandits: (x, y) => d.combat.spawnGroup(SPECIES.bandit, x, y, this.rng.int(3, 4), { label: 'Bandit ambush', provoke: true }),
      invasion: (v) => this.invade(v),
      merchant: (x, y) => {
        const m = new Npc('merchant', randomName(this.rng), 'merchant', x, y, x, y);
        m.leaveAt = this.time.total + MERCHANT_STAY_MINUTES;
        this.npcs.add(m);
      },
      waypoint: (label, x, y) => (this.waypoint = { label, x, y }),
    });
    d.world.now = () => this.time.total;
    this.quests.onComplete = (q) => this.reward(q);
    d.combat.onKill = (e) => this.quests.onKill(e.species.id);
    d.combat.onCleared = (kind) => {
      this.quests.onCleared(kind);
      if (kind === 'invasion') {
        const left = d.inventory.add(Items.coin, INVASION_REWARD);
        if (left > 0) d.overflow(Items.coin, left);
        d.hud.notify(`The villagers thank you: +${INVASION_REWARD} coins`);
      }
    };
  }

  get kind(): WeatherKind {
    const { player, world } = this.d;
    return this.weather.current(world.biomeAt(Math.floor(player.x), Math.floor(player.y))?.type, this.time.isNight);
  }

  get effect(): WeatherEffect {
    return WEATHER[this.kind];
  }

  /** How strongly the current weather is felt, 0 to 1. */
  get weatherStrength(): number {
    return this.strength;
  }

  get paused(): boolean {
    return this.dialog.isOpen || this.vision.isOpen;
  }

  onDiscover(o: WorldObject): void {
    this.quests.onDiscover(o.kind);
    this.story.whisper(o);
  }

  /** Places the story's landmarks; a world without a saved story starts the prologue. */
  beginStory(): void {
    this.story.begin(!this.storyLoaded);
  }

  /** Lets the NPC go once the conversation is over. */
  private endTalk(): void {
    if (!this.listener || this.dialog.isOpen) return;
    this.listener.release();
    this.listener = null;
  }

  update(dt: number): void {
    this.endTalk();
    const { player, combat, world } = this.d;
    const hours = this.time.update(dt);
    for (let h = 0; h < hours; h++) this.onHour();
    combat.night = this.time.isNight;
    const kind = this.kind;
    this.hazards.update(dt, kind === 'storm', WEATHER[kind].wet, player.x, player.y, player.invulnerable);
    this.npcs.update(dt, this.time.hour, player.x, player.y, this.time.total);
    this.story.update(player.x, player.y);
    this.spawnLostTravellers();
    for (const n of this.npcs.npcs) {
      if (!n.following) continue;
      const done = this.quests.updateEscort(n.questId, n.x, n.y);
      if (done) {
        this.npcs.remove(n);
        this.d.hud.notify(`${n.name} is home safe!`);
      }
    }
    if (this.waypoint && world.tileAt(Math.floor(this.waypoint.x), Math.floor(this.waypoint.y))?.deco === 0) this.waypoint = null;
  }

  /** Lighting, weather particles and effects. `addLights` adds the scenery's
   *  lights (fires, windows); `toScreen` maps world pixels to the screen. */
  render(dt: number, addLights: (out: Light[]) => void, toScreen: (x: number, y: number) => [number, number], zoom: number): void {
    const { settings } = this.d;
    const kind = this.kind;
    // Fade the old weather out before the new one fades in.
    if (kind === this.shown) this.strength = Math.min(1, this.strength + dt * 0.4);
    else if ((this.strength -= dt * 0.6) <= 0) {
      this.shown = kind;
      this.strength = 0;
    }
    this.particles.view.visible = settings.values.weather;
    this.particles.update(dt, this.shown, this.strength, settings.values.weather);
    const sight = this.d.inventory.count(Items.wanderersLantern) && !this.story.lanternDark ? Items.wanderersLantern.light! : 0;
    const biome = this.d.world.biomeAt(Math.floor(this.d.player.x), Math.floor(this.d.player.y));
    const forest = biome?.type === BiomeType.Forest;
    const calm = !WEATHER[kind].wet && WEATHER[kind].veil < 0.3;
    this.effects.ambient(this.d.player.x, this.d.player.y, settings.values.weather && forest && this.time.isNight && calm, settings.values.weather && forest && biome?.variant === 1 && !this.time.isNight);
    this.effects.update(dt, this.hazards.fires, this.hazards.strikes, this.story.memories, this.d.player.x, this.d.player.y, sight);

    const storm = this.shown === 'storm' ? 0.45 * this.strength : 0;
    // The far lands feel grimmer: a faint gloom that deepens with each band.
    const gloom = Math.min(3, difficultyBand(Math.floor(this.d.player.x), Math.floor(this.d.player.y))) * 0.03;
    const darkness = Math.min(1, this.time.darkness + storm + gloom);
    // Lights only matter at night: daytime gloom is a plain tint.
    const flat = !settings.values.lighting || this.time.darkness + storm <= 0.01;
    if (darkness <= 0.01 || flat) {
      this.lighting.update(dt, darkness, NO_LIGHTS, toScreen, zoom, flat);
      return;
    }
    const lights: Light[] = [];
    const { player } = this.d;
    lights.push({ x: player.x * TILE_SIZE, y: (player.y - 0.5) * TILE_SIZE, radius: this.playerLight() * TILE_SIZE, warmth: this.playerLight() > NIGHT_EYES ? 0.7 : 0 });
    addLights(lights);
    for (const f of this.hazards.fires) lights.push({ x: (f.gx + 0.5) * TILE_SIZE, y: f.gy * TILE_SIZE, radius: 6 * TILE_SIZE, warmth: 1 });
    this.effects.lights(lights);
    this.lighting.update(dt, darkness, lights, toScreen, zoom);
  }

  resize(width: number, height: number): void {
    this.lighting.resize(width, height);
    this.particles.resize(width, height);
  }

  /** Adds the screen-space layers above the world and effects inside it;
   *  ground effects go just under `standing`, the layer of things that stand. */
  attach(stage: Container, worldOverlay: Container, standing: Container): void {
    worldOverlay.addChildAt(this.effects.floor, worldOverlay.getChildIndex(standing));
    worldOverlay.addChild(this.effects.view);
    stage.addChild(this.lighting.view, this.particles.view);
  }

  /** Talks to the nearest NPC, if any. Returns true when someone answered. */
  talk(): boolean {
    const { player } = this.d;
    const npc = this.npcs.near(player.x, player.y, TALK_RANGE);
    if (!npc) return false;
    this.talkTo(npc);
    return true;
  }

  /** Starts a conversation with a particular NPC. They stop and turn to the
   *  player, and the player to them, until the dialog closes. */
  talkTo(npc: Npc): boolean {
    const { player } = this.d;
    const at = this.pos();
    this.listener?.release();
    this.listener = npc;
    npc.listen(at.x, at.y);
    if (!this.outside) player.faceTowards(npc.x - player.x, npc.y - player.y);
    if (this.story.talk(npc)) return true;
    if (npc.role === 'trader' || npc.role === 'merchant') this.openTrade(npc);
    else if (npc.role === 'lost') this.talkLost(npc);
    else this.talkVillager(npc);
    return true;
  }

  /** Symbols over NPCs: '!' for open work, '$' for trade, '?' for the lost. */
  marks(): Map<number, string> {
    // Asked every frame but changes rarely: worked out four times a second.
    const now = performance.now();
    if (now - this.marksAt < 250) return this.marksCache;
    this.marksAt = now;
    const m = this.marksCache;
    m.clear();
    const handIn = this.quests.readyToHandIn(this.d.inventory).length > 0;
    for (const n of this.npcs.npcs) {
      if (this.story.hasNews(n)) m.set(n.id, '!');
      else if (n.role === 'trader' || n.role === 'merchant') m.set(n.id, '$');
      else if (n.role === 'lost' && !n.following) m.set(n.id, '?');
      else if (n.questGiver && !this.quests.hasOffered(this.offerKey(n)) && !this.quests.full) m.set(n.id, '!');
      else if (handIn) m.set(n.id, '✓');
    }
    return m;
  }

  /** Quest lines for the HUD, with an arrow toward any place to go. */
  tracker(): Array<{ text: string; angle: number | null }> {
    const { inventory } = this.d;
    const player = this.pos();
    const toward = (x: number, y: number) => Math.atan2(y - player.y, x - player.x);
    const lines = this.quests.active.slice(0, 3).map((q) => {
      const o = q.objective;
      const angle = o.kind === 'rescue' ? (o.found ? toward(o.homeX, o.homeY) : toward(o.x, o.y)) : null;
      return { text: `${q.title}: ${progressText(q, inventory)}`, angle };
    });
    if (this.waypoint) lines.unshift({ text: this.waypoint.label, angle: toward(this.waypoint.x, this.waypoint.y) });
    const goal = this.story.objective();
    if (goal) lines.unshift({ text: `★ ${goal.text}`, angle: toward(goal.x, goal.y) });
    return lines;
  }

  abandonQuest(id: string): void {
    const q = this.quests.quests.find((x) => x.id === id);
    if (q && this.quests.abandon(id)) this.d.hud.notify(`Abandoned: ${q.title}`);
  }

  questViews(): QuestView[] {
    return this.quests.quests.map((q) => ({ ...q, progress: progressText(q, this.d.inventory) }));
  }

  /** Sleeping by a campfire skips to morning; the story's night in the village
   *  can be slept through at any hour. */
  canRest(): boolean {
    const p = this.time.phase;
    return p === 'night' || p === 'dusk' || this.story.stage === 'night';
  }

  /** Advances time, events and schedules while the player is indoors. */
  updateIndoors(dt: number): void {
    this.endTalk();
    const hours = this.time.update(dt);
    for (let h = 0; h < hours; h++) this.onHour();
    this.d.combat.night = this.time.isNight;
    const { x, y } = this.pos();
    this.npcs.update(dt, this.time.hour, x, y, this.time.total);
  }

  /** Residents at home behind this door: villagers who went in for the night. */
  residents(doorX: number, doorY: number): Npc[] {
    return this.npcs.npcs.filter((n) => n.hidden && n.doorX === doorX && n.doorY === doorY);
  }

  /** Lighting for a room: dimmer than outdoors, lit by its fire and lamps. */
  /** `cave`: a mine, as dark as night at any hour. */
  renderIndoors(dt: number, lights: Light[], toScreen: (x: number, y: number) => [number, number], zoom: number, cave = false): void {
    const { player, settings } = this.d;
    this.particles.view.visible = false;
    lights.push({ x: player.x * TILE_SIZE, y: (player.y - 0.5) * TILE_SIZE, radius: this.playerLight() * TILE_SIZE, warmth: 0.4 });
    const dark = cave ? Math.max(0.75, this.time.darkness) : this.time.darkness * 0.6;
    this.lighting.update(dt, dark, lights, toScreen, zoom, !settings.values.lighting);
  }

  rest(message = 'You rest by the fire until morning'): void {
    const { vitals, hud } = this.d;
    const at = this.pos();
    if (this.story.rest(Math.floor(at.x), Math.floor(at.y))) {
      this.time.skipTo(6);
      return;
    }
    const blocked = this.restBlocked();
    if (blocked) {
      hud.notify(blocked);
      return;
    }
    const day = this.time.day;
    const hours = this.time.skipTo(6);
    for (let h = 0; h < hours; h++) {
      this.weather.onHour();
      this.d.world.regrow();
    }
    vitals.hunger = Math.max(0, vitals.hunger - 15);
    vitals.thirst = Math.max(0, vitals.thirst - 15);
    vitals.health = Math.min(vitals.maxHealth, vitals.health + 40);
    if (this.time.day !== day) this.quests.newDay();
    hud.notify(message);
  }

  /** Why the player cannot rest right now, or null if they can. */
  restBlocked(): string | null {
    const hunting = this.d.combat.enemies.some((e) => !e.species.passive && e.state !== 'patrol' && e.state !== 'burrowed');
    return hunting ? "You can't rest with enemies nearby" : null;
  }

  /** The player's world position, even while indoors. */
  private pos(): { x: number; y: number } {
    return this.outside ?? this.d.player;
  }

  save(): LivingSave {
    return { time: this.time.save(), weather: this.weather.save(), quests: this.quests.save(), story: this.story.save() };
  }

  load(s: LivingSave): void {
    this.time.load(s.time);
    this.weather.load(s.weather);
    this.quests.load(s.quests);
    if (s.story) {
      this.story.load(s.story);
      this.storyLoaded = true;
    }
  }

  private onHour(): void {
    const { world, inventory, hud } = this.d;
    const player = this.pos();
    if (this.time.hour === 0) this.quests.newDay();
    this.weather.onHour();
    world.regrow();
    // Torches burn down through the night, unless a lantern is already doing the work.
    const lanternLit = inventory.count(Items.lantern) || (inventory.count(Items.wanderersLantern) && !this.story.lanternDark);
    if (this.time.darkness > 0.5 && !lanternLit && inventory.count(Items.torch)) {
      if (++this.darkHours >= TORCH_HOURS) {
        this.darkHours = 0;
        inventory.remove(Items.torch, 1);
        hud.notify('A torch burns out');
      }
    }
    const village = this.villageAt(player.x, player.y);
    this.events.onHour({
      x: player.x,
      y: player.y,
      night: this.time.isNight,
      village,
      merchantNearby: this.npcs.npcs.some((n) => n.role === 'merchant'),
      now: this.time.total,
      ending: this.story.ending,
      cabinFound: this.story.cabinFound,
    });
  }

  private playerLight(): number {
    const { inventory } = this.d;
    let light = NIGHT_EYES;
    if (inventory.count(Items.wanderersLantern) && !this.story.lanternDark) light = Math.max(light, Items.wanderersLantern.light!);
    if (inventory.count(Items.lantern)) light = Math.max(light, Items.lantern.light!);
    else if (inventory.count(Items.torch)) light = Math.max(light, Items.torch.light!);
    return light;
  }

  private villageAt(x: number, y: number): WorldObject | null {
    for (const o of this.d.world.objects.objects.values()) if (o.kind === 'village' && o.contains(Math.floor(x), Math.floor(y))) return o;
    return null;
  }

  private invade(v: WorldObject): void {
    const { combat, world } = this.d;
    const biome = world.biomeAt(v.x, v.y)?.type ?? BiomeType.Forest;
    for (let k = 0; k < 2; k++) {
      const species = pickSpecies(this.rng, biome) ?? SPECIES.wolf;
      const side = this.rng.int(0, 3);
      const x = side === 0 ? v.x - 2 : side === 1 ? v.x + v.w + 2 : v.x + v.w / 2;
      const y = side === 2 ? v.y - 2 : side === 3 ? v.y + v.h + 2 : v.y + v.h / 2;
      combat.spawnGroup(species, x, y, 3, { label: 'Village defence', kind: 'invasion', provoke: true });
    }
  }

  private offerKey(n: Npc): string {
    return `${n.village}:${n.name}:${this.time.day}`;
  }

  private talkVillager(n: Npc): void {
    const { inventory, world, hud } = this.d;
    const options = this.quests.readyToHandIn(inventory).map((q) => ({
      label: `Hand in: ${q.title}`,
      action: () => {
        this.quests.handIn(q, inventory);
        this.dialog.close();
      },
    }));
    const key = this.offerKey(n);
    if (n.questGiver && !this.quests.hasOffered(key)) {
      if (this.quests.full) {
        this.dialog.talk(n.name, 'You look busy enough already. Come back when you have finished some of your work.', options);
        return;
      }
      const biome = world.biomeAt(Math.floor(n.homeX), Math.floor(n.homeY))?.type ?? BiomeType.Forest;
      const home = this.villageAt(n.homeX, n.homeY);
      const quest = generateQuest(new Rng(hashString(key)), { giver: n.name, homeX: n.homeX, homeY: n.homeY, biome, band: difficultyBand(n.homeX, n.homeY), village: !!home }, key);
      const rewards = `Reward: ${quest.reward.coins} coins and ${quest.reward.xp} XP.`;
      this.dialog.talk(n.name, `${quest.text} ${rewards}`, [
        ...options,
        {
          label: 'Accept',
          action: () => {
            this.quests.accept(quest, key);
            hud.notify(`New quest: ${quest.title}`);
            this.dialog.close();
            // Defending starts at once: the beasts are already near.
            if (quest.objective.kind === 'defend' && home) {
              hud.notify('Beasts close in on the village!');
              this.invade(home);
            }
          },
        },
      ]);
      return;
    }
    const lines = [
      `Lovely ${this.effect.label.toLowerCase()} today, isn't it?`,
      'The traders by the well pay well for treasure.',
      'Stay out of the old dungeons after dark.',
      "If you're hungry, the campfires out in the wild will cook a good meal.",
    ];
    this.dialog.talk(n.name, lines[hashString(n.name + this.time.day) % lines.length], options);
  }

  private talkLost(n: Npc): void {
    if (n.following) {
      this.dialog.talk(n.name, "Lead the way, I'm right behind you!", []);
      return;
    }
    this.dialog.talk(n.name, "You came for me? Thank goodness! Please, take me home.", [
      {
        label: 'Follow me',
        action: () => {
          n.following = true;
          this.quests.found(n.questId);
          this.dialog.close();
        },
      },
    ]);
  }

  private openTrade(n: Npc): void {
    const { inventory, hud } = this.d;
    const offers = stockFor(`${n.village || 'travel'}:${n.name}`, n.role === 'merchant');
    const show = () => {
      const sellables = [...SELL_PRICES]
        .map(([item, price]) => ({ item, price, count: inventory.count(item) }))
        .filter((s) => s.count > 0);
      this.dialog.trade(n.title, inventory.count(Items.coin), offers, sellables,
        (o) => {
          const r = buy(inventory, o);
          if (r === 'full') hud.notify('Bag full');
          show();
        },
        (item, count) => {
          sell(inventory, item, count);
          show();
        },
      );
    };
    show();
  }

  /** Lost travellers appear once their quest location is simulated. */
  private spawnLostTravellers(): void {
    const sim = this.d.world.chunks.simRect;
    if (!sim) return;
    for (const q of this.quests.active) {
      const o = q.objective;
      if (o.kind !== 'rescue' || this.npcs.npcs.some((n) => n.questId === q.id)) continue;
      if (!inRect(sim, tileToChunk(o.x), tileToChunk(o.y))) continue;
      const spot = this.openSpot(o.x, o.y);
      if (!spot) continue;
      const npc = new Npc('lost', o.name, 'lost', spot[0], spot[1], spot[0], spot[1]);
      npc.questId = q.id;
      npc.following = o.found;
      this.npcs.add(npc);
    }
    // Travellers whose quest ended, or who were left far behind, go away.
    for (const n of [...this.npcs.npcs]) {
      if (n.role !== 'lost') continue;
      const q = this.quests.active.find((x) => x.id === n.questId);
      const far = !n.following && Math.hypot(n.x - this.d.player.x, n.y - this.d.player.y) > 120;
      if (!q || far) this.npcs.remove(n);
    }
  }

  private openSpot(x: number, y: number): [number, number] | null {
    const { world } = this.d;
    for (let r = 0; r < 8; r++) {
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          const gx = Math.floor(x) + dx;
          const gy = Math.floor(y) + dy;
          const t = world.tileAt(gx, gy);
          if (t && !world.isSolidAt(gx, gy) && t.deco !== Deco.Treasure) return [gx + 0.5, gy + 0.9];
        }
      }
    }
    return null;
  }

  private reward(q: Quest): void {
    const { inventory, combat, hud } = this.d;
    const give = (item: ItemDef, n: number) => {
      const left = inventory.add(item, n);
      if (left > 0) this.d.overflow(item, left);
    };
    give(Items.coin, q.reward.coins);
    for (const [id, n] of q.reward.items) {
      const item = itemById(id);
      if (item) give(item, n);
    }
    combat.grantXp(q.reward.xp);
    hud.notify(`Quest complete: ${q.title} (+${q.reward.coins} coins)`);
    this.d.audio.play('quest');
  }
}
