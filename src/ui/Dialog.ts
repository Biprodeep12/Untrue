// Conversation and trade panel, shown when talking to an NPC.

import type { ItemDef } from '../items/Items';
import type { Offer } from '../systems/TradeSystem';
import { itemIcon } from './ItemIcon';

export interface DialogOption {
  label: string;
  action: () => void;
  disabled?: boolean;
}

export interface Sellable {
  item: ItemDef;
  count: number;
  price: number;
}

export class Dialog {
  isOpen = false;
  private readonly root: HTMLElement;

  constructor(
    parent: HTMLElement,
    private readonly atlas: HTMLCanvasElement,
  ) {
    this.root = document.createElement('div');
    this.root.className = 'panel dialog';
    parent.appendChild(this.root);
  }

  talk(name: string, text: string, options: DialogOption[]): void {
    this.open();
    const head = document.createElement('div');
    head.innerHTML = `<h3></h3><p></p>`;
    head.querySelector('h3')!.textContent = name;
    head.querySelector('p')!.textContent = text;
    const row = document.createElement('div');
    row.className = 'dialog-options';
    for (const o of [...options, { label: 'Goodbye', action: () => this.close() }]) row.appendChild(this.button(o));
    this.root.replaceChildren(head, row);
  }

  trade(name: string, coins: number, offers: Offer[], sellables: Sellable[], buy: (o: Offer) => void, sell: (item: ItemDef, count: number) => void): void {
    this.open();
    const head = document.createElement('div');
    head.innerHTML = `<h3></h3><p class="coins"></p>`;
    head.querySelector('h3')!.textContent = name;
    head.querySelector('.coins')!.textContent = `Your coins: ${coins}`;
    const cols = document.createElement('div');
    cols.className = 'trade-cols';
    const column = (title: string, rows: HTMLElement[]) => {
      const c = document.createElement('div');
      c.innerHTML = `<h4>${title}</h4>`;
      if (!rows.length) c.insertAdjacentHTML('beforeend', '<p class="hint">Nothing</p>');
      c.append(...rows);
      return c;
    };
    const row = (item: ItemDef, label: string, ...buttons: DialogOption[]) => {
      const r = document.createElement('div');
      r.className = 'trade-row';
      const text = document.createElement('span');
      text.textContent = label;
      r.append(itemIcon(this.atlas, item, 24), text, ...buttons.map((b) => this.button(b)));
      return r;
    };
    cols.append(
      column('Buy', offers.map((o) => row(o.item, `${o.count > 1 ? `${o.count} × ` : ''}${o.item.name} · ${o.price}c`, { label: 'Buy', action: () => buy(o), disabled: coins < o.price }))),
      column('Sell', sellables.map((s) => row(s.item, `${s.item.name} (${s.count}) · ${s.price}c`,
        { label: 'Sell', action: () => sell(s.item, 1) },
        ...(s.count > 1 ? [{ label: `All ${s.count * s.price}c`, action: () => sell(s.item, s.count) }] : [])))),
    );
    const done = document.createElement('div');
    done.className = 'dialog-options';
    done.appendChild(this.button({ label: 'Done', action: () => this.close() }));
    this.root.replaceChildren(head, cols, done);
  }

  close(): void {
    this.isOpen = false;
    this.root.classList.remove('open');
  }

  private open(): void {
    this.isOpen = true;
    this.root.classList.add('open');
  }

  private button(o: DialogOption): HTMLButtonElement {
    const b = document.createElement('button');
    b.className = 'btn';
    b.textContent = o.label;
    b.disabled = !!o.disabled;
    b.addEventListener('click', () => o.action());
    return b;
  }
}
