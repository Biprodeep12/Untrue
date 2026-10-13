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
/** `durability`: uses left, drawn as a bar for weapons. */
export function slotContent(atlas: HTMLCanvasElement, item: ItemDef | null, count: number, durability?: number): DocumentFragment {
  const f = document.createDocumentFragment();
  f.appendChild(itemIcon(atlas, item));
  if (item && count > 1) {
    const n = document.createElement('span');
    n.className = 'count';
    n.textContent = String(count);
    f.appendChild(n);
  }
  const max = item?.weapon?.durability;
  if (max && durability !== undefined && durability < max) {
    const bar = document.createElement('span');
    bar.className = 'durability';
    const share = Math.max(0, durability / max);
    bar.style.setProperty('--left', `${share * 100}%`);
    bar.classList.toggle('low', share < 0.25);
    f.appendChild(bar);
  }
  return f;
}
