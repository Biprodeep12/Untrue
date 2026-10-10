// Hotbar (spec 7.2, bottom centre): the inventory's first row. Keys 1 to 8
// select a slot; F, or tapping the selected slot again, uses it.

import { HOTBAR_SIZE, type Inventory } from '../systems/InventorySystem';
import { slotContent } from './ItemIcon';

export class Hotbar {
  selected = 0;
  onUse?: (slot: number) => void;
  private readonly slots: HTMLElement[] = [];
  private drawnVersion = -1;

  constructor(
    root: HTMLElement,
    private readonly atlas: HTMLCanvasElement,
    private readonly inv: Inventory,
  ) {
    const bar = document.createElement('div');
    bar.className = 'panel hotbar';
    for (let i = 0; i < HOTBAR_SIZE; i++) {
      const el = document.createElement('button');
      el.className = 'slot';
      el.addEventListener('pointerdown', (e) => {
        e.stopPropagation();
        if (this.selected === i) this.onUse?.(i);
        else this.select(i);
      });
      bar.appendChild(el);
      this.slots.push(el);
    }
    root.appendChild(bar);
    this.select(0);
  }

  select(i: number): void {
    this.selected = i;
    this.slots.forEach((el, n) => el.classList.toggle('selected', n === i));
  }

  render(): void {
    if (this.inv.version === this.drawnVersion) return;
    this.drawnVersion = this.inv.version;
    this.slots.forEach((el, i) => {
      const s = this.inv.slots[i];
      el.replaceChildren(slotContent(this.atlas, s?.item ?? null, s?.count ?? 0));
      const key = document.createElement('span');
      key.className = 'key';
      key.textContent = String(i + 1);
      el.appendChild(key);
      el.title = s ? s.item.name : '';
    });
  }
}
