// Boots PixiJS, owns the game loop, and wires the world to the screen.

import { Application, Container, Graphics, Texture, TextureStyle } from 'pixi.js';
import { AudioSystem, type Sfx } from '../audio/AudioSystem';
import { CHUNK_SIZE, TILE_SIZE } from '../config';
import { BIOME_TYPES, BiomeType, Deco, isWater, Tile } from '../generation/Tiles';
import { DIFFICULTY_BANDS, difficultyBand } from '../generation/WorldRules';
import { buildAtlas } from '../rendering/Atlas';
import { GroundItemRenderer } from '../rendering/GroundItemRenderer';
import { BuildingRenderer } from '../rendering/Buildings';
import { EntityRenderer } from '../rendering/EntityRenderer';
import { InteriorRenderer } from '../rendering/InteriorRenderer';
import type { Light } from '../rendering/Lighting';
import { TileRenderer } from '../rendering/TileRenderer';
import { restore, SaveManager, snapshot, UnreadableSave, type SaveData } from '../save/SaveManager';
import type { BurstKind } from '../rendering/Effects';
import { CombatSystem } from '../systems/CombatSystem';
import { EXPLORE_XP, ExplorationSystem } from '../systems/ExplorationSystem';
import { craft, STATION_DECO, STATION_NAMES, STATION_RANGE, unknownRare, type Recipe, type Station } from '../systems/CraftingSystem';
import { GatheringSystem, interactionAt, type Interaction } from '../systems/GatheringSystem';
import { Inventory } from '../systems/InventorySystem';
import { Items, type ItemDef } from '../items/Items';
import { Progression, type SkillId } from '../systems/Progression';
import { SLOW_FACTOR, VITAL_MAX, Vitals } from '../systems/Vitals';
import { WEATHER, type WeatherKind } from '../systems/WeatherSystem';
import { DebugOverlay } from '../ui/DebugOverlay';
import { Hotbar } from '../ui/Hotbar';
import { Hints } from '../ui/Hints';
import { Intro } from '../ui/Intro';
import { Hud } from '../ui/Hud';
import { Playground, type PlaygroundFind } from '../ui/Playground';
import type { Landmark } from '../ui/MapView';
import { Menu } from '../ui/Menu';
import { PauseMenu } from '../ui/PauseMenu';
import { SleepOverlay } from '../ui/SleepOverlay';
import { TouchStick } from '../ui/TouchStick';
import { biomeName } from '../world/BiomeManager';
import { hashString, streamRng, Stream } from '../generation/Random';
import type { BuildingSpec } from '../generation/StructureGenerator';
import type { PlaceId } from '../story/StoryPlaces';
import { BOOKS } from '../story/StoryScript';
import { STAGE_TARGET } from '../story/StorySystem';
import { rollChest } from '../systems/Loot';
import { chunkKey, tileToChunk } from '../coords';
import type { Npc } from '../entities/NPC';
import { Interior, KEEP_FLOORS } from '../world/Interior';
import { WorldManager } from '../world/WorldManager';
import type { WorldObject } from '../world/WorldObject';
import { WorkerGenerator } from '../workers/WorkerGenerator';
import { SyncGenerator } from '../world/SyncGenerator';
import { Camera } from './Camera';
import { Input } from './Input';
import { LivingWorld } from './LivingWorld';
import { DODGE_STAMINA, Player, type Collider } from './Player';
import { bindings, keyName, type Action } from './Keys';
import { Settings } from './Settings';

/** Internal resolution target: the canvas is this tall, then scaled up with
 *  nearest-neighbour filtering. */
const TARGET_HEIGHT = 270;
/** A touch screen: messages name buttons instead of keys. */
const TOUCH = typeof matchMedia !== 'undefined' && matchMedia('(pointer: coarse)').matches;
/** How far the debug "far trip" jumps, in tiles. Far enough to unload everything. */
const FAR_TRIP = 20000;
/** Search radius when looking for open ground, in tiles. Stays inside the
 *  render margin so the search never waits on chunks that will not load. */
const SPAWN_SEARCH = 24;
const AUTOSAVE_SECONDS = 30;
const DISCOVERY_XP = 15;
const MOONWELL_XP = 25;
/** Movement speed while holding a block. */
const BLOCK_SPEED = 0.5;
/** Swimming speed in shallow and deep water. Deep water tires the player like
 *  running, and an exhausted swimmer starts to drown. */
const SWIM_SPEED = [1, 0.55, 0.42];
const DROWN_PER_SEC = 4;
/** Carry weight before the player is overloaded, plus Pack Mule ranks. */
const CARRY_BASE = 100;
const CARRY_PER_RANK = 25;
/** Speed while overloaded; there is no running either. */
const OVERLOADED_SPEED = 0.6;

/** What gathering sounds and looks like, by what was gathered. */
const GATHER_FX: Partial<Record<number, [Sfx, BurstKind]>> = {
  [Deco.Oak]: ['chop', 'wood'],
  [Deco.OakAutumn]: ['chop', 'wood'],
  [Deco.Pine]: ['chop', 'wood'],
  [Deco.PineSnow]: ['chop', 'wood'],
  [Deco.Palm]: ['chop', 'wood'],
  [Deco.DeadBush]: ['chop', 'wood'],
  [Deco.Barrel]: ['chop', 'wood'],
  [Deco.Stone]: ['mine', 'stone'],
  [Deco.RedRock]: ['mine', 'stone'],
  [Deco.SnowRock]: ['mine', 'stone'],
  [Deco.Ore]: ['mine', 'stone'],
  [Deco.Crystal]: ['mine', 'magic'],
  [Deco.Meteorite]: ['mine', 'stone'],
  [Deco.Bush]: ['pickup', 'leaf'],
  [Deco.Flowers]: ['pickup', 'leaf'],
  [Deco.Mushroom]: ['pickup', 'leaf'],
  [Deco.Crop]: ['pickup', 'leaf'],
  [Deco.Cactus]: ['pickup', 'leaf'],
  [Deco.Treasure]: ['chest', 'gold'],
};
const STEP_WALK = 0.36;
const STEP_RUN = 0.25;
/** Seconds between tool strikes while gathering. */
const STRIKE_INTERVAL = 0.45;

const PROMPTS: Record<Interaction['kind'], string> = {
  chest: 'E  Open chest',
  'empty-chest': 'E  Empty chest',
  drink: 'E  Drink',
  harvest: '',
  locked: '',
};

export class Game {
  private readonly app = new Application();
  private readonly camera = new Camera();
  private readonly worldLayer = new Container();
  // Render groups: Pixi rebuilds a group's draw list when anything in it is
  // cleared, added or re-sorted. The ground meshes rarely change, and the
  // y-sorted entities re-sort every frame, so each gets its own group and
  // neither makes the other rebuild.
  private readonly ground = new Container({ isRenderGroup: true });
  private readonly entities = new Container({ sortableChildren: true, isRenderGroup: true });
  /** Target outline and gathering progress, drawn above the world. */
  private readonly marker = new Graphics();
  /** Health bars, damage numbers and projectiles, above the world. */
  private readonly overlay = new Container();
  private readonly saves = new SaveManager();
  private readonly inventory = new Inventory();
  private readonly vitals = new Vitals();
  private readonly progression = new Progression();
  private readonly settings = new Settings();
  private readonly audio = new AudioSystem();
  private readonly exploration = new ExplorationSystem();
  private pause!: PauseMenu;
  private buildings!: BuildingRenderer;
  private interiorRenderer!: InteriorRenderer;
  /** The room the player is in, if indoors. */
  private room: Interior | null = null;
  private stepTimer = 0;
  private strikeTimer = 0;
  private living!: LivingWorld;
  private input!: Input;
  private world!: WorldManager;
  private renderer!: TileRenderer;
  private gathering!: GatheringSystem;
  private combat!: CombatSystem;
  private entityRenderer!: EntityRenderer;
  private blocking = false;
  private player!: Player;
  /** Collision for the player outdoors: like the world's, but water can be swum. */
  private readonly walker: Collider = {
    isSolidAt: (gx, gy) => {
      const t = this.world.tileAt(gx, gy);
      if (t && isWater(t.tile) && !t.deco) return false;
      return this.world.isSolidAt(gx, gy);
    },
  };
  private drownNote = 0;
  private swimNote = 0;
  private markerDrawn = false;
  private saveFailed = false;
  private errors = 0;
  private sleepOverlay!: SleepOverlay;
  /** Moonwells already drunk from; each gives its gift once. */
  private readonly usedMoonwells = new Set<string>();
  /** Where the player wakes after collapsing: the last place they rested,
   *  or the last story place reached. */
  private respawn = { x: 0, y: 0 };
  private lastStage = '';
  /** Saving is off: the stored save could not be read this session, or
   *  another tab holds the save. Says why. */
  private saveLock: string | null = null;
  private groundItems!: GroundItemRenderer;
  private overloaded = false;
  private hud!: Hud;
  private hotbar!: Hotbar;
  private menu!: Menu;
  private stick!: TouchStick;
  private debug!: DebugOverlay;
  /** The story playground, when the game runs as one. */
  private playground: Playground | null = null;
  private pixelScale = 1;
  /** Where the player is waiting to be placed once the ground loads. */
  private spawnTarget: { x: number; y: number } | null = null;
  private home: { x: number; y: number } | null = null;
  private target: Interaction | null = null;
  private autosaveTimer = AUTOSAVE_SECONDS;
  private uiTimer = 0;
  private hints!: Hints;
  /** The opening screen, until the first spawn clears it. */
  private intro: Intro | null = new Intro();

  async start(host: HTMLElement, ui: HTMLElement): Promise<void> {
    // ?new or ?seed=N start a fresh world; otherwise the save is loaded.
    const params = new URLSearchParams(location.search);
    // ?playground (development builds): a story test world, never saved.
    const playground = import.meta.env.DEV && params.has('playground');
    const fresh = params.has('new') || params.has('seed') || playground;
    // A save that cannot be read is kept aside, and a new world begins.
    let recovered = false;
    let saved: SaveData | null = null;
    if (!fresh) {
      try {
        saved = await this.saves.load();
      } catch (e) {
        if (e instanceof UnreadableSave) recovered = true;
        // Storage failed: a save may exist, so this session must not replace it.
        else this.saveLock = "Your save couldn't be loaded, so this session won't save over it. Reload to try again.";
      }
    }
    if (saved && !readable(saved)) {
      await this.saves.backup(saved).catch(() => {});
      saved = null;
      recovered = true;
    }
    const seed = playground ? Number(params.get('playground')) || 1 : (saved?.seed ?? (Number(params.get('seed')) || Math.floor(Math.random() * 1e9)));
    // Debug-only: ?spawn=x,y, ?hour=N and ?weather=kind (development builds).
    const dev = import.meta.env.DEV;
    const spawn = dev ? params.get('spawn')?.split(',').map(Number) : undefined;
    this.spawnTarget = spawn ? { x: spawn[0] || 0, y: spawn[1] || 0 } : (saved?.player ?? { x: 0, y: 0 });
    // Reloading should continue this world, not start another.
    history.replaceState(null, '', playground ? `${location.pathname}?playground=${seed}` : location.pathname);

    TextureStyle.defaultOptions.scaleMode = 'nearest';
    await this.app.init({
      background: '#1d1a17',
      antialias: false,
      resolution: 1,
      roundPixels: true,
      preference: 'webgl',
      // Input is plain DOM events: Pixi's pointer system would hit-test the
      // whole scene on every pointer move for nothing.
      eventFeatures: { move: false, globalMove: false, click: false, wheel: false },
    });
    this.app.stage.eventMode = 'none';
    if (params.get('fps') === '30') this.settings.values.fps30 = true;
    host.appendChild(this.app.canvas);

    const atlasCanvas = buildAtlas();
    const atlas = Texture.from(atlasCanvas);
    this.worldLayer.addChild(this.ground, this.entities, this.marker, this.overlay);
    this.app.stage.addChild(this.worldLayer);

    this.world = new WorldManager(seed, new WorkerGenerator());
    this.renderer = new TileRenderer(atlas, this.ground, this.entities, (gx, gy) => this.world.tileAt(gx, gy)?.tile);
    this.buildings = new BuildingRenderer(this.entities, (gx, gy) => this.world.biomeAt(gx, gy)?.type === BiomeType.Snow);
    this.interiorRenderer = new InteriorRenderer(atlas);
    this.app.stage.addChild(this.interiorRenderer.view);
    this.world.chunks.listener = this.renderer;
    if (saved) {
      restore(this.world, saved);
      this.inventory.load(saved.player.inventory);
      // Saves from before equipment put on the best armour carried.
      if (saved.player.equipment) this.inventory.loadEquipment(saved.player.equipment);
      else this.inventory.autoEquip();
      if (saved.player.progression) this.progression.load(saved.player.progression);
      this.vitals.maxHealth = this.progression.maxHealth;
      if (saved.player.vitals) this.vitals.load(saved.player.vitals);
      if (saved.exploration) this.exploration.load(saved.exploration);
    }
    this.player = new Player(atlas);
    this.entities.addChild(this.player.sprite);
    this.groundItems = new GroundItemRenderer(atlas, this.entities);

    this.input = new Input(window, this.app.canvas);
    this.hud = new Hud(ui);
    // The opening screen covers the first load; the HUD's own loading screen is for later trips.
    this.hud.setLoading(false);
    this.hints = new Hints((t) => this.hud.tip(t));
    this.sleepOverlay = new SleepOverlay(ui);
    this.hotbar = new Hotbar(ui, atlasCanvas, this.inventory);
    this.menu = new Menu(ui, atlasCanvas, this.inventory, {
      stations: () => this.stations(),
      craft: (r, times) => this.craft(r, times),
      use: (slot) => this.useItem(slot),
      drop: (slot) => this.drop(slot),
      load: () => ({ weight: this.inventory.weight(), capacity: this.capacity }),
      progression: this.progression,
      learn: (id) => this.learn(id),
      notify: (t) => this.hud.notify(t),
      quests: () => this.living.questViews(),
      abandon: (id) => this.living.abandonQuest(id),
      memories: () => this.living.story.memories,
      map: {
        exploration: this.exploration,
        player: () => ({ x: this.player.x, y: this.player.y }),
        landmarks: () => this.landmarks(),
        memories: () => this.living.story.memories,
        objective: () => this.living.story.objective(),
      },
      settings: this.settings,
    });
    this.pause = new PauseMenu(ui, {
      save: () => this.save(true),
      settings: () => this.menu.show('settings'),
      newWorld: () => {
        // The playground never touches the real save.
        if (this.playground) location.href = `${location.pathname}?playground=${this.world.seed}`;
        else void this.saves.clear().finally(() => (location.href = `${location.pathname}?new`));
      },
    });
    this.stick = new TouchStick(ui);
    this.debug = new DebugOverlay(ui);
    this.gathering = new GatheringSystem(this.world, this.inventory, this.vitals, (t) => this.hud.notify(t));
    this.gathering.progression = this.progression;
    this.entityRenderer = new EntityRenderer(atlas, this.entities, this.overlay);
    this.combat = new CombatSystem(this.world, this.inventory, this.vitals, this.progression, {
      damage: (x, y, amount, crit, toPlayer) => {
        this.entityRenderer.damageNumber(x, y, amount, crit, toPlayer);
        if (!toPlayer) {
          this.audio.play('hit');
          this.living.effects.burst(x, y + 0.5, 'hit', crit ? 10 : 6);
        }
      },
      swing: (x, y, dx, dy, reach) => {
        this.entityRenderer.swing(x, y, dx, dy, reach);
        this.audio.play('swing');
      },
      killed: (e) => {
        this.audio.play('kill');
        this.living.effects.burst(e.x, e.y - 0.4, 'dust', 14);
      },
      levelUp: () => {
        this.audio.play('level');
        this.living.effects.burst(this.player.x, this.player.y - 0.6, 'gold', 24);
      },
      playerHurt: (fx, fy) => {
        this.player.hurt(fx, fy, this.walker);
        this.gathering.cancel();
        this.hud.flashHurt();
        this.audio.play('hurt');
      },
      notify: (t) => this.hud.notify(t),
    });
    this.living = new LivingWorld({
      renderer: this.app.renderer,
      world: this.world,
      inventory: this.inventory,
      vitals: this.vitals,
      combat: this.combat,
      hud: this.hud,
      player: this.player,
      settings: this.settings,
      atlasCanvas,
      ui,
      unstick: () => this.unstick(),
      audio: this.audio,
      overflow: (item, count) => this.overflow(item, count),
    });
    this.gathering.overflow = (item, count) => this.overflow(item, count);
    this.gathering.onGathered = (deco, gx, gy) => {
      const fx = GATHER_FX[deco];
      if (!fx) return;
      this.audio.play(fx[0] === 'chop' || fx[0] === 'mine' ? 'pickup' : fx[0]);
      this.living.effects.burst(gx + 0.5, gy + 0.6, fx[1], 12);
    };
    this.gathering.onChest = (gx, gy) => {
      this.audio.play('chest');
      this.living.effects.burst(gx + 0.5, gy + 0.6, 'gold', 14);
    };
    this.exploration.onMilestone = (n) => {
      this.combat.grantXp(EXPLORE_XP);
      this.hud.notify(`Explored ${n} chunks of the world`);
    };
    // Browsers allow sound only after the player does something.
    const unlock = () => this.audio.unlock();
    window.addEventListener('pointerdown', unlock);
    window.addEventListener('keydown', unlock);
    document.addEventListener('click', (e) => {
      if ((e.target as HTMLElement).closest('.btn, .slot, .menu-tab')) this.audio.play('ui');
    }, true);
    this.living.attach(this.app.stage, this.worldLayer, this.entities);
    if (saved?.living) {
      try {
        this.living.load(saved.living);
      } catch (e) {
        // Keep the old save, since autosave would otherwise lose the story for good.
        console.error('Could not restore the living world; starting it afresh.', e);
        void this.saves.backup(saved).catch(() => {});
        this.hud.alert("Part of your save (story, quests, clock) couldn't be read and started afresh. A copy of the old save was kept.");
      }
    }
    if (saved?.player.respawn) this.respawn = { ...saved.player.respawn };
    for (const id of saved?.player.moonwells ?? []) this.usedMoonwells.add(id);
    if (playground) this.startPlayground(ui);
    this.living.beginStory();
    // Debug: ?hour=22 sets the clock, ?weather=storm forces the weather everywhere.
    const hour = dev ? params.get('hour') : null;
    if (hour !== null) this.living.time.minutes = (Number(hour) % 24) * 60;
    const weather = dev ? params.get('weather') : null;
    if (weather && weather in WEATHER) for (const b of BIOME_TYPES) this.living.weather.set(b, weather as WeatherKind, 24);
    // ?vitals=15 starts every vital at that much, to see the low warnings.
    const vitals = dev ? params.get('vitals') : null;
    if (vitals !== null) {
      const v = Math.max(0, Math.min(100, Number(vitals)));
      this.vitals.hunger = this.vitals.thirst = this.vitals.stamina = v;
      this.vitals.health = (this.vitals.maxHealth * v) / 100;
    }
    this.settings.onChange = () => this.applySettings();
    this.applySettings();
    // Touch has no mouse to aim with: Hit aims at the nearest enemy in reach.
    this.hud.onAttack = () => this.attack(false, true);
    this.hud.onDodge = () => this.dodge();
    this.hud.onPause = () => {
      if (!this.living.vision.isOpen) this.pause.toggle();
    };
    this.hotbar.onUse = (slot) => this.useItem(slot);
    this.hud.onAction = () => this.interact();
    this.hud.onBag = () => this.menu.toggle();
    // Running low rings an alarm; running out of stamina is too common to.
    this.hud.onDanger = (key) => {
      if (key !== 'stamina') this.audio.play('warn');
    };
    this.world.onDiscover = (o) => {
      this.hud.notify(`Discovered: ${o.name}`);
      this.combat.grantXp(DISCOVERY_XP);
      this.living.onDiscover(o);
    };
    if (saved) this.hud.notify('Welcome back');
    // The playground never saves, so it never competes for the save.
    if (!playground) this.watchOtherTabs();
    if (recovered) this.hud.alert("Your save couldn't be read (it may be from a newer version), so a new world began. The old save was kept.");
    if (this.saveLock) this.hud.alert(this.saveLock);
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) this.save(false);
    });

    this.resize();
    window.addEventListener('resize', () => this.resize());
    this.app.ticker.add((t) => {
      // One bad frame must never stop the game: Pixi stops ticking on a throw.
      try {
        this.tick(Math.min(0.1, t.deltaMS / 1000));
      } catch (e) {
        this.reportError(e);
        this.input.endFrame();
      }
    });
  }

  private resize(): void {
    this.pixelScale = Math.max(1, Math.floor(window.innerHeight / TARGET_HEIGHT));
    const w = Math.ceil(window.innerWidth / this.pixelScale);
    const h = Math.ceil(window.innerHeight / this.pixelScale);
    this.app.renderer.resize(w, h);
    this.app.canvas.style.width = `${w * this.pixelScale}px`;
    this.app.canvas.style.height = `${h * this.pixelScale}px`;
    this.living?.resize(w, h);
  }

  private applySettings(): void {
    const v = this.settings.values;
    // 60 at most: 120 Hz screens would otherwise do twice the work for little gain.
    this.app.ticker.maxFPS = v.fps30 ? 30 : 60;
    this.input.keys = bindings(v.keys);
    this.hud.setHelp(v.help, this.input.keys);
    this.pause.setKeys(this.input.keys);
    this.audio.setVolumes(v.music, v.sfx);
    this.hud.flashes = this.living.particles.flashes = v.flashes;
    this.living.effects.bursts = v.particles;
    document.documentElement.style.setProperty('--ui-scale', String(v.uiScale));
    this.stick.relayout();
  }

  /** Menus and conversations pause the world. */
  private get paused(): boolean {
    return this.menu.isOpen || this.living.paused || this.pause.isOpen || this.sleepOverlay.playing;
  }

  private tick(dt: number): void {
    const { input, camera, player, world } = this;
    this.handleKeys();

    if (this.spawnTarget) this.trySpawn();
    else if (this.room) {
      if (!this.paused) this.tickIndoors(dt);
    } else if (!this.paused) {
      this.living.update(dt);
      const under = world.tileAt(Math.floor(player.x), Math.floor(player.y - 0.1))?.tile;
      player.swim = under === Tile.WaterDeep ? 2 : under === Tile.Water ? 1 : 0;
      this.blocking = !player.swim && (input.holding('block') || input.mouseBlock || this.hud.blockHeld);
      this.checkLoad();
      const weather = this.living.effect;
      const swimmer = player.swim ? 1 + 0.1 * this.progression.rank('swimmer') : 1;
      const speed =
        (this.vitals.status.slow > 0 ? SLOW_FACTOR : 1) *
        (this.blocking ? BLOCK_SPEED : 1) *
        (this.overloaded ? OVERLOADED_SPEED : 1) *
        weather.speed *
        SWIM_SPEED[player.swim] *
        swimmer;
      this.dressPlayer();
      player.update(dt, input, this.walker, this.vitals.canRun && !this.blocking && !player.swim && !this.overloaded, speed);
      if (player.moving) this.gathering.cancel();
      this.swimNote -= dt;
      this.gathering.update(dt);
      this.sounds(dt);
      this.exploration.update(world);
      this.combat.update(dt, {
        x: player.x,
        y: player.y,
        faceX: player.faceX,
        faceY: player.faceY,
        blocking: this.blocking,
        invulnerable: player.invulnerable,
      });
      camera.follow(player.x * TILE_SIZE, player.y * TILE_SIZE, dt);
      const biome = world.biomeAt(Math.floor(player.x), Math.floor(player.y));
      const appetite = 1 - 0.1 * this.progression.rank('survivalist');
      const drain = player.swim === 2 ? 1 - 0.15 * this.progression.rank('swimmer') : 1;
      const needs = { hunger: weather.hunger * appetite, thirst: weather.thirst * appetite };
      if (this.vitals.update(dt, player.running || player.swim === 2, biome?.type, needs, drain)) this.collapse();
      else if (player.swim === 2 && !this.vitals.canRun) this.drown(dt);
      for (const s of world.ground.update(player.x, player.y, this.inventory)) {
        this.hud.notify(`+${s.count} ${s.item.name}`);
        this.audio.play('pickup');
      }
    }

    const { width, height } = this.app.renderer;
    // Indoors, the world keeps streaming around the door outside.
    const at = this.room ? this.room.outside : player;
    const halfW = width / 2 / camera.zoom / TILE_SIZE;
    const halfH = height / 2 / camera.zoom / TILE_SIZE;
    const cx = this.room ? at.x : camera.x / TILE_SIZE;
    const cy = this.room ? at.y : camera.y / TILE_SIZE;
    world.update({
      minX: cx - halfW,
      minY: cy - halfH,
      maxX: cx + halfW,
      maxY: cy + halfH,
      playerX: at.x,
      playerY: at.y,
      dirX: this.room ? 0 : player.dirX,
      dirY: this.room ? 0 : player.dirY,
    });

    const view = this.room ? this.interiorRenderer.view : this.worldLayer;
    view.scale.set(camera.zoom);
    view.position.set(Math.round(width / 2 - camera.x * camera.zoom), Math.round(height / 2 - camera.y * camera.zoom));
    if (this.room) {
      this.renderIndoors(dt);
      this.finishFrame(dt);
      return;
    }
    this.renderer.cull((cx - halfW) * TILE_SIZE, (cy - halfH) * TILE_SIZE, (cx + halfW) * TILE_SIZE, (cy + halfH) * TILE_SIZE);
    this.buildings.update(world.objects.objects.values(), world.chunks.renderRect, player.x * TILE_SIZE, player.y * TILE_SIZE);
    this.groundItems.update(dt, world.ground.items, { x0: cx - halfW - 2, y0: cy - halfH - 2, x1: cx + halfW + 2, y1: cy + halfH + 2 });
    this.updateTarget();
    this.renderer.fadeAround(player.x * TILE_SIZE, player.y * TILE_SIZE);
    this.entityRenderer.update(dt, this.combat.enemies, this.combat.projectiles, this.living.npcs.npcs, this.living.marks());
    const layer = this.worldLayer;
    this.living.render(
      dt,
      (out) => {
        this.renderer.lights(out);
        this.buildings.lights(out);
      },
      (x, y) => [x * camera.zoom + layer.x, y * camera.zoom + layer.y],
      camera.zoom,
    );
    this.finishFrame(dt);
  }

  /** Music, HUD, autosave: everything a frame ends with, indoors or out. */
  private finishFrame(dt: number): void {
    const { input, player, world } = this;
    const at = this.room ? this.room.outside : player;
    this.audio.update({
      biome: world.biomeAt(Math.floor(at.x), Math.floor(at.y))?.type,
      night: this.living.time.isNight,
      danger: !this.room && this.combat.enemies.some((e) => e.state === 'chase' || e.state === 'attack'),
      weather: this.living.kind,
      weatherStrength: this.paused || this.room ? 0 : this.living.weatherStrength,
      band: difficultyBand(Math.floor(at.x), Math.floor(at.y)),
      indoors: !!this.room,
      cave: !!this.room?.cave,
      hunter: this.room ? null : this.hunterCall(),
    });
    this.stick.update(input.stick);
    this.hotbar.render();
    this.menu.render();

    this.autosaveTimer -= dt;
    if (this.autosaveTimer <= 0) {
      this.autosaveTimer = AUTOSAVE_SECONDS;
      this.save(false);
    }
    this.uiTimer -= dt;
    if (this.uiTimer <= 0) {
      this.uiTimer = 0.25;
      this.updateUi();
      this.tips();
      this.playground?.update(this.living.story);
      // Reaching a new story stage also moves the waking spot there.
      const { stage } = this.living.story;
      if (stage !== this.lastStage) {
        if (this.lastStage) this.setRespawn();
        this.lastStage = stage;
      }
    }
    if (this.playground?.god) {
      const v = this.vitals;
      v.health = v.maxHealth;
      v.hunger = v.thirst = v.stamina = VITAL_MAX;
    }
    input.endFrame();
  }

  /** The call of whatever is hunting the player: wolves howl, the dead wail. */
  private hunterCall(): 'howl' | 'wail' | 'growl' | null {
    for (const e of this.combat.enemies) {
      if (e.state !== 'chase' && e.state !== 'aggro') continue;
      const art = e.species.art ?? e.species.id;
      if (art === 'wolf') return 'howl';
      if (art === 'wraith' || art === 'skeleton') return 'wail';
      if (art === 'bear' || art === 'golem') return 'growl';
    }
    return null;
  }

  // Indoors -----------------------------------------------------------------

  /** The building whose door is on this tile, if any. */
  private doorAt(gx: number, gy: number): { object: WorldObject; index: number } | null {
    for (const object of this.world.objects.inChunk(chunkKey(tileToChunk(gx), tileToChunk(gy)))) {
      const index = object.layout.buildings.findIndex((b: BuildingSpec) => object.x + b.x + b.door === gx && object.y + b.y + b.h - 1 === gy);
      if (index >= 0) return { object, index };
    }
    return null;
  }

  private enter(object: WorldObject, index: number): void {
    const room = new Interior(object, index);
    this.room = room;
    this.player.swim = 0;
    this.gathering.cancel();
    this.gathering.ground = room;
    this.gathering.bandAt = () => difficultyBand(room.outside.x, room.outside.y);
    this.living.outside = room.outside;
    this.interiorRenderer.open(room, this.player.sprite);
    this.worldLayer.visible = false;
    this.player.place(room.spawn.x, room.spawn.y);
    this.player.facing = 3;
    this.camera.snap(this.player.x * TILE_SIZE, this.player.y * TILE_SIZE);
    this.audio.play('chest');
  }

  private leave(): void {
    const room = this.room!;
    this.room = null;
    this.gathering.cancel();
    this.gathering.ground = this.world;
    this.gathering.bandAt = difficultyBand;
    this.living.outside = null;
    this.interiorRenderer.close();
    this.entities.addChild(this.player.sprite);
    this.worldLayer.visible = true;
    this.player.place(room.outside.x, room.outside.y);
    this.player.facing = 0;
    this.camera.snap(this.player.x * TILE_SIZE, this.player.y * TILE_SIZE);
  }

  /** Two tabs would overwrite each other's save: the first one open holds a
   *  lock and saves; any other plays without saving. */
  private watchOtherTabs(): void {
    const readOnly = () => {
      this.saveLock = 'Untrue is open in another tab, so this tab will not save. Close the other tab and reload to save here.';
      this.hud.alert(this.saveLock);
    };
    if (navigator.locks) {
      // Held until the tab closes.
      void navigator.locks.request('untrue-save', { ifAvailable: true }, (lock) => {
        if (!lock) {
          readOnly();
          return;
        }
        return new Promise<void>(() => {});
      });
      return;
    }
    if (typeof BroadcastChannel === 'undefined') return;
    const channel = new BroadcastChannel('untrue');
    channel.onmessage = (e) => {
      if (e.data === 'hello') channel.postMessage('here');
      if (e.data === 'here') readOnly();
    };
    channel.postMessage('hello');
  }

  /** Logs the first few errors and tells the player once, then carries on. */
  private reportError(e: unknown): void {
    if (this.errors++ < 3) console.error(e);
    if (this.errors === 1) this.hud?.notify('Something went wrong, but the game carried on');
  }

  /** Rests until morning behind the three-second sleep transition. */
  private sleep(message?: string): void {
    const blocked = this.living.restBlocked();
    if (blocked) {
      this.hud.notify(blocked);
      return;
    }
    this.gathering.cancel();
    this.setRespawn();
    this.sleepOverlay.play(() => this.living.rest(message));
  }

  /** Takes the stairs to another floor of the building. */
  private changeFloor(to: number): void {
    const from = this.room!;
    const room = new Interior(from.object, from.index, to);
    this.room = room;
    this.gathering.cancel();
    this.gathering.ground = room;
    this.gathering.bandAt = () => difficultyBand(room.outside.x, room.outside.y);
    this.interiorRenderer.close();
    this.interiorRenderer.open(room, this.player.sprite);
    const at = room.arrival(from.floor);
    this.player.place(at.x, at.y);
    this.player.facing = 0;
    this.camera.snap(this.player.x * TILE_SIZE, this.player.y * TILE_SIZE);
    this.audio.play('step');
    this.hud.notify(room.floorName);
  }

  private tickIndoors(dt: number): void {
    const { player, input } = this;
    const room = this.room!;
    this.living.updateIndoors(dt);
    this.checkLoad();
    this.dressPlayer();
    const speed = (this.vitals.status.slow > 0 ? SLOW_FACTOR : 1) * (this.overloaded ? OVERLOADED_SPEED : 1);
    player.update(dt, input, room, this.vitals.canRun && !this.overloaded, speed);
    if (player.moving) this.gathering.cancel();
    this.gathering.update(dt);
    if (room.changed) {
      room.changed = false;
      this.interiorRenderer.drawFurniture();
    }
    this.sounds(dt);
    this.camera.follow(player.x * TILE_SIZE, player.y * TILE_SIZE, dt);
    if (this.vitals.update(dt, player.running, undefined)) this.collapse();
    // Walking out over the doormat leaves.
    if (room.floor === 0 && player.y > room.exit.y + 0.6) this.leave();
  }

  /** Villagers home for the night behind this door, each at a spot in the room. */
  private residents(): Array<{ npc: Npc; x: number; y: number }> {
    const room = this.room!;
    if (!room.spots.length || room.floor !== 0) return [];
    return this.living.residents(room.door.x, room.door.y).map((npc, i) => ({ npc, ...room.spots[i % room.spots.length] }));
  }

  private renderIndoors(dt: number): void {
    this.interiorRenderer.update(this.residents());
    const room = this.room!;
    const lights: Light[] = [];
    this.interiorRenderer.lights(lights);
    // Daylight spills in from a mine's entrance.
    if (room.cave && room.floor === 0 && !this.living.time.isNight) {
      lights.push({ x: (room.exit.x + 0.5) * TILE_SIZE, y: room.exit.y * TILE_SIZE, radius: 3.5 * TILE_SIZE, warmth: 0 });
    }
    const view = this.interiorRenderer.view;
    this.living.renderIndoors(dt, lights, (x, y) => [x * this.camera.zoom + view.x, y * this.camera.zoom + view.y], this.camera.zoom, room.cave);
    this.updateIndoorPrompt();
  }

  /** What E would do indoors: talk, open, sleep, read, mine, or nothing. */
  private indoorTarget():
    | { kind: 'talk'; npc: Npc; x: number; y: number }
    | { kind: 'chest' | 'bed' | 'book'; x: number; y: number }
    | { kind: 'gather'; action: Interaction }
    | { kind: 'stairs'; to: number }
    | null {
    const room = this.room!;
    const { player } = this;
    for (const r of this.residents()) {
      if (Math.hypot(r.x - player.x, r.y - player.y) < 1.6) return { kind: 'talk', npc: r.npc, x: r.x, y: r.y };
    }
    const [fx, fy] = player.frontTile();
    const deco = room.tileAt(fx, fy)?.deco;
    if (deco === Deco.Chest) return { kind: 'chest', x: fx, y: fy };
    if (deco === Deco.Bed) return { kind: 'bed', x: fx, y: fy };
    if (deco === Deco.Bookshelf) return { kind: 'book', x: fx, y: fy };
    const stairs = room.stairs.find((st) => st.x === fx && st.y === fy);
    if (stairs) return { kind: 'stairs', to: stairs.to };
    const action = interactionAt(room, this.inventory, this.vitals, fx, fy, this.gatherSpeed);
    if (action?.kind === 'harvest' || action?.kind === 'locked') return { kind: 'gather', action };
    return null;
  }

  private updateIndoorPrompt(): void {
    const marker = this.interiorRenderer.marker;
    marker.clear();
    const busy = this.gathering.current;
    if (busy) {
      const x = busy.gx * TILE_SIZE;
      const y = busy.gy * TILE_SIZE - 6;
      marker.rect(x, y, TILE_SIZE, 3).fill({ color: 0x3b2412 });
      marker.rect(x, y, TILE_SIZE * this.gathering.progress, 3).fill({ color: 0x7ee07a });
      this.hud.setPrompt(`${busy.harvest.verb}…`);
      return;
    }
    const t = this.paused ? null : this.indoorTarget();
    if (t?.kind === 'gather') {
      const a = t.action;
      marker.rect(a.gx * TILE_SIZE, a.gy * TILE_SIZE, TILE_SIZE, TILE_SIZE).stroke({ width: 1, color: a.kind === 'locked' ? 0xe04a3a : 0xfff2b0, alpha: 0.8 });
      this.hud.setPrompt(a.kind === 'harvest' ? `E  ${a.harvest.action}` : a.kind === 'locked' ? a.reason : null);
      return;
    }
    if (!t) {
      this.hud.setPrompt(null);
      return;
    }
    if (t.kind === 'stairs') {
      const name = KEEP_FLOORS[t.to] ?? 'next floor';
      this.hud.setPrompt(`E  ${t.to > this.room!.floor ? 'Go up' : 'Go down'} to the ${name.toLowerCase()}`);
      return;
    }
    const prompts = {
      chest: 'E  Open chest',
      bed: this.living.canRest() ? 'E  Sleep until morning' : 'Too early to sleep',
      book: 'E  Read',
    };
    this.hud.setPrompt(t.kind === 'talk' ? `E  Talk to ${t.npc.name}` : prompts[t.kind as keyof typeof prompts]);
  }

  private interactIndoors(): void {
    const room = this.room!;
    const t = this.indoorTarget();
    if (!t) return;
    if (t.kind === 'talk') {
      this.living.talkTo(t.npc);
      // Indoors, residents stand at their spots: turn to each other there.
      t.npc.faceTowards(this.player.x - t.x, this.player.y - t.y);
      this.player.faceTowards(t.x - this.player.x, t.y - this.player.y);
      return;
    }
    if (t.kind === 'gather') {
      this.gathering.begin(t.action);
      return;
    }
    if (t.kind === 'stairs') {
      this.changeFloor(t.to);
      return;
    }
    if (t.kind === 'bed') {
      if (this.living.canRest()) this.sleep('You sleep soundly until morning');
      else this.hud.notify("It's too early to sleep");
      return;
    }
    if (t.kind === 'book') {
      this.hud.notify(BOOKS[hashString(`${room.object.id}:${t.x}:${t.y}:${this.living.time.day}`) % BOOKS.length]);
      return;
    }
    // A chest: opened once, and never refilled.
    const id = room.chestId(t.x, t.y);
    room.object.opened.add(id);
    if (room.object.anchor) this.world.lootedAnchors.add(room.object.anchor);
    this.gathering.give(rollChest(streamRng(Stream.Loot, this.world.seed, hashString(room.object.id), id), 1), 'The chest is empty');
    this.interiorRenderer.drawFurniture();
    this.audio.play('chest');
  }

  private handleKeys(): void {
    const { input, camera, player } = this;
    if (input.hit('F3')) this.debug.toggle();
    if (input.hit('F4')) this.playground?.toggle();
    if (input.act('bag')) this.menu.toggle();
    if (this.living.vision.isOpen && (input.hit('Space') || input.act('interact') || input.act('dodge') || input.hit('Enter'))) this.living.vision.next();
    if (input.hit('Escape')) {
      if (this.living.dialog.isOpen) this.living.dialog.close();
      else if (this.menu.isOpen) this.menu.close();
      else if (!this.living.vision.isOpen) this.pause.toggle();
    }
    if (input.act('map') && !this.pause.isOpen) this.menu.toggle('map');
    if (input.hit('Save')) this.save(true);
    if (this.paused) return;

    if (input.wheel) camera.zoomBy(input.wheel);
    if (input.act('zoomIn')) camera.zoomBy(-1);
    if (input.act('zoomOut')) camera.zoomBy(1);
    for (let n = 1; n <= 8; n++) if (input.hit(`Digit${n}`)) this.hotbar.select(n - 1);
    if (input.act('use')) this.useItem(this.hotbar.selected);
    if (input.act('drop')) this.drop(this.hotbar.selected);
    if (input.act('interact')) this.interact();
    if (input.act('attack') || input.mouseAttack) this.attack(input.mouseAttack);
    if (input.act('dodge')) this.dodge();
    if (import.meta.env.DEV && input.hit('KeyG') && !this.spawnTarget && !this.room) {
      this.home = { x: player.x, y: player.y };
      this.travel(player.x + FAR_TRIP, player.y);
    }
    if (import.meta.env.DEV && input.hit('KeyB') && this.home && !this.spawnTarget && !this.room) {
      this.travel(this.home.x, this.home.y);
      this.home = null;
    }
  }

  /** Finds what the player faces (or stands on) and marks it. */
  private updateTarget(): void {
    const { player, gathering } = this;
    this.clearMarker();
    if (this.blocking) {
      // A shield arc on the side the player faces.
      const a = Math.atan2(player.faceY, player.faceX);
      this.drawMarker().arc(player.x * TILE_SIZE, (player.y - 0.4) * TILE_SIZE, 11, a - 0.9, a + 0.9).stroke({ width: 2, color: 0xa8d8ff, alpha: 0.85 });
    }
    this.target = null;
    if (this.spawnTarget || this.paused) {
      this.hud.setPrompt(null);
      return;
    }
    const npc = this.living.npcs.near(player.x, player.y, 1.8);
    if (npc && !gathering.current) {
      this.hud.setPrompt(`E  Talk to ${npc.name}`);
      return;
    }
    const [px, py] = player.frontTile();
    if (this.doorAt(px, py)) {
      this.hud.setPrompt('E  Enter');
      return;
    }
    const storyPrompt = this.living.story.promptAt(px, py) ?? this.living.story.promptAt(Math.floor(player.x), Math.floor(player.y - 0.15));
    if (storyPrompt) {
      this.hud.setPrompt(storyPrompt);
      return;
    }
    if (this.restingSpot()) {
      this.hud.setPrompt('E  Rest until morning');
      return;
    }
    const well = this.moonwell();
    if (well) {
      this.hud.setPrompt(this.usedMoonwells.has(well.id) ? 'The water has gone still' : 'E  Drink from the Moonwell');
      return;
    }
    const [fx, fy] = player.frontTile();
    // What the player faces, else what they stand on.
    this.target =
      interactionAt(this.world, this.inventory, this.vitals, fx, fy, this.gatherSpeed) ??
      interactionAt(this.world, this.inventory, this.vitals, Math.floor(player.x), Math.floor(player.y - 0.15), this.gatherSpeed);

    const busy = gathering.current;
    const t = busy ?? this.target;
    if (t) {
      const color = t.kind === 'locked' ? 0xe04a3a : 0xfff2b0;
      this.drawMarker().rect(t.gx * TILE_SIZE, t.gy * TILE_SIZE, TILE_SIZE, TILE_SIZE).stroke({ width: 1, color, alpha: 0.8 });
    }
    if (busy) {
      const x = busy.gx * TILE_SIZE;
      const y = busy.gy * TILE_SIZE - 6;
      this.drawMarker().rect(x, y, TILE_SIZE, 3).fill({ color: 0x3b2412 });
      this.drawMarker().rect(x, y, TILE_SIZE * gathering.progress, 3).fill({ color: 0x7ee07a });
    }

    if (busy) this.hud.setPrompt(`${busy.harvest.verb}…`);
    else if (!this.target) this.hud.setPrompt(null);
    else if (this.target.kind === 'harvest') this.hud.setPrompt(`E  ${this.target.harvest.action}`);
    else if (this.target.kind === 'locked') this.hud.setPrompt(this.target.reason);
    else this.hud.setPrompt(PROMPTS[this.target.kind]);
  }

  /** Moves the player to the nearest open ground, e.g. when a building vanishes around them. */
  private unstick(): void {
    const { player, walker: world } = this;
    if (!player.blocked(player.x, player.y, world)) return;
    for (let r = 1; r < 12; r++) {
      for (let a = 0; a < 16; a++) {
        const x = player.x + Math.cos((a / 16) * Math.PI * 2) * r;
        const y = player.y + Math.sin((a / 16) * Math.PI * 2) * r;
        if (!player.blocked(x, y, world)) {
          player.place(x, y);
          return;
        }
      }
    }
  }

  /** The Moonwell the player faces, if any. */
  private moonwell(): WorldObject | null {
    const [fx, fy] = this.player.frontTile();
    if (this.world.tileAt(fx, fy)?.deco !== Deco.Moonwell) return null;
    return this.world.objects.inChunk(chunkKey(tileToChunk(fx), tileToChunk(fy))).find((o) => o.contains(fx, fy)) ?? null;
  }

  /** Each Moonwell heals, cures poison and slakes thirst, once. */
  private drinkMoonwell(well: WorldObject): void {
    if (this.usedMoonwells.has(well.id)) {
      this.hud.notify('The water has gone still');
      return;
    }
    this.usedMoonwells.add(well.id);
    this.setRespawn();
    this.vitals.consume({ health: this.vitals.maxHealth * 0.5, thirst: 40 }, 'poison');
    this.combat.grantXp(MOONWELL_XP);
    this.living.effects.burst(this.player.x, this.player.y - 0.6, 'magic', 24);
    this.audio.play('level');
    this.hud.notify('Moonlight runs through you. You feel restored.');
  }

  /** A campfire next to the player while it is dark enough to sleep. */
  private restingSpot(): boolean {
    const [fx, fy] = this.player.frontTile();
    return this.living.canRest() && this.world.tileAt(fx, fy)?.deco === Deco.Campfire;
  }

  /** Attacks toward the mouse, the nearest enemy (`aim`), or the way the player faces. */
  private attack(atMouse: boolean, aim = false): void {
    // Indoors there is nothing to fight, and combat still runs at the door outside.
    if (this.paused || this.spawnTarget || this.room) return;
    const { player, input } = this;
    // Enemies cannot follow into water, so the water is no place to fight from.
    if (player.swim) {
      if (this.swimNote <= 0) this.hud.notify("You can't fight while swimming");
      this.swimNote = 2;
      return;
    }
    let dx = player.faceX;
    let dy = player.faceY;
    if (atMouse && input.mouse) {
      const tx = (input.mouse.x / this.pixelScale - this.worldLayer.x) / this.camera.zoom / TILE_SIZE;
      const ty = (input.mouse.y / this.pixelScale - this.worldLayer.y) / this.camera.zoom / TILE_SIZE;
      dx = tx - player.x;
      dy = ty - (player.y - 0.4);
      player.faceTowards(dx, dy);
    } else if (aim) {
      const reach = (this.inventory.slots[this.hotbar.selected]?.item.weapon?.reach ?? 1.2) + 1.5;
      let best = reach * reach;
      for (const e of this.combat.enemies) {
        if (e.species.passive || e.state === 'burrowed' || !e.alive) continue;
        const ex = e.x - player.x;
        const ey = e.y - player.y;
        const d = ex * ex + ey * ey;
        if (d < best) {
          best = d;
          dx = ex;
          dy = ey;
        }
      }
      player.faceTowards(dx, dy);
    }
    if (this.combat.attack(dx, dy, this.hotbar.selected)) {
      this.gathering.cancel();
      const weapon = this.inventory.slots[this.hotbar.selected]?.item;
      if (weapon?.weapon) player.act(weapon.weapon.kind === 'bow' ? 'shoot' : 'swing', weapon);
      else player.act('punch');
      if (this.inventory.slots[this.hotbar.selected]?.item.weapon?.kind === 'bow') this.audio.play('bow');
    }
  }

  /** Too tired to keep swimming in deep water. */
  private drown(dt: number): void {
    this.drownNote -= dt;
    if (this.drownNote <= 0) {
      this.drownNote = 4;
      this.hud.notify("You're exhausted. Swim for the shore!");
      this.hud.flashHurt();
    }
    if (this.vitals.hurt(DROWN_PER_SEC * dt)) this.collapse();
  }

  private dodge(): void {
    if (this.paused || this.spawnTarget || this.player.swim) return;
    const cost = DODGE_STAMINA * (1 - 0.12 * this.progression.rank('nimble'));
    if (this.vitals.stamina < cost) return;
    if (this.player.dodge()) {
      this.vitals.spend(cost);
      this.gathering.cancel();
      this.audio.play('dodge');
      this.living.effects.burst(this.player.x, this.player.y, 'dust', 8);
    }
  }

  /** Footsteps, and tool strikes while gathering. */
  private sounds(dt: number): void {
    const { player, gathering } = this;
    if (player.moving) {
      this.stepTimer -= dt;
      if (this.stepTimer <= 0) {
        this.stepTimer = player.running ? STEP_RUN : STEP_WALK;
        this.audio.play('step');
        if (player.swim) this.living.effects.burst(player.x, player.y - 0.3, 'splash', 5);
        else if (player.running) this.living.effects.burst(player.x, player.y, 'dust', 2);
      }
    }
    const c = gathering.current;
    if (!c) return;
    this.strikeTimer -= dt;
    if (this.strikeTimer > 0) return;
    this.strikeTimer = STRIKE_INTERVAL;
    // Swing the best tool for the job, punch bare-handed, or stoop for plants.
    if (!c.harvest.tool) {
      player.act('pick');
      return;
    }
    const tool = this.inventory.bestTool(c.harvest.tool);
    if (tool) player.act('swing', tool);
    else player.act('punch');
    const axe = c.harvest.tool === 'axe';
    this.audio.play(axe ? 'chop' : 'mine');
    this.living.effects.burst(c.gx + 0.5, c.gy + 0.6, axe ? 'wood' : 'stone', 4);
  }

  /** Discovered places still standing, for the map. */
  private landmarks(): Landmark[] {
    return [...this.world.known.values()];
  }

  private interact(): void {
    if (this.paused || this.spawnTarget || this.gathering.current) return;
    if (this.room) {
      this.interactIndoors();
      return;
    }
    const [fx, fy] = this.player.frontTile();
    const door = this.doorAt(fx, fy);
    if (door) {
      this.enter(door.object, door.index);
      return;
    }
    const { story } = this.living;
    if (story.interactAt(fx, fy) || story.interactAt(Math.floor(this.player.x), Math.floor(this.player.y - 0.15))) return;
    if (this.living.talk()) return;
    if (this.restingSpot()) {
      this.sleep();
      return;
    }
    const well = this.moonwell();
    if (well) {
      this.drinkMoonwell(well);
      return;
    }
    if (this.target) this.gathering.begin(this.target);
  }

  /** Shows what the player holds and wears. */
  private dressPlayer(): void {
    const { player, inventory } = this;
    const eq = inventory.equipment;
    player.holding = this.heldItem();
    player.offhand = eq.offhand?.item ?? null;
    player.guarding = this.blocking;
    // Written in place: this runs every frame.
    const wear = player.wear;
    wear[0] = eq.head?.item.look ?? -1;
    wear[1] = eq.chest?.item.look ?? -1;
    wear[2] = eq.legs?.item.look ?? -1;
    wear[3] = eq.feet?.item.look ?? -1;
  }

  /** What the player holds: the selected weapon, tool or light. */
  private heldItem(): ItemDef | null {
    const item = this.inventory.slots[this.hotbar.selected]?.item;
    return item && (item.weapon || item.tool || item.light) ? item : null;
  }

  private get gatherSpeed(): number {
    return 1 + 0.15 * this.progression.rank('gatherer');
  }

  private get capacity(): number {
    return CARRY_BASE + CARRY_PER_RANK * this.progression.rank('packMule');
  }

  /** Too much in the bag slows the player down. */
  private checkLoad(): void {
    const over = this.inventory.weight() > this.capacity;
    if (over === this.overloaded) return;
    this.overloaded = over;
    this.hud.notify(over ? `Your bag is too heavy: drop something (${TOUCH ? 'Bag → Drop' : 'Q'}) to move freely` : 'Your load feels lighter');
  }

  /** Drops a whole stack at the player's feet. */
  private drop(slot: number): void {
    if (this.spawnTarget) return;
    if (this.room) {
      this.hud.notify("You can't drop things here");
      return;
    }
    if (this.inventory.slots[slot]?.item.id === 'wanderers-lantern') {
      this.hud.notify('The lantern will not leave your hand');
      return;
    }
    const stack = this.inventory.takeSlot(slot);
    if (!stack) return;
    const { player } = this;
    this.world.ground.drop(stack, player.x + player.faceX * 0.5, player.y + player.faceY * 0.5);
    this.hud.notify(`Dropped ${stack.count} ${stack.item.name}`);
  }

  private learn(id: SkillId): void {
    if (this.progression.learn(id)) {
      this.vitals.maxHealth = this.progression.maxHealth;
      this.hud.notify('Skill learned');
      this.audio.play('level');
    }
  }

  private useItem(slot: number): void {
    const s = this.inventory.slots[slot];
    if (!s) return;
    if (s.item === Items.schematic) {
      this.readSchematic(slot);
      return;
    }
    if (!s.item.food) {
      this.hud.notify(s.item.tool ? 'Tools work automatically while carried' : `${s.item.name} cannot be used`);
      return;
    }
    const item = this.inventory.takeOne(slot)!;
    this.vitals.consume(item.food!, item.cures);
    this.hud.notify(`Used ${item.name}`);
  }

  /** A Forgotten Schematic teaches a rare recipe not yet known. */
  private readSchematic(slot: number): void {
    const unknown = unknownRare(this.progression.recipes);
    if (!unknown.length) {
      this.hud.notify('You already know every recipe it could hold');
      return;
    }
    this.inventory.takeOne(slot);
    const r = unknown[Math.floor(Math.random() * unknown.length)];
    this.progression.recipes.add(r.output.id);
    this.audio.play('level');
    const where = r.station === 'hand' ? 'by hand' : `at ${r.station === 'anvil' ? 'an' : 'a'} ${STATION_NAMES[r.station].toLowerCase()}`;
    this.hud.alert(`You learned to make the ${r.output.name}, ${where}.`);
  }

  private stations(): Set<Station> {
    const set = new Set<Station>(['hand']);
    // Indoors, the room's own furniture counts, not the world outside.
    const ground = this.room ?? this.world;
    const gx = Math.floor(this.player.x);
    const gy = Math.floor(this.player.y);
    for (const [station, deco] of Object.entries(STATION_DECO) as Array<[Station, number]>) {
      let found = false;
      for (let y = gy - STATION_RANGE; y <= gy + STATION_RANGE && !found; y++) {
        for (let x = gx - STATION_RANGE; x <= gx + STATION_RANGE && !found; x++) found = ground.tileAt(x, y)?.deco === deco;
      }
      if (found) set.add(station);
    }
    return set;
  }

  private craft(recipe: Recipe, times = 1): void {
    if (recipe.rare && !this.progression.recipes.has(recipe.output.id)) {
      this.hud.notify('You do not know this recipe yet: find a Forgotten Schematic');
      return;
    }
    const stations = this.stations();
    let made = 0;
    let result: ReturnType<typeof craft> = 'ok';
    while (made < times && (result = craft(this.inventory, recipe, stations)) === 'ok') made++;
    const count = made * recipe.count;
    if (made) this.hud.notify(`Crafted ${count > 1 ? `${count} × ` : ''}${recipe.output.name}`);
    if (result === 'full') this.hud.notify('Bag full');
  }

  /** Story playground: places packed near the spawn, and a panel to drive the story. */
  private startPlayground(ui: HTMLElement): void {
    const { story } = this.living;
    story.compact = true;
    const goTo = (place: PlaceId | 'spawn') => {
      if (place === 'spawn') return this.teleport(0, 0);
      const o = this.world.objects.objects.get(`story:${place}`);
      if (!o) return this.hud.notify('That place is gone at this point in the story');
      // Just outside the south side, where the entrances are.
      this.teleport(o.x + o.w / 2, o.y + o.h + 2);
    };
    this.playground = new Playground(ui, {
      goTo,
      jump: (stage) => {
        this.living.dialog.close();
        story.jumpTo(stage);
        const target = STAGE_TARGET[stage];
        if (target) goTo(target);
        this.hud.notify(`Playground: chapter "${stage}"`);
      },
      ending: (e) => {
        this.living.dialog.close();
        story.chooseEnding(e);
      },
      find: (kind: PlaygroundFind) => {
        const { player } = this;
        const placed = this.living.events.trigger(kind, {
          x: player.x,
          y: player.y,
          night: this.living.time.isNight,
          village: null,
          merchantNearby: false,
          now: this.living.time.total,
          ending: story.ending,
          cabinFound: story.cabinFound,
        });
        if (!placed) this.hud.notify('No open ground nearby; move somewhere clearer');
      },
      setHour: (hour) => (this.living.time.minutes = hour * 60),
      restart: () => (location.href = `${location.pathname}?playground=${this.world.seed}`),
    });
  }

  private teleport(x: number, y: number): void {
    if (this.room) this.leave();
    this.gathering.cancel();
    this.travel(x, y);
  }

  /** Health ran out: wake up back at the start, keeping your things. */
  private collapse(): void {
    if (this.room) this.leave();
    this.gathering.cancel();
    this.vitals.revive();
    const { x, y } = this.respawn;
    this.hud.alert(x || y ? 'You collapsed… and wake up where you last rested.' : 'You collapsed… and wake up back at the start.');
    this.travel(x, y);
  }

  /** What does not fit in the bag is left on the ground, outside if indoors. */
  private overflow(item: ItemDef, count: number): void {
    const at = this.room ? this.room.outside : this.player;
    this.world.ground.drop({ item, count }, at.x, at.y);
    this.hud.notify(`Bag full: ${count} ${item.name} left on the ground${this.room ? ' outside' : ''}`);
  }

  /** The target marker is cleared only when something was drawn on it:
   *  clearing a Graphics makes Pixi rebuild its render group's draw list. */
  private clearMarker(): void {
    if (!this.markerDrawn) return;
    this.marker.clear();
    this.markerDrawn = false;
  }

  private drawMarker(): Graphics {
    this.markerDrawn = true;
    return this.marker;
  }

  /** Remembers where the player is, outdoors, as the place to wake after collapsing. */
  private setRespawn(): void {
    const at = this.room ? this.room.outside : this.player;
    this.respawn = { x: at.x, y: at.y };
  }

  private save(manual: boolean): void {
    if (this.playground) {
      if (manual) this.hud.notify('The story playground is never saved');
      return;
    }
    if (this.saveLock) {
      if (manual) this.hud.alert(this.saveLock);
      return;
    }
    // A vision may be half way through changing the story: save after it.
    if (this.living.vision.isOpen) {
      if (manual) this.hud.notify('Cannot save during a vision');
      return;
    }
    if (this.spawnTarget) {
      if (manual) this.hud.notify('Cannot save while travelling');
      return;
    }
    // Indoors, the save keeps the spot outside the door.
    const at = this.room ? this.room.outside : this.player;
    this.saves
      .save(
        snapshot(this.world, {
          x: at.x,
          y: at.y,
          inventory: this.inventory.save(),
          equipment: this.inventory.saveEquipment(),
          vitals: this.vitals.save(),
          progression: this.progression.save(),
          respawn: { ...this.respawn },
          moonwells: [...this.usedMoonwells],
        }, this.living.save(), this.exploration.save()),
      )
      .then(() => {
        this.saveFailed = false;
        if (manual) this.hud.notify('Game saved');
      })
      .catch(() => {
        // Autosaves report a failure once, not every 30 seconds.
        if (manual || !this.saveFailed) this.hud.notify("Couldn't save: this browser is blocking storage");
        this.saveFailed = true;
      });
  }

  /** The player is placed: lift the loading screen, or play the opening reveal the first time. */
  private loaded(): void {
    this.hud.setLoading(false);
    if (!this.intro) return;
    void this.intro.play();
    this.intro = null;
  }

  private travel(x: number, y: number): void {
    this.spawnTarget = { x, y };
    this.hud.setLoading(true);
  }

  /** Places the player on the nearest open tile once the ground has loaded. */
  private trySpawn(): void {
    const target = this.spawnTarget!;
    const { player, world, camera } = this;
    player.place(target.x, target.y);
    camera.snap(target.x * TILE_SIZE, target.y * TILE_SIZE);
    const tx = Math.floor(target.x);
    const ty = Math.floor(target.y);
    const loaded = (x: number, y: number) =>
      world.chunks.get(Math.floor(x / CHUNK_SIZE), Math.floor(y / CHUNK_SIZE))?.ready;
    if (!loaded(tx - SPAWN_SEARCH, ty - SPAWN_SEARCH) || !loaded(tx + SPAWN_SEARCH, ty + SPAWN_SEARCH) ||
        !loaded(tx - SPAWN_SEARCH, ty + SPAWN_SEARCH) || !loaded(tx + SPAWN_SEARCH, ty - SPAWN_SEARCH)) return;

    // A saved position is restored exactly when it is still open.
    if (!player.blocked(target.x, target.y, world)) {
      this.spawnTarget = null;
      this.loaded();
      return;
    }
    for (let r = 0; r <= SPAWN_SEARCH; r++) {
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
          const x = tx + dx + 0.5;
          const y = ty + dy + 0.9;
          if (player.blocked(x, y, world) || player.blocked(x, y + 1, world) || player.blocked(x + 1, y, world)) continue;
          player.place(x, y);
          camera.snap(x * TILE_SIZE, y * TILE_SIZE);
          this.spawnTarget = null;
          this.loaded();
          return;
        }
      }
    }
    // Nothing open nearby: try a bit further along.
    this.spawnTarget = { x: target.x + SPAWN_SEARCH * 2, y: target.y };
  }

  /** First-time tips, one at a time, as each part of the game comes up. */
  private tips(): void {
    if (this.spawnTarget || this.paused || this.playground) return;
    const k = (a: Action) => keyName(this.input.keys[a][0]);
    const act = TOUCH ? 'tap' : k('interact');
    const h = this.hints;
    const stations = this.stations();
    const { vitals } = this;
    void (
      h.once('start', true, TOUCH
        ? 'Drag on the left half to move; tap to talk, gather and open. The compass (top left) points to your next goal.'
        : `${k('up')}${k('left')}${k('down')}${k('right')} to move, ${k('interact')} to talk, gather and open. The compass (top left) points to your next goal.`) ||
      h.once('enemy', !this.room && this.combat.enemies.some((e) => e.state === 'chase' || e.state === 'attack'), TOUCH
        ? 'An enemy! Hit attacks the nearest one, hold Block to block, Roll to dodge.'
        : `An enemy! Click or ${k('attack')} to attack, hold right-click or ${k('block')} to block, ${k('dodge')} to roll away.`) ||
      h.once('hungry', vitals.hunger < 50, `You're getting hungry. Pick berries or cook meat at a campfire, then ${TOUCH ? 'tap its hotbar slot twice' : `select it and press ${k('use')}`} to eat.`) ||
      h.once('thirsty', vitals.thirst < 50, `Thirsty? Face water and ${act} to drink.`) ||
      h.once('night', this.living.time.isNight, `Night is dark and dangerous. ${act === 'tap' ? 'Tap' : `Press ${act}`} at a campfire to sleep until morning; you also wake there if you collapse.`) ||
      h.once('campfire', stations.has('campfire'), 'A campfire: cook food here from the Crafting tab of the Bag.') ||
      h.once('anvil', stations.has('anvil'), 'An anvil: forge tools, weapons and armour here from the Crafting tab.') ||
      h.once('skill', this.progression.skillPoints > 0, 'You have a skill point: spend it in the Skills tab of the Bag.') ||
      h.once('heavy', this.overloaded, 'Your bag is too heavy and slows you down: drop or sell things.')
    );
  }

  private updateUi(): void {
    const { world } = this;
    // Indoors, everything is measured from the door outside.
    const player = this.room ? this.room.outside : this.player;
    const gx = Math.floor(player.x);
    const gy = Math.floor(player.y);
    const biome = world.biomeAt(gx, gy);
    const floor = this.room?.floorName ? ` · ${this.room.floorName}` : '';
    const place = this.room ? `Inside · ${this.room.object.name}${floor}` : biome ? biomeName(biome) : '…';
    this.hud.setLocation(place, DIFFICULTY_BANDS[difficultyBand(gx, gy)].name, gx, gy);
    this.hud.setClock(this.living.time.label(), this.living.effect.label);
    const lines = this.living.tracker();
    const marker = this.exploration.trackedMarker;
    if (marker) lines.push({ text: marker.label, angle: Math.atan2(marker.y - player.y, marker.x - player.x) });
    this.hud.setTracker(lines);
    // The compass points at the story's next place, or the tracked marker.
    const goal = this.living.story.objective() ?? marker;
    const name = goal ? ('text' in goal ? goal.text : goal.label) : 'No destination';
    this.hud.setCompass(goal ? Math.atan2(goal.y - player.y, goal.x - player.x) : null, `${gx}, ${gy} · ${name}`);
    this.hud.setVitals(this.vitals, this.vitals.maxHealth);
    const { level, xp } = this.progression;
    this.hud.setLevel(level, xp, Progression.needed(level));
    const status: Array<[string, number]> = Object.entries(this.vitals.status);
    if (this.overloaded) status.push(['overloaded', Infinity]);
    this.hud.setStatus(status);
    const boss = this.combat.boss;
    this.hud.setBoss(boss ? boss.name : null, boss ? boss.hp / boss.maxHp : 0);
    this.debug.update(world, this.combat.enemies, this.app.ticker.FPS, this.renderer.drawnCount, player.x, player.y);
  }
}

/** Whether a save restores cleanly, tried on a throwaway world first. */
function readable(data: SaveData): boolean {
  try {
    restore(new WorldManager(data.seed, new SyncGenerator()), data);
    const inv = new Inventory();
    inv.load(data.player.inventory);
    if (data.player.equipment) inv.loadEquipment(data.player.equipment);
    if (data.player.progression) new Progression().load(data.player.progression);
    if (data.player.vitals) new Vitals().load(data.player.vitals);
    if (data.exploration) new ExplorationSystem().load(data.exploration);
    return Number.isFinite(data.seed) && Number.isFinite(data.player.x) && Number.isFinite(data.player.y);
  } catch (e) {
    console.error('Save could not be read.', e);
    return false;
  }
}
