// Hotbar (spec 7.2, bottom centre): the inventory's first row. Keys 1 to 8
// select a slot; F, or tapping the selected slot again, uses it.

import { HOTBAR_SIZE, type Inventory } from '../systems/InventorySystem';
import { slotContent } from './ItemIcon';

export class Hotbar {
  selected = 0;
  onUse?: (slot: number) => void;
  private readonly slots: HTMLElement[] = [];
  /** The selected item's name, shown briefly above the bar. */
  private readonly label: HTMLElement;
  private labelTimer = 0;
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
    this.label = document.createElement('div');
    this.label.className = 'hotbar-name';
    bar.appendChild(this.label);
    root.appendChild(bar);
    this.select(0);
  }

  select(i: number): void {
    this.selected = i;
    this.slots.forEach((el, n) => el.classList.toggle('selected', n === i));
    const s = this.inv.slots[i];
    const durability = s?.durability !== undefined && s.item.weapon ? ` · ${s.durability}/${s.item.weapon.durability}` : '';
    this.label.textContent = s ? `${s.item.name}${durability}` : '';
    this.label.classList.toggle('show', !!s);
    clearTimeout(this.labelTimer);
    this.labelTimer = window.setTimeout(() => this.label.classList.remove('show'), 1600);
  }

  render(): void {
    if (this.inv.version === this.drawnVersion) return;
    this.drawnVersion = this.inv.version;
    this.slots.forEach((el, i) => {
      const s = this.inv.slots[i];
      el.replaceChildren(slotContent(this.atlas, s?.item ?? null, s?.count ?? 0, s?.durability));
      const key = document.createElement('span');
      key.className = 'key';
      key.textContent = String(i + 1);
      el.appendChild(key);
      el.title = s ? s.item.name : '';
    });
  }
}
