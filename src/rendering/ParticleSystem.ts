// Weather on screen (spec 7.3): rain, snow and blowing sand as pooled
// screen-space particles, a veil for fog and storms, and lightning flashes.

import { Container, Sprite, Texture, type Renderer } from 'pixi.js';
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

/** A small filled rectangle as a canvas texture: unlike a generated render
 *  texture, it is uploaded again if the WebGL context is lost and restored. */
function rectTexture(w: number, h: number, color: string): Texture {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = color;
  ctx.fillRect(0, 0, w, h);
  return Texture.from(c);
}

interface Particle {
  sprite: Sprite;
  vx: number;
  vy: number;
}

export class ParticleSystem {
  readonly view = new Container();
  /** Tinted white sprites: changing them costs nothing, unlike redrawing a Graphics. */
  private readonly veil = new Sprite(Texture.WHITE);
  private readonly flash = new Sprite(Texture.WHITE);
  /** Particles not in use, kept for later instead of destroyed. */
  private readonly spare: Particle[] = [];
  /** Lightning flashes the screen; off for players sensitive to flashes. */
  flashes = true;
  private readonly layer = new Container();
  private readonly particles: Particle[] = [];
  private readonly textures: Record<Style['texture'], Texture>;
  private flashLeft = 0;
  private width = 1;
  private height = 1;

  /** The renderer is no longer needed; kept so callers need not change. */
  constructor(_renderer?: Renderer) {
    this.textures = {
      rain: rectTexture(1, 6, 'rgba(168,200,240,0.75)'),
      snow: rectTexture(2, 2, 'rgba(255,255,255,0.9)'),
      sand: rectTexture(7, 1, 'rgba(184,144,76,0.9)'),
    };
    this.view.addChild(this.veil, this.layer, this.flash);
  }

  resize(width: number, height: number): void {
    this.width = width;
    this.height = height;
  }

  lightning(): void {
    if (this.flashes) this.flashLeft = 0.25;
  }

  /** `strength` fades weather in and out; `effects` false hides particles (low quality). */
  update(dt: number, kind: WeatherKind, strength: number, effects: boolean): void {
    const style = STYLES[kind];
    const veilColor = style?.veil ?? VEILS[kind];
    this.veil.visible = veilColor !== undefined && strength > 0;
    if (this.veil.visible) {
      this.veil.setSize(this.width, this.height);
      this.veil.tint = veilColor!;
      this.veil.alpha = WEATHER[kind].veil * strength * 0.8 + (style ? 0.08 : 0);
    }

    const want = effects && style ? Math.round(style.count * strength * Math.min(1, (this.width * this.height) / (480 * 270))) : 0;
    while (this.particles.length < want) {
      let p = this.spare.pop();
      if (!p) {
        p = { sprite: new Sprite(), vx: 0, vy: 0 };
        this.layer.addChild(p.sprite);
      }
      p.sprite.visible = true;
      this.particles.push(p);
      this.respawn(p, style!, true);
    }
    while (this.particles.length > want) {
      const p = this.particles.pop()!;
      p.sprite.visible = false;
      this.spare.push(p);
    }
    for (const p of this.particles) {
      if (style && p.sprite.texture !== this.textures[style.texture]) this.respawn(p, style, true);
      p.sprite.x += p.vx * dt;
      p.sprite.y += p.vy * dt;
      if (p.sprite.y > this.height + 8 || p.sprite.x < -8 || p.sprite.x > this.width + 8) this.respawn(p, style!, false);
    }

    this.flashLeft = Math.max(0, this.flashLeft - dt);
    this.flash.visible = this.flashLeft > 0;
    if (this.flash.visible) {
      this.flash.setSize(this.width, this.height);
      this.flash.alpha = (this.flashLeft / 0.25) * 0.7;
    }
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
