# Story

## The canon

**The Drift** is old and ordinary. The world is endless, and no part of it is kept forever: land left far enough behind lets go, and when the player comes back the same ground has regenerated as something new. Forests, ruins and whole towns drift alike; nothing is protected for being lived in or important. People live with it. They trade directions instead of maps, say goodbye to places before leaving them, and tell stories of homelands nobody can walk back to. What drifts does not end: it passes out into the expanse beyond the world's edge.

**The Fracture** is new and wrong. Rifts have torn open in the air, burning violet at the edges, each one onto an outer dimension: the expanse where drifted places go. Around them the land stutters and glitches, places vanish that should have stayed, and creatures crawl out. Rifts are events, not the reason land drifts.

**Behind it** lies an ancient network of roads laid between lost places, long asleep, and woken. Beyond the furthest lost place is **the Null**, a place where nothing has ever been, which spreads wherever the edges thin; the Warden and the glitch creatures are touched by it. And the player is not innocent: they woke beside one of the first rifts with ash on their hands and days missing, and the clues lead, slowly, to their own experiment as what woke the network. It did not create the Drift; it opened a way into what lies beyond it.

None of this is told outright. The intro says only what everyone knows (the Drift) and what everyone fears (the Fracture), with two faint hints at the player (the ash, the gap). The lore stones and the plots of the outer worlds carry the rest, a few lines at a time, world by world: The Hollow hints that someone came up the old road before the Null, with ash on their hands; The Drowned Archive tells what the network was for, and shows the player their own hand in its Ledger. Why they did it, and what the Null wants with roads it never built, is further out.

### How the game keeps to it

| The canon says | The game does |
| --- | --- |
| Land drifts when it leaves the active area, whatever is on it | A region (8 × 8 chunks) regenerates once its last chunk leaves the cache area ([world-streaming.md](world-streaming.md)); there are no protected places |
| What the world remembers of a place goes with it | Looted chests, cleared lairs, legends, Moonwells drunk from and items on the ground are kept per region visit and forgotten when it drifts ([saves.md](saves.md#the-drift)) |
| Progress is remembered apart from the land | The story (rifts closed, dimensions cleared, stones read), quests, level and map markers are the player's, saved apart from any place |
| Rifts are events | Rifts are rolled structures and world events; a closed rift may open again once its region drifts |
| Maps of drifting land go stale | Maps work only inside the outer dimensions, whose land is fixed |
| Drifted places end up in the dimensions | The Hollow holds two: A Drifted Wood and The Lost Hamlet, in the overworld's own grass, timber and stone; the Archive's Ledger lists them |
| The Null is close to the Warden | The ground round the Warden's arena is pocked with round absences (`Tile.NullMark`); Null Shades roam there, and in the Archive near its Atrium |

**Multiplayer.** The same rule holds with several players: a region drifts only once it has left every player's active area ([multiplayer-plan.md](multiplayer-plan.md)).

## In play

| Objective (HUD tracker) | Shown when | Arrow |
| --- | --- | --- |
| Find a rift | No rift closed yet, and none within 14 tiles | Toward the nearest open rift loaded, if any |
| Enter the rift | No rift closed yet, and an open rift within 14 tiles | Toward it |
| Break the seals: *k*/3 trials | Inside a dimension, the Warden's gate still sealed | Toward the nearest trial not done |
| Face the Rift Warden (the Archivist, …) | Inside, once the three trials are done | Toward the boss's arena |
| Close the rift: step through the portal | Inside, once its boss has fallen | Toward the portal |
| Rifts closed: *N* | Once a rift has been closed, in the overworld | Toward the nearest open rift loaded, if any |

The objective is always the tracker's first line, and the compass needle points where its arrow does unless a map marker is tracked ([exploration.md](exploration.md#compass)). "Loaded" means a live rift object, within the cache area around the player; rifts further out are not known.

- **A new world** opens with a vision of three pages, *The Fracture*, once the opening screen has cleared (`RiftStory.intro`): the Drift, the rifts, and the player waking beside one.
- **Clearing a world** for the first time shows that world's own closing vision (*The Hollow Holds*, *The Archive Sleeps*); a world without one shows *The Tear Seals* on the first rift closed. Every rift closed counts toward "Rifts closed" and is worth the player's share of the world's experience ([dimensions.md](dimensions.md#contribution-and-attunement)). The world it was closed from counts as **cleared**.
- **Leaving without closing** (stepping back through the rift home before the boss falls, or dying inside) leaves the rift open; the objective goes back to "Enter the rift". Once the boss has fallen, stepping back through the rift home seals it as the portal would.
- **Clues.** Inside, the tracker counts the world's lore stones read ("Lore stones read: 2/7"). Reading one shows its text as a vision; the first read of each is worth 20 XP. The stones are numbered so they read in order.
- **The plot's line.** Inside, the tracker also follows the world's plot ([below](#outer-worlds)): "Someone waits here: seek out Isolde", "Restore the hamlet's bell: 1/3 pieces", "Bring the pieces back to Isolde".

## Outer worlds

Each outer world tells a short story of its own through someone who lives there, alongside its lore stones ([dimensions.md](dimensions.md#plots) has how plots play). Their text, like the stones', is in each world's map data.

### The Hollow: the bell

**Isolde** rang the bell of a hamlet that drifted into the Hollow, slowly, "like falling asleep". Her father kept watch on the old road; when the hum came up it he went to meet it, and came back as the **Rift Warden**. The bell broke the night the tear opened. If it rang once more, he might remember he was a man. Its crown lies in the Ember Watch, its lip on the Far Shelf, its clapper on the Quiet Islet. Rung (*The Bell Rings*), the Warden stops for a heartbeat, a man in a watchman's coat; and Isolde hears what he remembers: someone came up the road before the hum, with ash on their hands, asking the way into the old network, and he showed them. Closing it (*The Hollow Holds*): the roads run on, toward a drowned library where every lost thing was written down.

| Stone | Where | What it hints at |
| --- | --- | --- |
| I. A Stone by the Rift | Beside the rift home | Drifted places do not end; they come here, and so did whoever carved it |
| II. The Causeway Stone | The Causeway's plaza | The roads were laid to join lost places: a network, asleep |
| III. The Hamlet Stone | The Lost Hamlet | The Drift was a slow tide; the woken roads made it tear |
| IV. The Listening Stone | The Glyphwood | The Null, past the furthest lost place; its hum |
| V. The Stone Beyond the Path | The Far Shelf | The Warden was set to keep the roads shut; the Null reached it |
| VI. The Last Stone | The vault | The network was woken on purpose; a newer line "in a hand very like your own" |
| VII. The Stone Nobody Was Meant to Find | The Quiet Islet | The keepers wrote down every drifted place; their library lies past here; "Found their ledger. It answers when you write in it. I wrote." |

### The Drowned Archive: the Ledger

**Ondine** is the last of the keepers who catalogued every place the world let go of, not to bring them back ("the Drift is the world breathing") but so nothing would be lost entirely, and who built the roads so the lost could be visited. When the Null began to follow the roads home, the keepers drowned the archive and tore the index out of the **Ledger of the Drift**, so no road could open again; Ondine hid the three pages and forgot where. With them the Ledger opens (*The Ledger Opens*): centuries of lost places in a hundred hands, then nothing for a long time, then one new entry, the ink barely dry: "The road answers. I am going to see where the lost things go." The hand is the player's. The **Archivist**, read hollow by the Null, was her friend. Closing it (*The Archive Sleeps*): the player knows whose hand woke the network, not yet why, nor what the Null wants with roads it never built.

| Stone | Where | What it hints at |
| --- | --- | --- |
| I. The Porter's Stone | By the rift home | The archive keeps the names of every place the world let go of |
| II. The Keepers' Charter | The Reading Room | The Drift is not undone, only remembered; the roads were built to visit the lost |
| III. On the Shelving of Places | The Flooded Stacks | Places drift twice; some came from worlds that were never ours |
| IV. The Catalogue | Outside the Cipher Gallery | The gallery's order, spelt out (the puzzle's key) |
| V. The Flood | The Sluice Wing | Why the archive was drowned and the index torn out |
| VI. The Last Keeper's Note | The Lost Carrel | "If the Ledger is ever written in again, it will be by someone who does not know what it is. Forgive them, Ondine. Then stop them." |

### Where rifts lead

Each rift rolls its dimension from its seed when it appears (`dimensionForRift`). The registry's order is the story's (The Hollow, then The Drowned Archive): rifts lean toward the first world the player has not cleared (six times likelier than any one already cleared), sometimes open onto one already cleared, and never skip ahead. Once every world is cleared, any. So every rift opens onto The Hollow until it is cleared; then mostly onto the Archive.

**Retuning.** Once the player has cleared a dimension other than where a rift opens, pressing E at the rift asks where to tune it: where it opens, or any dimension cleared (keys 1–8, or a click or tap). With one choice it opens straight away.

Where rifts come from, how often, and what closing one does to the world: [objects-and-structures.md](objects-and-structures.md#rifts). What is behind them: [dimensions.md](dimensions.md).

### Villagers

Villagers' everyday talk mixes in what they make of the Drift (old, ordinary, a little sad: a grandmother's drifted town, saying goodbye to places before leaving) and of the Fracture (new and frightening: an orchard gone with people still in it, things crawling out of rifts, the hum). One line a day each (`VILLAGER_TALK` in `src/game/LivingWorld.ts`).

## Implementation

`RiftStory` (`src/story/RiftStory.ts`) holds the story's state: rifts closed, whether the player has ever entered one, the dimensions cleared (at most 64), the lore stones read, per dimension (at most 500 in all), and each world's plot progress (met its resident, the relics found, restored; at most 64 plots, 16 relics each). It is built in `LivingWorld`'s constructor (the seam where a story plugs in) with a function that shows a `Vision`.

| Seam | What the story does |
| --- | --- |
| `LivingWorld.tracker()` | `objective(at, rift, run)` puts the objective first. `at` is the player's spot in the overworld, `rift` the centre of `WorldManager.nearestRift` (live, open rifts only), and `run` the trip in progress (`LivingWorld.trip`, set by `Game`; trials done, trials in all, whether the Warden's gate and the portal are open, and the way to the next step). Inside, `clueLine(run)` comes second |
| `WorldManager.riftDestination` | Set by `Game`: `dimensionForRift(seed, story.cleared)` for each new rift |
| `Game.approachRift` | `retuneChoices(own, story.cleared)`; more than one opens the chooser (`Dialog.talk`, `Dialog.choose` for number keys) |
| `Game.interactDimension` | `readClue(dimension, clue)` shows a lore stone's text; true the first time. `talk(dimension, plot)` gives the resident's words; `findRelic`, `restore` move the plot on |
| `LivingWorld.tracker()` (inside) | `plotLine(run)` and `clueLine(run)` follow the objective |
| `Game.loaded()` | On a new world (not a loaded save, not the playground), `intro()` after the opening screen |
| `Game.enterRift` / `riftSealed` | `onEnter()`; `onClosed(dimension, closing)` once the passage out of a closed rift is over (the world's closing vision, the first time) |
| `LivingWorld.save()` / `load()` | `rift: { version: 4, closed, entered, cleared, lore, plots }` in the living save |

Older story saves load cleanly: version 2 kept stones read as `dimension:clue` ids, which become per-dimension lists; versions 1 and 2 kept no cleared dimensions, and since only The Hollow existed then, a closed rift means it was cleared; versions before 4 had no plots, so every world's plot starts afresh. Junk (wrong types, overlong ids) is dropped. A save without a story (from before the rifts) starts at "Find a rift", without the intro.

Nothing in the story runs per frame: the tracker is refreshed with the HUD, four times a second, and everything else happens on an event (a rift entered or closed, a stone read).

**Testing.** The story playground (`?playground`, development builds; [README.md](README.md#url-parameters)) has the rift tools: "Rift nearby" tears one open beside the player; "Enter the Hollow" and "Enter the Drowned Archive" jump straight into that world (through the nearest rift, opening one if need be; from inside one world, into the other); "Enter (shared)" goes in through a rift's passage to meet others; "Clear all worlds" counts every world as cleared, so a rift offers the retune chooser; and "→ Waves", "→ Path", "→ Tide" and "→ Glyphs" go to that trial of the world the player is in, and "→ Boss" and "→ Vault" to the arena or the vault with what bars the way done (`DimensionRun.skipTo`). The playground shows no intro vision and never saves.

See also: [README.md](README.md) · [dimensions.md](dimensions.md) · [living-world.md](living-world.md) · [exploration.md](exploration.md) · [saves.md](saves.md)
