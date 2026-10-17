// What a passage through a rift looks like on screen (`RiftTransition` is its
// clock): a veil over the whole screen with a violet vignette closing in, and,
// when a rift is closed, a ghost of its tear collapsing. A handful of sprites
// made once; hidden, they cost nothing.

import { Container, Rectangle, Sprite, Texture } from 'pixi.js';
import { RIFT_FPS, RIFT_FRAMES, riftFrame } from './Atlas';

export class RiftPassageView {
  /** Screen space, above the world, its lighting and its weather. */
  readonly view = new Container();
  private readonly veil = new Sprite(Texture.WHITE);
  private vignette: Sprite | null = null;
  /** The collapsing tear, in the world's y-sorted layer. */
  private readonly ghost: Sprite;
  private readonly frames: Texture[] = [];
  private time = 0;

  constructor(atlas: Texture, private readonly entities: Container) {
    for (let f = 0; f < RIFT_FRAMES; f++) {
      const { x, y, w, h } = riftFrame(f);
      this.frames.push(new Texture({ source: atlas.source, frame: new Rectangle(x, y, w, h) }));
    }
    this.ghost = new Sprite({ texture: this.frames[0], anchor: { x: 0.5, y: 1 } });
    this.view.addChild(this.veil);
    this.view.visible = false;
  }

  /** Covers the screen: `veil` 0 to 1 of `color`, the vignette's `edge` 0 (none) to 1 (closed in). */
  cover(width: number, height: number, veil: number, color: number, edge: number): void {
    const on = veil > 0.001 || edge > 0.001;
    this.view.visible = on;
    if (!on) return;
    const v = this.veil;
    v.setSize(width, height);
    v.tint = color;
    v.alpha = veil;
    const g = this.vignette ?? this.makeVignette();
    g.visible = edge > 0.001;
    if (!g.visible) return;
    g.position.set(width / 2, height / 2);
    const grow = 1.9 - 0.8 * edge;
    g.setSize(width * grow, height * grow);
    g.alpha = Math.min(1, edge * 1.2);
  }

  /** Shows the tear collapsing at the bottom centre of its tile, in world pixels. */
  showGhost(x: number, y: number): void {
    const g = this.ghost;
    g.position.set(x, y);
    g.zIndex = y;
    g.scale.set(1);
    g.alpha = 1;
    this.entities.addChild(g);
  }

  /** The collapsing tear's look this frame. */
  poseGhost(dt: number, sx: number, sy: number, alpha: number): void {
    const g = this.ghost;
    this.time += dt;
    g.texture = this.frames[Math.floor(this.time * RIFT_FPS) % RIFT_FRAMES];
    g.visible = sx > 0.01 && alpha > 0.01;
    g.scale.set(sx, sy);
    g.alpha = alpha;
  }

  hide(): void {
    this.view.visible = false;
    if (this.ghost.parent) this.entities.removeChild(this.ghost);
  }

  /** A soft violet edge with a clear middle; made the first time a rift is crossed. */
  private makeVignette(): Sprite {
    const c = document.createElement('canvas');
    c.width = c.height = 128;
    const ctx = c.getContext('2d')!;
    const grad = ctx.createRadialGradient(64, 64, 18, 64, 64, 80);
    grad.addColorStop(0, 'rgba(60, 20, 110, 0)');
    grad.addColorStop(0.55, 'rgba(70, 24, 130, 0.55)');
    grad.addColorStop(1, 'rgba(26, 10, 52, 1)');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, 128, 128);
    const tex = Texture.from(c);
    tex.source.scaleMode = 'linear';
    const s = new Sprite({ texture: tex, anchor: 0.5 });
    this.view.addChild(s);
    this.vignette = s;
    return s;
  }
}
