// Smooth motion for what another machine moves. Its updates come a few times
// a second, late and uneven; things here are drawn a little in the past
// (`DELAY_TICKS`), between the two updates around that moment, so they glide
// instead of jumping. Ticks are the sender's own count (20 a second); the
// clock maps them onto this machine's time.

/** Updates a second from every sender. */
export const SEND_HZ = 20;
const TICK_MS = 1000 / SEND_HZ;
/** Things are drawn this many ticks behind the newest update (100 ms). */
const DELAY_TICKS = 2;
/** Samples kept per moving thing. */
const RING = 4;

/** One sender's ticks against this machine's clock. */
export class TickClock {
  /** This machine's ms at the sender's tick 0, as best seen; NaN before the first. */
  private offset = Number.NaN;

  /** An update with this tick arrived at `now` (ms). The earliest-seeming
   *  arrival sets the pace; the estimate drifts later slowly, in case the
   *  first ones came early by luck. */
  observe(tick: number, now: number): void {
    const o = now - tick * TICK_MS;
    if (Number.isNaN(this.offset) || o < this.offset) this.offset = o;
    else this.offset += Math.min(o - this.offset, 0.5);
  }

  /** The tick (with a fraction) to draw at `now`. */
  at(now: number): number {
    return Number.isNaN(this.offset) ? 0 : (now - this.offset) / TICK_MS - DELAY_TICKS;
  }

  reset(): void {
    this.offset = Number.NaN;
  }
}

/** A few timed positions of one moving thing, oldest overwritten. */
export class Track {
  private readonly ticks = new Float64Array(RING);
  private readonly xs = new Float32Array(RING);
  private readonly ys = new Float32Array(RING);
  private n = 0;
  private head = 0;
  x = 0;
  y = 0;

  /** A position at a tick; older or repeated ticks are ignored. */
  push(tick: number, x: number, y: number): void {
    const last = this.n ? this.ticks[(this.head + RING - 1) % RING] : -Infinity;
    if (tick <= last) return;
    this.ticks[this.head] = tick;
    this.xs[this.head] = x;
    this.ys[this.head] = y;
    this.head = (this.head + 1) % RING;
    if (this.n < RING) this.n++;
    if (this.n === 1) {
      this.x = x;
      this.y = y;
    }
  }

  /** Sets `x`, `y` to where it was at `tick`: between two samples, else the
   *  nearest end (never guessing past the newest). */
  sample(tick: number): void {
    const n = this.n;
    if (!n) return;
    let prev = -1;
    for (let k = 0; k < n; k++) {
      const i = (this.head + RING - n + k) % RING;
      if (this.ticks[i] > tick) {
        if (prev < 0) {
          this.x = this.xs[i];
          this.y = this.ys[i];
        } else {
          const u = (tick - this.ticks[prev]) / (this.ticks[i] - this.ticks[prev]);
          this.x = this.xs[prev] + (this.xs[i] - this.xs[prev]) * u;
          this.y = this.ys[prev] + (this.ys[i] - this.ys[prev]) * u;
        }
        return;
      }
      prev = i;
    }
    this.x = this.xs[prev];
    this.y = this.ys[prev];
  }

  /** Starts over from where it was last drawn (a new sender, whose ticks are new). */
  restart(): void {
    this.n = 0;
    this.head = 0;
  }
}
