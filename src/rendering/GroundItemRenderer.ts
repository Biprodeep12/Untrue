// Items lying on the ground: their icons, bobbing gently over a shadow.

import { Container, Graphics, Rectangle, Sprite, Texture } from 'pixi.js';
import { TILE_SIZE } from '../config';
import type { GroundItem } from '../world/GroundItems';
import { itemCell } from './Atlas';

export class GroundItemRenderer {
  private readonly drawn = new Map<number, Container>();
  private readonly icons = new Map<number, Texture>();
  private time = 0;

  constructor(
    private readonly atlas: Texture,
    private readonly layer: Container,
  ) {}

  update(dt: number, items: readonly GroundItem[]): void {
    this.time += dt;
    const live = new Set<number>();
    for (const g of items) {
      live.add(g.id);
      let c = this.drawn.get(g.id);
      if (!c) {
        c = new Container();
        const shadow = new Graphics().ellipse(0, 0, 5, 1.5).fill({ color: 0x000000, alpha: 0.25 });
        const icon = new Sprite({ texture: this.icon(g.stack.item.icon), anchor: { x: 0.5, y: 1 } });
        icon.scale.set(0.75);
        c.addChild(shadow, icon);
        this.layer.addChild(c);
        this.drawn.set(g.id, c);
      }
      c.position.set(Math.round(g.x * TILE_SIZE), Math.round(g.y * TILE_SIZE));
      c.zIndex = g.y * TILE_SIZE;
      c.children[1].y = -1 - Math.round((Math.sin(this.time * 3 + g.id) + 1) * 1.5);
    }
    for (const [id, c] of this.drawn) {
      if (live.has(id)) continue;
      c.destroy({ children: true });
      this.drawn.delete(id);
    }
  }

  private icon(index: number): Texture {
    let t = this.icons.get(index);
    if (!t) {
      const [x, y] = itemCell(index);
      this.icons.set(index, (t = new Texture({ source: this.atlas.source, frame: new Rectangle(x, y, 16, 16) })));
    }
    return t;
  }
}
