// Weather on screen (spec 7.3): rain, snow and blowing sand as pooled
// screen-space particles, a veil for fog and storms, and lightning flashes.

import { Container, Graphics, Sprite, Texture, type Renderer } from 'pixi.js';
import { WEATHER, type WeatherKind } from '../systems/WeatherSystem';

interface Style {
  count: number;
  texture: 'rain' | 'snow' | 'sand';
  /** Pixels per second. */
  vx: number;
  vy: number;
  veil: number;
}

const STYLES: Partial<Record<WeatherKind, Style>> = {
  rain: { count: 140, texture: 'rain', vx: -40, vy: 420, veil: 0x3a4a6a },
  storm: { count: 220, texture: 'rain', vx: -90, vy: 520, veil: 0x101828 },
  snow: { count: 110, texture: 'snow', vx: -12, vy: 40, veil: 0xe8f0f8 },
  blizzard: { count: 240, texture: 'snow', vx: -160, vy: 90, veil: 0xe8f0f8 },
  sandstorm: { count: 180, texture: 'sand', vx: -320, vy: 30, veil: 0xc8a060 },
};
const VEILS: Partial<Record<WeatherKind, number>> = { fog: 0xdde4ea, heat: 0xffe0a0 };

interface Particle {
  sprite: Sprite;
  vx: number;
  vy: number;
}

export class ParticleSystem {
  readonly view = new Container();
  private readonly veil = new Graphics();
  private readonly flash = new Graphics();
  private readonly layer = new Container();
  private readonly particles: Particle[] = [];
  private readonly textures: Record<Style['texture'], Texture>;
  private flashLeft = 0;
  private width = 1;
  private height = 1;

  constructor(renderer: Renderer) {
    const make = (draw: (g: Graphics) => void) => {
      const g = new Graphics();
      draw(g);
      return renderer.generateTexture(g);
    };
    this.textures = {
      rain: make((g) => g.rect(0, 0, 1, 6).fill({ color: 0xa8c8f0, alpha: 0.75 })),
      snow: make((g) => g.rect(0, 0, 2, 2).fill({ color: 0xffffff, alpha: 0.9 })),
      sand: make((g) => g.rect(0, 0, 7, 1).fill({ color: 0xb8904c, alpha: 0.9 })),
    };
    this.view.addChild(this.veil, this.layer, this.flash);
  }

  resize(width: number, height: number): void {
    this.width = width;
    this.height = height;
  }

  lightning(): void {
    this.flashLeft = 0.25;
  }

  /** `strength` fades weather in and out; `effects` false hides particles (low quality). */
  update(dt: number, kind: WeatherKind, strength: number, effects: boolean): void {
    const style = STYLES[kind];
    const veilColor = style?.veil ?? VEILS[kind];
    this.veil.clear();
    if (veilColor !== undefined && strength > 0) {
      this.veil.rect(0, 0, this.width, this.height).fill({ color: veilColor, alpha: WEATHER[kind].veil * strength * 0.8 + (style ? 0.08 : 0) });
    }

    const want = effects && style ? Math.round(style.count * strength * Math.min(1, (this.width * this.height) / (480 * 270))) : 0;
    while (this.particles.length < want) {
      const sprite = new Sprite();
      this.layer.addChild(sprite);
      this.particles.push({ sprite, vx: 0, vy: 0 });
      this.respawn(this.particles[this.particles.length - 1], style!, true);
    }
    while (this.particles.length > want) this.particles.pop()!.sprite.destroy();
    for (const p of this.particles) {
      if (style && p.sprite.texture !== this.textures[style.texture]) this.respawn(p, style, true);
      p.sprite.x += p.vx * dt;
      p.sprite.y += p.vy * dt;
      if (p.sprite.y > this.height + 8 || p.sprite.x < -8 || p.sprite.x > this.width + 8) this.respawn(p, style!, false);
    }

    this.flashLeft = Math.max(0, this.flashLeft - dt);
    this.flash.clear();
    if (this.flashLeft > 0) this.flash.rect(0, 0, this.width, this.height).fill({ color: 0xffffff, alpha: (this.flashLeft / 0.25) * 0.7 });
  }

  private respawn(p: Particle, style: Style, anywhere: boolean): void {
    p.sprite.texture = this.textures[style.texture];
    const jitter = 0.7 + Math.random() * 0.6;
    p.vx = style.vx * jitter;
    p.vy = style.vy * jitter;
    if (anywhere) {
      p.sprite.position.set(Math.random() * this.width, Math.random() * this.height);
    } else if (style.vx < -100) {
      // Driven sideways: come in from the right edge.
      p.sprite.position.set(this.width + 4, Math.random() * this.height);
    } else {
      p.sprite.position.set(Math.random() * (this.width + 60), -6);
    }
    if (style.texture === 'rain') p.sprite.rotation = Math.atan2(-p.vx, p.vy);
  }
}
