# Dimensions

The outer dimensions behind the rifts. Each is an **open world with a fixed map**: the same engine as the overworld (chunk streaming, culling, tiles, trees, gathering, lighting, creatures), but its land is the same for everyone and never forgets. Landmarks on the map hold its challenges, lore stones hold clues to the main story, and each world has a **plot** of its own: someone who lives there, something they lost, and what it means ([below](#plots)). Players from any world can meet in them ([below](#playing-with-others)). Two exist, in story order: **The Hollow** and **The Drowned Archive**; rifts carry the id of the dimension they open onto.

Code: `src/dimension/` (the data format and its source, the land on the engine, the challenges; no rendering), `src/dimension/bake/` (the bakers of fixed maps), `src/game/RiftTrip.ts` (one trip into one), `src/rendering/SiteRenderer.ts`, `src/rendering/ArchiveArt.ts`, `src/ui/DimensionMap.ts`, and the dimension parts of `src/game/Game.ts`.

## Maps as data

A dimension's map is a data file: `public/dimensions/<id>.json`, shipped with the game today and, later, sent by a server. The format (`src/dimension/DimensionData.ts`, `format: 2`) is one JSON document:

| Field | What |
| --- | --- |
| `id`, `name` | The dimension's id (must be one this version of the game knows how to play, see [the registry](#under-the-hood)) and name |
| `width`, `height` | In tiles, whole chunks (32), at most 512 |
| `mood` | `darkness` (0–1) and `tint` of its light at every hour, and its `music` (`rift` or `archive`) |
| `tiles`, `decos` | The land: one byte per tile each (world `Tile` and `Deco` ids), run-length encoded as [count 1–255, value] pairs, then base64 |
| `regions`, `regionMap` | Region names, and one byte per chunk naming its region (encoded alike) |
| `rift`, `portal`, `chest` | [x, y] tiles: the rift home (its tile carries the tear, `Deco.Rift`), the way out, the vault's chest |
| `sites` | The challenges' landmarks: kind, name, rect, way in, centre, gate tiles, spawn spots; per kind the path's slabs and pads, plates, mural stones and how the order is given (`hint`), a tide hall's valves and flooded floor, the far side |
| `clues` | Lore stones (`Deco.LoreStone` on their tile): id, title and pages of text |
| `spawns` | Where creatures roam: a rect, species ids, and how many at once |
| `plot` | The world's own story (optional): its resident (name, tile, look), what the relics make whole, the relics (`Deco.Relic` on their tiles), what the resident says, the visions and the reward |

**Checked as untrusted.** `decodeDimension` checks everything before use and refuses a bad file whole, with a reason: the format and id; sizes against the caps (at most 16 sites, since a shared run packs gates in a 16-bit mask, and at most 600 path slabs, since their timers travel in every shared run state); run lengths against the map; every tile and decoration id; every coordinate and rect inside the map; that no tile is claimed twice; that the rift has its tear and ground below it; that there is exactly one boss; that the portal and the chest are inside a vault; that the portal, chest, gates, plates, valves and flooded floor stand on open ground, and so do every site's way in, spawn spots, pads and the boss's spot; that the mural's glyphs all have plates; that clues stand on lore stones and relics on relics; that the resident's look is one the game has; that spawn zones name only creatures met in that dimension (never its boss); and string lengths and list sizes. The Hollow's file is 31 KB, the Archive's 33 KB.

**Where maps come from.** The game asks a `DimensionSource` (`src/dimension/DimensionSource.ts`) for a dimension by id. Today that is `LocalDimensionSource`: it fetches the shipped file from the same origin (the CSP's `connect-src 'self'` allows it), gives up a fetch that takes over 10 s, refuses anything over 4 MB (before reading it, when the size is sent), parses and decodes it. `DimensionCache` keeps each decoded map, so it loads once; a map that could not be reached is tried again after 5 s, not sooner, and one that was refused (bad data) is not asked for again this session. **A server-backed source is later work:** it only has to implement `load(id)` the same way, and its answers are checked just the same.

**Loading early.** When the player comes within 40 tiles of an open rift, the map behind it starts loading (and so do the maps of every world cleared, for the chooser), so stepping through never waits. If it is not ready when the player presses E, the rift says "The rift is still settling. Try again in a moment."; if it failed, "The rift won't open: what lies beyond can't be reached right now." (the reason goes to the console), and the player stays in the overworld.

## Baking a fixed map

A fixed map is made once by a baker and committed: `npm run bake` (`scripts/bake-dimensions.mjs`, which loads the TypeScript bakers through Vite) writes `public/dimensions/<id>.json` for every world, after checking that the game would accept it. The bakers (`src/dimension/bake/hollowMap.ts`, `archiveMap.ts`) build each map from a fixed seed around hand-placed landmarks, so baking again gives the same file byte for byte (tests check the shipped files against fresh bakes). A bake fails rather than write a map that cannot be finished: from the arrival every site, pad, plate, valve, spawn spot, far side, lore stone, relic, the resident and the vault must be reachable, and the vault must not be reachable with the boss's gate shut.

## Entering and leaving

Facing a rift's tear in the overworld shows **E Enter the rift** ([objects-and-structures.md](objects-and-structures.md#rifts)). Each rift object carries `dimension`, the id of the dimension it opens onto, rolled when it appears: rifts lead to the first world in story order the player has not cleared, sometimes back to one already cleared, never ahead (`dimensionForRift`; [story.md](story.md#where-rifts-lead)). So every rift opens onto The Hollow until it is cleared; after that they lean to The Drowned Archive. Once the player has cleared a world, E first asks where to tune the rift: where it opens, or any world cleared (`retuneChoices`; number keys, click or tap). Pressing E (and choosing, if asked) pulls the player into the tear in a short passage (about 1.3 s; [rendering.md](rendering.md#passing-through-a-rift)): input is locked and the world waits, and under the passage's cover the game:

1. Seeds what is random inside from the rift: `hash(worldSeed, hashString(rift.id))` (the vault's rewards, the roaming creatures). The land itself is the map's.
2. Makes the dimension's land (`DimensionWorld`) and a `RiftTrip`, and moves the fight there (`CombatSystem.enterArena`): the overworld's enemies and shots are stashed, untouched, until the player is back.
3. Keeps what the player carried in (for saving, [below](#saving)), stands the world's resident where it waits, and takes the relics this player already found off the land.
4. Hides the overworld's sprites, opens the `SiteRenderer`, puts the player below the rift home, and draws the land around them at once. Entering takes about 10 ms.

There are three ways out, all back to the doorstep below the rift in the overworld:

| Way out | The rift | The run |
| --- | --- | --- |
| Step through the portal in the vault (it wakes once the boss falls; it takes only an attuned player, [below](#contribution-and-attunement)) | Closed: it shows a scar while its region stands, the player's share of the experience, and the world counts as cleared | Done |
| Face the rift home and press E: **E Step back through the rift** | Still open, unless the boss has fallen and the player is attuned: then it seals behind them, as the portal would ("With its Warden gone, the rift seals behind you.") | Lost: entering again starts over |
| Die | Still open | Lost, and so is everything carried ([below](#dying)) |

A blow that kills the player the same moment they step into the portal or the rift home counts first: they die, as anywhere inside. Every way out is a passage too. Closing waits for the player to be out: then the tear collapses behind them, and only then come the experience and the story's beat (the world's closing vision, the first time it is cleared). Leaving restores the overworld exactly; the dimension's chunks go back to their pool (shared by every trip) and its site sprites to theirs.

**While inside**, the overworld goes on as it does for a player indoors ([buildings-and-interiors.md](buildings-and-interiors.md#entering)): the clock, hunger, thirst and villagers' days run, the world keeps streaming around the rift outside, and world events can still fire there. Nothing of the overworld's combat runs. There is no weather. Only by-hand recipes can be crafted. What does not fit in the bag (a kill's drops, the vault, a plot's reward) is left on the ground where the player stands **inside**, to pick up by walking over it, and is lost with the trip: nothing found behind a rift is banked outside it.

## The land

`DimensionWorld` (`src/dimension/DimensionWorld.ts`) is the dimension's land on the overworld's engine: a `ChunkManager` fed by `FixedGenerator`, which slices chunks out of the map at once (off the map is void), drawn by the game's second `TileRenderer` into its own ground layer. There are no regions, no forgetting and no rolled structures; the map's edge is void all round.

- **Collision** reads the map's arrays directly (`isSolidAt`, `isVoidAt`, `tileAt`, `decoAt`), so it works anywhere on the map, loaded or not, in O(1) without allocating. Off the map is solid.
- **Nobody falls.** The void (`Tile.Void`, and `Tile.VoidCliff` under the land's edge) is a wall for the player and for walking creatures, all round every island and along every causeway. Only a hazard path's slabs bridge it ([below](#challenges)). Fliers and shots still cross it.
- **Gathering** works as outdoors (`GatheringSystem` points at the land): trees give wood, shard grass herbs, glow caps mushrooms, rift crystals crystals, stones stone. What is gathered is gone for this trip; the next trip finds the map as it was made.

## The Hollow

256 × 256 tiles of violet moss, ash and shard sand adrift in a starry void, tied together by ruined causeways. Light is the dimension's own at every hour (darkness 0.55, tinted violet). The HUD's location names the site the player stands in, else the region.

| Region | Where | What is there |
| --- | --- | --- |
| Shattered Shore | South | The arrival, below the rift home on a ring of flagstones |
| Ruined Causeway | The middle | A ruined plaza where the roads meet |
| Ash Fields | West | Ash trees, stones; the Glitch Nest; the Ember Watch, a ruined watch post with bones round its dead fire |
| Glyphwood | North-west | A dense violet wood; the Glyph Hall; a broken causeway out to the Quiet Islet |
| Crystal Reach | East | Rift crystals and shard sand; the Sunken Shrine (a rune ring and a worn statue); the ledge of the Crumbling Path |
| The Far Shelf | Beyond the chasm, east | Crystals; a lore stone |
| Warden's Rise | North | The Warden's arena on its plateau, the vault behind it; the ground round it pocked with the Null's marks, where Null Shades roam |
| A Drifted Wood | Off the shore, west | Overworld forest that drifted here |
| The Lost Hamlet | Off the shore, east | A drifted village's ruins, a well, a field gone to seed, graves, and an empty bell frame where Isolde waits |
| The Quiet Islet | Far north-west | A secret, at the end of the broken causeway: the seventh stone and a piece of the bell |

**Drifted fragments.** A Drifted Wood and The Lost Hamlet are made of the overworld's own tiles and decorations: places the world let go of, come to rest here ([story.md](story.md#the-canon)). **The Null's marks** (`Tile.NullMark`): small, perfectly round absences in the moss round the Warden's plateau.

**The sites** (trials in any order): the **Glitch Nest** (waves), **The Crumbling Path** (a hazard path across the chasm to the Far Shelf), the **Glyph Hall** (a glyph puzzle, its order lit on the mural), **Warden's Arena** (the Rift Warden; sealed until the three trials are done) and **The Vault** (the portal home and the chest, reached only through the arena). Each trial done breaks a seal: "A seal breaks. 2 still bind the Warden's gate."

**Creatures:** Glitchlings, Shard Wisps (fliers) and Null Shades (glitchlings the Null has hollowed out: slower, tougher, and their touch slows). **Waves:** 4 Glitchlings; 3 Glitchlings and 2 Shard Wisps; 3 Glitchlings and 3 Shard Wisps. **The Rift Warden:** below 66% "The Warden tears the air open." (3 Glitchlings); below 33% "The Warden flickers with fury." (2 Shard Wisps; attacks ×0.55 cooldown, moves ×1.35); at most 6 summons. Closing is worth 150 XP. Its music is the `rift` mood ([audio.md](audio.md)).

## The Drowned Archive

The second world: the library where the keepers of the old network wrote down every place the world let go of, adrift in the void and half drowned in black ink-water. 256 × 256 tiles of cold marble (`Tile.ArchiveFloor`, `ArchiveWet`), worn carpet (`ArchiveCarpet`), shelves to the ceiling as its walls (`BookWall`, with their fronts, `BookWallFace`), ankle-deep shallows to wade (`Shallows`) and pools of ink too deep to (`InkWater`, solid). Darkness 0.5 at every hour, tinted deep teal, lit by reading lamps, lecterns and lore stones; its music is the `archive` mood, a low, mournful minor, with water dripping in the stacks ([audio.md](audio.md)).

| Region | Where | What is there |
| --- | --- | --- |
| The Lower Stacks | South | The arrival in a ring of marble, rows of shelves either side |
| The Reading Room | The middle | A great walled hall, carpet down its middle, ink pools in its corners, lamps; the Great Lectern, where Ondine waits by the empty Ledger |
| The Flooded Stacks | West | Long shelves standing in the shallows; the Scriptorium; an index page |
| The Cipher Wing | North-west | The Cipher Gallery, and the catalogue stone by its door |
| The Sluice Wing | East | The Sluice Hall |
| The Map Room | Past the Sluice Hall | A round room of charts; an index page |
| The Lost Carrel | North-east | A secret: a reading nook up a narrow board-walk off the east bridge; an index page and the last keeper's note |
| The Atrium | North | The Archivist's hall, sealed until the three trials are done; the vault behind it |
| The Ink Sea | Round the edges | Drifts of floor in the void |

**The sites:** **The Scriptorium** (waves: 5 Drowned Pages; 3 Drowned Pages and 2 Ink Wraiths; 3 Ink Wraiths and 2 Null Shades; 4 Drowned Pages, 2 Ink Wraiths and a Null Shade), **The Sluice Hall** (a tide hall, [below](#challenges)), **The Cipher Gallery** (a glyph puzzle whose order is **written**: the mural stays dark, and the catalogue stone outside spells the order out, "first the moon, then the star, …"), **The Atrium** (the Archivist) and **The Vault**.

**Creatures:** Drowned Pages (torn pages that swim through the air in shoals: fast, frail), Ink Wraiths (spilt ink that learned to want: fliers that spit, and slow what they hit), Null Shades. **The Archivist** (900 health): below 70% "The Archivist tears pages from itself." (4 Drowned Pages); below 40% "Ink pours from the Archivist." (3 Ink Wraiths; cooldown ×0.7, speed ×1.2); below 15% "The Archivist forgets itself." (2 Null Shades; ×0.5, ×1.4); at most 7 summons. Closing is worth 260 XP; the vault is richer than the Hollow's (`ARCHIVE_REWARDS`: 4–7 Rift Shards, 40–80 coins, crystals, gems, star metal, spirit essence).

## Challenges

`src/dimension/Challenges.ts`. Each challenge site has a state machine (idle, active, done); `DimensionRun` keeps them. Per frame the game calls `run.update(dt, px, py)` with the player's feet and acts on the events it reports (`takeEvents`); nothing in a run allocates per frame.

**Waves.** Walking two tiles into the site seals its gate: "The gate seals. Something crawls out of the cracks…". The waves come out of spawn spots around the walls, away from the players; the next arrives 1.5 s after the last falls; after the last the gate opens.

**Slips, not falls.** When the ground goes from under the player (a slab gives way or glitches out under them, or the water rises over them) they are thrown back to the site's last safe spot, hurt (`slip`: 8 in The Hollow, 10 in the Archive): "The ground gives way! You scramble back to safe footing…" or "The water knocks you off your feet and drags you back…".

**Hazard path (The Crumbling Path).** A chasm with a ledge on this side and the Far Shelf beyond, crossed on a winding path of floating slabs with a safe pad at each bend. A slab that is gone is a gap nobody can step into, and the void beside the path is a wall, so it is a race, not a fall:

- Crumbling slabs crack when stepped on, give way 0.55 s later (blocking the way), and come back 5 s after that. Keep moving: still standing on one when it goes is a slip back to the last pad.
- Glitching slabs blink on a cycle: there for 2 s (flickering for the last 0.5), gone for 1.3 s. Each run of them has two fixed stepping stones before it to wait on.
- A slip puts every slab back, so the way is open again.
- Reaching the Far Shelf finishes it: "Solid ground again. Behind you, the path settles and holds."

**Tide hall (The Sluice Hall).** A long hall: a dry ledge, three bands of flooded floor with shelves standing in them (so the dry way winds), and the far side. A sluice valve is set in the floor at the ledge and at the end of each band (`DimTile.Valve`); the floor the water covers is `DimTile.Flood`, each tile with its band's depth (in the layout's `phase`). The water stands at 3:

- Stepping onto the next valve in turn lowers it a stage ("The valve turns. The water drains a stage."), uncovering the next band down to the next valve. A valve out of turn does nothing.
- The water holds low only 7 s (`tideHold`), then rises a stage again ("The water surges back up a stage!"), the band about to go under showing the water creeping over it for the last 2.5 s (`tideWarn`). Rising over someone is a slip back to the ledge. Each valve after the first stands in the band before it and goes under with it, so nobody is ever left on an island.
- Reaching the far side finishes it, and the hall drains for good.

Flooded floor and drowned valves block walkers; fliers cross them. On a mirror ([below](#playing-with-others)) the water level and the hold travel with the run.

**Glyph puzzle (Glyph Hall, The Cipher Gallery).** Five of six glyphs (ring, triangle, cross, diamond, moon, star) are carved on mural stones along the north wall; the same glyphs are on pressure plates scattered over the floor, pressed by stepping on them. In the Glyph Hall the stones light up one after another in the order to press the plates (0.7 s each, then two beats' pause); in the Cipher Gallery (`hint: 'text'`) they stay dark, and the order is written on the catalogue stone outside. Done plates stay lit. A wrong plate springs them all back up ("Wrong order"). Only the site's own plates count.

**Boss.** Walking three tiles into the arena seals it and wakes the boss in its ring. Its health drives its phases, each summoning adds and quickening it; when it falls, its summons fade, the gate opens and the portal wakes.

## Plots

Each world has a short story of its own, told by someone who lives there. Its progress is each player's own, kept in the story save ([saves.md](saves.md)); it works alone and in shared instances alike (nothing of it travels: each player meets the resident, finds the relics and restores for themselves).

- **The resident** stands where it waits, drawn faint (a spirit: `Npc` with role `spirit`, its own look). It turns to the player when near, shows **!** before they have met and **✓** once every relic is found. **E Talk to …** within 1.8 tiles: their words page by page ("…" goes on). What they say follows the player's progress: first meeting (the plot is set out), while relics are out there ("The bell is in pieces still: 1 of 3 found."), once all are found (ready; the last page offers **Give back the pieces**), after restoring, and once the world is cleared.
- **The relics** (`Deco.Relic`, a glowing piece on a plinth) lie in the world's corners: **E Take the …** ("Found the bell lip (2/3)"). A relic found is gone from the land for that player on every later trip.
- **Restoring** shows the world's vision and gives its reward (experience and items; what does not fit stays on the ground inside).
- **The closing vision**: the first time a world is cleared, its own vision shows as the rift seals.
- The tracker shows the plot's line inside its world: "Someone waits here: seek out Isolde" (with an arrow), "Restore the hamlet's bell: 1/3 pieces", "Bring the pieces back to Isolde" (with an arrow); nothing once restored.

| World | Resident | Relics (where) | Restored | Reward |
| --- | --- | --- | --- | --- |
| The Hollow | Isolde, the Lost Hamlet's bell-ringer, by the empty bell frame | Bell crown (the Ember Watch), bell lip (the Far Shelf, past the Crumbling Path), bell clapper (the Quiet Islet) | *The Bell Rings*: the Warden, for a heartbeat, remembers being her father, and who came up the road before the hum | 120 XP, 2 Rift Shards, 40 coins |
| The Drowned Archive | Ondine, the last keeper, by the Great Lectern | Index of the Drowned (the Flooded Stacks), Index of the Kept (the Map Room, past the Sluice Hall), Index of the Null (the Lost Carrel) | *The Ledger Opens*: the newest entry in the Ledger of the Drift is in the player's own hand | 200 XP, 3 Rift Shards, a gemstone |

The plots' text is in each map's data, like its lore ([story.md](story.md#outer-worlds)).

## Contribution and attunement

A run is one **instance** of its dimension, built to hold several players: a host feeds it each player's position (`join`, `move`, `leave`) and hits (`damage`) by player id; alone, the player is `LOCAL` and has everything. `Contribution` (`src/dimension/Contribution.ts`) keeps the tally:

| Scores | How much |
| --- | --- |
| Damage dealt to the boss or one of its summons | Point for point (only what was really taken) |
| Breaking a trial | 100, split among the players who took part: in a shared instance, those who spent at least 4 s inside its site while it was under way, and, for waves, struck one of its creatures. Standing beside a site does not count. Alone, the player |

Nothing else counts: roamers, lore stones, plots and gathering are each player's own. When the boss falls the shares are **settled** (`DimensionRun.share(player)`):

- **The vault**, rolled once from the run's seed, goes by share: each item's count times the share, rounded down; what rounding leaves goes to the top scorer. Each player opens their own share of the chest.
- **Experience** for closing the rift (`DimensionDef.closeXp`) goes by share, with a floor of a quarter for every attuned player.
- **Attunement**: a player with a tenth of the score, or who broke a trial, is attuned. The portal takes only attuned players home (and closes *their* rift); to anyone else: "The portal does not answer you."
- With no score at all (a run skipped through in the playground), everyone in it shares alike.

Alone, the player has the whole score: the whole vault, all the experience, always attuned.

**Shared instances** (`run.shared`, set by a host; never alone): the boss returns 20 minutes after it falls (`WARDEN_RETURN`): its arena resets, the portal falls dark, the vault fills again and the tally starts over, kept to the players still there. A wave or boss fight with nobody left inside its site (they died, or went home) resets after 5 s, opening its gate, so no instance is ever locked.

**Roaming creatures** roam the land from the map's spawn zones, as tough as the land around the rift (its difficulty band). Once a second, each zone within 40 tiles of a player with room under its cap gets one, 13–30 tiles from the players (out of sight), never within 14 tiles of the rift home, on open ground, outside the sites. Those more than 48 tiles from everyone leave. A zone rests 20 s after one of its creatures is killed.

## Playing with others

Behind a rift, other players can be met: a dimension's **instances** are open to anyone (the overworld is by invitation; see [networking.md](networking.md)). Everyone in an instance stands on the same fixed map (peers compare the map file's hash), so only the run, the creatures and the players travel. Code: `src/coop/` (loaded the first time it is needed; solo play never downloads it) over `src/net/`.

**The Drift Beacon.** Every player carries one (new worlds start with it; older saves are given one on load). It is bound to the player: it cannot be dropped or sold, and is not lost on dying behind a rift. **B** (or the touch **Beacon** button, or using it from the hotbar) opens its panel: rift trips public or private (kept in Settings, `publicRifts`), who is in the instance and its code, the open instances of the dimension ahead ("Hana's The Hollow · 2 of 8 · seals 1 of 3"), the player's name, and sharing the overworld by code.

**Entering a public rift.** At full cover the passage holds while the beacon looks on the board for an instance of that dimension with room and joins it, or opens a new one and posts it. The hold lasts at most 9 s: if no one answers in time, the trip goes on alone. A private trip never waits.

**Who runs what.** One player, the **host**, runs the instance: the run (trials, gates, the water, the boss and its phases, the tally, the vault), every creature and every enemy shot. Every player runs their own player: movement, slips (on the host's slabs and water, as the host last said; their own steps crack a slab at once), checkpoints, the map's fog, lore stones, their plot, their bag and their vitals.

| What | How it travels |
| --- | --- |
| Each player's state | To everyone, 20 times a second, unreliable (`PlayerState`, 21 bytes) |
| Creatures and enemy shots near each guest | Host to that guest, 20 times a second, as a delta (`Snapshot`, at most one packet) |
| The run: every site's state (a tide hall's level and hold among them), gates, the boss, the tally, the vault taken | Host to everyone when it changes (at most 10 a second; at least every 2 s), reliable (`RunState`); a vault taken is shared at once |
| The run's news: a gate, a wave, a plate or valve, a phase, a notice | Host to everyone, reliable (`Event`) |
| A guest's blow on a creature | Guest to host (`Request`): checked for reach, rate and strength, then applied |
| A creature's blow on a guest | Host to that guest (`Event`), through the guest's own armour |

**Shares.** When the boss falls the host settles the tally and tells each guest their share, experience and whether they are attuned; a guest who joins (or comes back) after that is told when they arrive. A guest opening the vault asks the host, who gives their share once. A guest stepping into the portal before taking their share asks for it and waits a moment (3 s at most) for the answer before going, so it is not lost on the way out. The portal closes only the stepping player's own rift.

**Coming and going.** A player who dies is thrown out to their own rift (losing what they carried, as alone); one who leaves goes home; the instance carries on. When the **host** goes, the longest-connected player takes over: their mirror of the run becomes the run, from the last state the host shared, the tally included; the creatures they were drawing become real by the same ids, and keep their boss's phase quickening. Creatures the old host ran that never reached the new one are forgotten: a wave carries on without them, a boss nobody runs waits in its arena again.

## Clues

Lore stones stand across the land, numbered so they read in order: seven in The Hollow, six in the Archive, each a clue to the main story ([story.md](story.md)). Facing one shows **E Read the stone**; reading it shows its text as a vision. The first read of each is worth 20 XP; the story keeps which were read, per world, and the tracker counts them inside: "Lore stones read: 2/7".

## Rewards

The vault's chest opens with E once the boss has fallen (it opens by itself if the player steps through the portal first), and gives the player their share of what it holds. It is rolled once from the trip's seed (`HOLLOW_REWARDS`, `ARCHIVE_REWARDS`). Rift Shards are found nowhere else; they forge a **Rift Blade**, make a **Rift Tonic** or arrows, and sell for 30 coins ([survival.md](survival.md#crafting)). Closing is worth the player's share of the world's experience, and its boss counts as a trophy.

## Dying

Dying inside an outer dimension **loses every item in the bag and the hotbar** (`Inventory.clearCarried`), but what is bound to the player (the Drift Beacon). Worn equipment is kept. The rift throws the player back out onto its doorstep, revived, with an alert: "The rift took everything you carried." The rift stays open; the run is gone.

## The map

Maps only work inside an outer dimension: there the Map tab shows and **M** opens it ([exploration.md](exploration.md#the-map)). `DimensionMap` shows the fixed map under a fog that lifts as the player walks: the land seen (coloured by ground, water, shelves, trees, crystals and relics), site tiles, each site seen into (ticked once done), the lore stones seen (bright once read), the rift home, the portal and the player. Fog is one byte per tile, painted into a small canvas only when more is seen; the map is drawn when the tab opens, never per frame.

## Saving

Saving inside records the doorstep outside the rift as the player's position (and saving during a passage is refused): a reload starts outside the rift, and the run's progress is gone. **What the save keeps of the bag** is what the player carried in: what was found inside is the rift's until the player is out, so leaving the page is no way to bank it. And if the player is in danger when the save is made (health under half, or something hunting them within 10 tiles), the save keeps nothing carried but what is bound to them, as dying would: closing the page is no way out of a fight. The story keeps the lore stones read, the plots' progress and, once a rift is closed, the world cleared. See [saves.md](saves.md).

## Under the hood

**The registry.** `DIMENSIONS` in `src/dimension/Dimension.ts` lists how each world plays (`DimensionDef`), in story order (`HOLLOW` in `Hollow.ts`, `ARCHIVE` in `Archive.ts`): its id and name, the creatures met inside, the waves, the boss and its phases, the hazards' tuning (slabs, glitches, slips, tides), the rewards and the experience for closing. Its map and its plot come as data with the same id. A new world is a new `DimensionDef` plus a map (baked now, sent by a server later); the land, the challenges, the run, the plots, the renderers and the map work on any map.

**Performance.** Measured in a headless browser (software rendering), the game's frame work averages about 0.41 ms walking through The Hollow and 0.32 ms in The Drowned Archive, against about 0.27 ms in the overworld on the same machine. Per frame: the land streams and culls as the overworld does; the run steps its few challenges (a tide hall is a counter and a timer: its water is drawn per tile only for blocks in view); roamers are looked at once a second; the resident is one pooled sprite; relics are decorations; the site renderer touches only blocks in view; the fog updates only on a new tile.

**The ground.** A trip is a `Place` and a combat `Arena`, so the game asks it for:

| Asked for | The trip answers |
| --- | --- |
| The player's collision (`isSolidAt`) | The land's walls, rocks, trees and the void (except under a path's slabs), sealed gates, mural stones and the chest, slabs that are gone, flooded floor and drowned valves |
| Walking enemies (`blocksEnemies`) | The same |
| Fliers and shots (`blocksFlyers`, `blocksShots`) | Walls, rocks and trees, gates and stones; they cross the void, gaps and water |
| Ground gone from under someone (`isHole`) | Slabs given way or glitched out, flooded floor and drowned valves (the void never) |
| What does not fit in the bag (`drop`) | Left on the trip's own ground, where it fell, lost with the trip |
| The player's spot in the overworld (`spot`) | The rift's doorstep: saving, the overworld's streaming, the clock |

**Events.** `RiftTrip.update` steps the run, reveals the map around the player, keeps the roamers, reports the boss's health share, and handles its own events (`spawn`, `despawn`, `bossPhase`). Every event then goes to `Game.tripEvent`: `slip` hurts the player and moves them back, `door` and `plate` play sounds, `notice` and `wave` show notes, `reward` puts the local player's share in the bag, `closed` and `leave` take the player home.

**Rendering.** See [rendering.md](rendering.md#outer-dimensions). The tide hall's water is the site renderer's flat overlay (`flood` frames: rising, flooded), its valves flat site tiles (`valve`); the Archive's tiles and props are painted by `ArchiveArt.ts`.
