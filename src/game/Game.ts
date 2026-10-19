// Boots PixiJS, owns the game loop, and wires the world to the screen.

import { Application, Container, Graphics, Texture, TextureStyle } from 'pixi.js';
import { AudioSystem, type MusicMood, type Sfx } from '../audio/AudioSystem';
import { CHUNK_SIZE, TILE_SIZE } from '../config';
import { BIOME_TYPES, BiomeType, Deco, isWater, Tile } from '../generation/Tiles';
import { DIFFICULTY_BANDS, difficultyBand } from '../generation/WorldRules';
import { buildAtlas } from '../rendering/Atlas';
import { RiftGlitch, type GlitchTargets } from '../rendering/RiftGlitch';
import { TEAR_MID_UP } from '../rendering/RiftArt';
import { RiftPassageView } from '../rendering/RiftPassageView';
import { SiteRenderer } from '../rendering/SiteRenderer';
import { GroundItemRenderer } from '../rendering/GroundItemRenderer';
import { BuildingRenderer } from '../rendering/Buildings';
import { EntityRenderer } from '../rendering/EntityRenderer';
import { InteriorRenderer } from '../rendering/InteriorRenderer';
import type { Light } from '../rendering/Lighting';
import { TileRenderer } from '../rendering/TileRenderer';
import { characterSave, restore, SaveManager, snapshot, UnreadableSave, type SaveData } from '../save/SaveManager';
import type { BurstKind } from '../rendering/Effects';
import { CombatSystem } from '../systems/CombatSystem';
import { EXPLORE_XP, ExplorationSystem } from '../systems/ExplorationSystem';
import { craft, STATION_DECO, STATION_NAMES, STATION_RANGE, unknownRare, type Recipe, type Station } from '../systems/CraftingSystem';
import { GatheringSystem, interactionAt, type Interaction } from '../systems/GatheringSystem';
import { Inventory, type SavedSlot, type Stack } from '../systems/InventorySystem';
import { itemById, Items, type ItemDef } from '../items/Items';
import { Progression, type SkillId } from '../systems/Progression';
import { SLOW_FACTOR, VITAL_MAX, Vitals } from '../systems/Vitals';
import { WEATHER, type WeatherKind } from '../systems/WeatherSystem';
import { DebugOverlay } from '../ui/DebugOverlay';
import { Hotbar } from '../ui/Hotbar';
import { Hints } from '../ui/Hints';
import { Intro } from '../ui/Intro';
import { Hud } from '../ui/Hud';
import { Playground } from '../ui/Playground';
import { Beacon } from '../ui/Beacon';
import type { Coop, CoopGame, InstanceLink, Joined, WorldGame, WorldGuest, WorldHost } from '../coop';
import type { Enemy } from '../entities/Enemy';
import type { RemotePlayer } from '../rendering/EntityRenderer';
import { Menu } from '../ui/Menu';
import { PauseMenu } from '../ui/PauseMenu';
import { SleepOverlay } from '../ui/SleepOverlay';
import { TouchStick } from '../ui/TouchStick';
import { biomeName } from '../world/BiomeManager';
import { hash, hashString, streamRng, Stream } from '../generation/Random';
import type { DimEvent } from '../dimension/Challenges';
import { LOCAL } from '../dimension/Contribution';
import { DIMENSIONS, dimensionById, dimensionForRift, retuneChoices, type DimensionLayout, type PlotRelic, type SiteKind } from '../dimension/Dimension';
import { DimensionCache, LocalDimensionSource } from '../dimension/DimensionSource';
import { DimensionWorld } from '../dimension/DimensionWorld';
import { DimTile } from '../dimension/DimTile';
import type { BuildingSpec } from '../generation/StructureGenerator';
import { rollChest } from '../systems/Loot';
import { chunkKey, clampTile, tileToChunk } from '../coords';
import { Npc } from '../entities/NPC';
import { BOOKS, Interior, KEEP_FLOORS } from '../world/Interior';
import { ChunkPool } from '../world/Chunk';
import { WorldManager } from '../world/WorldManager';
import type { WorldObject } from '../world/WorldObject';
import { WorkerGenerator } from '../workers/WorkerGenerator';
import { SyncGenerator } from '../world/SyncGenerator';
import { Camera } from './Camera';
import { Input } from './Input';
import { LivingWorld } from './LivingWorld';
import type { Place } from './Place';
import { riftDoorstep, riftTile, RiftTrip } from './RiftTrip';
import { RiftTransition, type RiftPassage } from './RiftTransition';
import { DODGE_STAMINA, Player, type Collider } from './Player';
import { bindings, keyName, type Action } from './Keys';
import { Settings } from './Settings';

/** Internal resolution target: the canvas is this tall, then scaled up with
 *  nearest-neighbour filtering. */
const TARGET_HEIGHT = 270;
/** A touch screen: messages name buttons instead of keys. */
const TOUCH = typeof matchMedia !== 'undefined' && matchMedia('(pointer: coarse)').matches;
/** The system asks for reduced motion: passages through rifts only fade. */
const REDUCED_MOTION = typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches;
/** The player's body centre above the feet, in pixels: a passage spins them about it. */
const BODY = 13;
/** The cover over a passage: a bright flash, or (without flashes) the void's dark. */
const PASSAGE_FLASH = 0xe6d8ff;
const PASSAGE_DARK = 0x150a2a;
/** How far the debug "far trip" jumps, in tiles. Far enough to unload everything. */
const FAR_TRIP = 20000;
/** Search radius when looking for open ground, in tiles. Stays inside the
 *  render margin so the search never waits on chunks that will not load. */
const SPAWN_SEARCH = 24;
const AUTOSAVE_SECONDS = 30;
const DISCOVERY_XP = 15;
const MOONWELL_XP = 25;
/** Reading a lore stone for the first time. */
const CLUE_XP = 20;
/** Within this many tiles of an outer world's resident, E talks to them. */
const TALK_RANGE = 1.8;
/** Saving inside an outer dimension keeps what was carried in only while the
 *  player is out of danger: health above this share, and nothing hunting
 *  them within `DANGER_RANGE` tiles. Otherwise the save keeps nothing carried,
 *  as dying would (closing the page is no way out of a fight). */
const SAFE_HEALTH = 0.5;
const DANGER_RANGE = 10;
/** Glitches run within this many tiles of an open rift. */
const GLITCH_RANGE = 12;
/** Within this many tiles of an open rift, the map behind it starts loading. */
const PRELOAD_RANGE = 40;
const NO_PLAYERS: readonly RemotePlayer[] = [];
/** How long a passage holds at full cover while the beacon looks for others behind the rift, in ms. */
const JOIN_WAIT_MS = 9000;
const NOWHERE = { x0: 0, y0: 0, x1: -1, y1: -1 };
/** Where a player is, as a shared world tells it (`Place` in src/coop/worldWire.ts,
 *  not imported: that module only loads when the world is shared). */
const OUTDOORS = 0;
const INDOORS = 1;
const AWAY = 2;
/** How many friends may visit a world at once: fewer when a phone hosts, as
 *  the host's machine does the work of the whole world. */
const VISITORS = TOUCH ? 2 : 4;
/** A notice to show once home again (why a visit ended), across the page load. */
const NOTICE_KEY = 'untrue-notice';
/** How long the beacon's jump to another world takes to cover the screen, in ms. */
const JUMP_MS = 600;
/** A code this page may visit without asking (the beacon chose it), for this tab. */
const JOIN_OK_KEY = 'untrue-join-ok';
/** Hidden with others playing in what this machine runs: a step this often, in ms. */
const HIDDEN_STEP_MS = 100;
/** Visiting: the character is saved this long after something is given or put down, in ms. */
const CHAR_SAVE_MS = 1000;
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
  [Deco.HollowTree]: ['chop', 'wood'],
  [Deco.AshTree]: ['chop', 'wood'],
  [Deco.RiftCrystal]: ['mine', 'magic'],
  [Deco.ShardGrass]: ['pickup', 'leaf'],
  [Deco.GlowCap]: ['pickup', 'leaf'],
};
const STEP_WALK = 0.36;
const STEP_RUN = 0.25;
/** Seconds between tool strikes while gathering. */
const STRIKE_INTERVAL = 0.45;
/** Hotbar slot keys. */
const DIGITS = ['Digit1', 'Digit2', 'Digit3', 'Digit4', 'Digit5', 'Digit6', 'Digit7', 'Digit8'];

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
  /** The ground's layers: the overworld's chunk meshes, a dimension's, then
   *  the flat parts of a dimension's sites over its land. */
  private readonly worldGround = new Container();
  private readonly dimGround = new Container();
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
  /** The trip into an outer dimension the player is on, if any. */
  private trip: RiftTrip | null = null;
  /** The dimension's land on that trip, streamed and drawn like the overworld. */
  private dimWorld: DimensionWorld | null = null;
  /** What the player carried when they stepped through the rift: a save made
   *  inside keeps this, not what was picked up inside (see `carriedForSave`). */
  private tripBag: SavedSlot[] | null = null;
  /** The outer world's resident, if it has one, and the list it is drawn from. */
  private resident: Npc | null = null;
  private readonly dimNpcs: Npc[] = [];
  private readonly dimMarks = new Map<number, string>();
  private dimTiles!: TileRenderer;
  private sites!: SiteRenderer;
  /** Playing with others behind the rifts (src/coop): loaded the first time it
   *  is needed, so solo play never downloads it. */
  private coopLib: Promise<Coop> | null = null;
  private coopMod: typeof import('../coop') | null = null;
  /** The shared instance this trip is part of, if any. */
  private coop: InstanceLink | null = null;
  /** Finding others behind a rift, while its passage holds at full cover. */
  private joining: { done: boolean; result: Joined | null; failed: boolean; since: number; abandoned: boolean } | null = null;
  /** The instance the beacon was tuned to, for the next trip. */
  private preferInstance: string | null = null;
  /** ?net=local: tabs of this browser meet each other, for testing. */
  private netLocal = false;
  /** This player's world, open to friends by its code (src/coop). */
  private worldHost: WorldHost | null = null;
  /** Visiting a friend's world: the link to it. */
  private worldGuest: WorldGuest | null = null;
  private worldGame!: WorldGame;
  /** Visiting: this player's own save, kept as it was but for their character. */
  private ownSave: SaveData | null = null;
  /** Seeds a world to come home to, for a visitor with none of their own. */
  private readonly homeSeed = Math.floor(Math.random() * 1e9);
  /** Visiting a test world: nothing is saved. */
  private visitUnsaved = false;
  /** Opening this world, or setting off to a friend's; why the last try failed. */
  private worldBusy = false;
  /** The timer that steps the game while the page is hidden, and when it last did. */
  private hiddenTimer: ReturnType<typeof setInterval> | undefined;
  private hiddenAt = 0;
  /** Visiting: the character's save, due soon. */
  private charSaveTimer: ReturnType<typeof setTimeout> | undefined;
  private worldError = '';
  /** Friends' instances behind the rifts, by dimension: entering one follows them. */
  private readonly friendInstances = new Map<string, string>();
  /** The player's body at the door while indoors, for a shared world's creatures. */
  private readonly doorBody = { x: 0, y: 0, faceX: 0, faceY: 1, blocking: false, invulnerable: true };
  private beacon!: Beacon;
  private coopGame!: CoopGame;
  /** The local player as the others see them, rewritten in place. */
  private readonly seenAs = { x: 0, y: 0, facing: 0, frame: 0, moving: false, hurt: 0, guarding: false, holding: -1, health: 1 };
  /** Chunk buffers for dimensions' land, reused trip after trip. */
  private readonly dimChunks = new ChunkPool();
  /** Dimensions' maps, loaded (and kept) as rifts come near. */
  private readonly dimensions = new DimensionCache(new LocalDimensionSource());
  /** The camera's view in a dimension, in tiles, filled in place. */
  private readonly dimView = { minX: 0, minY: 0, maxX: 0, maxY: 0, playerX: 0, playerY: 0, dirX: 0, dirY: 0 };
  /** How far the nearest open rift's tear is, and where, refreshed with the HUD. */
  private riftDistance = Infinity;
  private readonly riftAt = { x: 0, y: 0 };
  private readonly glitch = new RiftGlitch();
  private glitching = false;
  /** A passage through a rift, under way or not; the world waits while it runs. */
  private readonly passage = new RiftTransition({
    switch: (kind) => this.passageSwitch(kind),
    collapse: () => this.passageCollapse(),
    done: (kind) => this.passageDone(kind),
  });
  private passageView!: RiftPassageView;
  /** The passage's rift and its points in world pixels: where the player's body
   *  starts, where it is pulled to, and where it emerges; the zoom to go back to. */
  private readonly passageAt = { rift: null as WorldObject | null, layout: null as DimensionLayout | null, xp: 0, sealOnLeave: false, fromX: 0, fromY: 0, toX: 0, toY: 0, outX: 0, outY: 0, zoom: 1, burst: false };
  private readonly glitchTargets: GlitchTargets = {
    jolt: (gx, gy, dx, tint, seconds) => this.renderer.jolt(gx, gy, dx, tint, seconds),
    tint: (color) => {
      if (this.settings.values.flashes || color === 0xffffff) this.worldLayer.tint = color;
    },
    stutter: () => this.hud.stutter(),
  };
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
  /** The overworld as a place: the player is where they stand. */
  private outdoors!: Place;
  private drownNote = 0;
  private swimNote = 0;
  private markerDrawn = false;
  /** The same for the marker indoors. */
  private indoorMarkerDrawn = false;
  /** The music's mood, filled in place each frame. */
  private readonly mood: MusicMood = { biome: undefined, night: false, danger: false, weather: 'clear', weatherStrength: 0 };
  /** Per-frame arguments, filled in place instead of allocated each frame. */
  private readonly view = { minX: 0, minY: 0, maxX: 0, maxY: 0, playerX: 0, playerY: 0, dirX: 0, dirY: 0 };
  private readonly nearView = { x0: 0, y0: 0, x1: 0, y1: 0 };
  private readonly body = { x: 0, y: 0, faceX: 0, faceY: 1, blocking: false, invulnerable: false };
  private readonly roomLights: Light[] = [];
  private readonly screenAt: [number, number] = [0, 0];
  private readonly nameTags = new Container();
  /** World pixels to screen pixels, for the lighting. The tuple is reused. */
  private readonly toScreen = (x: number, y: number): [number, number] => {
    // A dimension is drawn in the world layer, like the overworld.
    const view = this.room ? this.interiorRenderer.view : this.worldLayer;
    this.screenAt[0] = x * this.camera.zoom + view.x;
    this.screenAt[1] = y * this.camera.zoom + view.y;
    return this.screenAt;
  };
  private readonly sceneLights = (out: Light[]): void => {
    this.renderer.lights(out);
    this.buildings.lights(out);
  };
  private canvasSize = '';
  private saveFailed = false;
  private errors = 0;
  private sleepOverlay!: SleepOverlay;
  /** Moonwells already drunk from; each gives its gift once. */
  private readonly usedMoonwells = new Set<string>();
  /** Where the player wakes after collapsing: the last place they rested. */
  private respawn = { x: 0, y: 0 };
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
  /** Show the story's opening vision after the opening screen. */
  private storyIntro = false;

  async start(host: HTMLElement, ui: HTMLElement): Promise<void> {
    // ?new or ?seed=N start a fresh world; otherwise the save is loaded.
    const params = new URLSearchParams(location.search);
    // ?playground (development builds): a story test world, never saved.
    const playground = import.meta.env.DEV && params.has('playground');
    const fresh = params.has('new') || params.has('seed') || playground;
    // ?net=local: tabs of this browser meet behind the rifts (for testing), not strangers.
    this.netLocal = params.get('net') === 'local';
    // ?join=CODE: visiting a friend's world. Their world comes over the network
    // from them; this player brings their own character (from their save).
    const joinCode = params.get('join');
    if (joinCode) {
      // A link someone sent: asked first, since joining shows them this
      // player's network address. The beacon's own jumps are asked already.
      if (!this.joinApproved(joinCode)) {
        this.goHome();
        return;
      }
      try {
        this.worldGuest = await (await this.loadCoop()).joinWorld(joinCode);
      } catch (e) {
        console.warn('Could not reach that world:', e);
        this.goHome(`Your beacon could not reach that world${e instanceof Error && e.message ? `: ${e.message}` : ''}.`);
        return;
      }
    }
    const visit = this.worldGuest?.info ?? null;
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
    } else if (!playground) {
      // A ?seed link starts over: keep a copy of the world it would autosave over.
      const old = await this.saves.load().catch(() => null);
      if (old) await this.saves.backup(old).catch(() => {});
    }
    if (saved && !readable(saved)) {
      await this.saves.backup(saved).catch(() => {});
      saved = null;
      recovered = true;
    }
    const seed = visit ? visit.seed : playground ? Number(params.get('playground')) || 1 : (saved?.seed ?? (Number(params.get('seed')) || Math.floor(Math.random() * 1e9)));
    // Debug-only: ?spawn=x,y, ?hour=N and ?weather=kind (development builds).
    const dev = import.meta.env.DEV;
    const spawn = dev ? params.get('spawn')?.split(',').map(Number) : undefined;
    // A visitor arrives by the host, wherever the host stands.
    const start = visit ? { x: visit.x + 1, y: visit.y } : spawn ? { x: spawn[0], y: spawn[1] } : (saved?.player ?? { x: 0, y: 0 });
    this.spawnTarget = { x: clampTile(start.x), y: clampTile(start.y) };
    // Reloading should continue this world (or this visit), not start another.
    history.replaceState(null, '', this.urlFor(visit ? { join: joinCode! } : playground ? { playground: String(seed) } : {}));

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
    this.ground.addChild(this.worldGround, this.dimGround);
    this.worldLayer.addChild(this.ground, this.entities, this.marker, this.overlay);
    this.app.stage.addChild(this.worldLayer);

    // A visitor's world is a copy of the host's, streamed from it.
    this.world = visit ? new WorldManager(seed, this.worldGuest!.generator, true) : new WorldManager(seed, new WorkerGenerator());
    this.ownSave = visit ? saved : null;
    // New rifts lean toward the next dimension the player's story has not cleared.
    this.world.riftDestination = (id) => dimensionForRift(hash(seed, hashString(id)), this.living?.story.cleared);
    this.renderer = new TileRenderer(atlas, this.worldGround, this.entities, (gx, gy) => this.world.tileAt(gx, gy)?.tile);
    // A dimension's land draws the same way, into its own layer.
    this.dimTiles = new TileRenderer(atlas, this.dimGround, this.entities, (gx, gy) => this.dimWorld?.tileAt(gx, gy)?.tile);
    this.sites = new SiteRenderer(atlas, this.entities);
    this.ground.addChild(this.sites.flats);
    this.buildings = new BuildingRenderer(this.entities, (gx, gy) => this.world.biomeAt(gx, gy)?.type === BiomeType.Snow);
    this.interiorRenderer = new InteriorRenderer(atlas);
    this.app.stage.addChild(this.interiorRenderer.view);
    this.world.chunks.listener = this.renderer;
    if (saved) {
      // Visiting, only the character comes from the save; the world is the host's.
      if (!visit) restore(this.world, saved);
      this.inventory.load(saved.player.inventory);
      // Saves from before equipment put on the best armour carried.
      if (saved.player.equipment) this.inventory.loadEquipment(saved.player.equipment);
      else this.inventory.autoEquip();
      if (saved.player.progression) this.progression.load(saved.player.progression);
      this.vitals.maxHealth = this.progression.maxHealth;
      if (saved.player.vitals) this.vitals.load(saved.player.vitals);
      if (saved.exploration && !visit) this.exploration.load(saved.exploration);
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
      map: {
        exploration: this.exploration,
        player: () => ({ x: this.player.x, y: this.player.y }),
      },
      mapAvailable: () => this.mapAvailable,
      dimensionMap: () => {
        const trip = this.trip;
        if (!trip) return null;
        const story = this.living.story;
        return { layout: trip.layout, run: trip.run, seen: trip.seen, seenVersion: trip.seenVersion, read: (id) => story.hasRead(trip.layout.id, id), player: () => this.player };
      },
      settings: this.settings,
    });
    this.pause = new PauseMenu(ui, {
      save: () => this.save(true),
      settings: () => this.menu.show('settings'),
      newWorld: () => {
        // The playground never touches the real save.
        if (this.playground) location.href = `${location.pathname}?playground=${this.world.seed}`;
        else {
          // An autosave as the page hides would write the old world back.
          this.saveLock = 'Starting a new world…';
          void this.saves.clear().catch(() => {}).finally(() => (location.href = `${location.pathname}?new`));
        }
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
        this.player.hurt(fx, fy, this.place);
        this.gathering.cancel();
        this.hud.flashHurt();
        this.audio.play('hurt');
      },
      notify: (t) => this.hud.notify(t),
    });
    this.outdoors = { kind: 'world', isSolidAt: this.walker.isSolidAt, spot: this.player, arena: this.combat.overworld };
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
    this.living.attach(this.app.stage, this.worldLayer);
    this.passageView = new RiftPassageView(atlas, this.entities);
    // Players' names: in screen pixels over the world and its lighting, under the passage's veil.
    this.app.stage.addChild(this.nameTags);
    this.entityRenderer.setTagLayer(this.nameTags, this.toScreen);
    this.app.stage.addChild(this.passageView.view);
    if (saved?.living) {
      try {
        this.living.load(saved.living);
      } catch (e) {
        // Keep the old save, since autosave would otherwise lose its quests for good.
        console.error('Could not restore the living world; starting it afresh.', e);
        void this.saves.backup(saved).catch(() => {});
        this.hud.alert("Part of your save (quests, weather, clock) couldn't be read and started afresh. A copy of the old save was kept.");
      }
    }
    if (visit) {
      // The host's clock and weather; its world events and fires are its own.
      this.living.guest = true;
      this.living.adoptClock(visit.day, visit.minutes, visit.weather);
      this.visitUnsaved = visit.playground;
      this.respawn = { x: visit.x, y: visit.y };
    } else {
      const wake = saved?.player.respawn;
      if (wake && Number.isFinite(wake.x) && Number.isFinite(wake.y)) this.respawn = { x: clampTile(wake.x), y: clampTile(wake.y) };
      const wells: unknown = saved?.player.moonwells;
      if (Array.isArray(wells)) for (const id of wells) if (typeof id === 'string') this.usedMoonwells.add(id);
    }
    if (playground) this.startPlayground(ui);
    // A new world opens on the story's vision, once the world is revealed;
    // older saves start without it.
    this.storyIntro = !saved && !playground && !visit;
    // A new world starts with a lantern, a light that never burns out.
    if (!saved) this.inventory.add(Items.lantern, 1);
    // Everyone carries a Drift Beacon; saves from before it get one.
    if (!this.inventory.count(Items.driftBeacon)) this.inventory.add(Items.driftBeacon, 1);
    this.startCoop(ui);
    this.startWorldSharing();
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
    // Menus stay shut while passing through a rift, as they do for keys.
    this.hud.onPause = () => {
      if (!this.living.vision.isOpen && !this.passage.active) this.pause.toggle();
    };
    this.hotbar.onUse = (slot) => this.useItem(slot);
    this.hud.onAction = () => this.interact();
    this.hud.onBag = () => {
      if (!this.passage.active) this.menu.toggle();
    };
    this.hud.onBeacon = () => {
      if (!this.passage.active) this.beacon.toggle();
    };
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
    // Why a visit ended, said once home.
    let notice: string | null = null;
    try {
      notice = sessionStorage.getItem(NOTICE_KEY);
      sessionStorage.removeItem(NOTICE_KEY);
    } catch {
      // Storage blocked: nothing to say.
    }
    if (notice && !visit) this.hud.alert(notice);
    if (visit) {
      this.hud.notify(`You step into ${this.worldGuest!.hostName}'s world.`);
      if (this.visitUnsaved) this.hud.alert('This is a test world: nothing you do here is saved.');
    }
    // Leaving the page half way through a rift ends the passage at once, so
    // the save sees one world (and a death behind a rift is not undone).
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) {
        clearInterval(this.hiddenTimer);
        this.hiddenTimer = undefined;
        return;
      }
      this.passage.finish();
      this.save(false);
      // Hidden, the page draws no frames, but friends in this world (or an
      // instance hosted here) still need it to go on: it steps on a timer.
      this.hiddenAt = performance.now();
      clearInterval(this.hiddenTimer);
      this.hiddenTimer = setInterval(() => this.stepHidden(), HIDDEN_STEP_MS);
    });
    // Safari may close a page without a visibility change.
    window.addEventListener('pagehide', () => {
      this.passage.finish();
      void this.save(false);
      // Friends are told at once, rather than waiting for the link to time out
      // (an instance's host hands it on to the next).
      this.worldHost?.close();
      this.worldGuest?.leave();
      this.coop?.leave();
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
    // A minimised or hidden window can report no size: keep the last one.
    if (!window.innerWidth || !window.innerHeight) return;
    const scale = Math.max(1, Math.floor(window.innerHeight / TARGET_HEIGHT));
    const w = Math.ceil(window.innerWidth / scale);
    const h = Math.ceil(window.innerHeight / scale);
    // Resize events come in bursts, and each real change remakes the lighting's texture.
    const size = `${w}x${h}@${scale}`;
    if (size === this.canvasSize) return;
    this.canvasSize = size;
    this.pixelScale = scale;
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

  /** Menus, conversations and passages through rifts pause the world (a
   *  shared dimension goes on regardless: see `tick`). */
  private get paused(): boolean {
    return this.menu.isOpen || this.living.paused || this.pause.isOpen || this.sleepOverlay.playing || this.passage.active || this.beacon.isOpen;
  }

  /** One step while the page is hidden (no frames come): only if others play
   *  in what this machine runs. Long gaps (browsers slow hidden timers) are
   *  walked in short steps. */
  private stepHidden(): void {
    const now = performance.now();
    const gap = Math.min(1, (now - this.hiddenAt) / 1000);
    this.hiddenAt = now;
    if (!this.worldHost?.hasGuests && !this.coop?.isHost) return;
    try {
      for (let left = gap; left > 0.001; left -= 0.1) this.tick(Math.min(0.1, left));
    } catch (e) {
      this.reportError(e);
    }
  }

  private tick(dt: number): void {
    const { camera, player, world } = this;
    this.handleKeys();
    if (this.passage.active) this.updatePassage(dt);

    if (this.spawnTarget) this.trySpawn();
    else if (this.room) {
      if (!this.paused) this.tickIndoors(dt);
      // Friends outdoors: the world cannot wait while this player reads a menu indoors.
      else if (this.worldHost?.guestsOutdoors && !this.passage.active && !this.sleepOverlay.playing) this.tickIndoorsFrozen(dt);
    } else if (this.trip) {
      if (!this.paused) this.tickDimension(dt);
      // Others share the instance: it cannot wait while this player reads a menu.
      else if (this.coop && !this.passage.active) this.tickDimension(dt, true);
    } else if (!this.paused) this.tickOutdoors(dt, false);
    // Friends share this world: it cannot wait while this player reads a menu.
    else if (this.sharing && !this.passage.active && !this.sleepOverlay.playing) this.tickOutdoors(dt, true);

    const { width, height } = this.app.renderer;
    // Indoors and in a dimension, the world keeps streaming around the door or the rift outside.
    const at = this.place.spot;
    const away = this.place !== this.outdoors;
    const halfW = width / 2 / camera.zoom / TILE_SIZE;
    const halfH = height / 2 / camera.zoom / TILE_SIZE;
    const cx = away ? at.x : camera.x / TILE_SIZE;
    const cy = away ? at.y : camera.y / TILE_SIZE;
    const v = this.view;
    v.minX = cx - halfW;
    v.minY = cy - halfH;
    v.maxX = cx + halfW;
    v.maxY = cy + halfH;
    v.playerX = at.x;
    v.playerY = at.y;
    v.dirX = away ? 0 : player.dirX;
    v.dirY = away ? 0 : player.dirY;
    // A visitor's host keeps what the visitor sees; a host streams for its visitors too.
    this.worldGuest?.view(v);
    world.update(v, this.worldHost?.views);
    if (this.worldHost?.isClosed) this.worldHost = null;
    this.worldHost?.update(dt);
    this.worldGuest?.update(dt);

    const view = this.room ? this.interiorRenderer.view : this.worldLayer;
    view.scale.set(camera.zoom);
    view.position.set(Math.round(width / 2 - camera.x * camera.zoom + this.glitch.offset), Math.round(height / 2 - camera.y * camera.zoom));
    if (this.room) {
      this.renderIndoors(dt);
      this.finishFrame(dt);
      return;
    }
    if (this.trip) {
      this.renderDimension(dt, halfW * TILE_SIZE, halfH * TILE_SIZE);
      this.finishFrame(dt);
      return;
    }
    this.renderer.cull((cx - halfW) * TILE_SIZE, (cy - halfH) * TILE_SIZE, (cx + halfW) * TILE_SIZE, (cy + halfH) * TILE_SIZE);
    this.renderer.animate(dt);
    this.renderer.settle(dt);
    this.riftGlitch(dt);
    this.buildings.update(world.objects.objects.values(), world.chunks.renderRect, player.x * TILE_SIZE, player.y * TILE_SIZE);
    const near = this.nearView;
    near.x0 = cx - halfW - 2;
    near.y0 = cy - halfH - 2;
    near.x1 = cx + halfW + 2;
    near.y1 = cy + halfH + 2;
    this.groundItems.update(dt, world.ground.items, near);
    this.updateTarget();
    this.renderer.fadeAround(player.x * TILE_SIZE, player.y * TILE_SIZE);
    this.entityRenderer.update(dt, this.combat.enemies, this.combat.projectiles, this.living.npcs.npcs, this.living.marks());
    this.entityRenderer.syncPlayers(this.visitors());
    this.living.render(dt, this.sceneLights, this.toScreen, camera.zoom);
    this.finishFrame(dt);
  }

  /** The overworld around the player. `frozen`: a menu is open while friends
   *  share this world, which goes on around the player, who stands still. */
  private tickOutdoors(dt: number, frozen: boolean): void {
    const { input, camera, player, world } = this;
    this.living.update(dt);
    const under = world.tileAt(Math.floor(player.x), Math.floor(player.y - 0.1))?.tile;
    player.swim = under === Tile.WaterDeep ? 2 : under === Tile.Water ? 1 : 0;
    const weather = this.living.effect;
    if (frozen) {
      this.blocking = false;
      player.moving = player.running = false;
    } else {
      this.blocking = !player.swim && (input.holding('block') || input.mouseBlock || this.hud.blockHeld);
      this.checkLoad();
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
    }
    this.exploration.update(world);
    const body = this.body;
    body.x = player.x;
    body.y = player.y;
    body.faceX = player.faceX;
    body.faceY = player.faceY;
    body.blocking = this.blocking;
    body.invulnerable = player.invulnerable;
    this.combat.update(dt, body);
    camera.follow(player.x * TILE_SIZE, player.y * TILE_SIZE, dt);
    const biome = world.biomeAt(Math.floor(player.x), Math.floor(player.y));
    const appetite = 1 - 0.1 * this.progression.rank('survivalist');
    const drain = player.swim === 2 ? 1 - 0.15 * this.progression.rank('swimmer') : 1;
    const needs = { hunger: weather.hunger * appetite, thirst: weather.thirst * appetite };
    if (this.vitals.update(dt, player.running || player.swim === 2, biome?.type, needs, drain)) this.collapse();
    else if (player.swim === 2 && !this.vitals.canRun) this.drown(dt);
    if (frozen) return;
    for (const s of world.ground.update(player.x, player.y, this.inventory)) {
      this.hud.notify(`+${s.count} ${s.item.name}`);
      this.audio.play('pickup');
    }
  }

  /** Friends share this world: this player's or one they are visiting. */
  private get sharing(): boolean {
    return !!this.worldGuest || !!this.worldHost?.hasGuests;
  }

  /** The other players in this world, drawn where they are (if here). */
  private visitors(): readonly RemotePlayer[] {
    return (this.worldHost ?? this.worldGuest)?.players.drawn ?? NO_PLAYERS;
  }

  /** Music, HUD, autosave: everything a frame ends with, indoors or out. */
  private finishFrame(dt: number): void {
    const { input, world } = this;
    const at = this.place.spot;
    const outdoors = this.place === this.outdoors;
    const mood = this.mood;
    mood.biome = world.biomeAt(Math.floor(at.x), Math.floor(at.y))?.type;
    mood.night = this.living.time.isNight;
    mood.danger = !this.room && this.combat.enemies.some((e) => e.state === 'chase' || e.state === 'attack');
    mood.weather = this.living.kind;
    mood.weatherStrength = this.paused || !outdoors ? 0 : this.living.weatherStrength;
    mood.band = difficultyBand(Math.floor(at.x), Math.floor(at.y));
    mood.indoors = !!this.room;
    mood.cave = !!this.room?.cave;
    mood.hunter = outdoors ? this.hunterCall() : null;
    mood.rift = this.glitching ? 1 - this.riftDistance / GLITCH_RANGE : 0;
    mood.dimension = this.trip ? this.trip.layout.mood.music : null;
    this.audio.update(mood);
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
    this.stopGlitch();
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

  // Outer dimensions ----------------------------------------------------------

  /** Where the player is: outdoors, in a room or in a dimension. */
  private get place(): Place {
    return this.room ?? this.trip ?? this.outdoors;
  }

  /** The rift whose tear is on this tile, if any. */
  private riftObjectAt(gx: number, gy: number): WorldObject | null {
    if (this.world.tileAt(gx, gy)?.deco !== Deco.Rift) return null;
    return this.world.objects.inChunk(chunkKey(tileToChunk(gx), tileToChunk(gy))).find((o) => o.kind === 'rift' && o.contains(gx, gy)) ?? null;
  }

  /** Where a rift opens onto, unless the player tunes it elsewhere. */
  private destinationOf(rift: WorldObject): string {
    return rift.dimension || this.world.riftDestination(rift.id);
  }

  /** A dimension's map, if it has loaded; else says why not (and keeps loading it). */
  private riftLayout(id: string): DimensionLayout | null {
    const layout = this.dimensions.get(id);
    if (layout) return layout;
    const error = this.dimensions.error(id);
    if (error) console.warn(`The map of ${id} could not be loaded: ${error}`);
    this.hud.notify(error ? "The rift won't open: what lies beyond can't be reached right now." : 'The rift is still settling. Try again in a moment.');
    return null;
  }

  /** Facing a rift and pressing E: straight in, or, once the player has
   *  cleared other dimensions, a choice of where to tune it. */
  private approachRift(rift: WorldObject): void {
    const choices = retuneChoices(this.destinationOf(rift), this.living.story.cleared);
    if (choices.length === 1) {
      this.stepIntoRift(rift, choices[0]);
      return;
    }
    const dialog = this.living.dialog;
    dialog.talk(
      'The rift',
      'The tear hums under your hand, and you feel it can be turned: toward where it opens, or toward somewhere you have been before.',
      choices.map((id, n) => ({
        label: `${TOUCH ? '' : `${n + 1}  `}${dimensionById(id)?.name ?? id}${n === 0 ? ' (where it opens)' : ''}`,
        action: () => {
          dialog.close();
          this.stepIntoRift(rift, id);
        },
      })),
    );
  }

  /** Into a rift, tuned to a dimension, once the map behind it is ready. A
   *  public trip looks for others behind it while the passage holds at full
   *  cover (`forcePublic`: whatever the beacon is set to). */
  private stepIntoRift(rift: WorldObject, id: string, forcePublic = false): void {
    // The chooser may have stayed open while the rift closed.
    if (this.passage.active || this.trip || rift.closed) return;
    const layout = this.riftLayout(id);
    if (!layout) return;
    this.passageAt.layout = layout;
    this.passageThrough('enter', rift);
    // With friends in this world, a trip is always one they can follow
    // (listed on the board only if public).
    const listed = forcePublic || this.settings.values.publicRifts;
    if (this.passage.active && (listed || this.sharing || this.friendInstances.has(id))) this.listenForOthers(id, listed);
  }

  /** Finds (or opens) a shared instance of the dimension ahead, while the
   *  passage waits at full cover: a friend's from this world first, if one
   *  went in. If it takes too long, the trip goes alone. */
  private listenForOthers(id: string, listed: boolean): void {
    const file = this.dimensions.file(id);
    if (!file) return;
    const friend = this.friendInstances.get(id);
    const j: NonNullable<Game['joining']> = { done: false, result: null, failed: false, since: performance.now(), abandoned: false };
    this.joining = j;
    this.passage.holding = true;
    this.hud.notify('Your beacon listens for others behind the rift…');
    const prefer = this.preferInstance ?? undefined;
    this.loadCoop()
      .then(async (c) => (friend ? await c.follow(id, file, friend) : null) ?? c.enter(id, file, listed, prefer))
      .then(
        (r) => {
          // Too late: the trip went on alone.
          if (j.abandoned) r.stop();
          else j.result = r;
          j.done = true;
        },
        (e: unknown) => {
          console.warn('Could not reach others behind the rift:', e);
          j.failed = j.done = true;
        },
      );
  }

  /** The Drift Beacon's panel, and what a shared instance asks of the game. */
  private startCoop(ui: HTMLElement): void {
    const game = this;
    this.coopGame = {
      get trip() {
        return game.trip!;
      },
      combat: this.combat,
      player: () => {
        const p = this.player;
        const s = this.seenAs;
        s.x = p.x;
        s.y = p.y;
        s.facing = p.facing;
        s.frame = p.walkFrame;
        s.moving = p.moving;
        s.hurt = p.hurtFlash;
        s.guarding = this.blocking;
        s.holding = p.holding ? p.holding.icon : -1;
        s.health = this.vitals.health / this.vitals.maxHealth;
        return s;
      },
      notify: (t) => this.hud.notify(t),
      runEvent: (e) => this.tripEvent(e),
      give: (item, count) => {
        const left = this.inventory.add(item, count);
        if (count > left) this.hud.notify(`+${count - left} ${item.name}`);
        if (left > 0) this.overflow(item, left);
        this.audio.play('pickup');
      },
      grantXp: (xp) => this.combat.grantXp(xp),
      replicaGone: (e: Enemy, killed) => {
        if (!killed) return;
        this.audio.play('kill');
        this.living.effects.burst(e.x, e.y - 0.4, 'dust', 14);
      },
    };
    this.beacon = new Beacon(ui, {
      isPublic: () => this.settings.values.publicRifts,
      setPublic: (v) => this.settings.set('publicRifts', v),
      status: () => ({
        dimension: this.trip ? this.trip.layout.id : this.riftAhead(),
        names: this.coop && !this.coop.alone ? this.coop.names() : [],
        code: this.coop?.code ?? '',
        host: this.coop?.isHost ?? false,
      }),
      world: () => ({
        mode: this.worldGuest ? 'visiting' : this.worldHost ? 'hosting' : 'alone',
        code: this.worldGuest?.code ?? this.worldHost?.code ?? '',
        guests: this.worldHost?.guestList() ?? [],
        host: this.worldGuest?.hostName ?? '',
        busy: this.worldBusy,
        error: this.worldError,
      }),
      openWorld: () => void this.openWorld(),
      closeWorld: () => this.closeWorld(),
      kick: (slot) => this.worldHost?.kick(slot),
      visit: (code) => this.visitWorld(code),
      goHome: () => this.leaveVisit(),
      instances: async () => {
        const id = this.trip ? this.trip.layout.id : this.riftAhead();
        if (!id) return [];
        const list = await (await this.loadCoop()).find(id);
        const name = dimensionById(id)?.name ?? id;
        return list.map((e) => ({ id: e.instance, label: `${e.name}'s ${name} · ${e.players} of ${e.capacity} · seals ${e.seals} of ${e.sealsTotal}` }));
      },
      prefer: (id) => (this.preferInstance = id),
      name: async () => (await this.loadCoop()).name,
      setName: async (v) => {
        const c = await this.loadCoop();
        c.name = v;
        return c.name;
      },
    });
  }

  /** What a shared overworld asks of the game, host or visitor (src/coop). */
  private startWorldSharing(): void {
    const game = this;
    const where = { place: OUTDOORS, object: null as WorldObject | null, index: 0, floor: 0 };
    const view = { x: 0, y: 0, px: 0, py: 0, halfW: 1, halfH: 1, dirX: 0, dirY: 0 };
    this.worldGame = {
      get world() {
        return game.world;
      },
      combat: this.combat,
      player: () => this.coopGame.player(),
      where: () => {
        const r = this.room;
        where.place = r ? INDOORS : this.trip ? AWAY : OUTDOORS;
        where.object = r ? r.object : null;
        where.index = r?.index ?? 0;
        where.floor = r?.floor ?? 0;
        return where;
      },
      view: () => {
        const v = this.view;
        view.x = (v.minX + v.maxX) / 2;
        view.y = (v.minY + v.maxY) / 2;
        view.px = v.playerX;
        view.py = v.playerY;
        view.halfW = (v.maxX - v.minX) / 2;
        view.halfH = (v.maxY - v.minY) / 2;
        return view;
      },
      spot: () => this.place.spot,
      notify: (t) => this.hud.notify(t),
      give: (item, count, durability) => {
        const left = this.inventory.addStack({ item, count, durability });
        if (count > left) this.hud.notify(`+${count - left} ${item.name}`);
        if (left > 0) this.overflow(item, left);
        this.audio.play('pickup');
      },
      grantXp: (xp) => this.combat.grantXp(xp),
      killed: (species) => this.living.quests.onKill(species.id),
      replicaGone: (e, killed) => this.coopGame.replicaGone(e, killed),
      clock: () => ({ day: this.living.time.day, minutes: this.living.time.minutes, weather: JSON.stringify(this.living.weather.save()) }),
      setClock: (day, minutes, weather) => this.living.adoptClock(day, minutes, weather),
      joinRequest: (name) => this.askToVisit(name),
      peopleChanged: () => this.beacon.refresh(),
      ended: (text) => this.visitEnded(text),
      saveSoon: () => {
        // A moment later, once a burst of them is over.
        clearTimeout(this.charSaveTimer);
        this.charSaveTimer = setTimeout(() => void this.save(false), CHAR_SAVE_MS);
      },
      riftInstance: (dimension, code) => {
        this.friendInstances.set(dimension, code);
        this.hud.notify(`A friend went behind a rift into ${dimensionById(dimension)?.name ?? 'somewhere'}. Step through a rift there, and your beacon finds them.`);
      },
    };
    const guest = this.worldGuest;
    if (!guest) return;
    guest.attach(this.worldGame);
    // Their chests are theirs to open, and what grows or lies in their world
    // theirs to give: the host is asked first.
    this.gathering.claim = (o, i, open) => guest.claimChest(o, i, open);
    this.gathering.confirm = (ground, gx, gy, deco, give) => guest.confirm(ground, gx, gy, deco, give);
  }

  /** May this page visit the world behind `code`? The beacon's own jumps
   *  were chosen here; a link from elsewhere is asked about once. */
  private joinApproved(code: string): boolean {
    const key = code.trim().toUpperCase();
    try {
      if (sessionStorage.getItem(JOIN_OK_KEY) === key) return true;
    } catch {
      // Storage blocked: ask.
    }
    if (!window.confirm(`Visit the world behind the code ${key}?\n\nWhoever holds that world will see your network address, as anyone you play with does.`)) return false;
    this.approveJoin(key);
    return true;
  }

  private approveJoin(code: string): void {
    try {
      sessionStorage.setItem(JOIN_OK_KEY, code.trim().toUpperCase());
    } catch {
      // Storage blocked: asked again on reload.
    }
  }

  /** Opens this player's world to friends, by a code to share. */
  private async openWorld(): Promise<void> {
    if (this.worldHost || this.worldGuest || this.worldBusy) return;
    this.worldBusy = true;
    this.worldError = '';
    this.beacon.refresh();
    try {
      const c = await this.loadCoop();
      const o = await c.openWorld(VISITORS + 1);
      this.worldHost = new this.coopMod!.WorldHost(o.session, this.worldGame, o.code, o.stop, !!this.playground);
      this.hud.notify(`Your world is open to friends. Its code: ${o.code}`);
    } catch (e) {
      console.warn('Could not open the world:', e);
      this.worldError = 'Your beacon could not reach the Drift. Check your connection, and try again.';
    } finally {
      this.worldBusy = false;
      this.beacon.refresh();
    }
  }

  /** Closes this player's world to visitors: they are sent home. */
  private closeWorld(): void {
    const h = this.worldHost;
    if (!h) return;
    this.worldHost = null;
    h.close();
    this.entityRenderer.syncPlayers(NO_PLAYERS);
    this.hud.notify('Your world is closed to visitors.');
    this.beacon.refresh();
  }

  /** May this player visit? Asked of the host, who says yes or no (no, after
   *  half a minute, or if the question is put away). */
  private askToVisit(name: string): Promise<boolean> {
    return new Promise((resolve) => {
      const dialog = this.living.dialog;
      const asked = performance.now();
      let done = false;
      const finish = (yes: boolean) => {
        if (done) return;
        done = true;
        clearInterval(watch);
        if (dialog.isOpen) dialog.close();
        resolve(yes);
      };
      dialog.talk('Drift Beacon', `${name} wants to visit your world.`, [
        { label: `${TOUCH ? '' : '1  '}Let them in`, action: () => finish(true) },
        { label: `${TOUCH ? '' : '2  '}Not now`, action: () => finish(false) },
      ]);
      this.audio.play('warn');
      const watch = setInterval(() => {
        if (!dialog.isOpen || performance.now() - asked > 30_000) finish(false);
      }, 250);
    });
  }

  /** Sets off to a friend's world by its code: this world is saved and left. */
  private visitWorld(typed: string): void {
    const code = typed.trim();
    if (!code || this.worldBusy || this.passage.active || this.trip || this.spawnTarget) return;
    if (this.worldHost) {
      this.worldError = 'Close your own world first: you cannot host friends while away.';
      this.beacon.refresh();
      return;
    }
    this.worldBusy = true;
    this.beacon.close();
    this.approveJoin(code);
    void this.save(false).finally(() => this.jump(() => (location.href = this.urlFor({ join: code }))));
  }

  /** Leaves a friend's world for home: the character is saved first. */
  private leaveVisit(notice?: string): void {
    const g = this.worldGuest;
    if (!g || this.worldBusy) return;
    this.worldBusy = true;
    this.beacon.close();
    // The character is saved as it is now: half way through a rift is no place to stop.
    this.passage.finish();
    clearTimeout(this.charSaveTimer);
    void this.save(false).finally(() => {
      g.leave();
      this.jump(() => this.goHome(notice));
    });
  }

  /** The visit is over (the host closed, sent this player home, or was lost). */
  private visitEnded(text: string): void {
    this.worldBusy = false;
    this.leaveVisit(text);
  }

  /** Back to this player's own world; `notice` is said once there. */
  private goHome(notice?: string): void {
    try {
      if (notice) sessionStorage.setItem(NOTICE_KEY, notice);
    } catch {
      // Storage blocked: home without a word.
    }
    location.href = this.urlFor({});
  }

  /** This page's address with these parameters (and ?net=local, if testing). */
  private urlFor(params: Record<string, string>): string {
    const q = new URLSearchParams(params);
    if (this.netLocal) q.set('net', 'local');
    const s = q.toString();
    return s ? `${location.pathname}?${s}` : location.pathname;
  }

  /** The beacon's jump to another world: the screen goes violet, then `then`. */
  private jump(then: () => void): void {
    const start = performance.now();
    this.audio.play('riftPull');
    const step = () => {
      const t = Math.min(1, (performance.now() - start) / JUMP_MS);
      const { width, height } = this.app.renderer;
      this.passageView.cover(width, height, t * t, PASSAGE_DARK, t);
      if (t < 1) requestAnimationFrame(step);
      else then();
    };
    step();
  }

  /** The dimension behind the nearest open rift, if one is close. */
  private riftAhead(): string | null {
    if (this.riftDistance >= PRELOAD_RANGE) return null;
    const rift = this.world.nearestRift(this.player.x, this.player.y);
    return rift ? this.destinationOf(rift) : null;
  }

  /** The network, loaded the first time it is needed. */
  private loadCoop(): Promise<Coop> {
    this.coopLib ??= import('../coop').then((m) => {
      this.coopMod = m;
      return new m.Coop(this.netLocal);
    });
    return this.coopLib;
  }

  /** Steps through a rift into the dimension behind it: its land is streamed
   *  and drawn like the overworld's, which waits, hidden, until the way back. */
  private enterRift(rift: WorldObject, layout: DimensionLayout): void {
    // The overworld's creatures wait here; another fight takes the combat.
    this.worldHost?.suspend();
    this.worldGuest?.suspend();
    // The rift's object id seeds what is random inside: rewards, roamers.
    const seed = hash(this.world.seed, hashString(rift.id));
    const def = dimensionById(layout.id)!;
    const tile = riftTile(rift);
    const land = new DimensionWorld(layout, seed, this.dimChunks);
    land.chunks.listener = this.dimTiles;
    const trip = new RiftTrip(def, land, seed, rift, riftDoorstep(rift), difficultyBand(tile.x, tile.y), this.combat, {
      event: (e) => this.tripEvent(e),
    });
    this.trip = trip;
    this.dimWorld = land;
    this.tripBag = this.inventory.save();
    trip.begin();
    this.meetPlot(layout, land);
    // Others behind the rift: this player joins (or holds open) their instance.
    const j = this.joining;
    this.joining = null;
    if (j?.result && this.coopMod) {
      this.coop = new this.coopMod.InstanceLink(j.result.session, this.coopGame, j.result.code, j.result.stop);
      // Friends in this world can follow.
      (this.worldHost ?? this.worldGuest)?.wentBehind(layout.id, j.result.code);
    } else if (j) {
      j.abandoned = true;
      this.hud.notify('No one answered the beacon. You go on alone.');
    }
    this.gathering.cancel();
    this.gathering.ground = land;
    this.gathering.bandAt = () => trip.band;
    this.player.swim = 0;
    this.living.outside = trip.outside;
    this.living.trip = trip;
    this.living.story.onEnter();
    // The overworld's sprites leave the scene until the player is back.
    this.stopGlitch();
    this.renderer.hideAll();
    this.buildings.update([], null, 0, 0);
    this.groundItems.update(0, [], NOWHERE);
    this.living.effects.clear();
    this.clearMarker();
    this.sites.open(trip.run);
    const a = layout.arrival;
    this.player.place(a.x, a.y);
    this.player.facing = 0;
    this.camera.snap(this.player.x * TILE_SIZE, this.player.y * TILE_SIZE);
    // Under the passage's cover: draw the land around the arrival at once.
    this.streamDimension();
    land.chunks.showPending();
    this.audio.play('rift');
    this.hud.notify(`You step through the rift into ${layout.name}...`);
  }

  /** Streams the dimension's chunks around the camera. */
  private streamDimension(): void {
    const land = this.dimWorld;
    if (!land) return;
    const { camera } = this;
    const { width, height } = this.app.renderer;
    const halfW = width / 2 / camera.zoom / TILE_SIZE;
    const halfH = height / 2 / camera.zoom / TILE_SIZE;
    const v = this.dimView;
    const cx = camera.x / TILE_SIZE;
    const cy = camera.y / TILE_SIZE;
    v.minX = cx - halfW;
    v.minY = cy - halfH;
    v.maxX = cx + halfW;
    v.maxY = cy + halfH;
    v.playerX = this.player.x;
    v.playerY = this.player.y;
    v.dirX = this.player.dirX;
    v.dirY = this.player.dirY;
    land.update(v);
  }

  /** Back out of the rift; `closed` when the portal closed it behind the player. */
  private exitRift(closed: boolean): void {
    const trip = this.trip;
    if (!trip) return;
    this.coop?.leave();
    this.coop = null;
    this.entityRenderer.syncPlayers(NO_PLAYERS);
    this.trip = null;
    this.tripBag = null;
    this.resident = null;
    this.dimNpcs.length = 0;
    this.dimMarks.clear();
    trip.end();
    // Back in the overworld's fight.
    this.worldHost?.resume();
    this.worldGuest?.resume();
    this.sites.close();
    this.dimWorld?.dispose();
    this.dimWorld = null;
    this.gathering.ground = this.world;
    this.gathering.bandAt = difficultyBand;
    this.living.outside = null;
    this.living.trip = null;
    this.living.effects.clear();
    this.gathering.cancel();
    this.clearMarker();
    this.player.place(trip.outside.x, trip.outside.y);
    this.player.facing = 0;
    this.camera.snap(this.player.x * TILE_SIZE, this.player.y * TILE_SIZE);
    this.audio.play('rift');
    if (!closed) return;
    this.world.closeRift(trip.rift);
    this.riftSealed(trip.layout, trip.def.closeXp);
    this.living.effects.burst(this.player.x, this.player.y - 1.5, 'magic', 30);
  }

  /** What closing a rift into `dimension` is worth: the player's share of
   *  its experience, and the story's next beat (the dimension counts as cleared). */
  private riftSealed(layout: DimensionLayout, xp: number): void {
    if (xp > 0) this.combat.grantXp(xp);
    this.living.story.onClosed(layout.id, layout.plot?.closing);
    this.audio.play('quest');
  }

  /** Dying behind a rift costs everything carried; what is worn stays. The
   *  rift throws the player back out, still open. */
  private riftDeath(): void {
    this.passageThrough('eject', this.trip!.rift);
  }

  // Passages through rifts --------------------------------------------------------

  /** Steps through a rift with a short passage: pulled in, covered, switched
   *  between the worlds once (`enterRift` / `exitRift`), then revealed. Input
   *  is locked and the world waits until it is over. */
  private passageThrough(kind: RiftPassage, rift: WorldObject): void {
    if (!this.passage.start(kind, REDUCED_MOTION)) return;
    const { player, camera } = this;
    const at = this.passageAt;
    at.rift = rift;
    at.burst = false;
    at.zoom = camera.zoom;
    at.fromX = player.x * TILE_SIZE;
    at.fromY = player.y * TILE_SIZE - BODY;
    at.toX = at.fromX;
    at.toY = at.fromY;
    const trip = this.trip;
    // On the way out, the dimension being left (closing it clears it).
    if (trip) at.layout = trip.layout;
    if (kind === 'enter') this.tearCentre(rift, at, 'to');
    else if (trip && kind !== 'eject') {
      // Into the arrival rift, or the portal home.
      const L = trip.run.layout;
      const i = kind === 'close' ? L.portal : L.rift;
      at.toX = ((i % L.w) + 0.5) * TILE_SIZE;
      at.toY = (Math.floor(i / L.w) + 1) * TILE_SIZE - (kind === 'close' ? 24 : TEAR_MID_UP);
    }
    this.gathering.cancel();
    this.stopGlitch();
    this.clearMarker();
    this.hud.setPrompt(null);
    player.sprite.pivot.set(0, -BODY);
    this.audio.play('riftPull');
    if (kind !== 'eject') this.living.effects.burst(at.toX / TILE_SIZE, at.toY / TILE_SIZE, 'magic', 16);
  }

  /** The middle of a rift's tear in the overworld, in world pixels. */
  private tearCentre(rift: WorldObject, at: { toX: number; toY: number; outX: number; outY: number }, which: 'to' | 'out'): void {
    const t = riftTile(rift);
    const x = (t.x + 0.5) * TILE_SIZE;
    const y = (t.y + 1) * TILE_SIZE - TEAR_MID_UP;
    if (which === 'to') {
      at.toX = x;
      at.toY = y;
    } else {
      at.outX = x;
      at.outY = y;
    }
  }

  /** Under full cover: into the dimension, or back out of it. */
  private passageSwitch(kind: RiftPassage): void {
    const at = this.passageAt;
    const rift = at.rift!;
    if (kind === 'enter') {
      this.enterRift(rift, at.layout!);
      at.layout = null;
      const L = this.trip!.run.layout;
      at.outX = ((L.rift % L.w) + 0.5) * TILE_SIZE;
      at.outY = (Math.floor(L.rift / L.w) + 1) * TILE_SIZE - TEAR_MID_UP;
    } else {
      if (kind === 'eject') this.inventory.clearCarried();
      // Closing waits for the reveal: the tear collapses in front of the player.
      this.exitRift(false);
      if (kind === 'eject') {
        this.vitals.revive();
        this.hud.alert('You collapse, and the rift throws you back out. The rift took everything you carried.');
      }
      this.tearCentre(rift, at, 'out');
    }
    this.camera.snap(at.outX, at.outY);
    this.living.effects.burst(at.outX / TILE_SIZE, at.outY / TILE_SIZE, 'magic', 20);
  }

  /** Closing: the player is out, and the tear behind them collapses. */
  private passageCollapse(): void {
    const rift = this.passageAt.rift!;
    this.world.closeRift(rift);
    const t = riftTile(rift);
    this.passageView.showGhost((t.x + 0.5) * TILE_SIZE, (t.y + 1) * TILE_SIZE);
    this.audio.play('riftClose');
  }

  /** Puts the player, camera and screen back as they were. */
  private passageDone(kind: RiftPassage): void {
    const { player } = this;
    const s = player.sprite;
    s.pivot.set(0, 0);
    s.scale.set(1);
    s.rotation = 0;
    s.alpha = 1;
    player.place(player.x, player.y);
    this.camera.zoom = this.passageAt.zoom;
    this.flare(0);
    this.slip(0, 0);
    this.passageView.hide();
    const rift = this.passageAt.rift;
    const left = this.passageAt.layout;
    this.passageAt.rift = null;
    this.passageAt.layout = null;
    if (kind === 'close' && rift && left) this.riftSealed(left, this.passageAt.xp);
    // Back out by the rift home once its Warden had fallen: the rift seals
    // anyway, so the same Warden and vault cannot be had again and again.
    if (kind === 'leave' && rift && left && this.passageAt.sealOnLeave) {
      this.passageAt.sealOnLeave = false;
      this.world.closeRift(rift);
      this.riftSealed(left, this.passageAt.xp);
      this.audio.play('riftClose');
      this.hud.notify('With its Warden gone, the rift seals behind you.');
    }
  }

  /** One frame of a passage: the player pulled in or emerging, the rift
   *  flaring, the camera leaning in, and the screen covered and uncovered. */
  private updatePassage(dt: number): void {
    const tr = this.passage;
    const j = this.joining;
    if (tr.holding && (!j || j.done || performance.now() - j.since > JOIN_WAIT_MS)) tr.holding = false;
    tr.update(dt);
    const kind = tr.kind;
    if (!kind) return;
    const { player, camera } = this;
    const at = this.passageAt;
    const flashes = this.settings.values.flashes;
    const still = tr.reduced;
    const color = flashes && !still ? PASSAGE_FLASH : PASSAGE_DARK;
    const { width, height } = this.app.renderer;
    // Where the body is, how big, turned and seen; how covered the screen is.
    let x: number;
    let y: number;
    let size = 1;
    let turn = 0;
    let seen = 1;
    let veil = 0;
    let edge = 0;
    let lean = 0;
    if (!tr.past) {
      const p = tr.pull;
      const e = p * p;
      if (still) {
        x = at.fromX;
        y = at.fromY;
        seen = 1 - p;
        veil = p;
      } else {
        x = at.fromX + (at.toX - at.fromX) * e;
        y = at.fromY + (at.toY - at.fromY) * e;
        size = 1 - 0.85 * e;
        turn = e * Math.PI * 4;
        seen = p < 0.7 ? 1 : 1 - (p - 0.7) / 0.3;
        veil = p < 0.5 ? 0 : ((p - 0.5) / 0.5) ** 1.5;
        edge = p;
        lean = e;
        // The colours slip twice as the rift takes hold.
        if (flashes) this.slip(p > 0.25 && p < 0.32 ? 0xa8fff4 : p > 0.5 && p < 0.56 ? 0xffb0e0 : 0, p > 0.25 && p < 0.32 ? 2 : -2);
      }
      if (kind === 'enter' || kind === 'leave') this.flare(still ? 0 : p);
    } else {
      const r = tr.reveal;
      const e = 1 - (1 - r) * (1 - r);
      const endX = player.x * TILE_SIZE;
      const endY = player.y * TILE_SIZE - BODY;
      if (still) {
        x = endX;
        y = endY;
        seen = r;
        veil = 1 - r;
      } else {
        x = at.outX + (endX - at.outX) * e;
        y = at.outY + (endY - at.outY) * e;
        size = 0.15 + 0.85 * e;
        turn = -(1 - e) * Math.PI * 2;
        seen = Math.min(1, r * 2.5);
        veil = (1 - r) ** 1.5;
        edge = 1 - r;
        lean = 1 - e;
        if (flashes) this.slip(r < 0.08 ? 0xd0a8ff : 0, -2);
      }
      this.flare(still ? 0 : 1 - r);
      if (tr.collapse > 0) {
        // The tear folds in on itself, then bursts.
        const c = tr.collapse;
        if (still) this.passageView.poseGhost(dt, 1, 1, 1 - c);
        else {
          const k = Math.min(1, c / 0.75);
          this.passageView.poseGhost(dt, (1 - k * k) * (1 + 0.2 * Math.sin(k * Math.PI)), 1 + 0.3 * k, 1);
        }
        if (c >= 0.75 && !at.burst) {
          at.burst = true;
          const t = riftTile(at.rift!);
          this.living.effects.burst(t.x + 0.5, t.y + 1 - TEAR_MID_UP / TILE_SIZE, 'magic', 30);
          this.living.effects.burst(t.x + 0.5, t.y + 0.8, 'dust', 12);
        }
        veil = flashes && !still && c >= 0.75 ? 0.55 * (1 - (c - 0.75) / 0.25) : 0;
        edge = 0;
      }
    }
    const s = player.sprite;
    s.position.set(Math.round(x), Math.round(y));
    s.scale.set(size);
    s.rotation = turn;
    s.alpha = Math.max(0, seen);
    camera.zoom = at.zoom * (1 + 0.25 * lean);
    camera.follow(x, y, dt);
    this.passageView.cover(width, height, veil, color, edge);
  }

  /** How hard rifts flare, in the overworld and the dimension alike (only one shows). */
  private flare(v: number): void {
    this.renderer.flare = v;
    this.dimTiles.flare = v;
  }

  /** The world's colours slip (0: back to normal) and tear sideways by `dx` pixels. */
  private slip(tint: number, dx: number): void {
    const color = tint || 0xffffff;
    if (this.worldLayer.tint !== color) this.worldLayer.tint = color;
    this.glitch.offset = tint ? dx : 0;
  }

  /** Acts on what the run reports; spawns and boss phases are the trip's own. */
  private tripEvent(e: DimEvent): void {
    const { player, hud, audio } = this;
    this.coop?.tripEvent(e);
    switch (e.type) {
      case 'claim':
        this.coop?.claim();
        break;
      case 'slip':
        player.place(e.x, e.y);
        this.camera.snap(player.x * TILE_SIZE, player.y * TILE_SIZE);
        hud.flashHurt();
        audio.play('hurt');
        if (this.vitals.hurt(e.damage)) this.collapse();
        break;
      case 'door':
        audio.play(e.open ? 'chest' : 'mine');
        break;
      case 'wave':
        if (e.wave > 1) hud.notify(`Wave ${e.wave} of ${e.of}`);
        break;
      case 'plate':
      case 'checkpoint':
        audio.play('pickup');
        break;
      case 'puzzleReset':
        audio.play('warn');
        break;
      case 'cleared':
        audio.play('level');
        break;
      case 'notice':
        hud.notify(e.text);
        break;
      case 'reward':
        // Others' shares are theirs to take.
        if (e.player !== LOCAL) break;
        for (const { item: id, count } of e.items) {
          const item = itemById(id);
          if (!item || count <= 0) continue;
          const left = this.inventory.add(item, count);
          if (count > left) hud.notify(`+${count - left} ${item.name}`);
          if (left > 0) this.overflow(item, left);
        }
        audio.play('chest');
        break;
      case 'closed':
        if (e.player !== LOCAL) break;
        // A killing blow the same moment counts first.
        if (this.vitals.health <= 0) {
          this.riftDeath();
          break;
        }
        this.passageAt.xp = e.xp;
        this.passageThrough('close', this.trip!.rift);
        break;
      case 'leave': {
        if (this.vitals.health <= 0) {
          this.riftDeath();
          break;
        }
        const trip = this.trip!;
        const seal = trip.portalOpen && trip.attuned;
        this.passageAt.sealOnLeave = seal;
        this.passageAt.xp = seal ? trip.run.share(LOCAL).xp : 0;
        if (!seal) hud.notify('You step back through the rift. It is still open.');
        this.passageThrough('leave', trip.rift);
        break;
      }
    }
  }

  /** `frozen`: a menu is open in a shared instance, which goes on around the
   *  player, who stands still. */
  private tickDimension(dt: number, frozen = false): void {
    const { player, input, camera } = this;
    const trip = this.trip!;
    // The overworld's clock, needs and villagers carry on, as indoors.
    this.living.updateIndoors(dt);
    this.checkLoad();
    if (!frozen) {
      this.blocking = input.holding('block') || input.mouseBlock || this.hud.blockHeld;
      const speed = (this.vitals.status.slow > 0 ? SLOW_FACTOR : 1) * (this.blocking ? BLOCK_SPEED : 1) * (this.overloaded ? OVERLOADED_SPEED : 1);
      this.dressPlayer();
      player.update(dt, input, trip, this.vitals.canRun && !this.blocking && !this.overloaded, speed);
      if (player.moving) this.gathering.cancel();
      this.gathering.update(dt);
      this.sounds(dt);
    } else {
      this.blocking = false;
      player.moving = player.running = false;
    }
    const body = this.body;
    body.x = player.x;
    body.y = player.y;
    body.faceX = player.faceX;
    body.faceY = player.faceY;
    body.blocking = this.blocking;
    body.invulnerable = player.invulnerable;
    this.combat.update(dt, body);
    trip.update(dt, player.x, player.y);
    this.coop?.update(dt);
    if (trip.ground.items.length && !frozen) {
      for (const st of trip.ground.update(player.x, player.y, this.inventory)) {
        this.hud.notify(`+${st.count} ${st.item.name}`);
        this.audio.play('pickup');
      }
    }
    // The run may have taken the player home, or begun to.
    if (this.trip !== trip || this.passage.active) return;
    camera.follow(player.x * TILE_SIZE, player.y * TILE_SIZE, dt);
    if (this.vitals.update(dt, player.running, undefined)) this.collapse();
  }

  /** `halfW`, `halfH`: half the view, in world pixels. */
  private renderDimension(dt: number, halfW: number, halfH: number): void {
    const trip = this.trip!;
    const { camera, player } = this;
    const minX = camera.x - halfW;
    const minY = camera.y - halfH;
    const maxX = camera.x + halfW;
    const maxY = camera.y + halfH;
    this.streamDimension();
    const tiles = this.dimTiles;
    tiles.cull(minX, minY, maxX, maxY);
    tiles.animate(dt);
    tiles.fadeAround(player.x * TILE_SIZE, player.y * TILE_SIZE);
    this.sites.update(minX, minY, maxX, maxY);
    this.updateDimensionTarget();
    const near = this.nearView;
    near.x0 = minX / TILE_SIZE - 2;
    near.y0 = minY / TILE_SIZE - 2;
    near.x1 = maxX / TILE_SIZE + 2;
    near.y1 = maxY / TILE_SIZE + 2;
    this.groundItems.update(dt, trip.ground.items, near);
    this.poseResident();
    this.entityRenderer.update(dt, this.combat.enemies, this.combat.projectiles, this.dimNpcs, this.dimMarks);
    this.entityRenderer.syncPlayers(this.coop?.players ?? NO_PLAYERS);
    const lights = this.roomLights;
    lights.length = 0;
    tiles.lights(lights);
    this.sites.lights(lights);
    const mood = trip.layout.mood;
    this.living.renderDimension(dt, lights, this.toScreen, camera.zoom, mood.darkness, mood.tint);
  }

  /** What E would do in a dimension: step back into the rift home, open the
   *  vault, read a lore stone, or gather, as outdoors. Marks it. */
  private updateDimensionTarget(): void {
    const { player, gathering } = this;
    const trip = this.trip!;
    const run = trip.run;
    const land = this.dimWorld!;
    this.clearMarker();
    this.target = null;
    if (this.blocking) {
      const a = Math.atan2(player.faceY, player.faceX);
      this.drawMarker().arc(player.x * TILE_SIZE, (player.y - 0.4) * TILE_SIZE, 11, a - 0.9, a + 0.9).stroke({ width: 2, color: 0xa8d8ff, alpha: 0.85 });
    }
    if (this.paused) {
      this.hud.setPrompt(null);
      return;
    }
    const [fx, fy] = player.frontTile();
    if (fy * trip.layout.w + fx === trip.layout.rift) {
      this.hud.setPrompt(trip.portalOpen && trip.attuned ? 'E  Step back through the rift (it seals behind you)' : 'E  Step back through the rift');
      return;
    }
    const resident = this.residentNear();
    if (resident) {
      this.hud.setPrompt(`E  Talk to ${resident.name}`);
      return;
    }
    const relic = this.relicAt(fx, fy);
    if (relic) {
      this.markTile(fx, fy, 0xffe28a);
      this.hud.setPrompt(`E  Take the ${relic.name}`);
      return;
    }
    if (run.canOpenChest(fx, fy)) {
      this.markTile(fx, fy, 0xfff2b0);
      this.hud.setPrompt('E  Open the vault');
      return;
    }
    const clue = land.decoAt(fx, fy) === Deco.LoreStone ? trip.clue(fx, fy) : undefined;
    if (clue) {
      this.markTile(fx, fy, 0xd8b0ff);
      this.hud.setPrompt(this.living.story.hasRead(trip.layout.id, clue.id) ? 'E  Read the stone again' : 'E  Read the stone');
      return;
    }
    const t = run.tileAt(fx, fy);
    if (t === DimTile.Chest) {
      this.hud.setPrompt(run.state(fx, fy) === 2 ? 'The vault is empty' : 'Sealed until the Warden falls');
      return;
    }
    if (t === DimTile.Portal) {
      this.hud.setPrompt(run.portalOpen ? 'Step into the portal to close the rift' : 'The portal is dormant');
      return;
    }
    if (t === DimTile.Gate && run.state(fx, fy) === 1) {
      this.hud.setPrompt(run.bossOpen ? 'The gate is sealed' : 'Sealed: break the three seals first');
      return;
    }
    this.target =
      interactionAt(land, this.inventory, this.vitals, fx, fy, this.gatherSpeed) ??
      interactionAt(land, this.inventory, this.vitals, Math.floor(player.x), Math.floor(player.y - 0.15), this.gatherSpeed);
    const busy = gathering.current;
    const g = busy ?? this.target;
    if (g) this.markTile(g.gx, g.gy, g.kind === 'locked' ? 0xe04a3a : 0xfff2b0);
    if (busy) {
      const x = busy.gx * TILE_SIZE;
      const y = busy.gy * TILE_SIZE - 6;
      this.drawMarker().rect(x, y, TILE_SIZE, 3).fill({ color: 0x3b2412 });
      this.drawMarker().rect(x, y, TILE_SIZE * gathering.progress, 3).fill({ color: 0x7ee07a });
      this.hud.setPrompt(`${busy.harvest.verb}…`);
    } else if (!this.target) this.hud.setPrompt(null);
    else if (this.target.kind === 'harvest') this.hud.setPrompt(`E  ${this.target.harvest.action}`);
    else if (this.target.kind === 'locked') this.hud.setPrompt(this.target.reason);
    else this.hud.setPrompt(PROMPTS[this.target.kind]);
  }

  /** Outlines a tile the player can act on. */
  private markTile(gx: number, gy: number, color: number): void {
    this.drawMarker().rect(gx * TILE_SIZE, gy * TILE_SIZE, TILE_SIZE, TILE_SIZE).stroke({ width: 1, color, alpha: 0.8 });
  }

  private interactDimension(): void {
    const trip = this.trip!;
    const [fx, fy] = this.player.frontTile();
    if (trip.run.interact(fx, fy)) {
      this.living.effects.burst(fx + 0.5, fy + 0.6, 'magic', 16);
      return;
    }
    if (this.residentNear()) {
      this.talkToResident();
      return;
    }
    const relic = this.relicAt(fx, fy);
    if (relic) {
      this.takeRelic(relic);
      return;
    }
    const clue = this.dimWorld?.decoAt(fx, fy) === Deco.LoreStone ? trip.clue(fx, fy) : undefined;
    if (clue) {
      if (this.living.story.readClue(trip.layout.id, clue)) {
        this.combat.grantXp(CLUE_XP);
        this.audio.play('quest');
      }
      this.living.effects.burst(fx + 0.5, fy, 'magic', 12);
      return;
    }
    if (this.target) this.gathering.begin(this.target);
  }

  // Outer worlds' plots ------------------------------------------------------------

  /** On arrival: the world's resident stands where it waits, and the relics
   *  this player has already found are gone from the land. */
  private meetPlot(layout: DimensionLayout, land: DimensionWorld): void {
    this.dimNpcs.length = 0;
    this.dimMarks.clear();
    this.resident = null;
    const plot = layout.plot;
    if (!plot) return;
    const r = plot.resident;
    const npc = new Npc('spirit', r.name, r.look, r.x + 0.5, r.y + 0.9, r.x + 0.5, r.y + 0.9);
    this.resident = npc;
    this.dimNpcs.push(npc);
    for (const relic of plot.relics) if (this.living.story.hasRelic(layout.id, relic.id)) land.harvest(relic.x, relic.y);
  }

  /** The resident turns to the player when near, and shows whether it has
   *  something to say: '!' before meeting, '✓' once the relics are all found. */
  private poseResident(): void {
    const npc = this.resident;
    const trip = this.trip;
    if (!npc || !trip?.layout.plot) return;
    const { player } = this;
    const dx = player.x - npc.x;
    const dy = player.y - npc.y;
    if (dx * dx + dy * dy < 36) npc.listen(player.x, player.y);
    const story = this.living.story;
    const plot = trip.layout.plot;
    const id = trip.layout.id;
    const mark = !story.plot(id).met ? '!' : story.canRestore(id, plot) ? '✓' : '';
    if (mark) {
      if (this.dimMarks.get(npc.id) !== mark) this.dimMarks.set(npc.id, mark);
    } else if (this.dimMarks.size) this.dimMarks.clear();
  }

  /** The resident, if the player is close enough to talk to them. */
  private residentNear(): Npc | null {
    const npc = this.resident;
    if (!npc) return null;
    const { player } = this;
    const dx = player.x - npc.x;
    const dy = player.y - npc.y;
    return dx * dx + dy * dy <= TALK_RANGE * TALK_RANGE ? npc : null;
  }

  /** The relic on a tile, if it is still there for this player. */
  private relicAt(gx: number, gy: number): PlotRelic | null {
    const trip = this.trip;
    const plot = trip?.layout.plot;
    if (!plot || this.dimWorld?.decoAt(gx, gy) !== Deco.Relic) return null;
    for (const r of plot.relics) if (r.x === gx && r.y === gy) return this.living.story.hasRelic(trip.layout.id, r.id) ? null : r;
    return null;
  }

  private takeRelic(relic: PlotRelic): void {
    const trip = this.trip!;
    const plot = trip.layout.plot!;
    if (!this.living.story.findRelic(trip.layout.id, relic.id)) return;
    this.dimWorld?.harvest(relic.x, relic.y);
    const found = this.living.story.relicsFound(trip.layout.id, plot);
    this.hud.notify(`Found the ${relic.name} (${found}/${plot.relics.length})`);
    if (found === plot.relics.length) this.hud.notify(`That is every piece. Bring them to ${plot.resident.name}.`);
    this.living.effects.burst(relic.x + 0.5, relic.y + 0.4, 'magic', 14);
    this.audio.play('quest');
  }

  /** A conversation with the resident, page by page; at the end of the last,
   *  with every relic found, the lost thing can be made whole. */
  private talkToResident(): void {
    const trip = this.trip!;
    const plot = trip.layout.plot!;
    const npc = this.resident!;
    const story = this.living.story;
    const id = trip.layout.id;
    const { pages, restore } = story.talk(id, plot);
    const dialog = this.living.dialog;
    npc.listen(this.player.x, this.player.y);
    const page = (k: number): void => {
      const last = k === pages.length - 1;
      const options = !last
        ? [{ label: `${TOUCH ? '' : '1  '}…`, action: () => page(k + 1) }]
        : restore
          ? [{ label: `${TOUCH ? '' : '1  '}Give back the pieces`, action: () => this.restorePlot() }]
          : [];
      dialog.talk(npc.name, pages[k], options);
    };
    page(0);
  }

  /** Every relic brought back: the lost thing is whole, its vision shows, and
   *  the resident gives what they promised. */
  private restorePlot(): void {
    this.living.dialog.close();
    const trip = this.trip;
    const plot = trip?.layout.plot;
    if (!trip || !plot || !this.living.story.restore(trip.layout.id, plot)) return;
    if (plot.reward.xp > 0) this.combat.grantXp(plot.reward.xp);
    for (const { item: itemId, count } of plot.reward.items) {
      const item = itemById(itemId);
      if (!item) continue;
      const left = this.inventory.add(item, count);
      if (count > left) this.hud.notify(`+${count - left} ${item.name}`);
      if (left > 0) this.overflow(item, left);
    }
    const npc = this.resident;
    if (npc) this.living.effects.burst(npc.x, npc.y - 1, 'magic', 30);
    this.audio.play('level');
  }

  /** Near an open rift the world glitches; nothing of it runs anywhere else. */
  private riftGlitch(dt: number): void {
    if (this.paused || this.spawnTarget || this.riftDistance >= GLITCH_RANGE) {
      this.stopGlitch();
      return;
    }
    this.glitching = true;
    this.glitch.update(dt, 1 - this.riftDistance / GLITCH_RANGE, this.riftAt.x, this.riftAt.y, Math.random, this.glitchTargets);
  }

  /** Puts back whatever a glitch has moved or tinted. */
  private stopGlitch(): void {
    if (!this.glitching) return;
    this.glitching = false;
    this.glitch.reset(this.glitchTargets);
    this.renderer.settle(Infinity);
  }

  /** Playground: into a dimension by the nearest rift, opening one beside the
   *  player if need be (once its map has loaded); then `then`. */
  private enterHollow(then?: () => void, shared = false, tuned?: string): void {
    if (this.trip) {
      // Into another world: leave this one first (the playground only).
      if (tuned && this.trip.layout.id !== tuned) {
        this.exitRift(false);
        this.enterHollow(then, shared, tuned);
        return;
      }
      then?.();
      return;
    }
    if (this.spawnTarget || this.passage.active) return;
    if (this.room) this.leave();
    const { player } = this;
    const near = this.world.nearestRift(player.x, player.y);
    const rift = near && Math.hypot(near.x - player.x, near.y - player.y) < 40 ? near : this.living.events.openRift({ x: player.x, y: player.y, now: this.living.time.total }, 3, 8);
    if (!rift) {
      this.hud.notify('No open ground for a rift here');
      return;
    }
    const id = tuned ?? this.destinationOf(rift);
    this.dimensions.load(id).then(
      (layout) => {
        if (this.trip || this.passage.active) return;
        // Shared: through the rift's passage, finding others behind it.
        if (shared) this.stepIntoRift(rift, id, true);
        else {
          this.enterRift(rift, layout);
          then?.();
        }
      },
      (e: unknown) => this.hud.notify(`The map of ${id} could not be loaded: ${e instanceof Error ? e.message : String(e)}`),
    );
  }

  /** Playground: on to the site of this kind; for the Warden and the vault,
   *  with what bars the way done. */
  private skipTo(kind: SiteKind): void {
    this.enterHollow(() => {
      const trip = this.trip;
      if (!trip) return;
      const i = trip.layout.sites.findIndex((s) => s.kind === kind);
      if (i < 0) return;
      trip.run.skipTo(i);
      const at = trip.layout.sites[i].entry;
      this.player.place(at.x, at.y);
      this.camera.snap(this.player.x * TILE_SIZE, this.player.y * TILE_SIZE);
    });
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
      }).catch(() => {});
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
    this.sleepOverlay.play(() => {
      this.living.rest(message);
      // Friends wake to the same morning.
      this.worldHost?.clockJumped();
    });
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

  /** Indoors with a menu open while friends are outdoors: the clock and the
   *  wild go on for them; this player stands still. */
  private tickIndoorsFrozen(dt: number): void {
    const room = this.room!;
    this.living.updateIndoors(dt);
    const b = this.doorBody;
    b.x = room.outside.x;
    b.y = room.outside.y;
    this.combat.update(dt, b);
  }

  private tickIndoors(dt: number): void {
    const { player, input } = this;
    const room = this.room!;
    this.living.updateIndoors(dt);
    // Friends outdoors: the wild goes on around them, this player safe behind the door.
    if (this.worldHost?.guestsOutdoors) {
      const b = this.doorBody;
      b.x = room.outside.x;
      b.y = room.outside.y;
      this.combat.update(dt, b);
    }
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
    // Friends in the same room.
    const here = this.interiorRenderer.room;
    this.entityRenderer.syncPlayers(this.visitors(), here);
    const room = this.room!;
    const lights = this.roomLights;
    lights.length = 0;
    this.interiorRenderer.lights(lights);
    // Daylight spills in from a mine's entrance.
    if (room.cave && room.floor === 0 && !this.living.time.isNight) {
      lights.push({ x: (room.exit.x + 0.5) * TILE_SIZE, y: room.exit.y * TILE_SIZE, radius: 3.5 * TILE_SIZE, warmth: 0 });
    }
    this.living.renderIndoors(dt, lights, this.toScreen, this.camera.zoom, room.cave);
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
    // As outdoors: clearing makes Pixi rebuild the draw list, so only when drawn.
    if (this.indoorMarkerDrawn) marker.clear();
    this.indoorMarkerDrawn = false;
    const busy = this.gathering.current;
    if (busy) {
      this.indoorMarkerDrawn = true;
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
      this.indoorMarkerDrawn = true;
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
    // A chest: opened once, and never refilled (friends visiting hear of it;
    // a visitor asks the host first).
    const id = room.chestId(t.x, t.y);
    const open = () => {
      this.world.openChest(room.object, id);
      this.gathering.give(rollChest(streamRng(Stream.Loot, this.world.seed, hashString(room.object.id), id), 1), 'The chest is empty');
      if (this.room === room) this.interiorRenderer.drawFurniture();
      this.audio.play('chest');
    };
    if (!this.worldGuest) open();
    else if (!this.worldGuest.claimChest(room.object, id, open)) this.hud.notify('The chest will not open');
  }

  private handleKeys(): void {
    const { input, camera, player } = this;
    if (input.hit('F3')) this.debug.toggle();
    if (input.hit('F4')) this.playground?.toggle();
    // Nothing else while passing through a rift.
    if (this.passage.active) return;
    if (input.act('bag')) this.menu.toggle();
    if (input.act('beacon') && !this.pause.isOpen) this.beacon.toggle();
    if (this.living.vision.isOpen && (input.hit('Space') || input.act('interact') || input.act('dodge') || input.hit('Enter'))) this.living.vision.next();
    if (input.hit('Escape')) {
      if (this.living.dialog.isOpen) this.living.dialog.close();
      else if (this.beacon.isOpen) this.beacon.close();
      else if (this.menu.isOpen) this.menu.close();
      else if (!this.living.vision.isOpen) this.pause.toggle();
    }
    if (input.act('map') && !this.pause.isOpen) {
      if (this.mapAvailable) this.menu.toggle('map');
      else this.hud.notify("Maps don't work here: the world won't hold still.");
    }
    if (input.hit('Save')) this.save(true);
    // A conversation's choices by number, as well as by click or tap.
    if (this.living.dialog.isOpen) for (let n = 0; n < DIGITS.length; n++) if (input.hit(DIGITS[n])) this.living.dialog.choose(n);
    if (this.paused) return;

    if (input.wheel) camera.zoomBy(input.wheel);
    if (input.act('zoomIn')) camera.zoomBy(-1);
    if (input.act('zoomOut')) camera.zoomBy(1);
    for (let n = 0; n < DIGITS.length; n++) if (input.hit(DIGITS[n])) this.hotbar.select(n);
    if (input.act('use')) this.useItem(this.hotbar.selected);
    if (input.act('drop')) this.drop(this.hotbar.selected);
    if (input.act('interact')) this.interact();
    if (input.act('attack') || input.mouseAttack) this.attack(input.mouseAttack);
    if (input.act('dodge')) this.dodge();
    if (import.meta.env.DEV && input.hit('KeyG') && !this.spawnTarget && this.place === this.outdoors) {
      this.home = { x: player.x, y: player.y };
      this.travel(player.x + FAR_TRIP, player.y);
    }
    if (import.meta.env.DEV && input.hit('KeyH') && this.home && !this.spawnTarget && this.place === this.outdoors) {
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
    if (this.riftObjectAt(px, py)) {
      this.hud.setPrompt('E  Enter the rift');
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

  private interact(): void {
    if (this.paused || this.spawnTarget || this.gathering.current) return;
    if (this.room) {
      this.interactIndoors();
      return;
    }
    if (this.trip) {
      this.interactDimension();
      return;
    }
    const [fx, fy] = this.player.frontTile();
    const door = this.doorAt(fx, fy);
    if (door) {
      this.enter(door.object, door.index);
      return;
    }
    const rift = this.riftObjectAt(fx, fy);
    if (rift) {
      this.approachRift(rift);
      return;
    }
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

  /** Maps only work inside the outer dimensions: the overworld won't hold
   *  still long enough to be drawn. */
  private get mapAvailable(): boolean {
    return !!this.trip;
  }

  private get capacity(): number {
    return CARRY_BASE + CARRY_PER_RANK * this.progression.rank('packMule');
  }

  /** Too much in the bag slows the player down. */
  private checkLoad(): void {
    const over = this.inventory.weight() > this.capacity;
    if (over === this.overloaded) return;
    this.overloaded = over;
    this.hud.notify(over ? `Your bag is too heavy: drop something (${TOUCH ? 'Bag → Drop' : keyName(this.input.keys.drop[0])}) to move freely` : 'Your load feels lighter');
  }

  /** Drops a whole stack at the player's feet. */
  private drop(slot: number): void {
    if (this.spawnTarget) return;
    if (this.place !== this.outdoors) {
      this.hud.notify("You can't drop things here");
      return;
    }
    const stack = this.inventory.takeSlot(slot);
    if (!stack) return;
    const { player } = this;
    this.putDown(stack, player.x + player.faceX * 0.5, player.y + player.faceY * 0.5);
    this.hud.notify(`Dropped ${stack.count} ${stack.item.name}`);
  }

  /** Puts a stack on the ground: this world's, or (visiting) the host's. */
  private putDown(stack: Stack, x: number, y: number): void {
    if (this.worldGuest) this.worldGuest.drop(stack, x, y);
    else this.world.ground.drop(stack, x, y);
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
    if (s.item === Items.driftBeacon) {
      this.beacon.open();
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
    // Seeded by the world and how many recipes are known, like the rest of the loot.
    const r = streamRng(Stream.Loot, this.world.seed, hashString('schematic'), this.progression.recipes.size).pick(unknown);
    this.progression.recipes.add(r.output.id);
    this.audio.play('level');
    const where = r.station === 'hand' ? 'by hand' : `at ${r.station === 'anvil' ? 'an' : 'a'} ${STATION_NAMES[r.station].toLowerCase()}`;
    this.hud.alert(`You learned to make the ${r.output.name}, ${where}.`);
  }

  private stations(): Set<Station> {
    const set = new Set<Station>(['hand']);
    // Nothing behind a rift to work at.
    if (this.trip) return set;
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

  /** Story playground: a fresh world with a panel of test tools. */
  private startPlayground(ui: HTMLElement): void {
    this.playground = new Playground(ui, {
      goToSpawn: () => this.teleport(0, 0),
      setHour: (hour) => (this.living.time.minutes = hour * 60),
      restart: () => (location.href = `${location.pathname}?playground=${this.world.seed}`),
      riftNearby: () => {
        if (this.place !== this.outdoors || this.spawnTarget) return;
        const o = this.living.events.openRift({ x: this.player.x, y: this.player.y, now: this.living.time.total }, 4, 9);
        this.hud.notify(o ? 'A rift tears open nearby.' : 'No open ground for a rift here');
      },
      enterHollow: (id) => this.enterHollow(undefined, false, id),
      enterHollowShared: () => this.enterHollow(undefined, true),
      skipTo: (kind) => this.skipTo(kind),
      clearAll: () => {
        for (const d of DIMENSIONS) this.living.story.cleared.add(d.id);
        this.hud.notify('Every outer world counts as cleared: rifts can be retuned.');
      },
    });
  }

  private teleport(x: number, y: number): void {
    if (this.passage.active) return;
    if (this.room) this.leave();
    this.exitRift(false);
    this.gathering.cancel();
    this.travel(x, y);
  }

  /** Health ran out: wake up back at the start, keeping your things. */
  private collapse(): void {
    if (this.trip) {
      this.riftDeath();
      return;
    }
    // Visiting: wake beside the host.
    if (this.worldGuest) {
      if (this.room) this.leave();
      this.gathering.cancel();
      this.vitals.revive();
      const at = this.worldGuest.hostSpot();
      this.hud.alert(`You collapsed… and wake beside ${this.worldGuest.hostName}.`);
      this.travel(at.x + 1, at.y);
      return;
    }
    if (this.room) this.leave();
    this.gathering.cancel();
    this.vitals.revive();
    const { x, y } = this.respawn;
    this.hud.alert(x || y ? 'You collapsed… and wake up where you last rested.' : 'You collapsed… and wake up back at the start.');
    this.travel(x, y);
  }

  /** What does not fit in the bag is left on the ground, outside if indoors or behind a rift. */
  private overflow(item: ItemDef, count: number): void {
    // Behind a rift it stays behind the rift, at the player's feet, lost with the trip.
    if (this.trip) {
      this.trip.ground.drop({ item, count }, this.player.x, this.player.y);
      this.hud.notify(`Bag full: ${count} ${item.name} left on the ground`);
      return;
    }
    const at = this.place.spot;
    this.putDown({ item, count }, at.x, at.y);
    const where = this.room ? ' outside' : '';
    this.hud.notify(`Bag full: ${count} ${item.name} left on the ground${where}`);
  }

  /** What a save keeps of the bag. Behind a rift, what was carried in (what
   *  was found inside is the rift's until the player is out), or, in danger,
   *  nothing but what is bound to the player: as if they had died there. */
  private carriedForSave(): SavedSlot[] {
    const bag = this.tripBag;
    if (!this.trip || !bag) return this.inventory.save();
    if (!this.inDanger()) return bag;
    return bag.map((s) => (s && itemById(s.id)?.bound ? s : null));
  }

  /** Hurt badly, or hunted: no time to be saving one's way out. */
  private inDanger(): boolean {
    const v = this.vitals;
    if (v.health < v.maxHealth * SAFE_HEALTH) return true;
    const { x, y } = this.player;
    for (const e of this.combat.enemies) {
      if ((e.state === 'chase' || e.state === 'attack') && (e.x - x) ** 2 + (e.y - y) ** 2 < DANGER_RANGE * DANGER_RANGE) return true;
    }
    return false;
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
    const at = this.place.spot;
    this.respawn = { x: at.x, y: at.y };
  }

  /** Saves the game; resolves once stored (or at once, if it is not saved). */
  private save(manual: boolean): Promise<void> {
    const done = Promise.resolve();
    if (this.playground) {
      if (manual) this.hud.notify('The story playground is never saved');
      return done;
    }
    if (this.visitUnsaved) {
      if (manual) this.hud.notify('This test world is never saved');
      return done;
    }
    if (this.saveLock) {
      if (manual) this.hud.alert(this.saveLock);
      return done;
    }
    // Half way through a rift, the player is in neither world.
    if (this.passage.active) {
      if (manual) this.hud.notify('Cannot save while passing through a rift');
      return done;
    }
    // Visiting: only the character is saved, into this player's own save; the
    // world they left is kept as it was. It holds no position, so travelling
    // (waking after a collapse) or a vision does not stop it.
    if (this.worldGuest) {
      const data = characterSave(
        this.ownSave,
        {
          inventory: this.carriedForSave(),
          equipment: this.inventory.saveEquipment(),
          vitals: this.vitals.save(),
          progression: this.progression.save(),
          story: this.living.story.save(),
          quests: this.living.quests.save(),
        },
        this.homeSeed,
      );
      this.ownSave = data;
      return this.stored(this.saves.save(data), manual);
    }
    // A vision may be half way through changing the story: save after it.
    if (this.living.vision.isOpen) {
      if (manual) this.hud.notify('Cannot save during a vision');
      return done;
    }
    if (this.spawnTarget) {
      if (manual) this.hud.notify('Cannot save while travelling');
      return done;
    }
    // Indoors, the save keeps the spot outside the door; in a dimension, the
    // spot outside the rift (the run itself is not kept).
    const at = this.place.spot;
    return this.stored(
      this.saves.save(
        snapshot(this.world, {
          x: at.x,
          y: at.y,
          inventory: this.carriedForSave(),
          equipment: this.inventory.saveEquipment(),
          vitals: this.vitals.save(),
          progression: this.progression.save(),
          respawn: { ...this.respawn },
          // A Moonwell's id holds its region's visit: once that drifts, the well is new.
          moonwells: this.world.liveMemory(this.usedMoonwells),
        }, this.living.save(), this.exploration.save()),
      ),
      manual,
    );
  }

  /** Says how a save went. */
  private stored(saving: Promise<void>, manual: boolean): Promise<void> {
    return saving
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
    const intro = this.intro.play();
    this.intro = null;
    if (this.storyIntro) void intro.then(() => this.living.story.intro());
  }

  private travel(x: number, y: number): void {
    this.spawnTarget = { x: clampTile(x), y: clampTile(y) };
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
        ? 'Drag on the left half to move; tap to talk, gather and open. The compass (top left) shows where you are.'
        : `${k('up')}${k('left')}${k('down')}${k('right')} to move, ${k('interact')} to talk, gather and open. The compass (top left) shows where you are.`) ||
      h.once('enemy', !this.room && this.combat.enemies.some((e) => e.state === 'chase' || e.state === 'attack'), TOUCH
        ? 'An enemy! Hit attacks the nearest one, hold Block to block, Roll to dodge.'
        : `An enemy! Click or ${k('attack')} to attack, hold right-click or ${k('block')} to block, ${k('dodge')} to roll away.`) ||
      h.once('hungry', vitals.hunger < 50, `You're getting hungry. Pick berries or cook meat at a campfire, then ${TOUCH ? 'tap its hotbar slot twice' : `select it and press ${k('use')}`} to eat.`) ||
      h.once('thirsty', vitals.thirst < 50, `Thirsty? Face water and ${act} to drink.`) ||
      h.once('night', this.living.time.isNight, `Night is dark and dangerous. ${act === 'tap' ? 'Tap' : `Press ${act}`} at a campfire to sleep until morning; you also wake there if you collapse.`) ||
      h.once('campfire', stations.has('campfire'), 'A campfire: cook food here from the Crafting tab of the Bag.') ||
      h.once('anvil', stations.has('anvil'), 'An anvil: forge tools, weapons and armour here from the Crafting tab.') ||
      h.once('skill', this.progression.skillPoints > 0, 'You have a skill point: spend it in the Skills tab of the Bag.') ||
      h.once('heavy', this.overloaded, 'Your bag is too heavy and slows you down: drop or sell things.') ||
      h.once('rift', this.riftDistance < 10, `A rift! Face it and ${act === 'tap' ? 'tap' : `press ${act}`} to step through. Fall on the other side and you lose everything you carry; what you wear stays.`) ||
      h.once('hollow', !!this.trip, `Maps work in here: open the Map tab (${TOUCH ? 'Bag, then Map' : k('map')}). Break the three seals, then face the Warden to open the way home. Lore stones tell what happened here.`)
    );
  }

  private updateUi(): void {
    const { world } = this;
    // Indoors and in a dimension, everything is measured from the door or rift outside.
    const player = this.place.spot;
    const gx = Math.floor(player.x);
    const gy = Math.floor(player.y);
    const biome = world.biomeAt(gx, gy);
    const floor = this.room?.floorName ? ` · ${this.room.floorName}` : '';
    const trip = this.trip;
    const where = trip?.placeAt(this.player.x, this.player.y);
    const place = this.room ? `Inside · ${this.room.object.name}${floor}` : trip ? `${trip.name}${where ? ` · ${where}` : ''}` : biome ? biomeName(biome) : '…';
    this.hud.setLocation(place, DIFFICULTY_BANDS[difficultyBand(gx, gy)].name, gx, gy);
    this.hud.setClock(this.living.time.label(), this.living.effect.label);
    // The nearest open rift: the story's arrow, and the glitches near it.
    const rift = this.place === this.outdoors ? world.nearestRift(player.x, player.y) : null;
    if (rift) {
      const t = riftTile(rift);
      this.riftAt.x = t.x;
      this.riftAt.y = t.y;
      this.riftDistance = Math.hypot(t.x + 0.5 - player.x, t.y + 0.5 - player.y);
      // The map behind it loads before the player gets there.
      if (this.riftDistance < PRELOAD_RANGE) {
        this.dimensions.preload(this.destinationOf(rift));
        // And those it could be tuned to.
        for (const id of this.living.story.cleared) this.dimensions.preload(id);
      }
    } else this.riftDistance = Infinity;
    const lines = this.living.tracker();
    const marker = this.exploration.trackedMarker;
    if (marker) lines.push({ text: marker.label, angle: Math.atan2(marker.y - player.y, marker.x - player.x) });
    this.hud.setTracker(lines);
    // The compass points at the tracked marker, else at the story's objective
    // (a rift); it always shows where the player is.
    const goal = marker ? Math.atan2(marker.y - player.y, marker.x - player.x) : (lines[0]?.angle ?? null);
    this.hud.setCompass(goal, marker ? `${gx}, ${gy} · ${marker.label}` : `${gx}, ${gy}`);
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
