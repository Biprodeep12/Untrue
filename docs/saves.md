# Saves

What a save holds, where it lives, and how older saves are upgraded.

## What is saved

Saves stay small because most of the world is never stored: terrain, biomes, ordinary structures, decorations and enemies all regenerate from the seed.

| Saved | Not saved |
| --- | --- |
| World seed | Terrain and decorations |
| Player position, inventory (with weapon durability), vitals, level and XP | Biome records |
| Every persistent object, with its full layout, buildings, discovered flag, anchor and opened chests | Temporary objects (they regenerate) |
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
    vitals: VitalValues | null;          // health, stamina, hunger, thirst
    progression: ProgressionSave | null; // xp, level
  };
  objects: SavedObject[];  // persistent objects: id, kind, name, persistence, x, y, w, h,
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

`snapshot(world, player, living, exploration)` builds it; `restore(world, data)` puts the persistent objects, looted anchors and cleared anchors back into a fresh world built from the same seed. `Game` restores inventory, progression and vitals, and `LivingWorld.load` restores the clock, weather, quests and story.

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

A save without `living.story` starts the story from the prologue. Unknown versions load as no save.

## Storage

- IndexedDB database `untrue`, object store `saves`, one slot with key `main`.
- Autosave every 30 seconds, and whenever the page is hidden (tab switch or minimise).
- Ctrl+S saves now and confirms with a notification.
- Nothing is saved while the player is travelling (waiting to be placed after a jump or a collapse).
- `?new` or `?seed=N` starts a fresh world; its first autosave replaces the slot.

Settings are separate: they live in `localStorage` under `untrue.settings` (`lighting`, `weather`, `fps30`, `help`, `music`, `sfx`), per browser, and fall back to defaults if storage is blocked.

The pause menu's "New world" clears the save slot and reloads with `?new`.

See also: [Objects and structures](objects-and-structures.md), [Architecture](architecture.md)
