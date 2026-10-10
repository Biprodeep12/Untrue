// Day and night (spec 6.1): sunrise, day, sunset, night.

/** Real seconds in one in-game day. */
export const DAY_SECONDS = 960;
const MINUTES_PER_DAY = 1440;
const MINUTES_PER_SECOND = MINUTES_PER_DAY / DAY_SECONDS;

export const DAWN = 5;
export const MORNING = 7;
export const DUSK = 18;
export const NIGHT = 20;

export type DayPhase = 'dawn' | 'day' | 'dusk' | 'night';

export interface TimeSave {
  day: number;
  minutes: number;
}

export class TimeSystem {
  day = 1;
  /** Minutes since midnight. */
  minutes = 8 * 60;

  get hour(): number {
    return Math.floor(this.minutes / 60);
  }

  /** Minutes since the world began, for timestamps. */
  get total(): number {
    return (this.day - 1) * MINUTES_PER_DAY + this.minutes;
  }

  get phase(): DayPhase {
    const h = this.minutes / 60;
    if (h >= NIGHT || h < DAWN) return 'night';
    if (h < MORNING) return 'dawn';
    if (h >= DUSK) return 'dusk';
    return 'day';
  }

  get isNight(): boolean {
    return this.phase === 'night';
  }

  /** 0 at midday, 1 in deep night, ramping through dawn and dusk. */
  get darkness(): number {
    const h = this.minutes / 60;
    if (h >= NIGHT || h < DAWN) return 1;
    if (h < MORNING) return 1 - (h - DAWN) / (MORNING - DAWN);
    if (h >= DUSK) return (h - DUSK) / (NIGHT - DUSK);
    return 0;
  }

  /** Advances the clock; returns how many hours began during this step. */
  update(dt: number): number {
    const before = Math.floor(this.total / 60);
    this.minutes += dt * MINUTES_PER_SECOND;
    while (this.minutes >= MINUTES_PER_DAY) {
      this.minutes -= MINUTES_PER_DAY;
      this.day++;
    }
    return Math.floor(this.total / 60) - before;
  }

  /** Jumps forward to the next time the clock reads `hour`; returns hours passed. */
  skipTo(hour: number): number {
    let minutes = hour * 60 - this.minutes;
    if (minutes <= 0) minutes += MINUTES_PER_DAY;
    return this.update(minutes / MINUTES_PER_SECOND);
  }

  label(): string {
    const h = this.hour;
    const m = Math.floor((this.minutes % 60) / 10) * 10;
    const h12 = h % 12 === 0 ? 12 : h % 12;
    return `Day ${this.day} · ${h12}:${String(m).padStart(2, '0')} ${h < 12 ? 'am' : 'pm'}`;
  }

  save(): TimeSave {
    return { day: this.day, minutes: this.minutes };
  }

  load(s: TimeSave): void {
    this.day = s.day;
    this.minutes = s.minutes;
  }
}
