# Multiplayer plan

Playing with others, with **no server of our own**: players' browsers link directly over WebRTC, public Nostr relays carry the few messages needed to find each other, and public STUN servers tell each browser its own address. The overview diagram is [overview-diagram.html](overview-diagram.html); the network itself is [networking.md](networking.md).

| | Overworld | Outer dimensions |
| --- | --- | --- |
| Who | Friends, by invite code on the Drift Beacon | Anyone: instances are listed on a public board |
| Shape | Star: guests link to the host | Mesh: everyone links to everyone (8 at most) |
| The land | Streamed by the host (its world is generated, and only the host's is right) | A fixed map file everyone already has (hash-checked) |
| Host leaves | The session ends; guests keep their character | The longest-connected player takes over |
| Status | **Built** (`src/coop/World*.ts`) | **Built** (`src/coop`, over `src/net`) |

## Key decisions

| Topic | Decision |
| --- | --- |
| Backend | None. Static hosting only. Relays and STUN are public and not ours; a manual copy-paste code always works without them. |
| Transport | Raw `RTCPeerConnection`, two pre-negotiated data channels: `ctrl` (ordered, reliable) and `snap` (unordered, no retransmits, one packet). |
| Signaling | A join code (XXXX-XXXX, 40 bits) stretched into a public topic and a private key: relays see neither the code nor the offers. BroadcastChannel for tabs of one browser (`?net=local`). |
| NAT | Public STUN only. No TURN in v1: about 10–20% of pairs cannot link, and the game says so. A TURN service can be added later without changing anything else. |
| Authority | One host decides: creatures, the run, the world. Everyone moves their own player; the host checks what others ask of it (blows, the vault). |
| Identity | A random keypair per browser (`localStorage`), a chosen name, a block list. No accounts. |
| Saves | Each player saves their own character and story progress; a dimension instance is never saved; an overworld session's world is the host's save. |

## Outer dimensions (built)

How it plays and what travels: [dimensions.md](dimensions.md#playing-with-others). In short:

- **Entering a public rift** looks on the board for an instance of that dimension with room, joins it, or opens a new one, all while the rift's passage holds at full cover (9 s at most, then alone). Private trips (the beacon's switch) never touch the network.
- **The host runs the run and every creature.** Each guest gets the creatures near it as delta snapshots (20 Hz), the run's state when it changes, and the run's news. Guests' blows are requests the host checks (reach, rate, strength) and applies as theirs; creatures' blows on a guest are events the guest takes through its own armour.
- **Rewards by contribution.** Damage to the Warden and its summons, and trials broken (shared among those present), make each player's share of the vault and of the rift's experience. A tenth of the score, or a trial broken, attunes a player: the portal closes only their own rift. The Warden returns 20 minutes after it falls.
- **Host migration.** The longest-connected player's mirror becomes the run, from the last state shared; the creatures it drew become real, by the same ids. No new signaling: the mesh's links already exist.
- **Several dimensions, revisited.** Each dimension is its own fixed map and its own instances. A rift opens onto the next dimension the player has not cleared; at a rift the player can retune to any dimension cleared before (to explore, read missed lore stones, or help others).
- **Later:** dimension maps can be sent by a server instead of shipping in the bundle (`DimensionSource`); the instance code does not change, since peers compare the map file's hash either way.

## Overworld by invite

A friend visits the host's world. The host opens the Drift Beacon (**B**), presses **Open my world** and reads out the code (XXXX-XXXX); the friend types it into their beacon (**Visit**) and arrives, through the beacon's jump, beside the host. The host is asked first ("… wants to visit your world": Let them in / Not now; no answer in 30 s is no). Nothing of it is public: there is no board for worlds.

| | |
| --- | --- |
| Visitors | 4 at most (2 when a phone hosts: the host's machine does the work of everyone's world) |
| Shape | Star: visitors link to the host, which relays their moves to each other |
| Saves | The host saves its world as always. A visitor saves only their character into their own save ([saves.md](saves.md#visiting-a-friends-world)), and comes home to their own world as they left it |
| Going home | The beacon's **Go home**; the host sending them home (**Send home**) or closing the world; or losing the host (after its 30 s rejoin window). The visitor's character is saved, and their own world loads with a line saying why |
| Dying while visiting | The visitor wakes beside the host, keeping everything (as dying anywhere in the overworld) |

### The land is streamed, so every chunk is the same

Generation from the seed is not the same everywhere: biome borders depend on which chunk loaded first, region visits on where each player went, structure placement skips around live objects, and `Math.sin`/`cos`/`hypot` differ in their last bits between browsers. So the host sends what it has, and visitors generate nothing:

| State | How it reaches a visitor |
| --- | --- |
| Terrain | The visitor's `NetChunkGenerator` (in place of the worker pool) asks the host for each chunk its `ChunkManager` schedules. The host answers with the chunk's base tiles and decorations exactly as its workers made them, raw-deflated once per chunk (about 340 bytes a chunk) |
| Region visit, biome | With each chunk: the visitor's `WorldManager` is a **replica** (`new WorldManager(seed, gen, true)`): it never grows biomes, rolls structures or counts region visits, and adopts the host's (`adoptChunk`) |
| Structures | Each chunk lists the host's ids of the objects over it; the visitor asks for any it lacks, and the whole object (its layout, buildings, chests opened, rift closed) comes deflated, before the chunk is composed |
| Harvest log | With each chunk, and again whenever it changes (gathered, grown back) |
| Items on the ground | With each chunk, and as they are put down and taken |
| Clock and weather | Every 5 s, and at once after the host sleeps |
| Creatures and enemy shots | Snapshots near each visitor, 20 a second, as in a dimension |

The visitor composes each chunk with the same code as everywhere (base bytes, then the objects stamped over them, then the harvest log), so every chunk is the same, byte for byte (tested, and checked in real browsers by hashing every chunk on both sides). The host keeps each visitor's view in its own chunk manager ([world-streaming.md](world-streaming.md#with-friends-visiting)), so it generates and keeps the land around every player, and a region drifts only once it has left everyone's area.

### Who decides what

| What the visitor does | How |
| --- | --- |
| Moves | Their own; sent 20 a second, drawn by everyone 100 ms behind |
| Gathers (chops, mines, picks) | Done at once on their side, sent to the host, which checks it is still there and within 4 tiles of them, and applies it (everyone sees it go); if not, it sends the chunk's true harvest back and the plant comes back |
| Opens a chest (outdoors or in a room) | Asks the host; it opens only if no one has yet. "Someone got to it first" otherwise |
| Picks up an item | Asks the host as they walk over it; it is theirs if still there and within reach |
| Drops something, or overflows a full bag | Asks the host to put it down there (or at the doorstep, if indoors or behind a rift) |
| Strikes a creature | A request the host checks (reach, 10 a second, strength), as in a dimension; a kill's experience and spoils come back to them |
| Is struck | The host's creature decides; the blow comes as an event, through the visitor's own armour |
| Closes a rift | Asks the host to close it in the world |
| Sleeps | Cannot: it is the host's world (the host's sleep moves everyone's clock) |

Villagers, quests, trade and the story are each player's own: a visitor's villagers walk and talk on their machine only. World events, fires and weather are the host's.

**Rooms.** A visitor can go into any building: a room is made from its object alone (`Interior`), so it is the same for everyone. Each player says where they are (outdoors, which room and floor, or behind a rift), and players are drawn only where they are: outdoors, or in the same room on the same floor.

**Rifts with friends.** With friends in the world, a rift trip always opens a shared instance (listed on the public board only if the beacon says public). Whoever goes in tells the others the instance's code; a friend stepping through a rift into that dimension follows them in, else the trip goes on as usual. While the host is behind a rift, the overworld's creatures wait with it, so visitors outdoors meet none.

### Performance

Playing alone loads none of it (it is in the lazily loaded multiplayer chunk) and runs none of it: no world listener, no per-player areas, no extra branch that costs anything. With friends: headless Chrome, software rendering, three windows on one machine, average game work per frame (the other two windows running worlds of their own, then visiting): **0.44 ms alone, about 0.8 ms hosting two visitors** (who stand 30–40 tiles away, so the host keeps three areas of land and creatures), and about 0.8 ms on a visitor. Messages are reused buffers; chunks are deflated once and kept per chunk; objects' layouts once per object.

## Security

A peer can send anything, so (details in [networking.md](networking.md)):

- **Messages.** Every message is decoded with bounds checks and dropped if malformed; sizes are capped (`snap` one packet, `ctrl` 64 KiB, inflated codes 16 KiB); every link has an allowance of messages and bytes, and one that keeps flooding is cut.
- **Who is who.** A Hello is signed with the player's key and bound to the link, so a slot cannot be taken by someone else; the host proves its key on the link too, and its signaling replies are signed, so a stranger on a public code cannot pose as the host or turn guests away; a returning member skips the host's question only as themselves; kicked keys stay out for the session.
- **Who hosts.** A claim to host counts only for the next handover and only from the member who should take over; a member cut off from the rightful successor goes on alone rather than splitting the instance.
- **The board.** Notes that claim more room or a longer life than any host could are refused; one note per host, in a random order; join attempts are bounded in time.
- **Requests.** The host checks every request: place, reach (from where it believes the guest is: guests move at a player's speed), rate, strength (no more than the weapon in hand), the vault once, chests and mined tiles really in the guest's room, rifts closed only by those just back from one, drops capped and given back if refused; gathering gives only once the host says yes. Guests cap what a host may do to them (damage, xp).
- **Introductions.** The host relays only the mesh introductions it asked for.
- **Joining by link.** A `?join=` link from elsewhere asks before connecting.

Names are cleaned of control characters and shown as text, never HTML. Privacy: peers see each other's IP addresses, relays see board notes and encrypted signaling; private rift trips avoid all of it (see the About tab). What cannot be prevented without a server: a modified client owns its own bag, and a modified host its own world.

## Build order

1. ~~Network core (`src/net`): codec, links, signaling, board, sessions, migration.~~ Done.
2. ~~Shared dimension instances (`src/coop`): the beacon, replication, contribution, migration.~~ Done.
3. ~~Overworld refactors: one view per player in the chunk manager, combat around every player, world change events, replica worlds, a network chunk generator.~~ Done.
4. ~~Overworld by invite: streaming, the beacon's code panel, visitors' character saves, rooms, following friends behind a rift.~~ Done.
5. Polish: blocking from the beacon, a TURN option, lag compensation for blows, guests' swings seen by others, generating terrain locally behind per-chunk checksums (once biome growth is order-independent and generation uses deterministic math).

## Risks

- **No TURN:** some pairs never link. The beacon says so instead of spinning, and the trip goes on alone.
- **Relays are not ours:** if all six are down, the board and codes do not work; the manual code always does.
- **Phones as hosts** of an overworld session will struggle with several guests; a dimension host does far less (no terrain to generate or stream).
- **Griefing in public instances:** a player can take part only in their own share; hosts will be able to kick and block (polish).
