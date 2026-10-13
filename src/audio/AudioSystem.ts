// Audio (spec 7.3): synthesised effects, gentle generated music that follows
// the biome, the time of day and how far out the player is, weather
// ambience, and the sounds of the land: birds by day, crickets by night,
// howls and wails from what hunts, drips and a drone in caves. No audio
// files ship.

import { BiomeType } from '../generation/Tiles';
import type { WeatherKind } from '../systems/WeatherSystem';

export type Sfx =
  | 'step'
  | 'chop'
  | 'mine'
  | 'pickup'
  | 'swing'
  | 'bow'
  | 'hit'
  | 'hurt'
  | 'kill'
  | 'dodge'
  | 'level'
  | 'quest'
  | 'ui'
  | 'chest'
  | 'thunder'
  | 'warn';

/** Scales (semitones from the root) for each mood. */
const SCALES = {
  day: [0, 2, 4, 7, 9],
  night: [0, 3, 5, 7, 10],
  desert: [0, 1, 4, 5, 7, 8],
  snow: [0, 2, 4, 6, 7, 11],
};
const ROOTS = [220, 196, 174.6, 246.9];
/** Seconds per music beat, per land: brisk in the desert, slow in the snow. */
const BEAT = 0.75;
const BEATS: Partial<Record<BiomeType, number>> = { [BiomeType.Desert]: 0.62, [BiomeType.Snow]: 0.9 };
/** The melody's voice per land. */
const VOICES: Partial<Record<BiomeType, OscillatorType>> = { [BiomeType.Desert]: 'square', [BiomeType.Snow]: 'sine' };
/** Creature calls, at most this often (seconds). */
const CALL_GAP = 18;

export interface MusicMood {
  biome: BiomeType | undefined;
  night: boolean;
  /** Enemies are hunting the player. */
  danger: boolean;
  weather: WeatherKind;
  /** 0 to 1, how strongly the weather is felt. */
  weatherStrength: number;
  /** Difficulty band: the music grows lower and darker further out. */
  band?: number;
  /** Indoors, and whether it is a cave (mine). */
  indoors?: boolean;
  cave?: boolean;
  /** What is hunting the player, for its call: a howl or a wail. */
  hunter?: 'howl' | 'wail' | 'growl' | null;
}

export class AudioSystem {
  private ctx: AudioContext | null = null;
  private master!: GainNode;
  private sfxBus!: GainNode;
  private musicBus!: GainNode;
  private noise!: AudioBuffer;
  private rain: { src: AudioBufferSourceNode; gain: GainNode; filter: BiquadFilterNode } | null = null;
  private rainLevel = -1;
  private nextAmbient = 0;
  private nextCall = 0;
  private nextBeat = 0;
  private beat = 0;
  private rootIndex = 0;
  private volumes = { music: 0.35, sfx: 0.6 };

  /** Browsers only allow audio after a user gesture; call from one. */
  unlock(): void {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') void this.ctx.resume();
      return;
    }
    try {
      const ctx = new AudioContext();
      this.ctx = ctx;
      this.master = ctx.createGain();
      this.master.connect(ctx.destination);
      this.sfxBus = ctx.createGain();
      this.musicBus = ctx.createGain();
      this.sfxBus.connect(this.master);
      this.musicBus.connect(this.master);
      this.setVolumes(this.volumes.music, this.volumes.sfx);
      this.noise = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
      const data = this.noise.getChannelData(0);
      for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
    } catch {
      this.ctx = null;
    }
  }

  setVolumes(music: number, sfx: number): void {
    this.volumes = { music, sfx };
    if (!this.ctx) return;
    this.musicBus.gain.value = music;
    this.sfxBus.gain.value = sfx;
  }

  play(kind: Sfx): void {
    const ctx = this.ctx;
    if (!ctx || ctx.state !== 'running') return;
    const t = ctx.currentTime;
    switch (kind) {
      case 'step':
        this.noiseBurst(t, 0.04, 500 + Math.random() * 300, 0.12, 'lowpass');
        break;
      case 'chop':
        this.tone(t, 150, 0.08, 0.35, 'triangle', 90);
        this.noiseBurst(t, 0.06, 1200, 0.2, 'bandpass');
        break;
      case 'mine':
        this.tone(t, 880 + Math.random() * 120, 0.15, 0.18, 'triangle');
        this.noiseBurst(t, 0.05, 2500, 0.15, 'highpass');
        break;
      case 'pickup':
        this.tone(t, 660, 0.07, 0.15, 'square');
        this.tone(t + 0.07, 990, 0.09, 0.15, 'square');
        break;
      case 'swing':
        this.noiseBurst(t, 0.12, 1800, 0.18, 'bandpass', 600);
        break;
      case 'bow':
        this.tone(t, 420, 0.18, 0.2, 'sawtooth', 200);
        break;
      case 'hit':
        this.tone(t, 130, 0.1, 0.35, 'sine', 70);
        this.noiseBurst(t, 0.05, 900, 0.2, 'lowpass');
        break;
      case 'hurt':
        this.tone(t, 240, 0.16, 0.25, 'square', 110);
        break;
      case 'kill':
        [520, 390, 260].forEach((f, i) => this.tone(t + i * 0.06, f, 0.08, 0.15, 'square'));
        break;
      case 'dodge':
        this.noiseBurst(t, 0.15, 900, 0.15, 'bandpass', 2400);
        break;
      case 'level':
        [523, 659, 784, 1046].forEach((f, i) => this.tone(t + i * 0.09, f, 0.25, 0.18, 'triangle'));
        break;
      case 'quest':
        [784, 988, 1175].forEach((f, i) => this.tone(t + i * 0.12, f, 0.5, 0.15, 'sine'));
        break;
      case 'ui':
        this.tone(t, 1200, 0.03, 0.08, 'square');
        break;
      case 'chest':
        this.tone(t, 330, 0.1, 0.15, 'triangle');
        this.tone(t + 0.1, 494, 0.2, 0.15, 'triangle');
        break;
      case 'thunder':
        this.noiseBurst(t + 0.1, 1.6, 180, 0.6, 'lowpass');
        break;
      case 'warn':
        // A two-note alarm, twice.
        [880, 660, 880, 660].forEach((f, i) => this.tone(t + i * 0.12, f, 0.1, 0.16, 'square'));
        break;
    }
  }

  /** A distant bell, rung three times. */
  bell(): void {
    const ctx = this.ctx;
    if (!ctx) return;
    for (let k = 0; k < 3; k++) {
      const at = ctx.currentTime + 0.1 + k * 1.6;
      for (const [ratio, level] of [[1, 0.25], [2.76, 0.11], [5.4, 0.05], [0.5, 0.08]]) {
        this.tone(at, 196 * ratio, 3.5, level, 'sine', undefined, this.sfxBus);
      }
    }
  }

  /** Advances the music and ambience; call every frame. */
  update(mood: MusicMood): void {
    const ctx = this.ctx;
    if (!ctx || ctx.state !== 'running') return;
    this.updateRain(mood);
    this.ambience(mood);
    if (this.nextBeat < ctx.currentTime) this.nextBeat = ctx.currentTime + 0.1;
    // Schedule a little ahead so timing stays steady.
    const beat = (mood.biome !== undefined && BEATS[mood.biome]) || BEAT;
    while (this.nextBeat < ctx.currentTime + 0.3) {
      this.playBeat(this.nextBeat, mood);
      this.nextBeat += beat;
      this.beat++;
    }
  }

  /** The land's own sounds, rolled a few times a second. */
  private ambience(mood: MusicMood): void {
    const ctx = this.ctx!;
    const t = ctx.currentTime;
    if (mood.hunter && t >= this.nextCall) {
      this.nextCall = t + CALL_GAP;
      this.call(t, mood.hunter);
    }
    if (t < this.nextAmbient) return;
    this.nextAmbient = t + 0.5;
    const wet = mood.weatherStrength > 0.3 && (mood.weather === 'rain' || mood.weather === 'storm');
    const r = Math.random();
    if (mood.cave) {
      // Water dripping in the dark, and a low drone now and then.
      if (r < 0.18) this.tone(t, 1400 + Math.random() * 800, 0.12, 0.05, 'sine', 700);
      else if (r < 0.22) this.tone(t, 55, 3, 0.05, 'sine', 50, this.sfxBus, 1);
      return;
    }
    if (mood.indoors || wet) return;
    if (!mood.night && mood.biome === BiomeType.Forest && r < 0.12) {
      // A bird: two or three quick rising chirps.
      const base = 2200 + Math.random() * 1200;
      const n = 2 + Math.floor(Math.random() * 2);
      for (let k = 0; k < n; k++) this.tone(t + k * 0.11, base, 0.07, 0.035, 'sine', base * 1.35);
    } else if (mood.night && mood.biome !== BiomeType.Snow && r < 0.25) {
      // Crickets.
      for (let k = 0; k < 3; k++) this.tone(t + k * 0.05, 4200, 0.03, 0.018, 'square');
    } else if (mood.biome === BiomeType.Desert && r < 0.04) {
      this.noiseBurst(t, 2.2, 400, 0.05, 'bandpass', 900);
    } else if (mood.biome === BiomeType.Snow && r < 0.04) {
      this.noiseBurst(t, 2.6, 700, 0.04, 'bandpass', 300);
    }
  }

  /** A creature's call from somewhere near. */
  private call(t: number, kind: 'howl' | 'wail' | 'growl'): void {
    if (kind === 'howl') {
      this.tone(t, 380, 0.5, 0.06, 'sine', 620, this.sfxBus, 0.2);
      this.tone(t + 0.5, 620, 1.4, 0.06, 'sine', 420, this.sfxBus, 0.05);
    } else if (kind === 'wail') {
      this.tone(t, 520, 1.6, 0.05, 'triangle', 300, this.sfxBus, 0.4);
      this.tone(t + 0.1, 780, 1.4, 0.03, 'sine', 460, this.sfxBus, 0.4);
    } else {
      this.noiseBurst(t, 0.6, 160, 0.12, 'lowpass', 90);
      this.tone(t, 70, 0.6, 0.08, 'sawtooth', 55);
    }
  }

  private playBeat(at: number, mood: MusicMood): void {
    const scale = mood.biome === BiomeType.Desert ? SCALES.desert : mood.biome === BiomeType.Snow ? SCALES.snow : mood.night ? SCALES.night : SCALES.day;
    if (this.beat % 16 === 0) this.rootIndex = (this.rootIndex + 1 + Math.floor(Math.random() * 2)) % ROOTS.length;
    // Further out the music drops lower, toward the unsettling.
    const far = Math.min(3, mood.band ?? 0);
    const root = ROOTS[this.rootIndex] * (mood.night ? 0.5 : 1) * (1 - far * 0.06);
    const note = (step: number) => root * Math.pow(2, (scale[step % scale.length] + 12 * Math.floor(step / scale.length)) / 12);
    // A soft pad every bar, a plucked melody note now and then.
    if (this.beat % 4 === 0) {
      for (const s of [0, 2, 4]) this.tone(at, note(s) / 2, BEAT * 4.2, 0.05, 'sine', undefined, this.musicBus, 0.6);
    }
    if (Math.random() < (mood.night ? 0.35 : 0.55)) {
      const voice = (mood.biome !== undefined && VOICES[mood.biome]) || 'triangle';
      this.tone(at, note(Math.floor(Math.random() * 7) + 3), BEAT * (voice === 'sine' ? 2.4 : 1.6), voice === 'square' ? 0.035 : 0.07, voice, undefined, this.musicBus);
    }
    // A low drone far out; a heartbeat when something hunts the player.
    if (far >= 2 && this.beat % 8 === 0) this.tone(at, root / 4, BEAT * 8, 0.04, 'sine', undefined, this.musicBus, 1.5);
    if (mood.danger && this.beat % 2 === 0) this.tone(at, 55, 0.25, 0.25, 'sine', 40, this.musicBus);
  }

  private updateRain(mood: MusicMood): void {
    const ctx = this.ctx!;
    const kind = mood.weather;
    const wet = kind === 'rain' || kind === 'storm';
    const windy = kind === 'sandstorm' || kind === 'blizzard';
    const level = (wet ? (kind === 'storm' ? 0.22 : 0.14) : windy ? 0.12 : 0) * mood.weatherStrength;
    if (!this.rain) {
      if (level <= 0) return;
      const src = ctx.createBufferSource();
      src.buffer = this.noise;
      src.loop = true;
      const filter = ctx.createBiquadFilter();
      const gain = ctx.createGain();
      gain.gain.value = 0;
      src.connect(filter).connect(gain).connect(this.sfxBus);
      src.start();
      this.rain = { src, gain, filter };
    }
    // Scheduled only when the level moves, not every frame.
    const rounded = Math.round(level * 100) / 100;
    if (rounded === this.rainLevel) return;
    this.rainLevel = rounded;
    this.rain.filter.type = windy ? 'bandpass' : 'lowpass';
    this.rain.filter.frequency.value = windy ? 500 : 1800;
    this.rain.gain.gain.setTargetAtTime(rounded, ctx.currentTime, 0.5);
    // Silent for good: stop the noise once it has faded out.
    if (rounded === 0) {
      const { src } = this.rain;
      this.rain = null;
      src.stop(ctx.currentTime + 3);
    }
  }

  private tone(at: number, freq: number, length: number, level: number, type: OscillatorType, slideTo?: number, bus = this.sfxBus, attack = 0.005): void {
    const ctx = this.ctx!;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, at);
    if (slideTo) osc.frequency.exponentialRampToValueAtTime(slideTo, at + length);
    gain.gain.setValueAtTime(0.0001, at);
    gain.gain.exponentialRampToValueAtTime(level, at + attack);
    gain.gain.exponentialRampToValueAtTime(0.0001, at + length);
    osc.connect(gain).connect(bus);
    osc.start(at);
    osc.stop(at + length + 0.05);
  }

  private noiseBurst(at: number, length: number, freq: number, level: number, type: BiquadFilterType, sweepTo?: number): void {
    const ctx = this.ctx!;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    const filter = ctx.createBiquadFilter();
    filter.type = type;
    filter.frequency.setValueAtTime(freq, at);
    if (sweepTo) filter.frequency.exponentialRampToValueAtTime(sweepTo, at + length);
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(level, at);
    gain.gain.exponentialRampToValueAtTime(0.0001, at + length);
    src.connect(filter).connect(gain).connect(this.sfxBus);
    src.start(at, Math.random());
    src.stop(at + length + 0.05);
  }
}
