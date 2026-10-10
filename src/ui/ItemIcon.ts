// Item icons drawn from the atlas into small canvases for the HTML UI.

import type { ItemDef } from '../items/Items';
import { itemCell } from '../rendering/Atlas';

export function itemIcon(atlas: HTMLCanvasElement, item: ItemDef | null, size = 32): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  c.className = 'item-icon';
  if (item) {
    const ctx = c.getContext('2d')!;
    ctx.imageSmoothingEnabled = false;
    const [x, y] = itemCell(item.icon);
    ctx.drawImage(atlas, x, y, 16, 16, 0, 0, size, size);
  }
  return c;
}

/** One inventory slot: icon plus stack count. */
export function slotContent(atlas: HTMLCanvasElement, item: ItemDef | null, count: number): DocumentFragment {
  const f = document.createDocumentFragment();
  f.appendChild(itemIcon(atlas, item));
  if (item && count > 1) {
    const n = document.createElement('span');
    n.className = 'count';
    n.textContent = String(count);
    f.appendChild(n);
  }
  return f;
}
