// The player: four-direction walking with tile collision, a dodge roll,
// knockback with brief invulnerability after a hit, and actions: swinging a
// weapon or tool, drawing a bow, and stooping to pick plants.

import { Container, Graphics, Rectangle, Sprite, Texture } from 'pixi.js';
import { PLAYER_DEPTH, PLAYER_HALF_W, RUN_SPEED, TILE_SIZE, WALK_SPEED } from '../config';
import type { ItemDef } from '../items/Items';
import { armorCell, ARMOR_PARTS, Dir, itemCell, playerCell } from '../rendering/Atlas';
import type { Input } from './Input';

/** Anything the player can walk around in: the world, or a room. */
export interface Collider {
  isSolidAt(gx: number, gy: number): boolean;
}

const FACING_VECTORS = [
  [0, 1],
  [-1, 0],
  [1, 0],
  [0, -1],
];
const DODGE_SPEED = 15;
const DODGE_SECONDS = 0.18;
const DODGE_COOLDOWN = 0.7;
export const DODGE_STAMINA = 20;
/** Invulnerability after taking a hit. */
const HURT_SECONDS = 0.6;
const KNOCKBACK = 0.45;
/** While swimming, only the top of the body shows, this many pixels lower. */
const SWIM_SHOWN = 24;
const SWIM_SINK = 4;

export type ActionKind = 'swing' | 'shoot' | 'pick' | 'punch';
const ACTION_SECONDS: Record<ActionKind, number> = { swing: 0.28, shoot: 0.3, pick: 0.4, punch: 0.2 };
/** Screen angle each facing points at (0 is right, down is positive). */
const FACING_ANGLE = [Math.PI / 2, Math.PI, 0, -Math.PI / 2];
/** The hand that holds things, in pixels from the feet, per facing, matching
 *  the arms in the human sprite (`paintHuman`); `step` is the walk sway. */
function handAt(facing: number, step: number): [number, number] {
  switch (facing) {
    case Dir.Left:
      return [1 + step, -7.5];
    case Dir.Right:
      return [-step, -7.5];
    default:
      return [3.5, -7.5 - step];
  }
}
/** Skin of the player's hand, drawn over the grip. */
const SKIN = 0xf2c29a;
/** Item icons point up and to the right; this turns them to point along 0. */
const ICON_TILT = Math.PI / 4;

export class Player {
  /** Feet position in tiles. */
  x = 0.5;
  y = 0.5;
  /** Last movement direction, used to predict which chunks to generate. */
  dirX = 0;
  dirY = 0;
  /** Moved this frame, and whether at a run. */
  moving = false;
  running = false;
  facing: number = Dir.Down;
  /** 0 on land, 1 in shallow water, 2 in deep water. */
  swim = 0;
  /** The player's figure and whatever is in hand, positioned at the feet. */
  readonly sprite = new Container();
  private readonly body: Sprite;
  private readonly held = new Sprite();
  /** The fist closed around what is held. */
  private readonly fist = new Graphics().rect(-1, -1, 2, 2).fill({ color: SKIN }).rect(-1, 1, 2, 0.5).fill({ color: 0xc89a7a });
  private frame = 0;
  /** Armour set worn per part (0 head, 1 chest, 2 legs, 3 feet), -1 for none. */
  wear: number[] = [-1, -1, -1, -1];
  /** What is in the off hand: a shield, torch or lantern. */
  offhand: ItemDef | null = null;
  /** Blocking: the shield comes up in front. */
  guarding = false;
  private readonly armor: Sprite[] = [];
  private readonly off = new Sprite();
  private readonly armorTextures = new Map<string, Texture>();
  private order = -1;
  /** A weapon, tool or light shown in hand, or null for empty hands. */
  holding: ItemDef | null = null;
  private action: { kind: ActionKind; t: number; item: ItemDef | null } | null = null;
  private readonly icons = new Map<number, Texture>();
  private readonly atlas: Texture;
  private readonly frames: Texture[] = [];
  private readonly swimFrames: Texture[] = [];
  private anim = 0;
  private dodgeTime = 0;
  private dodgeCooldown = 0;
  private dodgeX = 0;
  private dodgeY = 0;
  private hurtTime = 0;

  constructor(atlas: Texture) {
    this.atlas = atlas;
    for (let d = 0; d < 4; d++) {
      for (let f = 0; f < 4; f++) {
        const [x, y] = playerCell(d, f);
        this.frames.push(new Texture({ source: atlas.source, frame: new Rectangle(x, y, 16, 32) }));
        this.swimFrames.push(new Texture({ source: atlas.source, frame: new Rectangle(x, y, 16, SWIM_SHOWN) }));
      }
    }
    this.body = new Sprite({ texture: this.frames[0], anchor: { x: 0.5, y: 1 } });
    // Legs, feet, chest, then head, over the body.
    for (let k = 0; k < ARMOR_PARTS; k++) this.armor.push(new Sprite({ anchor: { x: 0.5, y: 1 } }));
    this.sprite.addChild(this.off, this.body, this.armor[2], this.armor[3], this.armor[1], this.armor[0], this.held, this.fist);
  }

  /** Starts an action animation: a swing with `item` (a weapon or tool), a
   *  punch, a bow shot, or stooping to pick something. */
  act(kind: ActionKind, item: ItemDef | null = null): void {
    this.action = { kind, t: 0, item };
  }

  get acting(): boolean {
    return this.action !== null;
  }

  /** Unit vector the player faces. */
  get faceX(): number {
    return FACING_VECTORS[this.facing][0];
  }

  get faceY(): number {
    return FACING_VECTORS[this.facing][1];
  }

  get invulnerable(): boolean {
    return this.dodgeTime > 0 || this.hurtTime > 0;
  }

  place(x: number, y: number): void {
    this.x = x;
    this.y = y;
    this.syncSprite(0);
  }

  /** Turns to face a direction, e.g. toward the mouse when attacking. */
  faceTowards(dx: number, dy: number): void {
    if (Math.abs(dx) > Math.abs(dy)) this.facing = dx < 0 ? Dir.Left : Dir.Right;
    else this.facing = dy < 0 ? Dir.Up : Dir.Down;
  }

  /** Starts a roll in the movement direction (or facing). */
  dodge(): boolean {
    if (this.dodgeCooldown > 0 || this.dodgeTime > 0) return false;
    const moving = this.dirX || this.dirY;
    this.dodgeX = moving ? this.dirX : this.faceX;
    this.dodgeY = moving ? this.dirY : this.faceY;
    this.dodgeTime = DODGE_SECONDS;
    this.dodgeCooldown = DODGE_COOLDOWN;
    return true;
  }

  /** Took a hit from (fromX, fromY): get pushed back and blink. */
  hurt(fromX: number, fromY: number, world: Collider): void {
    this.hurtTime = HURT_SECONDS;
    const dx = this.x - fromX;
    const dy = this.y - fromY;
    const len = Math.hypot(dx, dy) || 1;
    this.move((dx / len) * KNOCKBACK, (dy / len) * KNOCKBACK, world);
  }

  /** `speedFactor` slows the player, e.g. when webbed. */
  update(dt: number, input: Input, world: Collider, canRun: boolean, speedFactor: number): void {
    this.hurtTime = Math.max(0, this.hurtTime - dt);
    if (this.action && (this.action.t += dt) >= ACTION_SECONDS[this.action.kind]) this.action = null;
    this.dodgeCooldown = Math.max(0, this.dodgeCooldown - dt);
    const { x: ax, y: ay } = input.axis();
    this.dirX = ax;
    this.dirY = ay;

    if (this.dodgeTime > 0) {
      this.dodgeTime -= dt;
      this.move(this.dodgeX * DODGE_SPEED * dt, this.dodgeY * DODGE_SPEED * dt, world);
      this.moving = true;
      this.running = false;
      this.syncSprite(2);
      return;
    }

    const moving = ax !== 0 || ay !== 0;
    this.moving = moving;
    this.running = moving && canRun && input.running();
    if (moving) {
      const speed = (this.running ? RUN_SPEED : WALK_SPEED) * speedFactor;
      this.move(ax * speed * dt, ay * speed * dt, world);
      this.faceTowards(ax, ay);
      this.anim += dt * (speed / WALK_SPEED) * 8;
    } else {
      this.anim = 0;
    }
    this.syncSprite(moving ? Math.floor(this.anim) % 4 : 0);
  }

  /** The tile the player faces, one step from the feet. */
  frontTile(): [number, number] {
    return [Math.floor(this.x + this.faceX * 0.8), Math.floor(this.y - 0.15 + this.faceY * 0.8)];
  }

  blocked(x: number, y: number, world: Collider): boolean {
    for (const [cx, cy] of [
      [x - PLAYER_HALF_W, y - PLAYER_DEPTH],
      [x + PLAYER_HALF_W, y - PLAYER_DEPTH],
      [x - PLAYER_HALF_W, y - 0.01],
      [x + PLAYER_HALF_W, y - 0.01],
    ]) {
      if (world.isSolidAt(Math.floor(cx), Math.floor(cy))) return true;
    }
    return false;
  }

  private move(dx: number, dy: number, world: Collider): void {
    if (!this.blocked(this.x + dx, this.y, world)) this.x += dx;
    if (!this.blocked(this.x, this.y + dy, world)) this.y += dy;
  }

  private syncSprite(frame: number): void {
    this.frame = frame;
    const swimming = this.swim > 0 && this.dodgeTime <= 0;
    this.body.texture = (swimming ? this.swimFrames : this.frames)[this.facing * 4 + frame];
    // Bob gently in the water.
    const sink = swimming ? 32 - SWIM_SHOWN - SWIM_SINK + (Math.floor(this.anim) % 2) : 0;
    this.sprite.position.set(Math.round(this.x * TILE_SIZE), Math.round(this.y * TILE_SIZE) - sink);
    this.sprite.zIndex = this.y * TILE_SIZE;
    // Blink while invulnerable after a hit.
    this.sprite.alpha = this.hurtTime > 0 && Math.floor(this.hurtTime * 20) % 2 ? 0.35 : 1;
    this.pose(swimming);
    this.dress(swimming);
    this.poseOffhand(swimming);
    this.layer();
  }

  /** Armour over the body, frame for frame. */
  private dress(swimming: boolean): void {
    for (let part = 0; part < ARMOR_PARTS; part++) {
      const s = this.armor[part];
      const set = this.wear[part];
      // Underwater, only the head and chest show.
      s.visible = set >= 0 && !(swimming && part >= 2);
      if (!s.visible) continue;
      s.texture = this.armorTexture(set, part, this.facing, this.frame, swimming);
      s.position.copyFrom(this.body.position);
      s.scale.copyFrom(this.body.scale);
    }
  }

  /** The off-hand item: a shield at the side (raised in front while
   *  blocking), a torch held up, or a lantern hanging from the hand. */
  private poseOffhand(swimming: boolean): void {
    const item = this.offhand;
    const off = this.off;
    off.visible = !!item && !swimming && this.dodgeTime <= 0;
    if (!off.visible || !item) return;
    off.texture = this.icon(item);
    const step = this.frame === 1 ? 1 : this.frame === 3 ? -1 : 0;
    const bx = this.body.x;
    const by = this.body.y;
    if (item.shield && this.guarding) {
      off.anchor.set(0.5, 0.5);
      off.scale.set(0.75);
      off.rotation = 0;
      off.position.set(bx + this.faceX * 4, by - 12 + this.faceY * 2);
      return;
    }
    // The other hand: on the left facing down or up, out of sight to the side.
    const [hx, hy] = this.facing === Dir.Down || this.facing === Dir.Up ? [-3.5, -7.5 + step] : [this.facing === Dir.Left ? -2 : 2, -8];
    off.position.set(bx + hx, by + hy);
    if (item.shield) {
      off.anchor.set(0.5, 0.55);
      off.scale.set(0.6);
      off.rotation = 0;
    } else if (item.light && item.id !== 'torch') {
      off.anchor.set(0.5, 0.1);
      off.scale.set(0.55);
      off.rotation = this.moving ? Math.sin(this.anim * 1.6 + 1) * 0.25 : 0;
      off.position.y -= 1;
    } else {
      off.anchor.set(0.22, 0.78);
      off.scale.set(0.6);
      off.rotation = -Math.PI / 2 - 0.25 + ICON_TILT;
    }
  }

  /** Back to front: what is held on the far side, the body and its armour,
   *  then what is held on the near side. */
  private layer(): void {
    const away = this.facing === Dir.Up;
    const offFront = this.facing === Dir.Down || (this.guarding && !!this.offhand?.shield && !away);
    // Reordering children makes Pixi rebuild its draw lists, so only do it
    // when the order actually changes.
    const order0 = (away ? 1 : 0) + (offFront ? 2 : 0);
    if (order0 === this.order) return;
    this.order = order0;
    const order: Container[] = [];
    if (!offFront) order.push(this.off);
    if (away) order.push(this.held);
    order.push(this.body, this.armor[2], this.armor[3], this.armor[1], this.armor[0]);
    if (!away) order.push(this.held);
    order.push(this.fist);
    if (offFront) order.push(this.off);
    order.forEach((child, i) => this.sprite.setChildIndex(child, i));
  }

  private armorTexture(set: number, part: number, dir: number, frame: number, swimming: boolean): Texture {
    const key = `${set}:${part}:${dir}:${frame}:${swimming ? 1 : 0}`;
    let t = this.armorTextures.get(key);
    if (!t) {
      const [x, y] = armorCell(set, part, dir, frame);
      this.armorTextures.set(key, (t = new Texture({ source: this.atlas.source, frame: new Rectangle(x, y, 16, swimming ? SWIM_SHOWN : 32) })));
    }
    return t;
  }

  /** Leans into actions and places the item in the hand. */
  private pose(swimming: boolean): void {
    const a = this.action;
    const t = a ? a.t / ACTION_SECONDS[a.kind] : 0;
    const fx = this.faceX;
    const fy = this.faceY;
    // A lunge toward the facing for swings and punches; a stoop for picking.
    const lunge = a && (a.kind === 'swing' || a.kind === 'punch') ? Math.sin(t * Math.PI) * 2 : 0;
    this.body.position.set(Math.round(fx * lunge), Math.round(fy * lunge));
    this.body.scale.set(1, a?.kind === 'pick' ? 1 - Math.sin(t * Math.PI) * 0.12 : 1);

    const item = a ? a.item : this.holding;
    const held = this.held;
    const fist = this.fist;
    held.visible = !!item && !swimming && this.dodgeTime <= 0 && a?.kind !== 'pick' && a?.kind !== 'punch';
    fist.visible = held.visible && this.facing !== Dir.Up;
    if (!held.visible || !item) return;
    held.texture = this.icon(item);
    const step = this.frame === 1 ? 1 : this.frame === 3 ? -1 : 0;
    const [hx, hy] = handAt(this.facing, a ? 0 : step);
    const x = hx + this.body.x;
    const y = hy + this.body.y;
    fist.position.set(x, y);
    const face = FACING_ANGLE[this.facing];
    // Swings sweep clockwise facing right or down, and the other way facing left or up.
    const sign = this.facing === Dir.Left || this.facing === Dir.Up ? -1 : 1;

    if (!a && item.light && item.id !== 'torch') {
      // A lantern hangs from its handle, swaying as the player walks.
      held.anchor.set(0.5, 0.1);
      held.scale.set(0.55);
      held.rotation = this.moving ? Math.sin(this.anim * 1.6) * 0.25 : 0;
      held.position.set(x, y - 1);
      return;
    }
    if (a?.kind === 'shoot' || (!a && item.weapon?.kind === 'bow')) {
      // A bow is held out in front while shooting, and at the side otherwise.
      held.anchor.set(0.5, 0.5);
      held.rotation = (a ? face : -Math.PI / 2 + (this.facing === Dir.Left ? -0.3 : 0.3)) + ICON_TILT;
      held.scale.set(a ? 0.8 : 0.6);
      held.position.set(x + (a ? fx * 3 : 0), y + (a ? fy * 3 : -2));
      return;
    }
    held.anchor.set(0.22, 0.78);
    held.scale.set(a ? 0.8 : 0.6);
    held.position.set(x, y);
    let angle: number;
    if (a) {
      // Wind up behind, then sweep through the facing.
      const ease = t < 0.3 ? 0 : Math.min(1, (t - 0.3) / 0.5);
      angle = face - sign * 1.9 + sign * 2.6 * ease * ease * (3 - 2 * ease);
    } else {
      // Carried upright in the hand, tipped away from the body so it shows.
      const out = this.facing === Dir.Left ? -1 : 1;
      angle = -Math.PI / 2 + out * (item.light ? 0.25 : 0.45);
    }
    held.rotation = angle + ICON_TILT;
  }

  private icon(item: ItemDef): Texture {
    let t = this.icons.get(item.icon);
    if (!t) {
      const [x, y] = itemCell(item.icon);
      this.icons.set(item.icon, (t = new Texture({ source: this.atlas.source, frame: new Rectangle(x, y, 16, 16) })));
    }
    return t;
  }
}
