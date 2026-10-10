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
| Bell | The Waking Monument crumbles | Three strikes of inharmonic sine partials |

## Music

Music is generated one beat at a time (0.75 s per beat), scheduled slightly ahead so timing stays steady:

- **Scale** follows the mood: major pentatonic by day, minor pentatonic at night, a Phrygian-flavoured scale in the desert, a Lydian-flavoured one in the snow.
- **Root** moves between four roots every 16 beats, an octave lower at night.
- **Pad:** a soft three-note chord at the start of every bar.
- **Melody:** a plucked triangle note on about half the beats (fewer at night).
- **Danger:** a low pulse every other beat while enemies are chasing or attacking the player.

## Ambience

A looping filtered noise source plays the weather: low-passed rain for rain and storms (louder in storms), and band-passed wind for sandstorms and blizzards. Its volume follows how strongly the weather is felt, and fades when the game is paused.

See also: [README.md](README.md) · [living-world.md](living-world.md) · [rendering.md](rendering.md)
