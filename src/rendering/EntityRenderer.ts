// Draws enemies, NPCs, projectiles and combat feedback: health bars, alert
// marks, floating damage numbers and sword swings. Display objects are pooled:
// enemies come and go all the time, and making a Text costs a texture upload.

import { Container, Graphics, Rectangle, Sprite, Text, Texture } from 'pixi.js';
import { TILE_SIZE } from '../config';
import type { Enemy } from '../entities/Enemy';
import type { Npc } from '../entities/NPC';
import type { Projectile } from '../systems/CombatSystem';
import { creatureFrame, Dir, humanHand, itemCell, playerCell } from './Atlas';
import { pixelText } from './PixelText';

const ELITE_TINT = 0xffd27a;
const HIT_TINT = 0xff6a6a;
const WINDUP_TINT = 0xffb0b0;
/** The mark over an enemy about to strike: red, against the yellow "!" of noticing you. */
const STRIKE_MARK_TINT = 0xff5040;
const NUMBER_SECONDS = 0.8;
/** Players' names: pale letters, dark outline. */
const TAG_FILL: [number, number, number] = [0xe8, 0xf4, 0xff];
const TAG_OUTLINE: [number, number, number] = [0x1a, 0x12, 0x30];
/** A name sits this many world pixels above the feet. */
const TAG_LIFT = 34;
const SWING_SECONDS = 0.14;

interface Drawn {
  sprite: Sprite;
  bar: Graphics;
  mark: Text;
  /** What the health bar shows, so it is only redrawn when that changes. */
  barKey: string;
}

/** Another player in a shared dimension, as the network last placed them. */
export interface RemotePlayer {
  /** Their slot in the session: stable while they are in it. */
  readonly slot: number;
  name: string;
  x: number;
  y: number;
  facing: number;
  /** Walk frame, 0–3. */
  frame: number;
  /** Item icon index in hand, or -1. */
  holding: number;
  /** Seconds left on the hurt flash. */
  hurt: number;
}

interface PlayerView {
  body: Sprite;
  held: Sprite;
  /** The name, in screen pixels, so the camera's zoom never stretches it. */
  tag: Sprite;
  name: string;
}

interface Floating {
  text: Text;
  life: number;
  style: string;
}

export class EntityRenderer {
  private readonly textures = new Map<string, Texture>();
  /** Human frames per outfit, by direction * 4 + walk frame. */
  private readonly humans = new Map<string, Texture[]>();
  private readonly drawn = new Map<number, Drawn>();
  private readonly people = new Map<number, Drawn>();
  /** Other players, by slot, and those put away for reuse. */
  private readonly players = new Map<number, PlayerView>();
  private readonly sparePlayers: PlayerView[] = [];
  private readonly icons = new Map<number, Texture>();
  private readonly shots: Sprite[] = [];
  private readonly numbers: Floating[] = [];
  private readonly swings: Array<{ g: Graphics; life: number }> = [];
  /** Pools of hidden objects, ready for reuse. */
  private readonly spareDrawn: Drawn[] = [];
  private readonly spareNumbers = new Map<string, Text[]>();
  private readonly spareSwings: Graphics[] = [];
  /** Ids seen this frame, reused rather than allocated per frame. */
  private readonly live = new Set<number>();
  private time = 0;

  constructor(
    private readonly atlas: Texture,
    /** Y-sorted with trees and the player. */
    private readonly entities: Container,
    /** Drawn above everything in the world. */
    private readonly overlay: Container,
  ) {}

  /** Where players' names go: a layer in screen pixels, above the world and
   *  its lighting, and how to get there from world pixels. Without one,
   *  names are not drawn. */
  private tagLayer: Container | null = null;
  private toScreen: ((x: number, y: number) => readonly [number, number]) | null = null;

  setTagLayer(layer: Container, toScreen: (x: number, y: number) => readonly [number, number]): void {
    this.tagLayer = layer;
    this.toScreen = toScreen;
  }

  /** `marks` puts a symbol over NPCs, e.g. '!' for an open quest. */
  update(dt: number, enemies: readonly Enemy[], projectiles: readonly Projectile[], npcs: readonly Npc[], marks: ReadonlyMap<number, string>): void {
    this.time += dt;
    this.syncEnemies(enemies);
    this.syncNpcs(npcs, marks);
    this.syncProjectiles(projectiles);
    this.animateEffects(dt);
  }

  /** Draws other players: their figure, what they hold, and their name over
   *  them. A name's text is only remade when it changes. */
  syncPlayers(list: readonly RemotePlayer[], layer: Container = this.entities): void {
    const tags = this.tagLayer;
    const toScreen = this.toScreen;
    const live = this.live;
    live.clear();
    for (const p of list) {
      live.add(p.slot);
      let v = this.players.get(p.slot);
      if (!v) this.players.set(p.slot, (v = this.makePlayer()));
      // Into a room's own view when the players are indoors.
      if (v.body.parent !== layer) layer.addChild(v.body, v.held);
      if (tags && v.tag.parent !== tags) tags.addChild(v.tag);
      if (v.name !== p.name) {
        v.name = p.name;
        // Remade only when the name changes; the old one is freed.
        const old = v.tag.texture;
        v.tag.texture = pixelText(p.name, TAG_FILL, TAG_OUTLINE);
        if (old !== Texture.EMPTY) old.destroy(true);
      }
      const x = Math.round(p.x * TILE_SIZE);
      const y = Math.round(p.y * TILE_SIZE);
      const { body, held, tag } = v;
      body.texture = this.human('player', p.facing, p.frame);
      body.position.set(x, y);
      body.zIndex = p.y * TILE_SIZE;
      body.tint = p.hurt > 0 && Math.floor(p.hurt * 20) % 2 ? HIT_TINT : 0xffffff;
      held.visible = p.holding >= 0;
      if (held.visible) {
        held.texture = this.icon(p.holding);
        const [hx, hy] = humanHand(p.facing, p.frame);
        held.position.set(x + hx, y + hy);
        held.zIndex = body.zIndex + (p.facing === Dir.Up ? -0.5 : 0.5);
      }
      tag.visible = !!toScreen;
      if (toScreen) {
        const [sx, sy] = toScreen(x, y - TAG_LIFT);
        // Whole screen pixels, left edge from half the width: never a half pixel.
        tag.position.set(Math.round(sx) - (tag.texture.width >> 1), Math.round(sy) - tag.texture.height);
      }
    }
    for (const [slot, v] of this.players) {
      if (live.has(slot)) continue;
      v.body.visible = v.held.visible = v.tag.visible = false;
      this.players.delete(slot);
      this.sparePlayers.push(v);
    }
  }

  private makePlayer(): PlayerView {
    const spare = this.sparePlayers.pop();
    if (spare) {
      spare.body.visible = spare.tag.visible = true;
      return spare;
    }
    const v: PlayerView = {
      body: new Sprite({ anchor: { x: 0.5, y: 1 } }),
      held: new Sprite({ anchor: { x: 0.3, y: 0.7 } }),
      tag: new Sprite(Texture.EMPTY),
      name: '',
    };
    this.entities.addChild(v.body, v.held);
    if (this.tagLayer) this.tagLayer.addChild(v.tag);
    return v;
  }

  private icon(index: number): Texture {
    let t = this.icons.get(index);
    if (!t) {
      const [x, y] = itemCell(index);
      this.icons.set(index, (t = new Texture({ source: this.atlas.source, frame: new Rectangle(x, y, 16, 16) })));
    }
    return t;
  }

  damageNumber(x: number, y: number, amount: number, crit: boolean, toPlayer: boolean): void {
    const style = toPlayer ? 'hurt' : crit ? 'crit' : 'hit';
    let text = this.spareNumbers.get(style)?.pop();
    if (!text) {
      text = new Text({
        text: '',
        style: {
          fontFamily: 'Pixelify Sans, monospace',
          fontSize: crit ? 12 : 9,
          fill: toPlayer ? 0xff6a5a : crit ? 0xffd040 : 0xffffff,
          stroke: { color: 0x2a1a10, width: 2 },
        },
      });
      text.anchor.set(0.5, 1);
      this.overlay.addChild(text);
    }
    text.text = crit ? `${amount}!` : String(amount);
    text.visible = true;
    text.alpha = 1;
    text.position.set(x * TILE_SIZE + (Math.random() - 0.5) * 6, y * TILE_SIZE);
    this.numbers.push({ text, life: NUMBER_SECONDS, style });
  }

  swing(x: number, y: number, dx: number, dy: number, reach: number): void {
    let g = this.spareSwings.pop();
    if (!g) {
      g = new Graphics();
      this.overlay.addChild(g);
    }
    g.clear();
    g.visible = true;
    const angle = Math.atan2(dy, dx);
    const r = reach * TILE_SIZE;
    g.arc(0, 0, r, angle - 1, angle + 1).stroke({ width: 3, color: 0xffffff, alpha: 0.85 });
    g.arc(0, 0, r - 3, angle - 0.8, angle + 0.8).stroke({ width: 1, color: 0xfff2b0, alpha: 0.6 });
    g.position.set(x * TILE_SIZE, y * TILE_SIZE);
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
    // No string keys: this runs for every person every frame.
    let frames = this.humans.get(outfit);
    if (!frames) {
      frames = [];
      for (let k = 0; k < 16; k++) {
        const [x, y] = playerCell(k >> 2, k & 3, outfit);
        frames.push(new Texture({ source: this.atlas.source, frame: new Rectangle(x, y, 16, 32) }));
      }
      this.humans.set(outfit, frames);
    }
    return frames[dir * 4 + frame];
  }

  private create(): Drawn {
    const spare = this.spareDrawn.pop();
    if (spare) {
      spare.sprite.visible = spare.bar.visible = true;
      spare.sprite.alpha = 1;
      spare.mark.tint = spare.sprite.tint = 0xffffff;
      spare.sprite.scale.set(1);
      return spare;
    }
    const d = {
      sprite: new Sprite({ anchor: { x: 0.5, y: 1 } }),
      bar: new Graphics(),
      mark: new Text({ text: '!', style: { fontFamily: 'Pixelify Sans, monospace', fontSize: 12, fill: 0xffd040, stroke: { color: 0x2a1a10, width: 2 } } }),
      barKey: '',
    };
    d.mark.anchor.set(0.5, 1);
    this.entities.addChild(d.sprite);
    this.overlay.addChild(d.bar, d.mark);
    return d;
  }

  /** Hides what is no longer in the world and keeps it for reuse. */
  private prune(map: Map<number, Drawn>, live: Set<number>): void {
    for (const [id, d] of map) {
      if (live.has(id)) continue;
      d.sprite.visible = d.bar.visible = d.mark.visible = false;
      d.bar.clear();
      d.barKey = '';
      this.spareDrawn.push(d);
      map.delete(id);
    }
  }

  private syncNpcs(npcs: readonly Npc[], marks: ReadonlyMap<number, string>): void {
    const live = this.live;
    live.clear();
    for (const n of npcs) {
      live.add(n.id);
      let d = this.people.get(n.id);
      if (!d) this.people.set(n.id, (d = this.create()));
      const { sprite, mark } = d;
      sprite.visible = !n.hidden;
      // Spirits are faint, and drift a little.
      const ghost = n.role === 'spirit';
      const alpha = ghost ? 0.62 + 0.12 * Math.sin(this.time * 2) : 1;
      if (sprite.alpha !== alpha) sprite.alpha = alpha;
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
    const live = this.live;
    live.clear();
    for (const e of enemies) {
      live.add(e.id);
      let d = this.drawn.get(e.id);
      if (!d) this.drawn.set(e.id, (d = this.create()));
      const { sprite, bar, mark } = d;
      const size = (e.elite ? 1.25 : 1) * (e.species.size ?? 1);
      if (e.species.outfit) {
        // Humanoids use the four-direction human sprites instead of mirroring.
        sprite.texture = this.human(e.species.outfit, e.facing > 0 ? Dir.Right : Dir.Left, e.moving ? Math.floor(this.time * 8) % 4 : 0);
        sprite.scale.set(size);
      } else {
        const frame = e.moving ? Math.floor(this.time * 7) % 2 : 0;
        const art = e.species.art ?? e.species.id;
        sprite.texture = this.texture(e.state === 'burrowed' ? `${art}:buried` : `${art}:${frame}`);
        sprite.scale.set(e.facing * size, size);
      }
      sprite.position.set(Math.round(e.x * TILE_SIZE), Math.round(e.y * TILE_SIZE));
      sprite.zIndex = e.y * TILE_SIZE;
      sprite.tint = e.hitFlash > 0 ? HIT_TINT : e.windingUp && Math.floor(this.time * 16) % 2 ? WINDUP_TINT : e.elite ? ELITE_TINT : (e.species.tint ?? 0xffffff);

      const top = sprite.y - sprite.height - 3;
      // The bar is drawn around (0, 0) and moved, so walking does not redraw it.
      const shown = e.hp < e.maxHp && !e.species.boss;
      const key = shown ? `${Math.ceil((e.hp / e.maxHp) * 14)}${e.elite ? 'e' : ''}` : '';
      if (key !== d.barKey) {
        d.barKey = key;
        bar.clear();
        if (shown) {
          const w = 16;
          bar.rect(-w / 2, 0, w, 3).fill({ color: 0x2a1a10 });
          bar.rect(-w / 2 + 1, 1, (w - 2) * (e.hp / e.maxHp), 1).fill({ color: e.elite ? 0xffb030 : 0xe04a3a });
        }
      }
      bar.position.set(sprite.x, top);
      // "!" when it notices you; a red "!" while it winds up a blow.
      mark.visible = e.state === 'aggro' || e.windingUp;
      mark.text = '!';
      mark.tint = e.windingUp ? STRIKE_MARK_TINT : 0xffffff;
      mark.position.set(sprite.x, top - (e.windingUp ? 2 : 0));
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
        n.text.visible = false;
        let pool = this.spareNumbers.get(n.style);
        if (!pool) this.spareNumbers.set(n.style, (pool = []));
        pool.push(n.text);
        this.numbers.splice(i, 1);
      }
    }
    for (let i = this.swings.length - 1; i >= 0; i--) {
      const s = this.swings[i];
      s.life -= dt;
      s.g.alpha = s.life / SWING_SECONDS;
      if (s.life <= 0) {
        s.g.visible = false;
        this.spareSwings.push(s.g);
        this.swings.splice(i, 1);
      }
    }
  }
}
