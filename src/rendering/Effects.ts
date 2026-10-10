// World-space effects: burning trees, lightning warnings, meteor strikes,
// memory ghosts, particle bursts, and ambient fireflies and falling leaves.

import { Container, Graphics } from 'pixi.js';
import { TILE_SIZE } from '../config';
import type { Memory } from '../story/StorySystem';
import type { Light } from './Lighting';
import { STRIKE_WARNING, type Fire, type Strike } from '../systems/HazardSystem';

interface Meteor {
  x: number;
  y: number;
  t: number;
}

const METEOR_SECONDS = 0.9;

export type BurstKind = 'wood' | 'stone' | 'leaf' | 'dust' | 'hit' | 'magic' | 'gold' | 'splash';

/** Colours, speed (tiles/s), gravity (tiles/s²), life (s) and size (px) per burst. */
const BURSTS: Record<BurstKind, { colors: number[]; speed: number; gravity: number; life: number; size: number; rise: number }> = {
  wood: { colors: [0x8a5a2b, 0xb5824d, 0x6b4423], speed: 3, gravity: 14, life: 0.6, size: 2, rise: 3 },
  stone: { colors: [0x9a9389, 0x6c645b, 0xbab3a7], speed: 3, gravity: 14, life: 0.55, size: 2, rise: 3 },
  leaf: { colors: [0x5aab48, 0x3d8a3a, 0x8ccf62], speed: 2, gravity: 4, life: 0.9, size: 2, rise: 2 },
  dust: { colors: [0xc4a578, 0xab8c61], speed: 0.8, gravity: 0, life: 0.35, size: 1.5, rise: 0.5 },
  hit: { colors: [0xffffff, 0xffd040], speed: 6, gravity: 0, life: 0.25, size: 1.5, rise: 0 },
  magic: { colors: [0x7fd8ff, 0xd8f4ff], speed: 1.2, gravity: -2, life: 1.2, size: 1.5, rise: 1 },
  gold: { colors: [0xffd040, 0xfff0a0, 0xffffff], speed: 4, gravity: -1, life: 1, size: 2, rise: 2 },
  splash: { colors: [0xffffff, 0xd6eefa, 0x8cc3ec], speed: 1.6, gravity: 9, life: 0.4, size: 1.5, rise: 2 },
};

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  max: number;
  color: number;
  size: number;
  gravity: number;
  /** A falling leaf that sways as it drifts. */
  drift?: boolean;
}

interface Firefly {
  x: number;
  y: number;
  phase: number;
}

const FIREFLIES = 14;
const LEAVES = 10;
const MAX_PARTICLES = 400;

export class Effects {
  readonly view = new Container();
  /** Drawn on the ground, under everything that stands: the lantern's ghosts. */
  readonly floor = new Graphics();
  private readonly g = new Graphics();
  private readonly meteors: Meteor[] = [];
  private readonly particles: Particle[] = [];
  private readonly fireflies: Firefly[] = [];
  private time = 0;

  constructor() {
    this.view.addChild(this.g);
  }

  meteor(x: number, y: number): void {
    this.meteors.push({ x, y, t: 0 });
  }

  /** A puff of particles at a point, in tiles. */
  burst(x: number, y: number, kind: BurstKind, count = 8): void {
    const b = BURSTS[kind];
    for (let i = 0; i < count && this.particles.length < MAX_PARTICLES; i++) {
      const a = Math.random() * Math.PI * 2;
      const s = b.speed * (0.4 + Math.random() * 0.6);
      this.particles.push({
        x: x + (Math.random() - 0.5) * 0.4,
        y: y + (Math.random() - 0.5) * 0.4,
        vx: Math.cos(a) * s,
        vy: Math.sin(a) * s - b.rise,
        life: b.life * (0.7 + Math.random() * 0.3),
        max: b.life,
        color: b.colors[i % b.colors.length],
        size: b.size,
        gravity: b.gravity,
      });
    }
  }

  /** Keeps ambient life around the player: fireflies by night, leaves by day. */
  ambient(px: number, py: number, fireflies: boolean, leaves: boolean): void {
    if (!fireflies) this.fireflies.length = 0;
    while (fireflies && this.fireflies.length < FIREFLIES) {
      this.fireflies.push({ x: px + (Math.random() - 0.5) * 30, y: py + (Math.random() - 0.5) * 18, phase: Math.random() * 10 });
    }
    for (const f of this.fireflies) {
      if (Math.abs(f.x - px) > 18 || Math.abs(f.y - py) > 11) {
        f.x = px + (Math.random() - 0.5) * 30;
        f.y = py + (Math.random() - 0.5) * 18;
      }
    }
    if (leaves && this.particles.filter((p) => p.drift).length < LEAVES && Math.random() < 0.05) {
      this.particles.push({
        x: px + (Math.random() - 0.3) * 30,
        y: py - 10 - Math.random() * 4,
        vx: -0.8 - Math.random() * 0.5,
        vy: 0.5,
        life: 10,
        max: 10,
        color: Math.random() < 0.5 ? 0xd8742d : 0xf2a446,
        size: 2,
        gravity: 0.6,
        drift: true,
      });
    }
  }

  /** Fireflies glow in the dark. */
  lights(out: Light[]): void {
    for (const f of this.fireflies) {
      if (Math.sin(this.time * 2 + f.phase) > 0.2) out.push({ x: f.x * TILE_SIZE, y: f.y * TILE_SIZE, radius: 1.2 * TILE_SIZE, warmth: 0.5 });
    }
  }

  /** `sight` is the lantern's reach in tiles: forgotten places show as ghosts within it. */
  update(dt: number, fires: readonly Fire[], strikes: readonly Strike[], memories: readonly Memory[], px: number, py: number, sight: number): void {
    this.time += dt;
    const g = this.g.clear();
    const T = TILE_SIZE;

    const floor = this.floor.clear();
    if (sight > 0) {
      const pulse = 0.8 + Math.sin(this.time * 1.5) * 0.2;
      for (const m of memories) {
        if (px < m.x - sight || py < m.y - sight || px > m.x + m.w + sight || py > m.y + m.h + sight) continue;
        const x0 = Math.max(0, Math.floor(px - sight - m.x));
        const y0 = Math.max(0, Math.floor(py - sight - m.y));
        const x1 = Math.min(m.w, Math.ceil(px + sight - m.x));
        const y1 = Math.min(m.h, Math.ceil(py + sight - m.y));
        for (let y = y0; y < y1; y++) {
          for (let x = x0; x < x1; x++) {
            if (!m.mask[y * m.w + x]) continue;
            const d = Math.hypot(m.x + x + 0.5 - px, m.y + y + 0.5 - py);
            if (d >= sight) continue;
            // A spectral blueprint on the ground: a soft glow, with a bright
            // line only along the outline of the forgotten place.
            const f = (1 - d / sight) * pulse;
            const sx = (m.x + x) * T;
            const sy = (m.y + y) * T;
            floor.rect(sx, sy, T, T).fill({ color: 0x7fd8ff, alpha: 0.22 * f });
            const open = (dx: number, dy: number) => {
              const nx = x + dx;
              const ny = y + dy;
              return nx < 0 || ny < 0 || nx >= m.w || ny >= m.h || !m.mask[ny * m.w + nx];
            };
            const edge = { color: 0xc8f4ff, alpha: 0.7 * f };
            if (open(0, -1)) floor.rect(sx, sy, T, 1).fill(edge);
            if (open(0, 1)) floor.rect(sx, sy + T - 1, T, 1).fill(edge);
            if (open(-1, 0)) floor.rect(sx, sy, 1, T).fill(edge);
            if (open(1, 0)) floor.rect(sx + T - 1, sy, 1, T).fill(edge);
          }
        }
      }
    }

    for (const [i, f] of fires.entries()) {
      // Flickering flames and rising smoke over the tree.
      const cx = (f.gx + 0.5) * T;
      const base = (f.gy + 1) * T;
      for (let k = 0; k < 6; k++) {
        const phase = this.time * 6 + k * 1.3 + i;
        const x = cx + Math.sin(phase) * 6 + (k - 2.5) * 3;
        const y = base - 10 - ((this.time * 30 + k * 9) % 28);
        g.circle(x, y, 3 + (k % 3)).fill({ color: k % 2 ? 0xffc040 : 0xe8502a, alpha: 0.85 });
      }
      for (let k = 0; k < 3; k++) {
        const y = base - 30 - ((this.time * 14 + k * 12) % 26);
        g.circle(cx + Math.sin(this.time * 2 + k) * 5, y, 4 + k).fill({ color: 0x4a4a4a, alpha: 0.35 });
      }
    }

    for (const s of strikes) {
      const t = 1 - s.timer / STRIKE_WARNING;
      g.circle(s.x * T, s.y * T, 1.3 * T).stroke({ width: 1, color: 0xfff2a0, alpha: 0.4 + t * 0.5 });
      g.circle(s.x * T, s.y * T, 1.3 * T * t).fill({ color: 0xfff2a0, alpha: 0.2 });
    }

    for (let i = this.particles.length - 1; i >= 0; i--) {
      const p = this.particles[i];
      p.life -= dt;
      if (p.life <= 0) {
        this.particles.splice(i, 1);
        continue;
      }
      p.vy += p.gravity * dt;
      if (p.drift) p.vx += Math.sin(this.time * 2 + i) * dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      g.rect(p.x * T, p.y * T, p.size, p.size).fill({ color: p.color, alpha: Math.min(1, (p.life / p.max) * 2) });
    }
    for (const f of this.fireflies) {
      f.x += Math.sin(this.time * 0.7 + f.phase) * dt * 0.6;
      f.y += Math.cos(this.time * 0.9 + f.phase * 1.3) * dt * 0.4;
      const glow = Math.max(0, Math.sin(this.time * 2 + f.phase));
      g.circle(f.x * T, f.y * T, 1.2).fill({ color: 0xe8ff80, alpha: 0.3 + glow * 0.7 });
    }

    for (let i = this.meteors.length - 1; i >= 0; i--) {
      const m = this.meteors[i];
      m.t += dt;
      const k = Math.min(1, m.t / (METEOR_SECONDS * 0.6));
      const tx = m.x * T;
      const ty = m.y * T;
      if (k < 1) {
        const sx = tx + 260 * (1 - k);
        const sy = ty - 300 * (1 - k);
        g.moveTo(sx + 40, sy - 46).lineTo(sx, sy).stroke({ width: 3, color: 0xffd27a, alpha: 0.9 });
        g.circle(sx, sy, 4).fill({ color: 0xffffff });
      } else {
        const r = (m.t - METEOR_SECONDS * 0.6) * 200;
        g.circle(tx, ty, r).stroke({ width: 3, color: 0xffa040, alpha: Math.max(0, 1 - r / 70) });
      }
      if (m.t > METEOR_SECONDS) this.meteors.splice(i, 1);
    }
  }
}
