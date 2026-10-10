# Untrue: documentation

How the game works, from world generation to the story.

Untrue is an endless 2D procedural survival and exploration game for the browser. The world is generated around the player in chunks and thrown away behind them, so places can come back different on a later visit. It looks and feels like Stardew Valley: top-down pixel art with a warm, cozy tone. The player is an adventurer who explores, gathers, crafts and fights, but never builds. The story, *The World That Forgets*, turns the world's regeneration into its central mystery.

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
| E | Talk, read, gather, open, drink, rest, enter a building, take the stairs; advances a story vision |
| 1 to 8 | Select a hotbar slot |
| F | Use the selected item |
| Q | Drop the selected hotbar stack |
| Tab or I | Open or close the menu |
| M | Open or close the map |
| Escape | Close a dialog or the menu; otherwise pause |
| Ctrl+S | Save now |
| Mouse wheel, + and − | Zoom |
| F3 | Debug overlay |
| G, then B | Debug, development builds only: jump 20,000 tiles east, then come back |

Touch screens get a virtual stick (drag anywhere on the game) and Use, Bag, Hit and Roll buttons.

## URL parameters

| Parameter | Effect |
| --- | --- |
| `?new` | Start a new world with a random seed, ignoring the save. |
| `?seed=N` | Start a new world with seed `N`, ignoring the save. |
| `?spawn=x,y` | Spawn at tile `x,y` (development builds only). |
| `?hour=H` | Set the clock to hour `H` (development builds only). |
| `?weather=kind` | Force a weather kind in every biome for 24 hours (development builds only): `clear`, `rain`, `storm`, `fog`, `sandstorm`, `heat`, `snow`, `blizzard`. |
| `?fps=30` | Cap the frame rate at 30. |

The game strips the query string after reading it, so reloading continues the same world.

In dev builds (`npm run dev`), the running game is available in the browser console as `window.game`.

## Deploying

`npm run build` writes a static site to `dist/`: upload the folder to any static host (Netlify, GitHub Pages, itch.io, an S3 bucket, nginx). Paths are relative, so it works from a subfolder too. The game code (about 100 KB gzipped) and Pixi (about 160 KB gzipped) are separate files, so players keep Pixi cached across updates; serve `dist/assets/` with long cache headers, since its file names change with every build.

**On Vercel:** import the project (or run `vercel` in its folder). `vercel.json` already sets everything: `npm ci`, `npm run build`, output `dist/`, a year of immutable caching for `dist/assets/`, and a few safe security headers. Node 22.12 or newer is required (`engines` in `package.json`; Vercel's default Node 22 is fine). No environment variables or server functions are needed: the game is entirely static, and saves stay in each player's browser. The only outside request is the Pixelify Sans font from Google Fonts.

What keeps a live build safe:
- **Saves** live in IndexedDB in the player's browser. If storage is blocked (some private modes), the game still runs and says once that it cannot save. A save that cannot be read is kept as a backup and a new world begins, instead of the game failing to start. Older save versions are upgraded.
- **World generation** runs in web workers, and falls back to the main thread if workers cannot start or one fails, so the world always loads.
- **Errors** in a frame are logged and the game carries on (Pixi would otherwise stop ticking). If the game cannot start at all (no WebGL), the page says so.
- **Cheats are off:** `?spawn`, `?hour`, `?weather`, the G/B teleport and `window.game` only exist in development builds. `?seed`, `?new` and `?fps=30` work everywhere.
- **Two tabs** of the game warn each other, since both would save over the same slot.
- **Touch screens** get Use, Bag, Hit, Roll and a hold-to-Block button.

## Pages

Engine:

- [Architecture](architecture.md): source layout, the frame loop, threads, how systems talk, testing.
- [World streaming](world-streaming.md): chunks, the render, cache and simulation areas, the chunk lifecycle.
- [World generation](world-generation.md): noise fields, tiles, decorations, biomes, regions and regeneration.
- [Objects and structures](objects-and-structures.md): world objects, layouts, the structure catalogue, placement, persistence.
- [Saves](saves.md): what is saved, the save format and its versions.
- [Rendering](rendering.md): the procedural atlas, meshes, sprites, lighting, weather, effects and UI.

Gameplay:

- [Survival](survival.md)
- [Combat](combat.md)
- [Living world](living-world.md)
- [Story](story.md)
- [Buildings and interiors](buildings-and-interiors.md): building sprites, walls with height, and walking inside
- [Exploration](exploration.md): the world map, fog of war, markers and the compass
- [Audio](audio.md): synthesised sound effects, music and weather ambience

Design:

- [Design spec](../Endless%202D%20Procedural%20Survival%20Game%20Design%20Spec.md)
- [The World That Forgets](story.md), the full story text and how the game tells it

See also: [Architecture](architecture.md)
