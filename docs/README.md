# Untrue: documentation

How the game works, from world generation to the living world.

Untrue is an endless 2D procedural survival and exploration game for the browser. The world is generated around the player in chunks and thrown away behind them, so places can come back different on a later visit. It looks and feels like Stardew Valley: top-down pixel art with a warm, cozy tone. The player is an adventurer who explores, gathers, crafts and fights, but never builds. Every structure is forgotten once the player leaves it far behind. Since rifts tore open all over it, the world has been forgetting itself; stepping through one leads into an outer dimension of challenges ([story.md](story.md), [dimensions.md](dimensions.md)).

## Running it

| Command | What it does |
| --- | --- |
| `npm install` | Installs dependencies (PixiJS, Vite, TypeScript, Vitest). |
| `npm run dev` | Starts the Vite dev server. |
| `npm test` | Runs the Vitest suites once. |
| `npm run build` | Type-checks with `tsc --noEmit`, then builds to `dist/`. |
| `npm run preview` | Serves the production build. |
| `npm run docs` | Builds this documentation as a website in `docs-site/`; open `docs-site/index.html`. |

## Controls

| Input | Action |
| --- | --- |
| WASD or arrow keys | Move |
| Shift | Run (uses stamina) |
| Left click or J | Attack (toward the mouse, or the way you face) |
| Right click (hold) or K (hold) | Block |
| Space | Dodge roll (not while swimming); advances a story vision |
| E | Talk, read, gather, open, drink, rest, enter a building or a rift, take the stairs, open a dimension's vault; advances a story vision |
| 1 to 8 | Select a hotbar slot |
| F | Use the selected item |
| Q | Drop the selected hotbar stack |
| Tab or I | Open or close the menu |
| M | Open or close the map, where maps work: only inside an outer dimension (the overworld won't hold still) |
| Escape | Close a dialog or the menu; otherwise pause |
| Ctrl+S | Save now |
| Mouse wheel, + and − | Zoom |
| F3 | Debug overlay |
| G, then B | Debug, development builds only: jump 20,000 tiles east, then come back |

**Changing keys.** On desktop, Settings → Keys lists each action with its main key. Click one, then press the new key (Esc cancels). A key does one thing: if another action had it, that action gets the old key back. "Reset keys" restores the defaults. The arrow keys, right Shift, I (bag) and the numpad + and − always work too. Esc, F3, F4 and 1–8 are kept for the game and cannot be bound. Keys are physical positions (`KeyboardEvent.code`), so WASD sits in the same place on any layout. The controls bar, the pause menu and the tips name the player's own keys. Code: `src/game/Keys.ts`.

**Touch screens** get:
- a virtual stick (drag on the left half of the game; a faint one rests bottom left),
- tap-to-interact (a quick tap anywhere on the game, or on the action prompt, acts like E),
- pinch to zoom: two fingers together zoom instead of steering (the second finger counts as a pinch if it lands within 250 ms of the first, or if the first is not steering),
- Use, Bag, Hit, Roll and hold-to-Block buttons; Hit aims at the nearest enemy in reach,
- small Pause and Full buttons above the action buttons. Full is full screen (also in the pause menu). iPhones have no full screen for pages, so the button is hidden there; Add to Home Screen opens the game full screen instead (`public/manifest.webmanifest`).

Tapping a hotbar slot selects it and shows the item's name (and a weapon's durability) above the bar for a moment; tapping it again uses it. On touch screens the vitals sit under the compass and the buttons bottom right, and the pause menu lists the touch controls.

## URL parameters

| Parameter | Effect |
| --- | --- |
| `?new` | Start a new world with a random seed, ignoring the save. |
| `?seed=N` | Start a new world with seed `N`, ignoring the save. |
| `?spawn=x,y` | Spawn at tile `x,y` (development builds only). |
| `?hour=H` | Set the clock to hour `H` (development builds only). |
| `?weather=kind` | Force a weather kind in every biome for 24 hours (development builds only): `clear`, `rain`, `storm`, `fog`, `sandstorm`, `heat`, `snow`, `blizzard`. |
| `?vitals=N` | Start health, stamina, hunger and thirst at `N`% (development builds only), to see the low warnings. |
| `?playground` or `?playground=SEED` | Story playground (development builds only): a fresh world, never saved, with a panel (F4 or tapping its title folds it) to travel to the spawn, set night or morning, toggle god mode and restart, and for the rifts: tear one open nearby, enter The Hollow, and skip to its combat, path, puzzle, boss or vault chamber. |
| `?fps=30` | Cap the frame rate at 30 (it is otherwise capped at 60). |

The game strips the query string after reading it, so reloading continues the same world.

In dev builds (`npm run dev`), the running game is available in the browser console as `window.game`.

## Deploying

`npm run build` writes a static site to `dist/`: upload the folder to any static host (Netlify, GitHub Pages, itch.io, an S3 bucket, nginx). Paths are relative, so it works from a subfolder too. The game code (about 100 KB gzipped) and Pixi (about 160 KB gzipped) are separate files, so players keep Pixi cached across updates; serve `dist/assets/` with long cache headers, since its file names change with every build. Pixi's WebGPU code ships inside the Pixi file even though the game uses WebGL: Pixi's main export imports it statically, so splitting it out would need a custom Pixi build, and `vite.config.ts` does not try.

**On Vercel:** import the project (or run `vercel` in its folder). `vercel.json` already sets everything: `npm ci`, `npm run build`, output `dist/`, a year of immutable caching for `dist/assets/`, and a few safe security headers. Node 22.12 or newer is required (`engines` in `package.json`; Vercel's default Node 22 is fine). No environment variables or server functions are needed: the game is entirely static, and saves stay in each player's browser. The game makes no outside requests: the Pixelify Sans font ships with it (`@fontsource/pixelify-sans`, imported at the top of `src/style.css` so the opening screen has it from the first paint), so no player data reaches Google Fonts.

What keeps a live build safe:
- **Saves** live in IndexedDB in the player's browser. If storage is blocked (some private modes), the game still runs and says once that it cannot save. A save that cannot be read (for example, one from a newer version) is kept as a backup and a new world begins, with an alert, instead of the game failing to start. If storage fails to read at all, that session does not save, so it cannot overwrite a save it never saw. Older save versions are upgraded. See [saves.md](saves.md).
- **World generation** runs in web workers, and falls back to the main thread if workers cannot start or one fails, so the world always loads.
- **Errors** in a frame are logged and the game carries on (Pixi would otherwise stop ticking). If the game cannot start at all (no WebGL), the page says so.
- **Cheats are off:** `?spawn`, `?hour`, `?weather`, the G/B teleport and `window.game` only exist in development builds. `?seed`, `?new` and `?fps=30` work everywhere.
- **Two tabs:** only the first tab saves (a Web Lock, with a `BroadcastChannel` fallback); a later tab plays without saving and says so.
- **Touch screens** get a left-half stick, tap-to-interact, pinch zoom, a tappable action prompt, Use, Bag, Hit, Roll, hold-to-Block, Pause and Full buttons, and a layout that fits phones upright or sideways.
- **Accessibility:** screen flashes can be turned off (and are off by default under the system's reduced-motion setting, which also stops HUD animation), the text and HUD size runs from 0.8 to 1.5, desktop keys can be changed, and first-time tips explain each part of the game as it comes up.

## Privacy and licenses

- **No personal data:** no accounts, analytics, ads or cookies. Saves (IndexedDB) and settings (`localStorage`) stay in the player's browser, which counts as strictly necessary storage, so no consent banner is needed. The host's server logs (Vercel) are the only data anyone else sees.
- **About tab** (beside Settings in the menu, `src/ui/About.ts`): a short privacy note, credits (original art and sound) and the open source licenses, with the full texts on demand.
- **Third-party notices:** `npm run build` first runs `scripts/build-notices.mjs` (also `npm run notices`), which writes the license of every shipped package (Pixi.js and its dependencies, Pixelify Sans under the SIL OFL 1.1) to `public/THIRD_PARTY_NOTICES.txt`. Type-only packages are skipped.
- **Before the app stores, analytics, ads, accounts or sales:** the stores want a privacy policy URL; tracking needs a full privacy policy and consent; selling needs a trademark check on the name.

## Pages

Engine:

- [Architecture](architecture.md): source layout, the frame loop, threads, how systems talk, testing.
- [World streaming](world-streaming.md): chunks, the render, cache and simulation areas, the chunk lifecycle.
- [World generation](world-generation.md): noise fields, tiles, decorations, biomes, regions and regeneration.
- [Objects and structures](objects-and-structures.md): world objects, layouts, the structure catalogue, placement, and how every structure is forgotten.
- [Saves](saves.md): what is saved, the save format and its versions.
- [Rendering](rendering.md): the procedural atlas, meshes, sprites, lighting, weather, effects and UI.

Gameplay:

- [Survival](survival.md)
- [Combat](combat.md)
- [Living world](living-world.md)
- [Story](story.md): the rifts, and the objective in the tracker
- [Dimensions](dimensions.md): The Hollow behind the rifts, its challenges, the map, and dying there
- [Buildings and interiors](buildings-and-interiors.md): building sprites, walls with height, and walking inside
- [Exploration](exploration.md): the map (not in the overworld), fog of war, markers and the compass
- [Audio](audio.md): synthesised sound effects, music and weather ambience

Design:

- [Design spec](../Endless%202D%20Procedural%20Survival%20Game%20Design%20Spec.md)

See also: [Architecture](architecture.md)
