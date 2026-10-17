// What the world does near an open rift: it stutters. Every so often, more
// often the closer the player is, a decoration jolts out of place, the
// colours slip and the picture tears sideways, or the HUD shudders. All of
// it is cosmetic; the game only calls `update` while a rift is in range, so
// it costs nothing elsewhere, and nothing here allocates.

/** What a glitch can touch. */
export interface GlitchTargets {
  /** Nudges the decoration nearest a tile sideways, tinted, for a moment. */
  jolt(gx: number, gy: number, dx: number, tint: number, seconds: number): void;
  /** Tints the whole world layer; 0xffffff is back to normal. */
  tint(color: number): void;
  /** Shakes the HUD briefly. */
  stutter(): void;
}

/** Glitch colours: the rift's violet, cyan and pink. */
const TINTS = [0xd0a8ff, 0xa8fff4, 0xffb0e0];
/** Seconds between glitches far from a rift and right beside it. */
const SLOWEST = 4.5;
const FASTEST = 0.7;

export class RiftGlitch {
  /** Pixels the world layer is torn sideways by this frame. */
  offset = 0;
  private wait = SLOWEST;
  private slip = 0;

  /** `closeness` is 0 at the edge of the range and 1 at the rift; (rx, ry) is the rift's tile. */
  update(dt: number, closeness: number, rx: number, ry: number, random: () => number, t: GlitchTargets): void {
    if (this.slip > 0 && (this.slip -= dt) <= 0) {
      t.tint(0xffffff);
      this.offset = 0;
    }
    if ((this.wait -= dt) > 0) return;
    this.wait = (SLOWEST - (SLOWEST - FASTEST) * closeness) * (0.6 + random() * 0.8);
    const roll = random();
    const color = TINTS[Math.floor(random() * TINTS.length)];
    if (roll < 0.55) {
      // A tree or rock nearby jumps out of place.
      const n = 1 + Math.floor(random() * (1 + closeness * 2));
      for (let k = 0; k < n; k++) {
        const gx = Math.round(rx + (random() - 0.5) * 12);
        const gy = Math.round(ry + (random() - 0.5) * 10);
        t.jolt(gx, gy, (random() < 0.5 ? -1 : 1) * (2 + Math.floor(random() * 4)), color, 0.08 + random() * 0.12);
      }
    } else if (roll < 0.85 || closeness < 0.4) {
      // The colours slip and the picture tears.
      t.tint(color);
      this.offset = random() < 0.5 ? -2 : 2;
      this.slip = 0.06 + random() * 0.08;
    } else t.stutter();
  }

  /** Ends whatever is showing, e.g. once the rift is out of range. */
  reset(t: GlitchTargets): void {
    if (this.slip > 0) t.tint(0xffffff);
    this.slip = 0;
    this.offset = 0;
    this.wait = SLOWEST;
  }
}
