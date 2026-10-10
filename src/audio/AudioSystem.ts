// Audio (spec 7.3): synthesised effects, gentle generated music that follows
// the biome and the time of day, and weather ambience. No audio files ship.

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
  | 'thunder';

/** Scales (semitones from the root) for each mood. */
const SCALES = {
  day: [0, 2, 4, 7, 9],
  night: [0, 3, 5, 7, 10],
  desert: [0, 1, 4, 5, 7, 8],
  snow: [0, 2, 4, 6, 7, 11],
};
const ROOTS = [220, 196, 174.6, 246.9];
/** Seconds per music beat. */
const BEAT = 0.75;

export interface MusicMood {
  biome: BiomeType | undefined;
  night: boolean;
  /** Enemies are hunting the player. */
  danger: boolean;
  weather: WeatherKind;
  /** 0 to 1, how strongly the weather is felt. */
  weatherStrength: number;
}

export class AudioSystem {
  private ctx: AudioContext | null = null;
  private master!: GainNode;
  private sfxBus!: GainNode;
  private musicBus!: GainNode;
  private noise!: AudioBuffer;
  private rain: { src: AudioBufferSourceNode; gain: GainNode; filter: BiquadFilterNode } | null = null;
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
    if (this.nextBeat < ctx.currentTime) this.nextBeat = ctx.currentTime + 0.1;
    // Schedule a little ahead so timing stays steady.
    while (this.nextBeat < ctx.currentTime + 0.3) {
      this.playBeat(this.nextBeat, mood);
      this.nextBeat += BEAT;
      this.beat++;
    }
  }

  private playBeat(at: number, mood: MusicMood): void {
    const scale = mood.biome === BiomeType.Desert ? SCALES.desert : mood.biome === BiomeType.Snow ? SCALES.snow : mood.night ? SCALES.night : SCALES.day;
    if (this.beat % 16 === 0) this.rootIndex = (this.rootIndex + 1 + Math.floor(Math.random() * 2)) % ROOTS.length;
    const root = ROOTS[this.rootIndex] * (mood.night ? 0.5 : 1);
    const note = (step: number) => root * Math.pow(2, (scale[step % scale.length] + 12 * Math.floor(step / scale.length)) / 12);
    // A soft pad every bar, a plucked melody note now and then.
    if (this.beat % 4 === 0) {
      for (const s of [0, 2, 4]) this.tone(at, note(s) / 2, BEAT * 4.2, 0.05, 'sine', undefined, this.musicBus, 0.6);
    }
    if (Math.random() < (mood.night ? 0.35 : 0.55)) {
      this.tone(at, note(Math.floor(Math.random() * 7) + 3), BEAT * 1.6, 0.07, 'triangle', undefined, this.musicBus);
    }
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
    this.rain.filter.type = windy ? 'bandpass' : 'lowpass';
    this.rain.filter.frequency.value = windy ? 500 : 1800;
    this.rain.gain.gain.setTargetAtTime(level, ctx.currentTime, 0.5);
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
