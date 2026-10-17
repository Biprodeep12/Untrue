# Saves

What a save holds, where it lives, and how older saves are upgraded.

## What is saved

Saves stay small because the world itself is never stored: terrain, biomes, every structure, decorations and enemies all regenerate from the seed.

| Saved | Not saved |
| --- | --- |
| World seed | Terrain and decorations |
| Player position, inventory (with weapon durability), worn equipment, vitals, level, XP and skill ranks | Biome records |
| Where the player wakes after collapsing (`respawn`) and the Moonwells already drunk from | World objects: every structure, rare or not (they regenerate) |
| Legends defeated (`trophies`) and rare recipes learned (`recipes`), inside progression | |
| Anchors whose chests were looted (`lootedAnchors`) | Enemies, projectiles, NPCs and fires |
| Dungeons, arenas and legendary spots that were cleared, and closed rifts by object id (`clearedAnchors`) | A trip into an outer dimension: its run, enemies and map |
| Region visit counters, so regions come back as the player left them | |
| The harvest log, so gathered plants stay gathered until they regrow | |
| Clock, per-biome weather and quests | |
| The rift story: rifts closed, and whether the player has entered one | |
| Explored chunks and map markers | |

Lost travellers from rescue quests are not saved as NPCs; their position lives in the quest record and they reappear when their spot is simulated.

## Format

`SaveData` (`src/save/SaveManager.ts`):

```ts
interface SaveData {
  version: number;        // SAVE_VERSION, currently 8
  seed: number;
  savedAt: number;        // Date.now()
  player: {
    x: number; y: number;
    inventory: SavedSlot[];              // { id, count, durability? } or null, 24 slots
    equipment?: Partial<Record<EquipSlot, SavedSlot>>;  // head, chest, legs, feet, offhand
    vitals: VitalValues | null;          // health, stamina, hunger, thirst
    progression: ProgressionSave | null; // xp, level, skills?, trophies?, recipes?
    respawn?: { x, y };                  // where the player wakes after collapsing
    moonwells?: string[];                // ids of Moonwells already drunk from
  };
  lootedAnchors: string[];
  clearedAnchors: string[];
  living: {                // null in saves from before the living world
    time: { day, minutes };
    weather: Record<biome, { kind, hoursLeft }>;
    quests: Quest[];
    rift?: { version: 1, closed: number, entered: boolean };  // the story; missing before it
  } | null;
  exploration: {           // null before the map existed
    explored: number[];    // flat pairs: chunk key, biome palette + 1
    markers: { id, x, y, label }[];
    tracked: number | null;
  } | null;
  regions: number[];       // flat pairs: region key, visit counter (only counters above 0)
  harvested: { key, visit, cells: number[] }[];  // per chunk: flat triples of cell, decoration, minute
  ground: { id, count, durability?, x, y }[];      // items dropped on the ground
}
```

`snapshot(world, player, living, exploration)` builds it; `restore(world, data)` puts the looted and cleared anchors, region visits, harvest log and ground items back into a fresh world built from the same seed. `Game` restores inventory, equipment, progression, vitals, the waking spot and the used Moonwells, and `LivingWorld.load` restores the clock, weather, quests and the rift story.

Fields marked `?` are missing in older saves and load with defaults: the best armour carried is put on, there are no skills, trophies or recipes, the player wakes at the start, no Moonwell has been used, and the story starts at "Find a rift" with no rifts closed (and without the opening vision, which only a new world shows). The rift story is an optional field, so it needed no new save version.

**Saving in a dimension.** As indoors, the save keeps the player's spot in the overworld: the doorstep outside the rift (`Place.spot`). Nothing of the trip is saved, so a reload starts outside the rift with the run's progress gone. A rift from a world event is not saved either, so after a reload it may not be there.

## Versions

`migrate()` upgrades older saves one step at a time:

| From | Change |
| --- | --- |
| 1 | Adds an empty inventory, `vitals: null`, `progression: null`, `anchor: ''` and `opened: []` on objects, and `lootedAnchors: []`. |
| 2 | Adds `progression: null` and `clearedAnchors: []`. |
| 3 | Adds `living: null`. |
| 4 | Adds `exploration: null`. |
| 5 | Adds `buildings: []` to every object, `regions: []` and `harvested: []`. |
| 6 | Adds `ground: []`. |
| 7 | Every structure now forgets and the old story is gone: drops `objects` (persistent places, story places and kept villages, castles, mines and nomad camps), `known` (the register of discovered places) and `living.story` (the stage, flags, ending, whose world rules go with it, and the lantern memories). The Wanderer's Lantern, in the bag, the hotbar or the off hand, becomes an ordinary Lantern, so the player keeps a light that never burns out. |

The version 1 and 5 steps still fill in fields on an old save's `objects`; the version 7 step then drops them.

## Saves that cannot be read

The game never lets a new world overwrite a save it could not use (`SaveManager.load()`, `Game.start()`):

| Problem | What happens |
| --- | --- |
| The stored save has an unknown or newer version, or is malformed | It is copied to a backup key (`backup-<time>`) in the same store and `UnreadableSave` is thrown. The game starts a new world and shows an alert saying the old save was kept. |
| Storage fails to read at all | A save may exist, so this session does not save (`saveLock`). An alert says to reload. |
| The living-world part (quests, weather, clock) fails to load | The rest of the save loads and the living world starts afresh. The old save is backed up and an alert says so. |

Alerts (`Hud.alert`) stay on screen until the player presses OK.

## Storage

- IndexedDB database `untrue`, object store `saves`, one slot with key `main`.
- Autosave every 30 seconds, and whenever the page is hidden (tab switch or minimise).
- Ctrl+S saves now and confirms with a notification.
- Nothing is saved while the player is travelling (waiting to be placed after a jump or a collapse), or while a vision is open, since a story may be half way through a change.
- A write counts as done once its IndexedDB transaction completes, not when the request succeeds.
- `?new` or `?seed=N` starts a fresh world; its first autosave replaces the slot.

## Two tabs

Two tabs would save over the same slot. The first tab takes a Web Lock (`navigator.locks`, lock `untrue-save`) and holds it until it closes. A later tab cannot get the lock, so it plays without saving and shows an alert. Where Web Locks are missing, a `BroadcastChannel` named `untrue` does the same: a new tab says hello, and if an open tab answers, the new tab stops saving. The story playground never saves, so it does not take the lock.

## Settings and tips

Settings are separate: they live in `localStorage` under `untrue.settings` (`lighting`, `weather`, `particles`, `fps30`, `flashes`, `help`, `music`, `sfx`, `uiScale`, `keys`), per browser, and fall back to defaults if storage is blocked. First-time tips already shown are kept under `untrue.hints` (`src/ui/Hints.ts`).

The pause menu's "New world" clears the save slot and reloads with `?new`.

See also: [Objects and structures](objects-and-structures.md), [Architecture](architecture.md)
