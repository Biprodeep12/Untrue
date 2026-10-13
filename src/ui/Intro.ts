// The opening screen: the title over darkness from the first paint (its markup
// is in index.html, so it shows before the game's code has loaded). Once the
// world is ready, the darkness breaks into chunk-sized squares that clear
// from the player outward in a widening ring, and the screen is gone.
//
// Cheap by design: a tiny canvas (8 pixels per square) scaled up by CSS,
// drawn for about a second and then removed. Reduced motion gets a fade.

/** Size of a square on screen, CSS pixels. */
const CELL = 40;
/** Canvas pixels per square: squares shrink in eight crisp steps. */
const RES = 8;
/** Seconds for the ring to reach the screen's corners. */
const SPREAD = 1;
/** Seconds each square takes to shrink away. */
const SHRINK = 0.24;
/** Random lag per square, so the ring's edge is ragged like loading chunks. */
const JITTER = 0.14;
const DARK = '#1d1a17';
/** The ring's leading edge, in the wood colours of the UI. */
const EDGE = '#3e2a1a';
const EDGE_LIGHT = '#7a5432';

export class Intro {
  private readonly root: HTMLElement | null = document.getElementById('intro');

  /** Clears the screen to reveal the world. Resolves once it is gone. */
  play(): Promise<void> {
    const root = this.root;
    if (!root?.isConnected) return Promise.resolve();
    root.classList.add('leaving');
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) return this.fade(root);

    const cols = Math.ceil(window.innerWidth / CELL);
    const rows = Math.ceil(window.innerHeight / CELL);
    const canvas = document.createElement('canvas');
    canvas.className = 'intro-cells';
    canvas.width = cols * RES;
    canvas.height = rows * RES;
    canvas.style.width = `${cols * CELL}px`;
    canvas.style.height = `${rows * CELL}px`;
    // Centred on the screen, where the player stands.
    canvas.style.left = `${(window.innerWidth - cols * CELL) / 2}px`;
    canvas.style.top = `${(window.innerHeight - rows * CELL) / 2}px`;
    const ctx = canvas.getContext('2d');
    if (!ctx) return this.fade(root);
    root.appendChild(canvas);
    // The solid backdrop gives way to the squares, which now cover the screen.
    root.style.background = 'transparent';

    // When each square starts to go: by its distance from the centre.
    const cx = (cols - 1) / 2;
    const cy = (rows - 1) / 2;
    const far = Math.hypot(cx, cy) || 1;
    const start = new Float32Array(cols * rows);
    for (let y = 0; y < rows; y++) {
      for (let x = 0; x < cols; x++) {
        const i = y * cols + x;
        start[i] = (Math.hypot(x - cx, y - cy) / far) * SPREAD + Math.random() * JITTER;
      }
    }
    const end = SPREAD + JITTER + SHRINK;

    return new Promise((resolve) => {
      const t0 = performance.now();
      const frame = (now: number) => {
        const t = (now - t0) / 1000;
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        // Dark squares still waiting, then the shrinking ones at the ring's edge.
        ctx.fillStyle = DARK;
        for (let i = 0; i < start.length; i++) {
          if (t < start[i]) ctx.fillRect((i % cols) * RES, Math.floor(i / cols) * RES, RES, RES);
        }
        for (let i = 0; i < start.length; i++) {
          const p = (t - start[i]) / SHRINK;
          if (p < 0 || p >= 1) continue;
          const size = Math.round(RES * (1 - p * p));
          if (size <= 0) continue;
          const x = (i % cols) * RES + (RES - size) / 2;
          const y = Math.floor(i / cols) * RES + (RES - size) / 2;
          ctx.fillStyle = p < 0.35 ? EDGE_LIGHT : EDGE;
          ctx.fillRect(Math.floor(x), Math.floor(y), size, size);
        }
        if (t < end) requestAnimationFrame(frame);
        else {
          root.remove();
          resolve();
        }
      };
      requestAnimationFrame(frame);
    });
  }

  /** Takes the screen away without playing anything, e.g. when the game failed to start. */
  remove(): void {
    this.root?.remove();
  }

  private fade(root: HTMLElement): Promise<void> {
    root.classList.add('fade');
    return new Promise((resolve) =>
      setTimeout(() => {
        root.remove();
        resolve();
      }, 450),
    );
  }
}
