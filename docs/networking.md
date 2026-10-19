# Networking

Multiplayer without a server of our own. Players link to each other directly over WebRTC data channels; the only third parties are public Nostr relays (to find each other) and public STUN servers (to learn their own address). The plan behind it is in [overview-diagram.html](overview-diagram.html) and [multiplayer-plan.md](multiplayer-plan.md).

Code: `src/net/`, used by `src/coop/` (shared dimension instances) and loaded lazily with it, so solo play never downloads it.

## Two kinds of session

| | Overworld | Dimension instance |
| --- | --- | --- |
| Who | Friends, by invite code | Anyone; listed on the board |
| Shape | Star: guests link to the host only | Mesh: everyone links to everyone |
| Most players | 5 (host and 4 guests) | 8 |
| Host leaves | The session ends for everyone | The longest-connected member takes over |
| A link drops | Their slot is held 30 s; they rejoin by the same code | The same; if it was the host's, a new host takes over |

## Modules

| File | What it does |
| --- | --- |
| `codec.ts` | `Writer` (one reused, growing buffer: no allocation per message once grown) and `Reader` (every read bounds-checked; marks itself failed instead of throwing) |
| `protocol.ts` | Every message: type byte, shape, encode and decode. Decoders return null for anything malformed |
| `snapshot.ts` | Entity snapshots, delta-compressed against the receiver's last acknowledged frame, at most one packet each |
| `transport.ts` | `Transport` (a link: ctrl and snap channels), `RtcTransport` over `RTCPeerConnection`, `RtcLinker` (makes links from session descriptions), STUN list, close reasons |
| `auth.ts` | Proving a key on a link (challenge, Schnorr signature bound to the link's DTLS fingerprints) |
| `session.ts` | `Session`: membership, slots, join orders, hosts, mesh introductions, host migration, pings and the shared clock |
| `codes.ts` | Join codes (Crockford base32, XXXX-XXXX) and the join rate limiter |
| `crypto.ts` | Code keys (PBKDF2 then HKDF), AES-GCM sealing, SHA-256, base64url, raw deflate |
| `signaling.ts` | Join by code over a `Bus` (`NostrBus`, `BroadcastBus`, `MemoryHub`), and manual copy-paste codes |
| `nostr.ts` | Minimal Nostr client: signed events (NIP-01), relay pool with reconnects, event checks |
| `board.ts` | The board of open dimension instances on Nostr |
| `identity.ts` | This browser's keypair, name and block list (localStorage, every access guarded) |
| `join.ts` | `joinByCode` (guest) and `hostByCode` (host) |
| `index.ts` | `Net`: what the game calls; re-exports what it needs |
| `fake.ts`, `fakeRelay.ts` | In-memory links and relay for tests |

## Channels and messages

Every link has two pre-negotiated data channels (ids 0 and 1, so either side can make the offer):

- **ctrl** (`CTRL`, 0): ordered and reliable. Joining, membership, introductions, hosts, run state, events and requests. At most 64 KiB a message.
- **snap** (`SNAP`, 1): unordered, no retransmits. Pings, player state, snapshots and acks. At most 1200 bytes a message (one packet, no IP fragmentation). Dropped while 64 KiB is queued.

Types 1–31 are the session's own; 32–63 are passed to the game (`session.on.message`).

| Type | Message | Channel | Notes |
| --- | --- | --- | --- |
| 1 | Hello | ctrl | Guest to host: protocol, game version, mode, dimension, map hash, key, name, signature |
| 2 | Welcome | ctrl | Host to guest: slot, host slot, epoch, host clock, resumed, every member |
| 3 | Reject | ctrl | A reason (`RejectReason`, with text for each in `REJECT_TEXT`) |
| 4, 5 | Ping, Pong | any | Round trips and the shared clock |
| 6, 7, 8 | MemberJoined, MemberLeft, MemberAway | ctrl | From the host only |
| 9 | Intro | ctrl | Mesh: the host asks a member to offer a link to a newcomer, then relays the offer and answer |
| 10 | PeerHello | ctrl | First words on a direct member-to-member link |
| 11 | HostClaim | ctrl | "I am the host now", with the new epoch |
| 12 | Handoff | ctrl | A leaving host names its successor |
| 13 | Bye | ctrl | Leaving on purpose |
| 14 | RunState | ctrl | A dimension run (below) |
| 15 | Challenge | ctrl | Host's first words on a new link: a nonce to sign |
| 32 | PlayerState | snap | 21 bytes: slot, tick, position (1/32 tile), facing and animation, health, held item, flags |
| 33 | Snapshot | snap | Entities, as a delta (below) |
| 34 | Ack | snap | Newest snapshot tick received |
| 35 | Event | ctrl | A kind, up to 16 integers, and a short text |
| 36, 37 | Request, Response | ctrl | A guest asks (hit, pick up, interact, open chest, harvest, drop, use); the host answers |
| 38 | World | ctrl | A shared overworld's own messages, with a kind byte after the type: the land, its objects, ground, clock, whereabouts and requests (`src/coop/worldWire.ts`, below) |

Positions travel as whole 1/32 tiles in an i32; health as a u16 share of the maximum; items and entity kinds as u16 indices the game maps to its own ids. The protocol version (`PROTOCOL`) rises whenever any message changes shape; peers on another version are refused.

### Snapshots

The host keeps a `SnapshotSender` per receiver. Each tick the game fills its `frame` with what that receiver should see, most important first (`push(id, kind, x, y, dir, health, flags)`), and sends `encode(writer, tick)`. Each entity is written only with the fields that changed since the receiver's last acknowledged frame (position as a one-byte step on each axis when it is small); removals go first. Whatever does not fit in 1200 bytes waits: the sender records each frame exactly as the receiver will rebuild it, so leaving things out never desynchronises the two. Up to 128 entities a frame. Frames are typed-array columns reused for the whole session, and id lookups go through a stamped table: a tick allocates nothing.

The receiver's `SnapshotReceiver.read` rebuilds the frame (or returns null: malformed, stale, or built on a frame it no longer has) and the game acknowledges the frame's tick with an Ack. Under loss and reordering it converges as soon as acks get through (tested with 20% loss, reordering and constant churn).

### Run state

A dimension instance's host shares the run with `setRunState`: trials (idle, active, done), whether the boss gate is open, the boss's health share, phase and summons, when it returns (on the shared clock), and the contribution table: per player key, a score, whether they are attuned (may close their rift through the portal) and whether they have claimed their share of the chest. `extra` (up to 1 KiB) carries anything else the game keeps per run. Every member keeps the latest, so a new host carries on from it.

## Flows

### Joining by code

1. The host shows a code (`newCode`, 40 bits). PBKDF2 (100 000 rounds) and HKDF turn it into a **topic** (published) and an **AES-GCM key** (never published). Relays see the topic, not the code, and guessing codes against a topic costs 100 000 hashes a guess.
2. The guest makes an offer (`linker.offer`, ICE gathered whole, up to 3 s), seals `{offer, request id, name, key, time}` and posts it on the topic, again every 4 s until answered (the host may not be listening yet, a relay may drop it).
3. The host opens it (stale or replayed messages are ignored), checks the rate limit (8 a 30 s, 3 per sender, at most 3 weighed at once), the room, the block list (and keys kicked this session) and `on.joinRequest`, and answers (`session.admit`) or refuses (sealed Reject). Answers and refusals are **signed** with the host's identity (`hk`, `hs` in the envelope): a guest who knows whom it is joining (a board note names the host; a rejoin knows the host it met) takes only that host's replies, so a stranger listening on a public code can neither answer first nor turn guests away. Offers over the rate limit are dropped without a word: answering a flood costs a signature and a post, which is what a flood wants.
4. The link opens. The host sends a **Challenge**: a nonce, its own key and a signature over the nonce, the link's binding (both ends' DTLS fingerprints) and that key; the guest checks it, and that it is the host expected (else `ConnectError('impostor')`). The guest's **Hello** carries a Schnorr signature over the nonce, the binding and its key, so a key cannot be claimed by someone who does not hold it, and a signature cannot be passed on to another link. A guest who named a key when asking (a returning member skips the host's question) must say Hello as that key. Then version, mode, dimension and map hash are checked; the host sends **Welcome** (and the run state), which must name as host the key proved on the link, and tells everyone else (**MemberJoined**).

On Nostr, signaling posts are ephemeral (kind 25050: relays pass them on and never store them) and signed with a throwaway key, so they say nothing about who is joining.

**Manual code** (no relays at all): `manualCode('invite', offerSdp)` packs a whole session description (raw deflate, base64url, `UNTRUE1I.`); the other player answers with `manualCode('reply', answerSdp)`. `readManualCode` refuses anything that is not one, or inflates past 16 KiB.

### The board

A dimension host posts a note every 60 s (kind 30078, addressable by instance id, `t` tag `untrue-dim-<id>`): players, room, seals broken, game version, the instance's code and the host's name, expiring after 3 minutes (NIP-40). Stopping replaces it with a full note that expires at once. `findInstances` asks every relay, waits for the first to finish (plus 0.4 s for the rest, 3 s at most), and keeps live, open notes on this game version from hosts not blocked, **one per host** (its newest), **in a random order**. Notes that claim what no host could are refused (`parseNote`): room past 8, more players than room, a time more than a minute ahead, a life longer than a note's. So made-up notes cannot crowd the top, and each join attempt is bounded (`Coop.enter`: two tries of 3 s each, answer and link together, within the passage's 9 s hold). The code is public: anyone may join an instance from the board, and only the note's host may answer on it.

### Mesh introductions

When someone joins a dimension instance, the host asks every other member to offer them a link (Intro, kind 0). Each offer goes to the host (kind 1), which relays it to the newcomer after checking it really comes from that member and is one it asked for (one offer per introduction, then one answer back: unasked offers are dropped, so no member can make another open connections without end); the answer comes back the same way (kind 2). A member ignores an offer from someone it already has, or is already answering. The direct link then opens and both ends send PeerHello. Only the first link ever needs signaling, and the DTLS fingerprints in the relayed descriptions tie each direct link to the member the host vouched for.

### Host migration

Every member knows every member's join order. When the host's link drops, each member drops the host and picks the longest-connected member left that it can reach (lowest order, then lowest key). That member becomes host (epoch + 1, a u32), claims it over the links that already exist, says the old host left, and carries on from the last run state; the shared clock carries on too. Others wait for the claim, and pass over a successor that never claims within 5 s. A leaving host hands off first (Handoff, then Bye).

**Claims are checked.** A claim counts only for the very next handover (`epoch + 1`, not any higher) and only from the member who should take over (the one awaited, or one outranking it): no member can seize an instance by claiming it, early or with a huge epoch. While the host still answers, a member keeps only the next host's own claim (in case the host goes), and never acts on it, so one member losing only its link to a live host cannot split the instance. A rival claim for the same handover (two took over at once) counts only for a moment after it, and the lower-ranked steps down. A member that would take over while a member it cannot reach outranks it is the cut-off side: it ends its session and plays on alone rather than splitting the instance. Whoever hosts also takes over listening on the instance's code and its board note (`Net` does this on `roleChanged`).

### Floods

Every link has an allowance (`Session.spend`): 200 messages and 256 KiB a second, 600 and 1 MiB at once (a guest's first chunks come in a burst). Past it messages are dropped; a link that keeps flooding (200 strikes, fading as it behaves) is cut. Relays get a budget too: an event is checked against the subscription's filter before its signature, and at most 40 signatures a second are checked per subscription. Relay sockets open only when there is something to send or hear, and close after 20 s idle.

## How the game uses it

Dimension instances (`src/coop/InstanceLink.ts`, see [dimensions.md](dimensions.md#playing-with-others)) and visiting a friend's overworld by code (`src/coop/WorldHost.ts`, `WorldGuest.ts`, see [multiplayer-plan.md](multiplayer-plan.md#overworld-by-invite)) are both wired in.

- **Loading.** `Game.loadCoop()` does `import('../coop')` the first time a public rift trip starts or the Drift Beacon lists instances or names the player. `src/coop` imports `src/net` statically, so Vite makes them one separate file (about 147 KB, 49 KB gzipped); the main bundle holds none of it, and a private trip never loads it.
- **`Coop`** (`src/coop/index.ts`) owns one `Net` for the page. `GAME_VERSION` (`untrue-<items>.<species>-c1`) is what peers must match: the indices of items and creatures on the wire, and the game's own messages. `?net=local` gives it `signaling: 'local'`, a BroadcastChannel relay for the board (`src/coop/localRelay.ts`) and `storage: null` (a fresh key per tab, since a key cannot meet itself).
- **Entering a public rift.** `Coop.enter(dimension, mapFile, isPublic, prefer?)`: hashes the map file as loaded (`DimensionCache.file`), asks the board (2.5 s at most), tries two instances with room (the beacon's choice first, 3 s each, only their note's host may answer), else `hostInstance`. The rift's passage holds at full cover meanwhile (`RiftTransition.holding`, 9 s at most), then the trip starts with an `InstanceLink`, or alone.
- **`InstanceLink`** (`src/coop/InstanceLink.ts`) sets `session.on` and plays one player's part:

| Message | Sent | What the other side does |
| --- | --- | --- |
| `PlayerState` (snap) | Everyone, 20 Hz, broadcast over the mesh | Draws the player (smoothed, 100 ms behind); the host also moves them in the run and aims its creatures |
| `Snapshot` / `Ack` (snap) | Host to each guest, 20 Hz: creatures and enemy shots within 36 tiles, the Warden first | Rebuilds the frame; makes, moves and removes replicas |
| `RunState` (ctrl) | Host, when the run changed (10 Hz at most, every 2 s at least) | Mirror takes on every site, gate, the Warden, the vault taken; carries `extra` (`runSync.ts`) |
| `Event` (ctrl) | Host: the run's news to everyone; damage, kills, shares and vault rewards to one guest | Sounds and notices; a hit through armour; xp and items; attunement |
| `Request` (ctrl) | Guest to host: a blow on a creature (id, strength, direction, crit, ranged), opening the vault | Host checks reach (from where it believes they are), rate (10 a second, by time) and strength (at most what the weapon in their hand could strike: `maxBlow`), applies the blow as the guest's; answers the vault with a reward or why not, and shares the run state at once after a claim |

- **What a host believes** (`src/coop/guard.ts`). Guests run their own players, so the host plays only what a player could do: `MoveGuard` follows a guest at a player's speed (with room for lag bursts and a dodge); a jump is believed only back to a spot held lately (a fall caught), when the game vouches for it (waking beside the host), or once held steadily for 1.5 s (a stall, a respawn). Until then they are drawn where they say, but creatures, reach and the run go by the last believable spot. A guest takes from the host no blow harder than a creature could strike (`MAX_DAMAGE_TAKEN`) and no more xp than a kill could give (`MAX_KILL_XP`).

- **Host migration** (`on.roleChanged('host')`): the run becomes authoritative from the last `RunState` (`DimensionRun.becomeAuthority`, tally included), replicas become creatures by the same ids (`RiftTrip.adopt`), and the new host starts sending. Others swap to a fresh `SnapshotReceiver`. Members the session drops quietly on a handover are pruned on any role change. If every link is lost, the instance carries on alone.
- **Combat seams** (`CombatSystem`): `others` (other players' feet, nearest hunted), `onOtherHit`, `onOtherKill`, `strike` (a checked blow from another player), `takeHit` (a blow from another machine), `onReplicaHit` (a blow on a replica), and `Enemy.replica` / `Projectile.replica` (moved by the network, never thinking here).

### A shared overworld

- **Opening.** The beacon's "Open my world" calls `Coop.openWorld` (`Net.hostWorld` with room for 4 visitors, 2 on a phone) and makes a `WorldHost`. It sets the world's `changes` listener, the ground's listener and the chunk manager's `onReady`; `Game.tick` passes `worldHost.views` to `world.update`, so the host streams and simulates for everyone. The host is asked about every visitor (`joinRequest`: a dialog).
- **Visiting.** The beacon's "Visit" saves and reloads the page with `?join=CODE`. A `?join=` link from anywhere else asks first (joining shows the host this player's network address); the beacon's own jumps are approved for the tab. `Game.start` then calls `Coop.joinWorld` before anything else, and asks the host for the world (`W.Hello` → `W.Info`: seed, where the host stands, clock, weather, whether it is a test world). The game builds a replica `WorldManager` on the guest's `NetChunkGenerator`, takes the character from its own save and the clock from the host, and spawns beside the host. `WorldGuest.attach` then hooks the world's `changes` (closed rifts go to the host), the ground's `reach` (picking up asks the host), gathering (`GatheringSystem.confirm`: the plant goes at once, what it gives only once the host says yes, so two players on one tree get one tree's wood), and combat (blows on replicas are requests). A session that ends while the game is still loading is said once it is attached; one where chunks are waited on and the host says nothing for 30 s is ended as lost.
- **Nothing lost on the way.** Something put down while the host cannot be reached waits and goes once it can (back in the bag if the visit ends first); something the host will not put on its ground (bound, more than a stack, too far, too many of the guest's things lying there, too fast) is given back (`Give`). After anything is given or put down, the character is saved a second later (`saveSoon`), so closing the page cannot keep both the thing and its trace on the host.
- **Back after a drop.** The host keeps an away guest's view (their land must not drift) and, when they are back, sends every chunk they hold again; the guest puts right its harvest, ground and objects there (`refreshChunk`).
- **Chunk requests never leak.** The host tells a guest when a chunk it waits on was let go before it was made; the guest lets go of requests its chunk manager no longer waits on (`NetChunkGenerator.prune`, answering them as cancelled so the count of requests in flight stays right).
- **A host away from the keyboard.** Indoors with a menu open, the clock and creatures still go on for guests outdoors; with the tab hidden (no frames), the game steps on a 100 ms timer while anyone plays in what this machine runs (a world with visitors, or an instance it hosts).
- **Order.** World messages a guest receives are applied strictly in order, one at a time (inflating is asynchronous), so a later change is never overtaken by an earlier chunk.

| World kind | From | What |
| --- | --- | --- |
| 1 Info | Host | Seed, host's spot, clock, weather, test world |
| 2 View | Guest | What they see (centre and half-size in tiles, at most 64 × 40) and their spot; the host keeps that area (a chunk more each way). Sent when the view moves 4 tiles, or their spot 1 tile, or they change place |
| 3, 4, 5 ChunkReq, ChunkLater, Chunk | Guest, host, host | A chunk asked for; not yet (outside what the host keeps for them: ask again in 0.4 s); the chunk: visit, biome, deflated base terrain, object ids, harvest, ground items |
| 6, 7, 8, 9, 10 ObjectDef, ObjectNeed, ObjectForget, ObjectGone, ObjectState | Host, guest, guest, host, host | An object (deflated layout, buildings, chests opened, closed); asking for one; letting one go (its chunks left); one gone; chests or rift changed |
| 11 Harvest | Host | A chunk's harvest log, whole |
| 12, 13 GroundAdd, GroundGone | Host | An item put down, or taken away |
| 14 Time | Host | Day, minute, weather |
| 15 Where | Anyone | Outdoors, a room (object, building, floor) or behind a rift, and the mover's state tick (older states, reordered, belong to the old place); the host relays it |
| 16 RiftInstance | Anyone | Gone into a shared instance of a dimension, by its code: friends follow |
| 17 Resync, 18 Hello | Guest | Send creatures in full again (back from a rift); send Info |
| 20–25 HarvestReq, ChestReq, PickupReq, DropReq, CloseRiftReq, MineReq | Guest | Requests the host checks: place, reach, still there; a chest or a mined tile in a room must really be in the room they are in (the host builds the room to check); a rift is closed only by one who came back out of a rift by it lately; chunk and object asks are rate-limited, and objects already sent are not sent again |
| 30 ChestReply, 31 Give, 32 HarvestReply | Host | Whether the chest is theirs; what they picked up (or a drop given back); whether a gathering or mining was theirs |

## Limits (v1)

- **No TURN.** About 10–20% of pairs (mobile data, strict office or school networks) cannot link directly; the link times out after 15 s with words saying so (`CLOSE_TEXT`). A TURN server can be added later through `RtcOptions.iceServers` and `relayOnly`.
- **Relays are not ours.** If all six are down, codes and the board do not work; the manual code always does.
- **An orphaned host.** A host whose own network failed (while the rest migrated) keeps hosting alone under the same code until it notices; joins may reach it. Rare; the game can end a session whose host has had no members for a while.
- **Join codes are 40 bits.** Fine against guessing over relays (100 000 hashes a guess); not against a GPU farm that recorded topics. A friend's world still asks its host about every visitor, and kicked keys stay out for the session.
- **Cheating is bounded, not prevented.** There is no server: guests own their bags (a modified one can drop items it never had, capped at a stack and its share of the ground), and a modified host can do anything in its own world or instance. Strangers meet only in dimension instances, where the guards above apply.
- **One board note per `Net`.** One hosted instance at a time.
- Board notes and signaling depend on relays honouring ephemeral kinds and NIP-40; notes are also filtered by expiry on arrival.

## Tests

`npx vitest run src/net` (54 tests, about 4 s):

- **Codec and protocol:** every message round-trips; every message cut short or with a byte added is refused; 20 000 random inputs and 9 500 mutated messages never throw.
- **Snapshots:** full then delta, removals and new entities, the one-packet budget with catching up, convergence under 20% loss with reordering and churn, missing baselines, fuzzing.
- **Codes, crypto, signaling:** code format and typing, the limiter, key derivation, sealing and tampering, deflate bombs, join by code over a hub and over BroadcastChannel, refusals, wrong codes, stale messages, manual codes.
- **Nostr and the board:** signatures and tampering, the relay pool (dedupe, forgeries dropped, resubscribe after a reconnect, junk), board listing (live, open, version, dimension, blocked, stopped, expired), malformed notes, identity storage.
- **Sessions** (fake links, fake timers): joining and talking, the shared clock, full / declined / blocked / wrong version / wrong map, a Hello signed with the wrong key, slots held and given back, kicks, the host leaving, mesh links through the host, migration (with run state kept and a newcomer introduced after), a successor that is gone too, handoff, and no split when one member loses only its link to a live host.
- **Security** (`security.test.ts`): no one followed who claims the host while it is up, nor any far-future claim (the rightful successor takes over); a host that is not the one expected is refused (`impostor`), and a rejoin finds the host it met or none; a stranger naming a member's key to skip the host's question is refused; a kicked key stays out; unasked mesh introductions are not relayed; a flood is dropped past the allowance and the flooding link cut; only the expected host's signed answer is taken on a code where a stranger answers first and refuses.
- **End to end** (`net.test.ts`): `Net` over fake links with a hub and with a fake relay: join a world by code and rejoin after a drop; find an instance on the board, join it, lose its host, and join again under the new host.

### Two-tab manual test

1. `npm run dev`, then open the game in two tabs of one browser.
2. In the console of each: `const net = await import('/src/net/index.ts'); const n = new net.Net({ gameVersion: 'dev', signaling: 'local' });`
3. Tab A: `const w = await n.hostWorld(); w.code`.
4. Tab B: `const s = await n.joinWorld('<the code>'); s.members()`.
5. Send: `s.sendToHost(net.CTRL, net.writeEvent(new net.Writer(), { kind: 1, ints: [], text: 'hi' }))`, with `w.session.on.message = (f, c, d) => console.log(net.readEvent(new net.Reader(), d))` set in tab A.

This was run in headless Chrome with real `RTCPeerConnection`s (three tabs): a join by code in about 240 ms, both channels, a direct (host) path with a 1 ms round trip, a dimension mesh introduced through the host, and a handoff to the next member.

### Shared dimension tests

`npx vitest run src/coop` (25 tests, about 20 s, fake links and a fake relay). The guards (`guard.test.ts`): a walk and a run followed, a teleport not until it holds, a jump back to a recent spot and a vouched one taken; blows capped by the weapon in hand; allowances; chunk requests let go of answered as cancelled; a visitor's quests kept in their character save. The shared overworld (`world.test.ts`): the guest's chunks are the host's byte for byte, biomes and objects included; streaming follows a guest far from the host, and the host keeps both areas; gathering on either side reaches the other, a guest is given what they gathered only once the host says yes (and nothing for a tree already gone), and a guest's gathering out of reach is put right and gives nothing; what may not be put down (bound, more than a stack, too far) is given back; a chest opens for one player only; items dropped by one are picked up by the other; the host's creatures seen, struck and striking; the clock shared; a guest sent home; players drawn only where they are (outdoors, the same room); a visit that ended while the game was loading is said once it is attached. The dimension instances: smooth motion (tracks and the tick clock); a run packed for the wire and taken on by a mirror, junk refused; run events in and out, a player's own kept home; two players who see each other, the host's creatures sent to the guest and the guest's blows landing on them (and refused out of reach); the host's creatures striking the guest through the guest's own health; the Warden settled by who fought it, the guest's share of the vault given once; and the host's tab dying, with the longest-connected guest taking over the run and the creatures by the same ids while the third keeps seeing them.

**In the game, on one machine:** `npm run dev`, then open two or three *windows* (a hidden tab gets no animation frames) of `http://localhost:5173/?playground&net=local`, and press **Enter the Hollow (shared)** in each, a few seconds apart. The first opens an instance; the others find it on the board and join. This was run in three headless Chrome windows with real WebRTC: opening an instance took under 1 s and joining about 2.5 s from pressing E; each saw the others move; a guest's blows took a host creature from 26 to 1 health; the seals and the Warden reached every guest; shares were settled by the tally and a guest took its share of the vault; with three players the frame work was 0.69 ms on the host and 0.61 ms on a guest (0.55 ms alone); closing the host's window handed the instance to the next player, the third saw it go on.

**After the security fixes** (two headless Chrome windows, real WebRTC, `?join=` link): the link asked first (a dialog) and the visitor arrived in about 4 s; the host believed the visitor beside it once they had stood there a moment; a tree the visitor gathered went for the host and the visitor got its wood only after the host's yes; the visitor picked up the host's wood (gone from the host's ground) and dropped it back (on the host's ground); both went into the same house and saw each other's names there; closing the world sent the visitor home with the reason. Names over players are crisp at every zoom and indoors (screen-pixel font, `src/rendering/PixelText.ts`).
