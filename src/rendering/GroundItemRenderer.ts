// Items lying on the ground: their icons, bobbing gently over a shadow. Only
// items near the screen are drawn; all share one shadow shape.

import { Container, Graphics, GraphicsContext, Rectangle, Sprite, Texture } from 'pixi.js';
import { TILE_SIZE } from '../config';
import type { GroundItem } from '../world/GroundItems';
import { itemCell } from './Atlas';

export class GroundItemRenderer {
  private readonly drawn = new Map<number, Container>();
  private readonly icons = new Map<number, Texture>();
  private readonly shadow = new GraphicsContext().ellipse(0, 0, 5, 1.5).fill({ color: 0x000000, alpha: 0.25 });
  private readonly live = new Set<number>();
  private time = 0;

  constructor(
    private readonly atlas: Texture,
    private readonly layer: Container,
  ) {}

  /** `view`: the drawn area in tiles; items outside it are not drawn. */
  update(dt: number, items: readonly GroundItem[], view: { x0: number; y0: number; x1: number; y1: number }): void {
    this.time += dt;
    const live = this.live;
    live.clear();
    for (const g of items) {
      if (g.x < view.x0 || g.x > view.x1 || g.y < view.y0 || g.y > view.y1) continue;
      live.add(g.id);
      let c = this.drawn.get(g.id);
      if (!c) {
        c = new Container();
        const shadow = new Graphics(this.shadow);
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
