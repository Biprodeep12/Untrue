// Stepping through a rift: a short passage instead of a cut. The player is
// pulled into the tear (or the portal), the screen is covered, the switch
// between the overworld and the dimension happens once under that cover,
// then the cover lifts on the player emerging from the rift at the other
// end. Closing a rift adds a last beat: the tear collapses behind them.
//
// This is only the clock: phases, their progress, and the hooks fired once
// each. The game drives it from its tick, locks input and pauses the world
// while it runs, and draws from its progress (see `RiftPassageView`).

export type RiftPassage = 'enter' | 'leave' | 'close' | 'eject';

export interface PassageHooks {
  /** Under full cover: move the player between the worlds. Called once. */
  switch(kind: RiftPassage): void;
  /** Closing only: the reveal is over and the tear starts to collapse. */
  collapse(kind: RiftPassage): void;
  /** The passage is over: put everything back. */
  done(kind: RiftPassage): void;
}

/** Seconds for each phase: pulled in, revealed, (closing) the tear collapsing. */
export interface PassageTiming {
  pull: number;
  reveal: number;
  collapse: number;
}

const TIMINGS: Record<RiftPassage, PassageTiming> = {
  enter: { pull: 0.7, reveal: 0.6, collapse: 0 },
  leave: { pull: 0.6, reveal: 0.6, collapse: 0 },
  close: { pull: 0.6, reveal: 0.55, collapse: 0.6 },
  // Thrown out on dying: a quicker pull.
  eject: { pull: 0.45, reveal: 0.6, collapse: 0 },
};
/** Reduced motion: a quick fade out and in. */
const REDUCED: PassageTiming = { pull: 0.25, reveal: 0.3, collapse: 0.25 };

export function passageTiming(kind: RiftPassage, reduced: boolean): PassageTiming {
  const t = TIMINGS[kind];
  return reduced ? { pull: REDUCED.pull, reveal: REDUCED.reveal, collapse: t.collapse ? REDUCED.collapse : 0 } : t;
}

export class RiftTransition {
  /** The passage under way, or null. */
  kind: RiftPassage | null = null;
  /** Shorter, and only fades: the system asked for reduced motion. */
  reduced = false;
  /** Holds the passage at full cover before the switch (finding others
   *  behind the rift); the game lets go when ready, or after a while. */
  holding = false;
  /** Seconds since it started. */
  private t = 0;
  private timing: PassageTiming = TIMINGS.enter;
  private switched = false;
  private collapsed = false;

  constructor(private readonly hooks: PassageHooks) {}

  get active(): boolean {
    return this.kind !== null;
  }

  /** Starts a passage; false (and nothing happens) if one is already under way. */
  start(kind: RiftPassage, reduced: boolean): boolean {
    if (this.kind) return false;
    this.kind = kind;
    this.reduced = reduced;
    this.timing = passageTiming(kind, reduced);
    this.t = 0;
    this.switched = false;
    this.collapsed = false;
    this.holding = false;
    return true;
  }

  /** Total length in seconds. */
  get duration(): number {
    const { pull, reveal, collapse } = this.timing;
    return pull + reveal + collapse;
  }

  /** 0 to 1 through being pulled in; 1 once switched. */
  get pull(): number {
    return Math.min(1, this.t / this.timing.pull);
  }

  /** 0 to 1 through the reveal; 0 before the switch. */
  get reveal(): number {
    return this.switched ? Math.min(1, (this.t - this.timing.pull) / this.timing.reveal) : 0;
  }

  /** 0 to 1 through the tear's collapse (closing only). */
  get collapse(): number {
    const { pull, reveal, collapse } = this.timing;
    return this.collapsed && collapse > 0 ? Math.min(1, (this.t - pull - reveal) / collapse) : 0;
  }

  /** Whether the switch has happened yet. */
  get past(): boolean {
    return this.switched;
  }

  /** Ends a passage under way at once, firing whatever hooks are left. */
  finish(): void {
    this.holding = false;
    if (this.kind) this.update(Infinity);
  }

  /** Advances the clock, firing each hook once, in order, even on a long frame. */
  update(dt: number): void {
    const kind = this.kind;
    if (!kind) return;
    this.t += dt;
    const { pull, reveal, collapse } = this.timing;
    // Held: the screen stays covered, the switch waits.
    if (this.holding && !this.switched && this.t >= pull) {
      this.t = pull;
      return;
    }
    if (!this.switched && this.t >= pull) {
      this.switched = true;
      this.hooks.switch(kind);
    }
    if (collapse > 0 && !this.collapsed && this.t >= pull + reveal) {
      this.collapsed = true;
      this.hooks.collapse(kind);
    }
    if (this.t >= pull + reveal + collapse) {
      this.kind = null;
      this.hooks.done(kind);
    }
  }
}
