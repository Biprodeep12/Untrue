# Saves

What a save holds, where it lives, and how older saves are upgraded.

## What is saved

Saves stay small because most of the world is never stored: terrain, biomes, ordinary structures, decorations and enemies all regenerate from the seed.

| Saved | Not saved |
| --- | --- |
| World seed | Terrain and decorations |
| Player position, inventory (with weapon durability), worn equipment, vitals, level, XP and skill ranks | Biome records |
| Where the player wakes after collapsing (`respawn`) and the Moonwells already drunk from | Semi-persistent objects not yet discovered |
| Legends defeated (`trophies`) and rare recipes learned (`recipes`), inside progression | |
| Every persistent object, with its full layout, buildings, discovered flag, anchor and opened chests | Temporary objects (they regenerate) |
| Semi-persistent objects the world is keeping (discovered villages, castles, mines and nomad camps), with the minute they were last left | |
| Anchors whose chests were looted (`lootedAnchors`) | Enemies, projectiles, NPCs and fires |
| Dungeons, arenas and legendary spots that were cleared (`clearedAnchors`) | |
| Region visit counters, so regions come back as the player left them | |
| The harvest log, so gathered plants stay gathered until they regrow | |
| Clock, per-biome weather and quests | |
| Story stage, flags, ending and lantern memories | |
| Explored chunks and map markers | |

Lost travellers from rescue quests are not saved as NPCs; their position lives in the quest record and they reappear when their spot is simulated.

## Format

`SaveData` (`src/save/SaveManager.ts`):

```ts
interface SaveData {
  version: number;        // SAVE_VERSION, currently 7
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
  objects: SavedObject[];  // persistent objects, and semi-persistent ones being kept:
                           // id, kind, name, persistence, x, y, w, h,
                           // tiles, decos (Uint8Array), discovered, anchor, opened[],
                           // buildings (building specs), idleSince (semi-persistent)
  lootedAnchors: string[];
  clearedAnchors: string[];
  living: {                // null in saves from before the living world
    time: { day, minutes };
    weather: Record<biome, { kind, hoursLeft }>;
    quests: Quest[];
    story?: { stage, flags, ending, memories };  // missing before the story
  } | null;
  exploration: {           // null before the map existed
    explored: number[];    // flat pairs: chunk key, biome palette + 1
    markers: { id, x, y, label }[];
    tracked: number | null;
  } | null;
  regions: number[];       // flat pairs: region key, visit counter (only counters above 0)
  harvested: { key, visit, cells: number[] }[];  // per chunk: flat triples of cell, decoration, minute
  ground: { id, count, durability?, x, y }[];      // items dropped on the ground
  known?: { id, name, x, y, w, h, story }[];       // discovered places, for the map
}
```

`snapshot(world, player, living, exploration)` builds it; `restore(world, data)` puts the saved objects, looted anchors and cleared anchors back into a fresh world built from the same seed. `Game` restores inventory, equipment, progression, vitals, the waking spot and the used Moonwells, and `LivingWorld.load` restores the clock, weather, quests and story.

Fields marked `?` are missing in older saves and load with defaults: the best armour carried is put on, there are no skills, trophies or recipes, the player wakes at the start, and no Moonwell has been used.

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

A save without `living.story` starts the story from the prologue.

## Saves that cannot be read

The game never lets a new world overwrite a save it could not use (`SaveManager.load()`, `Game.start()`):

| Problem | What happens |
| --- | --- |
| The stored save has an unknown or newer version, or is malformed | It is copied to a backup key (`backup-<time>`) in the same store and `UnreadableSave` is thrown. The game starts a new world and shows an alert saying the old save was kept. |
| Storage fails to read at all | A save may exist, so this session does not save (`saveLock`). An alert says to reload. |
| The living-world part (story, quests, clock) fails to load | The rest of the save loads and the living world starts afresh. The old save is backed up and an alert says so. |

Alerts (`Hud.alert`) stay on screen until the player presses OK.

## Storage

- IndexedDB database `untrue`, object store `saves`, one slot with key `main`.
- Autosave every 30 seconds, and whenever the page is hidden (tab switch or minimise).
- Ctrl+S saves now and confirms with a notification.
- Nothing is saved while the player is travelling (waiting to be placed after a jump or a collapse), or while a story vision is open, since a vision may be half way through changing the story.
- A write counts as done once its IndexedDB transaction completes, not when the request succeeds.
- `?new` or `?seed=N` starts a fresh world; its first autosave replaces the slot.

## Two tabs

Two tabs would save over the same slot. The first tab takes a Web Lock (`navigator.locks`, lock `untrue-save`) and holds it until it closes. A later tab cannot get the lock, so it plays without saving and shows an alert. Where Web Locks are missing, a `BroadcastChannel` named `untrue` does the same: a new tab says hello, and if an open tab answers, the new tab stops saving. The story playground never saves, so it does not take the lock.

## Settings and tips

Settings are separate: they live in `localStorage` under `untrue.settings` (`lighting`, `weather`, `particles`, `fps30`, `flashes`, `help`, `music`, `sfx`, `uiScale`, `keys`), per browser, and fall back to defaults if storage is blocked. First-time tips already shown are kept under `untrue.hints` (`src/ui/Hints.ts`).

The pause menu's "New world" clears the save slot and reloads with `?new`.

See also: [Objects and structures](objects-and-structures.md), [Architecture](architecture.md)
