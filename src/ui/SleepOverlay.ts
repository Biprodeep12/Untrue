// The sleep transition: the screen fades to night, "Z z z" drifts up while the
// hours pass, then the morning fades back in. Three seconds in all.

/** Milliseconds to fade out (and back in), and to stay asleep. */
const FADE_MS = 1000;
const ASLEEP_MS = 1000;

export class SleepOverlay {
  private readonly root: HTMLElement;
  private busy = false;

  constructor(parent: HTMLElement) {
    this.root = document.createElement('div');
    this.root.className = 'sleep-overlay';
    this.root.innerHTML = '<div class="sleep-z"><span>Z</span><span>z</span><span>z</span></div>';
    parent.appendChild(this.root);
  }

  get playing(): boolean {
    return this.busy;
  }

  /** Plays the transition: `asleep` runs once the screen is dark, `done` when
   *  the morning has faded back in. */
  play(asleep: () => void, done?: () => void): void {
    if (this.busy) return;
    this.busy = true;
    this.root.classList.add('on');
    setTimeout(() => {
      asleep();
      this.root.classList.add('dreaming');
    }, FADE_MS);
    setTimeout(() => this.root.classList.remove('on', 'dreaming'), FADE_MS + ASLEEP_MS);
    setTimeout(() => {
      this.busy = false;
      done?.();
    }, FADE_MS * 2 + ASLEEP_MS);
  }
}
