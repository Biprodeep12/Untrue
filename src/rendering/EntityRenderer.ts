// Draws enemies, NPCs, projectiles and combat feedback: health bars, alert
// marks, floating damage numbers and sword swings.

import { Container, Graphics, Rectangle, Sprite, Text, Texture } from 'pixi.js';
import { TILE_SIZE } from '../config';
import type { Enemy } from '../entities/Enemy';
import type { Npc } from '../entities/NPC';
import type { Projectile } from '../systems/CombatSystem';
import { creatureFrame, Dir, playerCell } from './Atlas';

const ELITE_TINT = 0xffd27a;
const HIT_TINT = 0xff6a6a;
const WINDUP_TINT = 0xffb0b0;
const NUMBER_SECONDS = 0.8;
const SWING_SECONDS = 0.14;

interface Drawn {
  sprite: Sprite;
  bar: Graphics;
  mark: Text;
}

interface Floating {
  text: Text;
  life: number;
}

export class EntityRenderer {
  private readonly textures = new Map<string, Texture>();
  private readonly drawn = new Map<number, Drawn>();
  private readonly people = new Map<number, Drawn>();
  private readonly shots: Sprite[] = [];
  private readonly numbers: Floating[] = [];
  private readonly swings: Array<{ g: Graphics; life: number }> = [];
  private time = 0;

  constructor(
    private readonly atlas: Texture,
    /** Y-sorted with trees and the player. */
    private readonly entities: Container,
    /** Drawn above everything in the world. */
    private readonly overlay: Container,
  ) {}

  /** `marks` puts a symbol over NPCs, e.g. '!' for an open quest. */
  update(dt: number, enemies: readonly Enemy[], projectiles: readonly Projectile[], npcs: readonly Npc[], marks: ReadonlyMap<number, string>): void {
    this.time += dt;
    this.syncEnemies(enemies);
    this.syncNpcs(npcs, marks);
    this.syncProjectiles(projectiles);
    this.animateEffects(dt);
  }

  damageNumber(x: number, y: number, amount: number, crit: boolean, toPlayer: boolean): void {
    const text = new Text({
      text: crit ? `${amount}!` : String(amount),
      style: {
        fontFamily: 'Pixelify Sans, monospace',
        fontSize: crit ? 12 : 9,
        fill: toPlayer ? 0xff6a5a : crit ? 0xffd040 : 0xffffff,
        stroke: { color: 0x2a1a10, width: 2 },
      },
    });
    text.anchor.set(0.5, 1);
    text.position.set(x * TILE_SIZE + (Math.random() - 0.5) * 6, y * TILE_SIZE);
    this.overlay.addChild(text);
    this.numbers.push({ text, life: NUMBER_SECONDS });
  }

  swing(x: number, y: number, dx: number, dy: number, reach: number): void {
    const g = new Graphics();
    const angle = Math.atan2(dy, dx);
    const r = reach * TILE_SIZE;
    g.arc(0, 0, r, angle - 1, angle + 1).stroke({ width: 3, color: 0xffffff, alpha: 0.85 });
    g.arc(0, 0, r - 3, angle - 0.8, angle + 0.8).stroke({ width: 1, color: 0xfff2b0, alpha: 0.6 });
    g.position.set(x * TILE_SIZE, y * TILE_SIZE);
    this.overlay.addChild(g);
    this.swings.push({ g, life: SWING_SECONDS });
  }

  private texture(key: string): Texture {
    let t = this.textures.get(key);
    if (!t) {
      const f = creatureFrame(key);
      t = new Texture({ source: this.atlas.source, frame: new Rectangle(f.x, f.y, f.w, f.h) });
      this.textures.set(key, t);
    }
    return t;
  }

  private human(outfit: string, dir: number, frame: number): Texture {
    const key = `human:${outfit}:${dir}:${frame}`;
    let t = this.textures.get(key);
    if (!t) {
      const [x, y] = playerCell(dir, frame, outfit);
      t = new Texture({ source: this.atlas.source, frame: new Rectangle(x, y, 16, 32) });
      this.textures.set(key, t);
    }
    return t;
  }

  private create(): Drawn {
    const d = {
      sprite: new Sprite({ anchor: { x: 0.5, y: 1 } }),
      bar: new Graphics(),
      mark: new Text({ text: '!', style: { fontFamily: 'Pixelify Sans, monospace', fontSize: 12, fill: 0xffd040, stroke: { color: 0x2a1a10, width: 2 } } }),
    };
    d.mark.anchor.set(0.5, 1);
    this.entities.addChild(d.sprite);
    this.overlay.addChild(d.bar, d.mark);
    return d;
  }

  private prune(map: Map<number, Drawn>, live: Set<number>): void {
    for (const [id, d] of map) {
      if (live.has(id)) continue;
      d.sprite.destroy();
      d.bar.destroy();
      d.mark.destroy();
      map.delete(id);
    }
  }

  private syncNpcs(npcs: readonly Npc[], marks: ReadonlyMap<number, string>): void {
    const live = new Set<number>();
    for (const n of npcs) {
      live.add(n.id);
      let d = this.people.get(n.id);
      if (!d) this.people.set(n.id, (d = this.create()));
      const { sprite, mark } = d;
      sprite.visible = !n.hidden;
      sprite.scale.set(n.scale);
      sprite.alpha = n.ghost ? 0.5 + Math.sin(this.time * 2) * 0.08 : 1;
      sprite.texture = this.human(n.outfit, n.facing, n.moving ? Math.floor(this.time * 8) % 4 : 0);
      sprite.position.set(Math.round(n.x * TILE_SIZE), Math.round(n.y * TILE_SIZE));
      sprite.zIndex = n.y * TILE_SIZE;
      const symbol = marks.get(n.id);
      mark.visible = !n.hidden && !!symbol;
      if (symbol) {
        mark.text = symbol;
        mark.position.set(sprite.x, sprite.y - 34 + Math.sin(this.time * 4) * 1.5);
      }
    }
    this.prune(this.people, live);
  }

  private syncEnemies(enemies: readonly Enemy[]): void {
    const live = new Set<number>();
    for (const e of enemies) {
      live.add(e.id);
      let d = this.drawn.get(e.id);
      if (!d) this.drawn.set(e.id, (d = this.create()));
      const { sprite, bar, mark } = d;
      const size = e.elite ? 1.25 : 1;
      if (e.species.outfit) {
        // Humanoids use the four-direction human sprites instead of mirroring.
        sprite.texture = this.human(e.species.outfit, e.facing > 0 ? Dir.Right : Dir.Left, e.moving ? Math.floor(this.time * 8) % 4 : 0);
        sprite.scale.set(size);
      } else {
        const frame = e.moving ? Math.floor(this.time * 7) % 2 : 0;
        sprite.texture = this.texture(e.state === 'burrowed' ? 'lurker:buried' : `${e.species.id}:${frame}`);
        sprite.scale.set(e.facing * size, size);
      }
      sprite.position.set(Math.round(e.x * TILE_SIZE), Math.round(e.y * TILE_SIZE));
      sprite.zIndex = e.y * TILE_SIZE;
      sprite.tint = e.hitFlash > 0 ? HIT_TINT : e.windingUp && Math.floor(this.time * 16) % 2 ? WINDUP_TINT : e.elite ? ELITE_TINT : 0xffffff;

      const top = sprite.y - sprite.height - 3;
      bar.clear();
      if (e.hp < e.maxHp && !e.species.boss) {
        const w = 16;
        bar.rect(sprite.x - w / 2, top, w, 3).fill({ color: 0x2a1a10 });
        bar.rect(sprite.x - w / 2 + 1, top + 1, (w - 2) * (e.hp / e.maxHp), 1).fill({ color: e.elite ? 0xffb030 : 0xe04a3a });
      }
      mark.visible = e.state === 'aggro';
      mark.text = '!';
      mark.position.set(sprite.x, top);
    }
    this.prune(this.drawn, live);
  }

  private syncProjectiles(projectiles: readonly Projectile[]): void {
    while (this.shots.length < projectiles.length) {
      const s = new Sprite({ anchor: { x: 0.5, y: 0.5 } });
      this.overlay.addChild(s);
      this.shots.push(s);
    }
    this.shots.forEach((s, i) => {
      const p = projectiles[i];
      s.visible = !!p;
      if (!p) return;
      s.texture = this.texture(`projectile:${p.kind}`);
      s.position.set(p.x * TILE_SIZE, p.y * TILE_SIZE);
      s.rotation = p.kind === 'arrow' || p.kind === 'ice' ? Math.atan2(p.vy, p.vx) : this.time * 8;
    });
  }

  private animateEffects(dt: number): void {
    for (let i = this.numbers.length - 1; i >= 0; i--) {
      const n = this.numbers[i];
      n.life -= dt;
      n.text.y -= dt * 18;
      n.text.alpha = Math.min(1, n.life / 0.3);
      if (n.life <= 0) {
        n.text.destroy();
        this.numbers.splice(i, 1);
      }
    }
    for (let i = this.swings.length - 1; i >= 0; i--) {
      const s = this.swings[i];
      s.life -= dt;
      s.g.alpha = s.life / SWING_SECONDS;
      if (s.life <= 0) {
        s.g.destroy();
        this.swings.splice(i, 1);
      }
    }
  }
}
