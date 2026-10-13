# Audio

Synthesised sound effects, generated music and weather ambience, all made with the Web Audio API; no audio files ship.

## Setup

`AudioSystem` (`src/audio/AudioSystem.ts`) creates its `AudioContext` on the first key press or pointer press, because browsers block sound until the player interacts. Everything routes through two buses, music and effects, whose volumes come from the Settings tab (defaults: music 0.35, effects 0.6).

A shared two-second white-noise buffer feeds the noise-based sounds.

## Sound effects

| Sound | When | Made of |
| --- | --- | --- |
| `step` | Every 0.36 s walking, 0.25 s running | Short low-passed noise |
| `chop` | Each axe strike while gathering (every 0.45 s) | A falling triangle thump and band-passed noise |
| `mine` | Each pickaxe strike while gathering | A metallic triangle ping and high-passed noise |
| `pickup` | Something gathered | Two rising square blips |
| `swing` | A melee swing | Band-passed noise sweeping down |
| `bow` | A bow shot | A falling sawtooth twang |
| `hit` | Damage dealt to an enemy | A low sine thud and noise |
| `hurt` | The player takes damage | A falling square tone |
| `kill` | An enemy defeated | Three falling blips |
| `dodge` | A dodge roll | Band-passed noise sweeping up |
| `level` | Level up | A rising four-note arpeggio |
| `quest` | Quest complete | A three-note chime |
| `chest` | Chest or treasure opened | Two triangle notes |
| `ui` | Any button, slot or tab clicked | A tiny click |
| `thunder` | A lightning strike | Long low-passed noise |
| `warn` | A vital gets worse (low or critical), except stamina | A two-note square alarm, played twice |
| Bell | The Waking Monument crumbles | Three strikes of inharmonic sine partials |

## Music

Music is generated one beat at a time, scheduled slightly ahead so timing stays steady. A beat is 0.75 s, 0.62 s in the desert (brisker) and 0.9 s in the snow (slower).

- **Scale** follows the mood: major pentatonic by day, minor pentatonic at night, a Phrygian-flavoured scale in the desert, a Lydian-flavoured one in the snow.
- **Root** moves between four roots every 16 beats, an octave lower at night. Further out it drops 6% per difficulty band (up to band 3), so the far lands sound lower and darker.
- **Pad:** a soft three-note chord at the start of every bar.
- **Melody:** a plucked note on about half the beats (fewer at night). The voice follows the land: a triangle in the forest, a soft square in the desert, a long sine in the snow.
- **Drone:** from band 2 out, a low sine two octaves under the root every 8 beats.
- **Danger:** a low pulse every other beat while enemies are chasing or attacking the player.

## Ambience

A looping filtered noise source plays the weather: low-passed rain for rain and storms (louder in storms), and band-passed wind for sandstorms and blizzards. Its volume follows how strongly the weather is felt, and fades when the game is paused. The volume is only rescheduled when it changes, and the noise stops once it has faded to silence.

The land has its own sounds, rolled twice a second (`AudioSystem.ambience`):

| Where | Sound |
| --- | --- |
| Forest, by day | Birds: two or three quick rising chirps (12% of rolls) |
| Anywhere but snow, at night | Crickets: three short high clicks (25% of rolls) |
| Desert | A gust of band-passed wind now and then |
| Snow | A lower gust of wind now and then |
| Mines | Water dripping, and now and then a low drone |

Birds, crickets and gusts are quiet indoors and in strong rain or storms.

**Creature calls.** When something hunts the player outdoors, its call sounds, at most every 18 seconds: wolves (and wolf-shaped creatures) howl, wraiths and skeletons wail, bears and golems growl (`Game.hunterCall`).

See also: [README.md](README.md) · [living-world.md](living-world.md) · [rendering.md](rendering.md)
