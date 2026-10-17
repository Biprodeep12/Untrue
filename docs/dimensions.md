# Dimensions

The outer dimensions behind the rifts: finite spaces of challenges, entered from a rift in the overworld and left through a portal that closes the rift behind the player. Only one exists so far, **The Hollow**, but dimensions come from a registry so more can be added.

Code: `src/dimension/` (the dimensions themselves, with no rendering), `src/game/RiftTrip.ts` (one trip into one), `src/rendering/DimensionRenderer.ts`, `src/ui/DimensionMap.ts`, and the dimension parts of `src/game/Game.ts`.

## Entering and leaving

Facing a rift's tear in the overworld shows **E Enter the rift** ([objects-and-structures.md](objects-and-structures.md#rifts)). Pressing E pulls the player into the tear in a short passage (about 1.3 s; [rendering.md](rendering.md#passing-through-a-rift)): input is locked and the world waits, and under the passage's cover the game:

1. Seeds the space from the rift: `hash(worldSeed, hashString(rift.id))`, so the same rift always leads to the same layout, and `pickDimension(seed)` chooses which dimension (always The Hollow for now).
2. Makes a `RiftTrip` and moves the fight there (`CombatSystem.enterArena`): the overworld's enemies and shots are stashed, untouched, until the player is back.
3. Hides the overworld's sprites and opens the `DimensionRenderer`, then puts the player on the arrival platform, below the rift they came in by.

There are three ways out, all back to the doorstep below the rift in the overworld:

| Way out | The rift | The run |
| --- | --- | --- |
| Step through the portal in the vault (it wakes once the boss falls) | Closed: it shows a scar while its region stands, and +150 XP | Done |
| Step back onto the arrival rift | Still open | Lost: entering again starts over |
| Die | Still open | Lost, and so is everything carried ([below](#dying)) |

Every way out is a passage too: pulled into the portal or the arrival rift (on dying, spun away where the player falls), and emerging from the tear outside. Closing waits for the player to be out: then the tear collapses behind them, and only then come the experience and the story's beat. Leaving restores the overworld exactly: the trip's enemies go, the overworld's come back as they were, the overworld renders again (chunks re-culled, buildings rescanned from their cached art, ground items redrawn), and the dimension's meshes and sprites go back to their pools.

**While inside**, the overworld goes on as it does for a player indoors ([buildings-and-interiors.md](buildings-and-interiors.md#entering)): the clock, hunger, thirst and villagers' days run (`LivingWorld.updateIndoors`), the world keeps streaming around the rift outside, and world events can still fire there (an ambush waits in the stash). Nothing of the overworld's combat runs: no wild spawning, despawning by distance, guard triggers or legend rolls. There is no weather; hazards, ground items and gathering are the overworld's and stay there. Only by-hand recipes can be crafted, nothing can be dropped, and what does not fit in the bag is left outside the rift.

## The Hollow

A chain of stone chambers floating in a violet void, 96 × 96 tiles (`src/dimension/Hollow.ts`). Six chambers are laid end to end by a backtracking search from a random start, each joined to the last by a short walled corridor with a three-tile door into the next:

| Chamber | Size (tiles, walls included) | Challenge |
| --- | --- | --- |
| Arrival | 11 × 11 | None: the rift home, rune tiles and four crystals |
| Glitch nest | 17–19 × 15–17 | Waves |
| Crumbling path | 21–23 square | Hazard path |
| Glyph hall | 15–17 × 13–15 | Glyph puzzle |
| Warden's arena | 21–23 × 19–21 | Boss |
| Vault | 11 × 9 | None: the portal home and the vault's chest |

The HUD's location names the chamber the player stands in (`RiftTrip.chamberAt`). Light comes from crystals, the rift, safe pads and the portal; the space's darkness is 0.55 at every hour, tinted violet. Its music and sounds are in [audio.md](audio.md).

**Doors.** The door into a chamber stays sealed until the chamber before it is done. The waves and the boss also seal the door behind the player while they fight, and open it again when they are won (or reset).

## Challenges

`src/dimension/Challenges.ts`. Each challenge chamber has a state machine (idle, active, done); `DimensionRun` sequences them. Per frame the game calls `run.update(dt, px, py)` with the player's feet and acts on the events it reports (`takeEvents`); nothing in a run allocates per frame.

**Waves (Glitch nest).** Walking two tiles into the chamber seals it: "The doors seal. Something crawls out of the cracks…". Three waves come out of spawn spots around the walls, away from the player: 4 Glitchlings; 3 Glitchlings and 2 Shard Wisps; 3 Glitchlings and 3 Shard Wisps. The next wave arrives 1.5 s after the last one falls; after the third the doors open.

**Hazard path (Crumbling path).** The room is void, with a ledge at each door and a winding path of floating slabs between them, with a 2 × 2 safe pad at each bend:

- Crumbling slabs crack when stepped on, fall 0.55 s later, and come back 5 s after that.
- Glitching slabs blink on a cycle: there for 2 s (flickering for the last 0.5), gone for 1.3 s. Each run of them has a safe step before it to wait on.
- Walking onto the void, a fallen slab or a glitched-out one is a fall: 15 damage, and the player is put back on the last safe pad touched (a fall also puts every slab back, so the way is open again).
- Reaching the far ledge finishes it: "Solid ground again."

**Glyph puzzle (Glyph hall).** Four or five of six glyphs are carved on mural stones along a wall without a door; the same glyphs are on pressure plates scattered over the floor. The stones light up one after another in the order to press the plates (0.7 s each, then a pause of two beats), and stay lit as each is done. A wrong plate springs them all back up ("Wrong order"). The last right one opens the door.

**Boss (Warden's arena).** Walking three tiles into the arena seals it and wakes **The Rift Warden** in the centre of its rune circle. Its health drives two phases:

| Below | What happens |
| --- | --- |
| 66% | "The Warden tears the air open." 3 Glitchlings join it |
| 33% | "The Warden flickers with fury." 2 Shard Wisps join it, and it attacks faster (cooldown ×0.55) and moves faster (×1.35) |

At most 6 summons live at once. The phases' multipliers go on that one enemy (`Enemy.speedScale`, `cooldownScale`), never on its species. When it falls, its summons fade, the doors open and the portal wakes: "The way home opens."

**The creatures** (stats in [combat.md](combat.md#enemies)) are as tough as the land around the rift: their difficulty band is the rift's, so rifts far from home are harder. All three are weak to spirit damage. Glitchlings swarm fast; Shard Wisps float over the void (walls still stop them) and shoot shards. A walker knocked off an edge falls and dies; the Warden keeps its footing.

## Rewards

The vault's chest opens with E once the boss has fallen (it opens by itself if the player steps through the portal first). It is rolled once from the run's seed (`HOLLOW_REWARDS`):

| Item | Count | Chance |
| --- | --- | --- |
| Rift Shard | 3–5 | Always |
| Coin | 20–45 | Always |
| Crystal | 1–2 | 60% |
| Gemstone | 1 | 30% |
| Star Metal | 1 | 25% |

Rift Shards are found nowhere else. They forge a **Rift Blade** (an Iron Sword, 4 shards and a Crystal at an anvil: 24 spirit damage, reach 1.7), make a **Rift Tonic** by hand (1 shard, 2 Herbs: +45 health, +10 thirst, cures poison) or 10 arrows (1 shard, 2 Wood), and sell for 30 coins ([survival.md](survival.md#crafting)). Closing the rift is worth 150 XP, and the Warden counts as a trophy.

## Dying

Dying inside an outer dimension, from a blow or a fall, **loses every item in the bag and the hotbar** (`Inventory.clearCarried`). Worn equipment (head, chest, legs, feet and the off hand) is kept. The rift throws the player back out onto its doorstep in the overworld, revived as after any collapse, with an alert: "The rift took everything you carried." The rift stays open; the run is gone. Dying in the overworld is unchanged: the player wakes at their waking spot and keeps everything.

## The map

Maps only work inside an outer dimension: there the Map tab shows and **M** opens it ([exploration.md](exploration.md#the-map)). `DimensionMap` (`src/ui/DimensionMap.ts`) shows:

- the tiles the player has seen (within 6 tiles of where they have stood), coloured by kind; the void stays dark,
- each chamber the player has seen into, by name, with a tick once done,
- the rift home (pink), the portal (pale cyan once open, dark before), and the player (white).

It frames what has been seen so far, at a whole number of pixels per tile. Fog is one byte per tile (`RiftTrip.seen`), updated only when the player reaches a new tile, with a version number that rises only when something new is seen. The seen tiles are painted one pixel each into a small canvas only when that version changed, and the map is drawn when the tab opens (the menu pauses the game), never per frame.

## Saving

Saving inside records the doorstep outside the rift as the player's position, as indoors (and saving during a passage is refused, as during a vision): a reload starts outside the rift, and the run's progress is gone. Nothing of a trip is saved. See [saves.md](saves.md).

## Under the hood

**The registry.** `DIMENSIONS` in `src/dimension/Dimension.ts` lists every dimension (`DimensionDef`): its id and name, its mood (darkness, tint, music, palette), size, generator, the creatures met inside, waves, boss and phases, hazard tuning and rewards. `pickDimension(seed)` chooses one for a rift. A new dimension is a new `DimensionDef` with its own generator; the challenges, the run, the renderer and the map work on any layout.

**The ground.** A trip is a `Place` (`src/game/Place.ts`) and a combat `Arena`, so the game asks it, not "are we in a dimension?", for:

| Asked for | The trip answers |
| --- | --- |
| The player's collision (`isSolidAt`) | Walls, props and sealed doors; the void is open (walking onto it is a fall) |
| Walking enemies (`blocksEnemies`) | The same, plus the void and every gap in the path |
| Fliers (`blocksFlyers`) | Walls, props and sealed doors |
| Knockback and shots (`isSolid`, `blocksShots`) | Walls, props and sealed doors; shots fly over the void |
| Falls (`isHole`) | The void, fallen slabs and glitched-out ones |
| The player's spot in the overworld (`spot`) | The rift's doorstep: saving, streaming, the HUD, the clock and overflow go by it |

**Events.** `RiftTrip.update` steps the run, reveals the map around the player, reports the boss's health share, and handles its own events: `spawn` (a new `Enemy` at the rift's band, provoked, added to combat and mapped id ↔ enemy), `despawn` (removed without a kill), `bossPhase` (the boss's multipliers). Every event then goes to `Game.tripEvent`: `fell` hurts the player and moves them to the safe spot, `door` and `plate` play sounds, `notice` and `wave` show notes, `reward` puts the items in the bag (overflow outside the rift), `closed` and `leave` take the player home. Kills come back the other way: `CombatSystem` tells its arena (`Arena.killed`), and the trip tells the run (`enemyKilled`).

**Rendering.** See [rendering.md](rendering.md#outer-dimensions). Nothing of a dimension runs or is drawn in the overworld, and nothing of the overworld's combat, glitches or decorations runs or is drawn in a dimension.

See also: [story.md](story.md) · [combat.md](combat.md) · [exploration.md](exploration.md) · [saves.md](saves.md)
