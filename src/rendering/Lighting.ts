// Night lighting (spec 6.1, 7.3): a darkness layer with soft holes cut out
// for every light, plus a warm additive glow around fires and windows.

import { Container, RenderTexture, Sprite, Texture, type Renderer } from 'pixi.js';

export interface Light {
  /** World position in pixels. */
  x: number;
  y: number;
  /** Radius in pixels. */
  radius: number;
  /** Warm glow strength, 0 for none. */
  warmth: number;
}

const NIGHT = 0x080c22;
const DUSK = 0x2a1430;
/** Darkness at its deepest; the world never goes fully black. */
const MAX_ALPHA = 0.8;

function radialTexture(): Texture {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const ctx = c.getContext('2d')!;
  const g = ctx.createRadialGradient(64, 64, 0, 64, 64, 64);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.45, 'rgba(255,255,255,0.75)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 128, 128);
  return Texture.from(c);
}

export class Lighting {
  /** The finished darkness layer; add above the world. */
  readonly view = new Container();
  private readonly mask = new Container();
  /** The darkness itself: a tinted white sprite, cheaper to change than a Graphics. */
  private readonly dark = new Sprite(Texture.WHITE);
  /** With lighting off, night is only this flat tint: no light holes, no render pass. */
  private readonly flat = new Sprite(Texture.WHITE);
  private readonly glow: Texture;
  private readonly holes: Sprite[] = [];
  private readonly warm: Sprite[] = [];
  private readonly warmLayer = new Container();
  private rt: RenderTexture;
  private readonly sprite: Sprite;
  private time = 0;

  constructor(private readonly renderer: Renderer) {
    this.glow = radialTexture();
    this.rt = RenderTexture.create({ width: 2, height: 2 });
    this.sprite = new Sprite(this.rt);
    this.mask.addChild(this.dark);
    this.view.addChild(this.sprite, this.warmLayer, this.flat);
  }

  resize(width: number, height: number): void {
    this.rt.resize(width, height);
  }

  /** `toScreen` maps world pixels to screen pixels; `scale` is the camera zoom. */
  /** `flat`: the cheap night of the low-quality setting, a plain tint. */
  update(dt: number, darkness: number, lights: readonly Light[], toScreen: (x: number, y: number) => [number, number], scale: number, flat = false): void {
    this.time += dt;
    const on = darkness > 0.01;
    this.view.visible = on;
    if (!on) return;
    const { width, height } = this.rt;
    const tint = darkness > 0.6 ? NIGHT : DUSK;
    this.flat.visible = flat;
    this.sprite.visible = this.warmLayer.visible = !flat;
    if (flat) {
      this.flat.setSize(width, height);
      this.flat.tint = tint;
      this.flat.alpha = darkness * MAX_ALPHA * 0.85;
      return;
    }
    this.dark.setSize(width, height);
    this.dark.tint = tint;
    this.dark.alpha = darkness * MAX_ALPHA;

    this.ensure(this.holes, lights.length, this.mask, 'erase');
    this.ensure(this.warm, lights.length, this.warmLayer, 'add');
    lights.forEach((l, i) => {
      const [sx, sy] = toScreen(l.x, l.y);
      const flicker = l.warmth > 0 ? 1 + Math.sin(this.time * 9 + i * 1.7) * 0.05 : 1;
      const size = (l.radius * 2 * scale * flicker) / 128;
      const hole = this.holes[i];
      hole.position.set(sx, sy);
      hole.scale.set(size);
      const glow = this.warm[i];
      glow.position.set(sx, sy);
      glow.scale.set(size * 0.8);
      glow.alpha = l.warmth * 0.35 * darkness;
    });
    for (let i = lights.length; i < this.holes.length; i++) {
      this.holes[i].visible = false;
      this.warm[i].visible = false;
    }
    this.renderer.render({ container: this.mask, target: this.rt, clear: true });
  }

  private ensure(pool: Sprite[], n: number, parent: Container, blend: 'erase' | 'add'): void {
    while (pool.length < n) {
      const s = new Sprite({ texture: this.glow, anchor: 0.5 });
      s.blendMode = blend;
      if (blend === 'add') s.tint = 0xffa040;
      parent.addChild(s);
      pool.push(s);
    }
    for (let i = 0; i < n; i++) pool[i].visible = true;
  }
}
