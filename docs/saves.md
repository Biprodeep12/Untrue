# Saves

What a save holds, where it lives, and how older saves are upgraded.

## What is saved

Saves stay small because the world itself is never stored: terrain, biomes, every structure, decorations and enemies all regenerate from the seed.

| Saved | Not saved |
| --- | --- |
| World seed | Terrain and decorations |
| Player position, inventory (with weapon durability), worn equipment, vitals, level, XP and skill ranks | Biome records |
| Where the player wakes after collapsing (`respawn`) and the Moonwells already drunk from (while their region stands) | World objects: every structure, rare or not (they regenerate) |
| Legends defeated (`trophies`) and rare recipes learned (`recipes`), inside progression | |
| Anchors whose chests were looted, per region visit (`lootedAnchors`) | Enemies, projectiles, NPCs and fires |
| Dungeons, arenas and legendary spots cleared, per region visit, and closed rifts by object id (`clearedAnchors`) | A trip into an outer dimension: its run, enemies and map |
| Region visit counters, so regions come back as the player left them | Anything remembered of a region that has since drifted |
| The harvest log, so gathered plants stay gathered until they regrow | |
| Clock, per-biome weather and quests | |
| The rift story: rifts closed, dimensions cleared, whether the player has entered one, the lore stones read per dimension, and each outer world's plot progress | |
| Explored chunks and map markers | |

Lost travellers from rescue quests are not saved as NPCs; their position lives in the quest record and they reappear when their spot is simulated.

### Visiting a friend's world

While visiting a friend's world (by its code on the Drift Beacon: [multiplayer-plan.md](multiplayer-plan.md#overworld-by-invite)), the world is theirs and their machine saves it. The visitor's game saves only their **character** into their own save (`characterSave` in `src/save/SaveManager.ts`): bag, worn gear, vitals, level and skills, their quests (so one handed in while visiting stays handed in), and their rift story (rifts closed, dimensions cleared, lore read). Everything else in the save stays as they left it: their world's seed, where they stood in it, their waking spot, regions, ground, chests, harvest, clock, weather and map. The character is saved a second after anything is given or put down, and when the visit ends (a passage under way is finished first; travelling after a collapse or a vision does not stop it, since the character holds no position). So they come home to their own world exactly where they left it, carrying what they gained. A visitor with no save of their own gets a fresh world to come home to. Visiting a host's test world (the playground) saves nothing.

## The Drift

A region (8 × 8 chunks) regenerates once its last chunk leaves the cache area: its visit counter rises, and every roll in it comes out differently ([world-streaming.md](world-streaming.md)). What the world remembers of a place is kept for one visit of its region, and drifts with it ([story.md](story.md#the-canon)):

| Remembered | Kept as | Forgotten when |
| --- | --- | --- |
| A looted chest | `cx,cy/slot#visit` in `lootedAnchors` (the object's `anchor`) | Its region drifts: a structure rolled there next has full chests |
| A cleared dungeon or boss arena | The same key in `clearedAnchors` | Its region drifts: its guards may wake again, if it is rolled again |
| A legend defeated there | `legend@cx,cy#visit` in `clearedAnchors` | Its region drifts: a new legend may roam it (the trophy is the player's for good) |
| A closed rift | Its object id, which holds the visit (`rift@cx,cy#visit/slot`) | Its region drifts: a new rift may open there |
| A Moonwell drunk from | Its object id, which holds the visit | Its region drifts |
| An item on the ground | The region and its visit at the drop (`visit` on each saved item) | Its region drifts: the item is gone, at once if the region drifts in play, or on load if the save is older than the region's visit |
| A gathered plant | The harvest log, per chunk and visit | Its region drifts, or it regrows |

Keys of past visits are dropped on saving (`WorldManager.liveMemory`), and so are keys of world events no longer standing, so the save does not grow without end. Nothing here runs per frame: the ground is swept only when a region's visit rises.

What is the player's own is never tied to a place: the inventory, level, skills, trophies, recipes, quests, map markers and the rift story.

## Format

`SaveData` (`src/save/SaveManager.ts`):

```ts
interface SaveData {
  version: number;        // SAVE_VERSION, currently 9
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
  lootedAnchors: string[];   // `cx,cy/slot#visit` (see "The Drift")
  clearedAnchors: string[];  // the same, `legend@cx,cy#visit`, and closed rifts' object ids
  living: {                // null in saves from before the living world
    time: { day, minutes };
    weather: Record<biome, { kind, hoursLeft }>;
    quests: Quest[];
    rift?: { version: 4, closed: number, entered: boolean, cleared: string[], lore: Record<string, string[]>,
             plots: Record<string, { met: boolean, relics: string[], restored: boolean }> };  // the story; missing before it
  } | null;
  exploration: {           // null before the map existed
    explored: number[];    // flat pairs: chunk key, biome palette + 1
    markers: { id, x, y, label }[];
    tracked: number | null;
  } | null;
  regions: number[];       // flat pairs: region key, visit counter (only counters above 0)
  harvested: { key, visit, cells: number[] }[];  // per chunk: flat triples of cell, decoration, minute
  ground: { id, count, durability?, x, y, visit? }[];  // items on the ground, with their region's visit
}
```

`snapshot(world, player, living, exploration)` builds it; `restore(world, data)` puts the looted and cleared anchors, region visits, harvest log and ground items back into a fresh world built from the same seed. `Game` restores inventory, equipment, progression, vitals, the waking spot and the used Moonwells, and `LivingWorld.load` restores the clock, weather, quests and the rift story.

Fields marked `?` are missing in older saves and load with defaults: the best armour carried is put on, there are no skills, trophies or recipes, the player wakes at the start, no Moonwell has been used, and the story starts at "Find a rift" with no rifts closed (and without the opening vision, which only a new world shows). The rift story is an optional field with its own version, so it needed no new save version: version 2 kept stones read as `dimension:clue` ids (they become per-dimension lists), versions 1 and 2 kept no cleared dimensions (a closed rift then could only have been into The Hollow, so it counts as cleared), and versions before 4 kept no plots (every world's plot starts afresh). Ground items without a `visit` count as from the visit their region is on.

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
| 8 | The Drift: looted anchors (`cx,cy/slot`) and cleared lairs (`cx,cy/slot`, `legend@cx,cy`) get the visit their region was on (`#visit`, from the save's own region counters), so they are forgotten once it drifts. Closed rifts' and events' keys are kept as they were. |

The version 1 and 5 steps still fill in fields on an old save's `objects`; the version 7 step then drops them.

Not a version step: a player without a Drift Beacon (a save from before it) is given one on load. Nothing of a shared dimension instance is ever saved; the beacon's public or private switch and the player's name for others live in `localStorage` (settings and `untrue.net.*`), not in the save.

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
- Behind a rift, the save keeps the player at the rift's doorstep and, of the bag, what they carried in: what was found inside is the rift's until they are out. In danger (health under half, or something hunting them within 10 tiles), it keeps nothing carried but what is bound to them, as dying there would ([dimensions.md](dimensions.md#saving)).
- A write counts as done once its IndexedDB transaction completes, not when the request succeeds.
- `?new` or `?seed=N` starts a fresh world; its first autosave replaces the slot.

## Two tabs

Two tabs would save over the same slot. The first tab takes a Web Lock (`navigator.locks`, lock `untrue-save`) and holds it until it closes. A later tab cannot get the lock, so it plays without saving and shows an alert. Where Web Locks are missing, a `BroadcastChannel` named `untrue` does the same: a new tab says hello, and if an open tab answers, the new tab stops saving. The story playground never saves, so it does not take the lock.

## Settings and tips

Settings are separate: they live in `localStorage` under `untrue.settings` (`lighting`, `weather`, `particles`, `fps30`, `flashes`, `help`, `music`, `sfx`, `uiScale`, `keys`), per browser, and fall back to defaults if storage is blocked. First-time tips already shown are kept under `untrue.hints` (`src/ui/Hints.ts`).

The pause menu's "New world" clears the save slot and reloads with `?new`.

See also: [Objects and structures](objects-and-structures.md), [Architecture](architecture.md)
