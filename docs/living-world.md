# Living world

The clock, light, weather, hazards, regrowth, NPCs, quests, trading, world events and settings.

`src/game/LivingWorld.ts` owns all of these and is driven by the game loop. Opening the menu, a conversation or a vision pauses them.

## Time

`src/systems/TimeSystem.ts`. One in-game day lasts 960 real seconds (16 minutes), so 1.5 in-game minutes pass per real second. A new world starts on Day 1 at 8:00.

| Phase | Hours | Darkness |
| --- | --- | --- |
| Night | 20:00–5:00 | 1 |
| Dawn | 5:00–7:00 | Ramps 1 → 0 |
| Day | 7:00–18:00 | 0 |
| Dusk | 18:00–20:00 | Ramps 0 → 1 |

The HUD shows the clock and the current weather above the location panel, for example "Day 3 · 6:40 pm · Rain".

Each in-game hour, `LivingWorld.onHour()`:
- advances the weather
- regrows plants
- burns torches
- may start a world event

At midnight, each villager has a new quest to offer.

### Resting

Facing a campfire at dusk or night, E rests until 6:00. Resting:
- costs 15 hunger and 15 thirst, and restores 40 health
- runs the hourly weather and regrowth for the hours skipped, but no world events
- is refused while any enemy is hunting the player (wildlife doesn't count)
- makes this spot the player's waking spot after a collapse ([survival.md](survival.md#collapse))
- plays a 3-second sleep transition (`src/ui/SleepOverlay.ts`): the screen fades to night over 1 second, "Z z z" drifts up for 1 second while the hours pass, then the morning fades back in over 1 second. The game is paused throughout. Beds indoors use the same transition.

## Light

`src/rendering/Lighting.ts` draws a darkness layer, coloured violet at dusk and deep blue at night, at up to 80% opacity scaled by darkness. Every light cuts a soft hole in it, and warm lights add an orange glow.

Thunderstorms add up to 0.45 darkness in daytime.

**The far lands are grimmer:** a faint gloom of 0.03 darkness per difficulty band (0.09 in the Extreme band) is added at all hours, so even midday out there is a little dim. The music darkens with distance too ([audio.md](audio.md#music)).

By day (darkness from the clock and storms at 0.01 or less), no lights are gathered: any gloom is drawn as a plain tint.

| Light source | Radius (tiles) | Warm glow |
| --- | --- | --- |
| Player, no light | 2.4 | none |
| Player with torch / Lantern | 5 / 7 | yes |
| Campfire | 5 | strong |
| House window (facade tiles with a window) | 1.8 | soft |
| Burning tree | 6 | strong |
| Meteorite | 2.5 | some |

With the "Lighting" setting off, night is still dark, but as a plain tint (85% as strong) with no lights cut into it.

## Weather

`src/systems/WeatherSystem.ts`. Each biome type runs its own weather, and the player feels the weather of the biome they stand in. When a spell ends, the next is picked by weight. Clear spells last 4–10 hours; others last 2–6.

| Biome | Weather (weight) |
| --- | --- |
| Forest | Clear 6, Rain 3, Thunderstorm 1, Fog 1.5 |
| Desert | Clear 6, Sandstorm 1.5, Heat wave 2 |
| Snow | Clear 4, Snow 4, Blizzard 1.2, Fog 1 |

A heat wave counts as Clear at night.

| Weather | Hunger | Thirst | Speed | Veil | Wet |
| --- | --- | --- | --- | --- | --- |
| Clear | ×1 | ×1 | ×1 | 0 | no |
| Rain | ×1 | ×0.7 | ×1 | 0.1 | yes |
| Thunderstorm | ×1.1 | ×0.7 | ×0.95 | 0.2 | yes |
| Fog | ×1 | ×1 | ×1 | 0.45 | no |
| Sandstorm | ×1 | ×1.3 | ×0.8 | 0.5 | no |
| Heat wave | ×1 | ×1.6 | ×1 | 0.05 | no |
| Snow | ×1.15 | ×1 | ×0.95 | 0.1 | yes |
| Blizzard | ×1.35 | ×1 | ×0.8 | 0.5 | yes |

Hunger and thirst multiply the drain rates in [survival.md](survival.md#vitals). Speed multiplies movement. Veil is how much the screen is hazed. Wet weather slows fire.

On screen, `src/rendering/ParticleSystem.ts` fades weather in and out over a few seconds, with rain, snow or blowing-sand particles. The "Weather particles" setting turns them off.

## Hazards

`src/systems/HazardSystem.ts`.

**Lightning**, in thunderstorms only:
- **Timing:** a strike lands every 5–13 s (the first after 8 s).
- **Target:** half the time it picks a tree within 8×6 tiles of the player; otherwise a random point within 7×5 tiles.
- **Warning:** a glowing circle marks the spot for 1.2 s.
- **Damage:** the strike deals 25 to the player if within 1.3 tiles, unless the player is invulnerable, and lights the tree if there is one.

**Fire** burns trees, bushes, palms and dead bushes:
- **Burn time:** 7 s, or twice as fast in wet weather.
- **Damage:** 6/s to the player within 1.1 tiles.
- **Spread:** halfway through, the fire tries to light every neighbour within 2 tiles, with a 35% chance each, or 5% in wet weather.
- **Afterwards:** the tree is gone, as if harvested.

## Regrowth

`WorldManager.regrow()` runs every in-game hour. Gathered plants grow back while their region stays loaded:

| Plant | Regrows after |
| --- | --- |
| Bush (berries) | 1 day (1,440 min) |
| Flowers (herbs) | 1 day |
| Mushroom | 1.5 days (2,160 min) |
| Garden vegetables | 1 day |

Everything else stays gone until its region fully unloads and regenerates.

## NPCs

`src/entities/NPC.ts`, `src/systems/NpcSystem.ts`.

**Villages:** each village in the simulation radius gets four people, all leaving when the village leaves the radius:
- **Three villagers**, in one of three outfits. The first is the village's quest giver. Villagers wander within 9 tiles of the village centre at 2.2 tiles/s.
- **A trader** who stays within 2 tiles of the well.
- **A resident in every house**, who stays at home day and night (`Npc.homebody`) and is met inside.

**Lone houses and cabins** are lived in half the time (seeded by the object): one resident, at home day and night.

**Nomad camps** (desert) get two people the same way: a traveller who offers quests, and a trader by the fire.

**Schedule:** from 20:00 to 6:00, villagers and traders walk to a door and go indoors, where the player can visit them (see [buildings-and-interiors.md](buildings-and-interiors.md#residents)). In the morning they step out of their door again.

**Travelling merchant:** appears through a world event, stands still, and leaves after 180 in-game minutes.

**Lost traveller:** the target of a rescue quest. They appear when their quest location enters the simulation radius, then wait until spoken to. After that they follow the player:
- at a 1.6-tile gap, at 5 tiles/s
- jumping back to the player if more than 12 tiles behind

They're removed if their quest ends, or if the player gets 120 tiles away before finding them.

Press E within 1.8 tiles to talk. The NPC you talk to stops and turns to face you (and you turn to them) until the conversation or trade closes, then waits 2 seconds before going on; everyone else carries on as before. A conversation's choices can be picked by number (1–8) as well as clicked or tapped.

Villagers without a quest to offer say one thing a day each (`VILLAGER_TALK`): the weather, a tip, or what they make of the Drift (old and ordinary: a grandmother's drifted town, saying goodbye to places before leaving them) and of the Fracture (new and frightening: an orchard gone with people still in it, things crawling out of rifts, the hum). See [story.md](story.md#villagers).

| Symbol over an NPC | Meaning |
| --- | --- |
| ! | Has something new to say, or a quest to offer |
| $ | Trader or merchant |
| ? | Lost traveller not yet found |
| ✓ | A collect or find quest is ready to hand in |

Marks are worked out four times a second, not every frame.

## Quests

`src/systems/QuestSystem.ts`.

**Getting quests:**
- Each quest giver offers one quest per in-game day. The offer is seeded by village, giver and day, so it's the same every time you ask that day.
- The player can hold 5 active quests. A full journal turns new offers away.
- Finished quests are dropped from the journal at the next new day.
- An unfinished quest can be given up with **Abandon** in the Quests tab (after a confirmation), which frees its slot.

| Type | Weight | Objective | Coins (base) | XP |
| --- | --- | --- | --- | --- |
| Collect | 3 | Bring N of a biome resource, handed in to any villager | 10 + 2N | 30 + 2N |
| Find | 1.5 | Bring N of a rare find from the giver's band (below), handed in like a collect quest | 40 + 25 × rarity × N | 60 + 30 × rarity |
| Slay | 3 | Kill 3–6 of a non-night species from the giver's biome | 15 + 6N | 40 + 10N |
| Discover | 2 | Find ruins, a dungeon, a nomad camp, a castle, the standing stones, a tower, a temple, a mine, a cabin or a lake | 30 | 60 |
| Clear | 1 | Clear any dungeon | 70 | 120 |
| Rescue | 1.5 | Find a lost traveller 150–300 tiles from the village and walk them within 12 tiles of it | 60 | 150 |
| Defend | 1, only from givers who live in a village | Accepting it starts an invasion of the village at once; driving it off completes the quest | 60 | 140 |

Find quests by band (rarity: Uncommon 1, Rare 2, Epic 3):

| Band | Finds (N) |
| --- | --- |
| 0 Easy | Gold Ore 2–3, Spirit Essence 2–3, Venom Sac 2–3 |
| 1 Medium | Gold Ore 3–4, Crystal 1, Ice Shard 3–4 |
| 2 and beyond | Crystal 1–2, Gemstone 1, Star Metal 1–2 |

Collect resources by biome:

| Biome | Resources (N) |
| --- | --- |
| Forest | Wood 10–20, Berries 5–10, Hide 3–5, Silk 3–5, Herb 4–8 |
| Desert | Cactus Fruit 4–8, Chitin 3–5, Stone 10–20, Venom 1–3 |
| Snow | Ice Shard 2–4, Wood 10–20, Hide 3–5, Coal 4–8 |

**Rewards:**
- Coins are the base × (1 + 0.5 × band) × a random 0.8–1.2.
- Each quest also rewards the first item of a chest roll at the giver's band.

**Completion:** quests complete as soon as their objective is met and pay out at once, except collect and find quests, which are handed in through a villager's dialog. Rewards that do not fit in the bag are left on the ground.

**Tracking:** the HUD tracker (top right, under the location) lists the story's objective first ([story.md](story.md)), then any treasure or Moonwell waypoint, up to three quests and the tracked map marker. Rescue lines carry an arrow toward the traveller, then toward home. The menu's Quests tab lists everything with its progress and rewards.

## Trading

`src/systems/TradeSystem.ts`. Talking to a trader or merchant opens the trade panel.

**Stock:** each shop shows 6 offers, seeded by who the trader is.
- **Village traders** draw from: Arrows ×10 (12c), Torches ×3 (6c), Bandage (8c), Antidote (12c), Cooked Meat ×2 (10c), Stew (14c), Wooden Sword (20c), Hunting Bow (55c), Leather Armor (60c), Stone Pickaxe (18c).
- **Travelling merchants** add rare stock: Health Potion (35c), Iron Sword (140c), Iron Armor (220c), Iron Pickaxe (120c), Lantern (90c), Iron Ingot ×3 (30c). They also carry the first four village items.

**Buying** needs enough coins; if the item doesn't fit in the bag, the purchase is undone. **Selling** goes one item at a time (Sell), or the whole stack at once (All, which shows the total), and only items with a price are bought:

| Item | Price |
| --- | --- |
| Golden Idol | 250 |
| Star Ingot | 120 |
| Gemstone | 60 |
| Star Metal | 45 |
| Crystal | 35 |
| Rift Shard | 30 |
| Gold Ore | 12 |
| Iron Ingot, Spirit Essence | 8 |
| Venom Sac, Ice Shard | 6 |
| Iron Ore | 4 |
| Hide, Spider Silk, Chitin, Cooked Meat | 3 |
| Raw Meat, Bone | 1 |

## World events

`src/systems/WorldEvents.ts`. Each in-game hour, once the 3-hour cooldown has passed, there is a 22% chance an event fires. The kind is a weighted pick among those whose conditions hold. "Wild" means more than 64 tiles from the origin.

| Event | Weight | Condition | What happens |
| --- | --- | --- | --- |
| Meteor | 2 | Night | A meteor streaks in and leaves a 7×7 crater 10–18 tiles away, with a Meteorite to mine |
| Bandits | 2 | Wild, not in a village | 3–4 bandits appear 11 tiles away, already hunting |
| Invasion | 3 | Standing in a village | 2 groups of 3 biome enemies attack from the village edges; clearing them pays 30 coins. A defend quest starts the same invasion. |
| Treasure | 2 | Always | An X is buried 18–32 tiles away, with a waypoint and a compass hint |
| Merchant | 1.5 | Daytime, no merchant nearby | A travelling merchant sets up 6–11 tiles away |
| Ancient | 1 | Wild | A 9×9 Risen Obelisk with a chest rises 12–20 tiles away |
| Moonwell | 1.5 | Night | A Moonwell rises 14–24 tiles away, with a waypoint |
| Rift | 0.5 | Wild | "A rift tears open nearby.": a 7×7 rift opens 14–24 tiles away ([dimensions.md](dimensions.md)) |

Event structures are temporary objects placed on open ground clear of other objects (trees and bushes under them are cleared). They come and go like any other object.

**Night-only structures.** The Moonwell (`NIGHT_ONLY` in `src/systems/WorldEvents.ts`) exists only at night: a 9×9 ring of pale stone around a glowing spring, with mushrooms and flowers. Every Moonwell still standing fades at the first hour of daylight. Facing it, E drinks: half of max health back, +40 thirst, poison cured and 25 XP, once per Moonwell (the used ones are saved). Drinking also makes it the waking spot after a collapse.

## Settings

The menu's Settings tab (`src/game/Settings.ts`) stores these in this browser's `localStorage`:

| Setting | Default |
| --- | --- |
| Lighting (off: a plain night tint) | on |
| Weather particles (also fireflies and falling leaves) | on |
| Hit and dust particles (bursts) | on |
| Cap at 30 frames per second | off (the cap is otherwise 60) |
| Screen flashes (lightning, getting hurt, a rift's colour slips and HUD stutter) | on, or off when the system asks for reduced motion |
| Show the controls bar | on |
| Music volume | 0.35 |
| Sound effects volume | 0.6 |
| Text and HUD size | 1 (0.8 to 1.5; applied when the slider is let go) |
| Keys (desktop only) | WASD, Shift, J, K, Space, E, F, Q, Tab, M, = and − |

The size setting zooms the whole HTML interface (`#ui`, CSS `zoom`); the touch stick undoes it so it stays where the thumb is. The keys are described in [README.md](README.md#controls).

`?fps=30` in the URL also turns on the frame cap. For testing, `?hour=22` sets the clock and `?weather=storm` forces the weather in every biome.

See also: [README.md](README.md) · [survival.md](survival.md) · [combat.md](combat.md) · [story.md](story.md) · [rendering.md](rendering.md) · [saves.md](saves.md)
