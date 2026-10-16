# Multiplayer plan: peer-to-peer co-op

Design plan for 2–4 player co-op over WebRTC data channels (no websocket game server). Nothing here is built yet.

## 0. Key decisions

| Topic | Decision |
| --- | --- |
| Topology | Host-authoritative star, 2–4 players. The host is the player whose save holds the world. |
| World state | **The host streams it.** That covers biome records, region visit counters, resolved structures (full layouts), harvest log, and the base terrain bytes of each chunk (deflated). Guests never roll biomes or structures. They do not count region visits, and v1 guests do not generate terrain at all. |
| Biome growth rewrite | **Not done.** Making biome growth order-independent would change every existing world. It still would not fix visit counters, `collides`/`crowded`, or the differences in `Math.sin`/`cos`/`hypot` between engines. |
| Transport | Raw `RTCPeerConnection` with two pre-negotiated data channels: `ctrl` (ordered, reliable) and `snap` (unordered, `maxRetransmits: 0`). |
| Signaling | One `Signaling` interface with three implementations. BroadcastChannel is for dev and two tabs. Manual copy/paste needs no servers at all. A tiny Vercel HTTP endpoint (polling, short-TTL KV) is the main one. |
| NAT | Public STUN by default. TURN credentials come from a Vercel function with short-lived credentials. When a connection fails, the player gets a clear explanation and a "try relay" retry. |
| Simulation | No lockstep. The host simulates with variable `dt` as it does today. It sends snapshots at 15 Hz and guests interpolate 100 ms behind. Guests move themselves, and the host sanity-checks their positions. |
| Saves | The host save holds the world plus a guest roster (position, respawn, Moonwells). Each guest keeps their character in their own browser under the key `guest:<worldId>`, so the solo `main` slot is never touched. |
| Host leaves | No host migration. Guests save their character and go back to solo. |

## 1. Topology

| | Host-authoritative star | Full mesh |
| --- | --- | --- |
| Who decides enemies, loot, the world | The host only | Needs a consensus scheme or arbitrary ownership; enemy AI would conflict |
| Connections for 4 players | 3 | 6 (more NAT pairs that can fail) |
| Fits the code | Yes. `CombatSystem`, `LivingWorld` and `WorldManager` already run as a single authority. | No |
| Host upload | About 10 KB/s per guest (see 6.6) | Spread out, but each peer needs the whole world |
| Weakness | Host CPU and tab visibility (section 11) | Complexity |

**Recommendation:** star, with a hard cap of 4 players (host plus 3). The host simulates up to 4 simulation areas (5×5 chunks each) and generates terrain for every player's render area. That is fine on desktop. Show a warning when hosting on a phone.

## 2. Is the world deterministic from the seed? Partly, so the host must stream it

### 2.1 What the code shows

- **Pure:** the worker's `generateChunk(fields, req)` (`src/generation/TerrainGenerator.ts`). Its result depends only on the `ChunkRequest` built by `WorldManager.buildRequest`: `{ cx, cy, worldSeed, visit, biomes[27] }`, where `biomes` holds the type, variant and seed of the 3×3 neighbour biomes. Interiors (`new Interior(object, index)`) are pure given the object. Height, rivers, trails, bridges and climate type are also seeded.
- **Depends on the path taken** (the test in `src/world/WorldManager.test.ts` is literally "is repeatable for the same seed **and path**"):
  - (a) `BiomeManager.ensure` grows a biome from whichever chunk loads first. `isFree` skips chunks that already have an owner, and slivers below `MIN_BIOME_CHUNKS` merge into `mostTouching`. Borders, variant and biome seed therefore depend on load order, screen size and zoom (the cache rectangle), and that data feeds into `generateChunk`.
  - (b) `RegionTracker.leave` raises `visit` when a region fully leaves *this peer's* cache, gated by `rules.regenChance`, which changes with the story ending.
  - (c) `WorldManager.resolveAnchor` skips placements against live objects using `objects.collides` and `objects.crowded`. `rareBoost`, `lootedAnchors` and `clearedAnchors` are player state too.
  - (d) `Math.sin`, `Math.cos`, `Math.hypot` and `**` are not bit-identical across JS engines (V8, SpiderMonkey, JSC). This affects desert ripples, biome growth, bridge scoring, spacing and distance bands, so tiles near thresholds can differ between a Chrome host and a Firefox or Safari guest.
  - Also sequence-dependent: the RNGs in `CombatSystem.rng`, `LivingWorld.rng` and `WorldEvents`, which fire in call order.

### 2.2 Options

| Option | Fixes a | Fixes b | Fixes c | Fixes d | Cost |
| --- | --- | --- | --- | --- | --- |
| A. Order-independent biome growth (Phase 0 rewrite) | yes | no (visits depend on the path by design) | no | no | Changes every existing world and the regeneration design |
| B. Host streams biome records, visits and object layouts; guests generate terrain locally | yes | yes | yes | **no** | Small bandwidth; mismatches stay hidden |
| **C. B plus the host streams base terrain bytes** | yes | yes | yes | **yes** | About 0.3–0.6 KB per chunk deflated, under 1 KB/s while a guest is running |
| D. B plus a deterministic math module plus checksums | yes | yes | yes | mostly | Changes the terrain of existing solo worlds slightly; needs a careful port |

**Recommendation: C for v1. D is an optional Phase 5 bandwidth optimisation.**

- `ChunkGenerator` (`request`/`onResult`, `src/world/ChunkManager.ts`) is already the right seam. A guest-side `NetChunkGenerator` replaces `WorkerGenerator`: requests go to the host, and results come back as the host's `baseTiles`/`baseDecos` bytes. Token and stale-result handling (`chunk.token !== res.token`) keeps working unchanged.
- Guests still **compose** locally, using the same `compose` hook: base bytes, then `WorldObject.stamp` for replicated layouts, then the replicated harvest log. This is all integer work, so it is deterministic everywhere.
- Guests still need biome records (for `biomeAt`: HUD name, weather, music, `BuildingRenderer` snow, exploration palette), so these are replicated as small tables.
- Guests never call `biomes.ensure`, `resolveAnchor`, `regions.enter`/`leave`-driven increments, `objects.sweep` or `regrow`.
- Bandwidth at run speed (9 tiles/s): about 1.5 new chunks per second. At ~0.5 KB each that is under 1 KB/s, and a late join is about 30–40 chunks, roughly 20 KB.

## 3. Signaling without a game server

### 3.1 Options

| Option | Infra | Reliability | Privacy | UX |
| --- | --- | --- | --- | --- |
| Manual copy/paste SDP (non-trickle, deflate-raw plus base64url, in a URL `#fragment` or QR) | None | Depends only on the network | Best: SDP never leaves the two players | Two hand-offs: host sends an invite link, guest sends back a reply code; one link per guest |
| PeerJS cloud (`0.peerjs.com`) | Third-party websocket | Historically overloaded, no SLA | Third party sees SDP and IPs | Easy |
| Trystero (BitTorrent trackers, Nostr, MQTT) | Public relays | Relays come and go and rate-limit | Payloads encrypted with the room password; relays still see IPs | Easy; builds a full mesh by default |
| **Vercel function plus KV (Upstash Redis via the Marketplace), HTTP polling** | Ours, serverless, no websockets | Good; we control it | Only our infra sees SDP, deleted after use or after 10 min | Room code such as `K7QF2M` |
| BroadcastChannel | None | Same origin and browser only | n/a | **Dev and two-tab testing only** |

### 3.2 Recommendation

Build a `Signaling` interface (`src/net/Signaling.ts`) with three implementations:

1. `BroadcastSignaling`: dev and two-tab tests, built first.
2. `ManualSignaling`: needs no infra, always available, a fallback for forks and self-hosting.
3. `HttpSignaling`: the default in production.

Optionally add Trystero/Nostr later as one more implementation. Use pre-negotiated channels (`negotiated: true`, ids 0 and 1) so either side can make the offer.

**HTTP flow (`api/signal.ts`, Vercel Function):**

1. The host calls `POST {op:'open'}` and gets back `{room, hostToken}`. Room TTL is 10 min, refreshed while the host polls.
2. The guest creates an offer, waits for ICE gathering (2–3 s cap), and calls `POST {op:'join', room, guestId, sdp}`.
3. The host polls `GET ?room&hostToken` every second. It shows "Ana wants to join: Accept / Decline". On accept it creates an answer and calls `POST {op:'answer', room, guestId, sdp}`.
4. The guest polls every 500 ms, receives the answer and connects. The server deletes the keys.

After that, everything goes over `ctrl`, including ICE restarts.

Server-side limits: 6-character room codes from a 32-letter alphabet (about 30 bits), join attempts rate-limited per IP, a 16 KB body cap, and only opaque blobs stored. Vercel's Hobby plan is for non-commercial use only; check this, and check the Upstash free-tier limits.

### 3.3 STUN and TURN

- STUN: `stun:stun.l.google.com:19302` and `stun:stun.cloudflare.com:3478`.
- TURN: about 10–20% of pairs fail without it (symmetric NAT, mobile CGNAT, school and office firewalls). Candidates: Cloudflare Realtime TURN (free allowance, then per GB), Metered, Twilio NTS, or coturn on a small VPS. Game traffic is tiny (about 10 KB/s per guest), so relay cost stays low.
  - Never ship static TURN credentials in the bundle. `api/turn.ts` mints time-limited credentials (the TURN REST API HMAC scheme) from an env secret.
- Failure handling: use a 15 s timeout or `iceConnectionState === 'failed'`.
  - Message: "Couldn't connect directly. One of your networks blocks peer-to-peer (common on mobile data, school or office Wi-Fi)."
  - Buttons: [Try relay] (`iceTransportPolicy: 'relay'`) and [Use invite code instead].
  - Show the selected candidate-pair type (host, srflx or relay) from `getStats()` in `DebugOverlay`.

## 4. Library choice

| Library | Bundle (approx., measure with a build) | Maintenance | Fit |
| --- | --- | --- | --- |
| **Raw `RTCPeerConnection`** | 0 KB, about 400 lines of our own code | Browser standard | **Best.** Full control of channel reliability, binary frames and backpressure (`bufferedAmountLowThreshold`). |
| PeerJS | ~25–30 KB gz | Maintained | Tied to the PeerServer signaling (websocket) and its own serialisation |
| Trystero | ~10–25 KB gz per strategy | Active | Good for zero-infra signaling, but it owns the peer connections and builds a mesh |
| simple-peer | ~30 KB gz plus Node polyfills (`buffer`, `readable-stream`) | Effectively unmaintained since about 2021 | Vite polyfill pain; reject |

**Recommendation:** raw WebRTC in `src/net/Peer.ts`. No new runtime dependency, which keeps `package.json` at just `pixi.js` and the font.

## 5. Shared state and who owns it

| State | Module today | Owner in MP | How it reaches guests |
| --- | --- | --- | --- |
| Seed, `worldId`, `rules` (regenChance, rareBoost) | `WorldManager` | Host | `Welcome`. Guests don't need `rules`, since they never roll. |
| Biome records | `BiomeManager` | Host | `BiomeAdd {id, type, variant, seed, chunks}` (chunk keys as i16 deltas) and `BiomeDrop` |
| Region visit counters | `RegionTracker` | Host, using the **union of every player's cache** | `RegionVisit {region, visit}` |
| Base terrain | Workers | Host | `ChunkData {cx, cy, token, deflated bytes}` through `NetChunkGenerator` |
| Objects: structures, events, story places; `opened`; `discovered` | `ObjectManager`, `WorldObject` | Host | `ObjectAdd` (the `SavedObject` shape in binary, layouts included), `ObjectRemove`, `ObjectOpened {id, index}` |
| Harvest log and regrowth | `WorldManager.harvested`, `regrow` | Host | `Harvested {key, cell, deco, at}`, `Regrown {key, cells}` |
| Looted and cleared anchors | `WorldManager` | Host | `Anchor {kind, key}`. Only needed for UI; guests never roll. |
| Ground items | `GroundItems` (module-level `nextId`) | Host, which assigns ids | `GroundAdd` and `GroundRemove`. Pickup is requested by the guest and granted by the host. |
| Enemies, projectiles, guards, legends | `CombatSystem`, `Enemy` | Host simulates | `EnemySpawn`/`EnemyGone` on `ctrl`; state on `snap`. Projectiles are ballistic: send the spawn and let guests simulate. |
| Combat hits by guests | `CombatSystem.attack` | Guest requests, host decides | `Attack` request, then host `Fx` (damage numbers) and `KillCredit`/`Grant`/`XP` |
| Hits on guests | `CombatSystem.hitPlayer` | Host decides the hit, the **guest resolves it** (block, armor, dodge, vitals) | `Hurt {raw, speciesId, fromX, fromY}`; guest uses `incomingDamage` locally |
| Time and weather | `TimeSystem`, `WeatherSystem` | Host | `Clock {total, weather}` hourly and on rest; guests run time locally and nudge it toward the host's |
| Hazards (lightning, fire) | `HazardSystem` | Host, run per player | `Fx` strikes and fires; fire burns become `Harvested`; damage arrives as `Hurt` |
| World events | `WorldEvents.onHour` | Host. Each hour it picks the context of one player, rotating. | Objects replicate; `Waypoint`/`Notify` go to the player the event was for |
| NPCs and their schedules | `NpcSystem`, `Npc` (module-level ids) | Host, for villages in any sim area | `NpcSpawn {id, role, name seed, village, outfit}` once, plus `snap` state |
| Trade | `TradeSystem` (stock seeded, no state) | Guest, locally | Nothing to sync; only the guest's inventory changes |
| Quests | `QuestSystem` in `LivingWorld` | **Per player** (part of the character) | Offers are seeded by `offerKey`, so guests generate them locally. World side effects are requests: `StartInvasion`, `RescueTargets`. Kills come back as `KillCredit`. |
| Story | `StorySystem` | **Host only** | Guests see the world consequences (objects added and removed). Story prompts and story NPCs say "This is <host>'s story". Shared visions can come later. |
| Player position and animation | `Player` | Each player for themselves; host checks | `PlayerState` on `snap` at 20 Hz |
| Inventory, equipment, vitals, progression, Moonwells, respawn, exploration and markers | `Game`, `Inventory`, `Vitals`, `Progression`, `ExplorationSystem` | Each player (co-op trust) | Not replicated. Guests send only what the host needs: weapon id, damage bonus, skill ranks in requests, and the look of their armour in `PlayerState`. |
| Interiors | `Interior` (pure from the object) | Built locally; chest and mining state lives in `object.opened` | `ObjectOpened`. Players are grouped by "space" (see 6.5). |

## 6. Protocol

### 6.1 Channels and encoding

- `ctrl`: ordered and reliable. Carries the handshake, events, world replication and requests.
  - Messages are small binary frames: `u8 type`, `u16 reqSeq`, then a payload, all through a tiny `Writer`/`Reader` over `DataView`. Strings are UTF-8 with length limits.
  - Bulk data (late join, `ObjectAdd`, `ChunkData`) uses `CompressionStream('deflate-raw')` and is split into **pieces of 16 KB or less** (a safe SCTP message size across browsers), with `bufferedAmount` backpressure.
- `snap`: `ordered: false, maxRetransmits: 0`. Carries snapshots (host to guest) and `PlayerState` (guest to host), each 1,200 bytes or less to avoid IP fragmentation.
- Use JSON nowhere on the hot path. If debug or chat messages ever use it, parse it only, with a schema check.

### 6.2 Handshake and versioning

- `PROTOCOL_VERSION` lives in `src/net/Protocol.ts`.
- `__BUILD__` is the git SHA, injected through `vite.config.ts` `define` (on Vercel, from `VERCEL_GIT_COMMIT_SHA`).

| Step | Message | Notes |
| --- | --- | --- |
| 1 | Guest sends `Hello {protocol, build, playerId, name, look}` | `playerId` is random and kept in localStorage. In dev, `?player=2` overrides it so two tabs can be tested. |
| 2 | Host replies `Welcome {seed, worldId, netId, time, weather, roster[], yourSpawn}` or `Reject {reason: version, full, declined, password}` | **The build must match exactly**: game logic (combat, compose, interiors) is shared code. Message: "Reload both games to get the latest version." |
| 3 | Guest builds a replica `WorldManager` and sends its first `PlayerState` with its view rectangle | |
| 4 | Host adds the guest's view to `ChunkManager` and streams the area state for the guest's cache | See 6.4 |
| 5 | Guest runs `trySpawn` and sends `Ready` | The host shows "Ana joined" |
| Always | `Ping`/`Pong` once a second on `snap` | Gives the RTT used for lag compensation and the debug overlay |

### 6.3 Message types

H→G is host to guest, G→H is guest to host.

| Group | Messages |
| --- | --- |
| World (H→G, ctrl) | `BiomeAdd`, `BiomeDrop`, `RegionVisit`, `ChunkData`, `ObjectAdd`, `ObjectRemove`, `ObjectOpened`, `Harvested`, `Regrown`, `GroundAdd`, `GroundRemove`, `Anchor`, `Clock`, `Slept` |
| Entities (H→G, ctrl) | `EnemySpawn`, `EnemyGone {reason}`, `NpcSpawn`, `NpcGone`, `ProjectileSpawn`, `ProjectileGone`, `PlayerJoined`, `PlayerLeft` |
| Feedback (H→G, ctrl) | `Fx {kind, x, y, n}` (damage numbers, bursts, lightning, meteor, swing), `Notify {key, args}` (message **keys**, never raw HTML), `Hurt`, `Grant {items[], reason}`, `XP`, `KillCredit {speciesId, clearedKind?}`, `Waypoint`, `Result {reqSeq, ok, why}` |
| Requests (G→H, ctrl) | `ChunkWant`, `Attack {seq, x, y, dx, dy, weaponId, dmgBonus}`, `Harvest {gx, gy, deco, space, tier, forager}`, `OpenChest {objectId, index or chestId}`, `Pickup {groundId}`, `Drop {itemId, count, dur, x, y}`, `Talk {npcId}`/`EndTalk`, `Discovered {objectId}`, `Rest`/`RestCancel`, `StartInvasion {villageId}`, `RescueTargets [...]`, `Travel {x, y, reason}`, `Chat` |
| Snapshots (H→G, snap) | `Snap {seq, hostTime, ackInput, players[], enemies[], npcs[]}` |
| Player state (G→H, snap) | `PlayerState {seq, x, y, face, flags (moving, running, swim, blocking, dodging, invulnerable), action, held, wear[4], space, view {minX..maxY, dir}}` |

### 6.4 Interest management and late join

- The host's `ChunkManager` keeps one `View` per player (refactor P0-2). Each view has its own render, cache and sim rectangles. The host's cache is the union of all of them, which makes region visits and object lifetimes correct for everyone.
- For each guest, the host tracks that guest's cache keys. When they change, the entering chunks trigger `AreaState` deltas: biomes owning them, region visits, objects touching them, harvest cells, ground items. Leaving chunks let the guest drop the data.
- Late join is the same code path starting from an empty set, plus all anchors, current entities and the roster.
- Snapshots carry only entities in the guest's sim rectangle plus one chunk, and only in the guest's space.

### 6.5 Spaces (interiors)

- `space = 0` means outdoors. Otherwise `space = hash(objectId, building index, floor)`.
- Players in different spaces don't appear in each other's snapshots, except in the roster and on the map.
- Indoors, the host treats a guest's world position as `room.outside`, exactly like `Game.tick` does today. The guest's view stays centred on the door.

### 6.6 Rates, compression and interpolation

| Item | Value |
| --- | --- |
| Host simulation | Frame rate, variable `dt` capped at 0.1 s, as today |
| Snapshot rate | 15 Hz (configurable 10–20) |
| Guest `PlayerState` rate | 20 Hz |
| Interpolation delay | 100 ms, extrapolation capped at 150 ms |
| Quantisation | Positions as int32 at 1/64 tile; facing u8; HP u8 (percent); state u8 |
| Typical snapshot | Header 12 B, 4 players × 16 B, 20 enemies × 12 B, 8 NPCs × 9 B: about 400–600 B, so about 9 KB/s per guest |
| Delta compression | **Not in v1** (bandwidth is already small). Phase 5: baseline equals the last acked snapshot, plus a per-entity changed-field bitmask. |
| Lag compensation | The host keeps 1 s of enemy positions at 20 Hz. `Attack` is checked against positions rewound by RTT/2 plus the 100 ms interpolation delay, capped at 250 ms. |

### 6.7 Disconnect, reconnect, host leaving

- **Guest drops** (channel closes, or ICE `disconnected` for more than 5 s): the host removes the avatar and the guest's view, and writes the roster entry. Enemies retarget.
- **Reconnect:** for 10 s, try `restartIce()` over `ctrl` if it is still open. Otherwise the guest rejoins with the same room code (the host keeps the room open while hosting).
- **Host leaves or crashes:** guests show "The host left. Your character was saved." They save to `guest:<worldId>` and reload into solo. The replica world is thrown away.
- **No host migration.** The world save lives on the host, and moving it would mean transferring all of `SaveData`.

## 7. Saves

- **`SAVE_VERSION` 8** (`src/save/SaveManager.ts`, plus a `migrate` step):
  - `worldId: string` (`crypto.randomUUID()`; old saves get one in the migration).
  - `guests?: Record<playerId, { name, x, y, respawn, moonwells, lastSeen }>`.
- **Host:** saves exactly as today. The world includes guest-caused changes because the host applied them.
- **Guest:**
  - Never saves the replica world.
  - Saves a `CharacterSave` to `guest:<worldId>` in the same IndexedDB store. `CharacterSave` is `PlayerSave` minus the position, plus quests and exploration.
  - Holds a Web Lock named `untrue-guest-<worldId>`, not `untrue-save`, so a solo tab of the same browser keeps working.
  - Autosaves every 30 s and when the page is hidden, as today.
- **Characters are per world, not portable:** keeps the solo `main` save intact and avoids duplicating items between solo and co-op. "Bring my solo character (copy)" is an open question for Phase 5.
- **Positions live on the host** (roster): a returning guest appears where they left. First joins spawn next to the host.

## 8. Security and cheating

Trust model: friends' co-op, so preventing cheats is out of scope. The goal is that a malformed or hostile peer can't crash the game, corrupt the host's save, or inject HTML.

- **Validate every message:** check the type tag, finite numbers, ranges, and string length (names 16 characters or less, control characters stripped). Item ids go through `itemById`; unknown ids are dropped. Counts are clamped to stack limits. Object, NPC, enemy and ground ids must exist and be in the sender's interest area.
- **Size caps:** `ctrl` frames 16 KB or less; `snap` 1,200 B or less; total inflated size of a decompressed bulk transfer capped at 2 MB (guards against zip bombs).
- **Rate limits** (`src/net/RateLimit.ts`, token buckets per peer and type): `Attack` no faster than the weapon cooldown minus 10%; `Harvest` 4/s, `Pickup` 10/s, `Chat` 2/s, `ChunkWant` 30/s. A peer that floods for too long is kicked.
- **Sanity checks on the host:**
  - Speed at most 15 tiles/s (dodge) times a margin; jumps are allowed only through `Travel` (collapse or respawn).
  - Attack origin within 2 tiles of the last `PlayerState`.
  - Harvest and chest targets within 3 tiles, and the deco must match the host's composed tile.
  - `dmgBonus` at most the maximum for level 50 with Warrior 5; skill ranks 0–5.
- **Atomic first-come-first-served** for chests, ground pickups and harvests: the host decides and the loser gets `Result {ok: false}`.
- **No eval and no networked strings in `innerHTML`.** `Dialog.ts` (`<h4>${title}</h4>`) and `Menu.ts` (`<h3>${item.name}</h3>`) interpolate catalogue strings into `innerHTML` today. Switch both to `textContent` before NPC titles or player names ever arrive over the network. Notifications travel as message keys.
- **Joining:** the host has to accept every join; an optional room password; join attempts rate-limited by the signaling function.
- **Privacy:** WebRTC shows each peer's IP address to the others and to the signaling and TURN servers. Multiplayer must be opt-in (no STUN or signaling traffic until the player opens it). The About privacy text ("Nothing you do in the game is sent anywhere", `src/ui/About.ts`) must be updated. Offer "Hide my IP (relay only)" through `iceTransportPolicy: 'relay'`. If a CSP is added to `vercel.json`, it must allow the signaling and TURN endpoints.

## 9. Refactors needed first (Phase 0)

| # | Refactor | Files | Why |
| --- | --- | --- | --- |
| P0-1 | **`Character` bundle**: inventory, equipment, vitals, progression, respawn, `usedMoonwells`, exploration, quests, with `save()`/`load()` | new `src/game/Character.ts`; `Game.ts`, `LivingWorld.ts` (quests out), `SaveManager.ts` | `Game` scatters per-player state across fields; the host needs one bundle for itself and summaries for guests |
| P0-2 | **Multiple views in `ChunkManager`**: `update(views[], local)`. Cache is the union; sim becomes a set (`isSimulated(cx, cy)`, `simRects`); generation covers every view's render area plus the predicted strip, local first; `shown`/listener stay local-only | `ChunkManager.ts`, `WorldManager.ts` | Lets the host stream, simulate and count region visits for everyone |
| P0-3 | Replace every `simRect` use with `isSimulated` and per-player rectangles | `CombatSystem.ts` (`despawn`, `spawnWild`, `spawnAnimals`, `rollLegends`), `NpcSystem.update`, `LivingWorld.spawnLostTravellers`, `ExplorationSystem.update` (local `renderRect` only) | Same reason |
| P0-4 | **Combat with several bodies**: `update(dt, bodies: PlayerBody[] with id)`; each enemy targets the nearest body in aggro range and keeps it until 2.5× aggro; `hitPlayer` routes to `events.hurt(bodyId, …)`; `attack(attacker stats)` instead of reading `Inventory`; `kill()` returns `{xp, drops, killerId}` instead of `inv.add`; spawn caps per group of nearby players; `triggers()` per body | `CombatSystem.ts`, `Enemy.ts`, `Game.ts` | Combat assumes one `body` and one `inv` |
| P0-5 | **Ids owned by an instance, not the module**: `Enemy`, `Npc`, `GroundItem` take ids from an allocator the authority owns | `Enemy.ts`, `NPC.ts`, `GroundItems.ts` | Stable network ids |
| P0-6 | **World change events** (`WorldChanges` emitter): harvested, regrown, object added/removed/opened, ground add/remove, anchor, biome add/drop, region visit, chunk ready. No listener in solo, so no cost. | `WorldManager.ts`, `ObjectManager.ts`, `GroundItems.ts`, `BiomeManager.ts`, `Regions.ts` | Feeds host replication |
| P0-7 | **Replica mode in `WorldManager`** (`mode: 'authority' or 'replica'`): replica skips `ensure`, `resolveAnchor`, visit counting, `sweep`, `regrow`; adds `adoptBiome`, `setVisit`, `applyHarvest`; `harvest()` and `openChest()` become requests | `WorldManager.ts`, `BiomeManager.ts`, `Regions.ts` | Section 2 |
| P0-8 | **`NetChunkGenerator implements ChunkGenerator`**, plus a host-side chunk server that answers from `ChunkManager` or queues generation | new `src/net/NetChunkGenerator.ts` | Section 2, option C |
| P0-9 | **Split simulation from presentation in `LivingWorld`**: `LivingSim` (time, weather, hazards, NPCs, events, rest, quest hooks) and `LivingView` (lighting, particles, effects, dialog, vision). In `Game.tick`, `simulate(dt)` and `present(dt)` become separate. | `LivingWorld.ts`, `Game.ts` | Lets host and guest run headless together in Vitest; lets guests run a view without a sim |
| P0-10 | **Separate pause from blocked input**: split `paused` into `inputBlocked` and `simPaused`. In MP, menus don't pause the world. | `Game.ts`, `LivingWorld.ts` | In MP, the host opening the bag would otherwise freeze everyone |
| P0-11 | **Split `Player`** into `PlayerBody` (movement, collision, dodge; no Pixi) and `PlayerView` (sprite and animation, reused for remote avatars) | `Player.ts`, `EntityRenderer.ts` | Remote players need the view without the movement code |
| P0-12 | Security: `textContent` in `Dialog.ts` and `Menu.ts`; `__BUILD__` define | `Dialog.ts`, `Menu.ts`, `vite.config.ts` | Section 8 |

**Rule for Phase 0:** every refactor keeps solo behaviour unchanged. All current suites must pass unmodified, plus new tests for one view versus several.

## 10. Roadmap

### Phase 0: refactor (no networking)

- **Deliverables:** P0-1 to P0-12.
- **New tests:**
  - `ChunkManager` with two views: the union cache is right, region visits only rise when both views have left.
  - Combat with two bodies: retargeting, hits routed to the right body.
  - The replica `WorldManager` fed by an in-memory link ends up with **byte-identical `tiles`/`decos`** to the host for every chunk ready on both, after the guest walks a different path.
  - A test that writes down the problem: two independent authority worlds on different paths disagree on biomes.

### Phase 1: connect and see each other

- **Create:**
  - `src/net/Peer.ts`: two channels, backpressure, stats, and a `NetSim` latency, jitter and loss shim (`?netsim=lat:120,jitter:30,loss:0.05`).
  - `src/net/Codec.ts`, `src/net/Protocol.ts`.
  - `src/net/Signaling.ts` with `signaling/BroadcastSignaling.ts` and `signaling/ManualSignaling.ts`.
  - `src/net/Session.ts` (`HostSession`, `GuestSession`, roster, handshake, timeouts).
  - `src/net/Interpolation.ts`, `src/game/RemotePlayer.ts`.
  - `src/ui/MultiplayerPanel.ts` (a new pause menu entry: Host / Join / invite code / status / errors).
- **Modify:** `Game.ts` (MP boot: `?mp=host`, `?mp=join&room=…`), `PauseMenu.ts`, `EntityRenderer.ts` (avatars and name tags), `Hud.ts` (player list), `DebugOverlay.ts` (RTT, kbps, loss, candidate type), `vite.config.ts`.
- **Scope:** guests stream terrain, biomes, objects and the harvest log from the host (read-only world). Avatars are interpolated. Time and weather sync.
- **Tests:** codec round trips and random-byte fuzzing (decoders never throw past the boundary); a session test on an in-memory `FakeTransport` with latency, loss and reordering under Vitest fake timers (handshake, version mismatch, late join, host leaving); two-tab manual test over BroadcastChannel with `?player=2`.

### Phase 2: shared world edits and signaling

- **Deliverables:**
  - Harvest, chests (outdoor and interior), ground drop and pickup, discovery, Moonwells (per player), all as host-arbitrated requests.
  - `api/signal.ts` and `api/turn.ts` (Vercel Functions plus Upstash Redis), and `signaling/HttpSignaling.ts`.
  - Guest character slots (`src/save/CharacterStore.ts`), save v8 (`worldId`, `guests`).
- **Modify:** `GatheringSystem.ts` (in MP mode: request, then grant on ack), `GroundItems.ts`, `WorldManager.ts`, `SaveManager.ts`, `Game.ts` (`interact`, `drop`, `interactIndoors`).
- **Tests:** two guests race for the same chest or tree (exactly one wins); save v7 to v8 migration; a guest's harvest is in the host's saved snapshot; real cross-network tests (phone on mobile data, forced relay).

### Phase 3: enemies and combat

- **Deliverables:**
  - Host-simulated enemies replicated to guests: spawn/gone events, snapshot state, interpolation, ballistic projectiles.
  - Guest attacks with lag compensation, `Hurt` resolved by the guest, kill credit and XP sharing (proposal: full XP to every player within 16 tiles who damaged the enemy).
  - Guards, legends and the boss bar per local player; `restBlocked` counts only enemies targeting that player.
  - Hazards per player.
- **Modify:** `CombatSystem.ts`, `Enemy.ts`, `HazardSystem.ts`, `LivingWorld.ts`, `EntityRenderer.ts`.
- **Tests:** headless host plus 2 guests on `FakeTransport` with 150 ms latency and 5% loss (a melee swing at an interpolated enemy hits); pack aggro splits between players; dodge i-frames on the guest cancel a host hit; a dungeon clear writes `clearedAnchors` once.

### Phase 4: NPCs, trade, quests, events, rest

- **Deliverables:**
  - NPC replication; local dialogs and trade; quests per player (offers seeded by `offerKey`).
  - `StartInvasion` for defend quests; `RescueTargets` so the host spawns lost travellers for guests' quests.
  - World events rotate the player whose position the event uses.
  - **Rest vote:** a sleep skip happens only when every player is resting; otherwise "Waiting for others (1/3)". `Slept` plays `SleepOverlay` for everyone.
  - Story gated to the host.
  - Optional chat (`src/ui/Chat.ts`, log near `.hud-notes`, input on Enter/T; Input needs a typing guard; render with `textContent`).
- **Modify:** `NpcSystem.ts`, `QuestSystem.ts`, `WorldEvents.ts`, `LivingWorld.ts`, `StorySystem.ts`, `Dialog.ts`.
- **Tests:** a guest's slay quest progresses from `KillCredit`; a rescue escort for a guest; rest vote timeouts.

### Phase 5: polish

- Delta snapshots.
- Option D (a deterministic math module for generation plus per-chunk checksums) so guests can generate terrain locally.
- ICE restart, reconnect UX, kick and ban.
- Enemy HP scaled by player count.
- "Bring a copy of my solo character".
- Trystero/Nostr fallback signaling.
- Privacy text, and `docs/multiplayer.md` (plus the docs-site build).
- **Tests:** a soak test (4 tabs, 30 minutes) watching memory, kbps and GC; Windows `clumsy` for real packet loss (Chrome DevTools throttling does **not** affect WebRTC data channels); `chrome://webrtc-internals`.

## 11. Risks and open questions

**Risks**

- **The host tab in the background stalls the world.** `requestAnimationFrame` stops in hidden tabs, so the Pixi ticker stops and the simulation stops for everyone. Mitigation: while `document.hidden`, the host runs `simulate()` from `setInterval` with substeps (timers are throttled). Warn the host to keep the tab visible. Moving the simulation into a Worker is a possible later step.
- **Host CPU:** up to 4 sim areas, plus chunk generation for 4 render areas on 1–3 workers. Phones may not keep up.
- **Version skew:** Vercel deploys mid-session mean an exact build match is required. Show the reload message clearly.
- **Cost and terms:** Vercel Hobby is non-commercial only; KV and TURN free tiers have limits.
- **Story conflicts:** the host's ending changes `world.rules` and removes places while guests are present. Acceptable, since it is the host's world.
- **Item duplication:** guests own their inventory. Accepted for co-op; document it.
- **Phase 0 scope:** `Game.ts` (~1,500 lines) and `LivingWorld.ts` mix simulation, UI and rendering. The P0-9 and P0-11 splits are the largest and riskiest part. Do them in small steps with tests at each one.
- **Safari:** confirm data-channel behaviour and `CompressionStream` support (Safari 16.4+) early.

**Open questions**

1. Player cap of 4, or 2 for v1?
2. XP split rule; loot to the killer or round-robin?
3. Friendly fire off (proposed), and no PvP?
4. Can guests take part in the host's story (shared visions)?
5. Portable characters later? A copy, or a move?
6. Can the host kick a guest? A room password by default?
7. Should hosting work on mobile at all?

**Critical files:** `src/world/ChunkManager.ts`, `src/world/WorldManager.ts`, `src/systems/CombatSystem.ts`, `src/game/Game.ts`, `src/game/LivingWorld.ts`, `src/save/SaveManager.ts`, `src/world/BiomeManager.ts`, `src/world/Regions.ts`, `src/ui/Dialog.ts`.
