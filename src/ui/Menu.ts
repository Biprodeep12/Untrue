// Main menu (spec 7.2): a full-screen wood panel with tabs for inventory,
// crafting, skills, quests, the map, the lantern, settings and about.

import { ACTION_LABELS, bindings, DEFAULT_KEYS, keyName, RESERVED_KEYS, type Action } from '../game/Keys';
import type { Settings } from '../game/Settings';
import type { Memory } from '../story/StorySystem';
import { SPECIES } from '../entities/Species';
import { ELEMENT_NAMES, itemById, Items, RARITY_NAMES, weightOf, type EquipSlot, type ItemDef } from '../items/Items';
import { armorCell, Dir, playerCell } from '../rendering/Atlas';
import { MAX_RANK, SKILLS, type Progression, type SkillId } from '../systems/Progression';
import { hasInputs, RECIPES, STATION_NAMES, type Recipe, type Station } from '../systems/CraftingSystem';
import { HOTBAR_SIZE, INVENTORY_SIZE, type Inventory } from '../systems/InventorySystem';
import { aboutView } from './About';
import { itemIcon, slotContent } from './ItemIcon';
import { MapView, type MapSource } from './MapView';

type Tab = 'inventory' | 'crafting' | 'skills' | 'quests' | 'map' | 'lantern' | 'settings' | 'about';

export interface QuestView {
  id: string;
  title: string;
  giver: string;
  text: string;
  progress: string;
  reward: { coins: number; xp: number; items: Array<[string, number]> };
  done: boolean;
}

export interface MenuActions {
  /** Stations within reach right now. */
  stations(): ReadonlySet<Station>;
  /** Crafts `times` batches, or as many as possible. */
  craft(recipe: Recipe, times?: number): void;
  use(slot: number): void;
  /** Drops a whole stack on the ground. */
  drop(slot: number): void;
  /** Carried weight and how much can be carried. */
  load(): { weight: number; capacity: number };
  progression: Progression;
  learn(id: SkillId): void;
  notify(text: string): void;
  quests(): QuestView[];
  abandon(id: string): void;
  /** Places the world forgot and the lantern kept. */
  memories(): readonly Memory[];
  map: MapSource;
  settings: Settings;
}

/** The legendary creatures listed in the Quests tab. */
const LEGENDS = [SPECIES.stag, SPECIES.alphaWolf, SPECIES.duneTyrant, SPECIES.ancientGolem, SPECIES.guardian];

const SLOT_NAMES: Record<EquipSlot, string> = { head: 'Head', chest: 'Chest', legs: 'Legs', feet: 'Feet', offhand: 'Off hand' };
/** Faded stand-ins shown in empty equipment slots. */
const PLACEHOLDERS: Record<EquipSlot, ItemDef> = {
  head: Items.leatherCap,
  chest: Items.leatherArmor,
  legs: Items.leatherPants,
  feet: Items.leatherBoots,
  offhand: Items.woodenShield,
};
const ARMOR_PART: Partial<Record<EquipSlot, number>> = { head: 0, chest: 1, legs: 2, feet: 3 };

const VOLUME_LABELS: Array<['music' | 'sfx', string]> = [
  ['music', 'Music volume'],
  ['sfx', 'Sound effects volume'],
];

const SETTING_LABELS: Array<['lighting' | 'weather' | 'particles' | 'fps30' | 'flashes' | 'help', string]> = [
  ['lighting', 'Lighting (off: a plain night tint)'],
  ['weather', 'Weather particles'],
  ['particles', 'Hit and dust particles'],
  ['fps30', 'Cap at 30 frames per second'],
  ['flashes', 'Screen flashes (lightning, getting hurt)'],
  ['help', 'Show the controls bar'],
];

export class Menu {
  isOpen = false;
  private tab: Tab = 'inventory';
  private mapView?: MapView;
  private selected: number | null = null;
  private drawnVersion = -1;
  private readonly root: HTMLElement;
  private readonly body: HTMLElement;
  private readonly tabs = new Map<string, HTMLElement>();

  constructor(
    parent: HTMLElement,
    private readonly atlas: HTMLCanvasElement,
    private readonly inv: Inventory,
    private readonly actions: MenuActions,
  ) {
    this.root = document.createElement('div');
    this.root.className = 'menu-backdrop';
    this.root.innerHTML = `
      <div class="panel menu">
        <div class="menu-tabs"></div>
        <div class="menu-body"></div>
        <button class="menu-close" title="Close">✕</button>
      </div>`;
    const tabBar = this.root.querySelector('.menu-tabs')!;
    for (const [id, label] of [
      ['inventory', 'Inventory'],
      ['crafting', 'Crafting'],
      ['skills', 'Skills'],
      ['quests', 'Quests'],
      ['map', 'Map'],
      ['lantern', 'Lantern'],
      ['settings', 'Settings'],
      ['about', 'About'],
    ] as const) {
      const b = document.createElement('button');
      b.className = 'menu-tab';
      b.textContent = label;
      b.addEventListener('click', () => this.show(id));
      tabBar.appendChild(b);
      this.tabs.set(id, b);
    }
    this.body = this.root.querySelector('.menu-body')!;
    this.root.querySelector('.menu-close')!.addEventListener('click', () => this.close());
    this.root.addEventListener('pointerdown', (e) => {
      if (e.target === this.root) this.close();
    });
    parent.appendChild(this.root);
  }

  toggle(tab?: Tab): void {
    if (this.isOpen && (!tab || tab === this.tab)) this.close();
    else this.show(tab ?? this.tab);
  }

  show(tab: Tab): void {
    this.isOpen = true;
    this.tab = tab;
    this.root.classList.add('open');
    for (const [id, el] of this.tabs) el.classList.toggle('active', id === tab);
    this.drawnVersion = -1;
    this.render();
  }

  close(): void {
    this.isOpen = false;
    this.selected = null;
    this.root.classList.remove('open');
  }

  /** Redraws when the inventory changed; `force` for station changes. */
  render(force = false): void {
    if (!this.isOpen || (!force && this.inv.version === this.drawnVersion)) return;
    this.drawnVersion = this.inv.version;
    const views = {
      inventory: () => this.inventoryView(),
      crafting: () => this.craftingView(),
      skills: () => this.skillsView(),
      quests: () => this.questsView(),
      lantern: () => this.lanternView(),
      map: () => (this.mapView ??= new MapView(this.actions.map)).show(),
      settings: () => this.settingsView(),
      about: aboutView,
    };
    this.body.replaceChildren(views[this.tab]());
  }

  /** Armour slots, a preview of the player wearing them, and the off hand. */
  private equipPanel(): HTMLElement {
    const panel = document.createElement('div');
    panel.className = 'equip';
    const column = document.createElement('div');
    column.className = 'equip-slots';
    for (const slot of ['head', 'chest', 'legs', 'feet'] as const) column.appendChild(this.equipSlot(slot));
    // The figure, with every worn piece drawn over it.
    const preview = document.createElement('canvas');
    preview.width = 16;
    preview.height = 32;
    preview.className = 'equip-preview';
    const ctx = preview.getContext('2d')!;
    ctx.imageSmoothingEnabled = false;
    const [px, py] = playerCell(Dir.Down, 0);
    ctx.drawImage(this.atlas, px, py, 16, 32, 0, 0, 16, 32);
    for (const slot of ['legs', 'feet', 'chest', 'head'] as const) {
      const look = this.inv.equipment[slot]?.item.look;
      if (look === undefined) continue;
      const [ax, ay] = armorCell(look, ARMOR_PART[slot]!, Dir.Down, 0);
      ctx.drawImage(this.atlas, ax, ay, 16, 32, 0, 0, 16, 32);
    }
    const side = document.createElement('div');
    side.className = 'equip-side';
    const armor = document.createElement('div');
    armor.className = 'armor-value';
    armor.textContent = `Armor ${Math.round(this.inv.armor() * 100)}%`;
    side.append(this.equipSlot('offhand'), armor);
    panel.append(column, preview, side);
    return panel;
  }

  /** One equipment slot. With a bag item selected that fits, clicking wears
   *  it; otherwise clicking takes off what is there. */
  private equipSlot(slot: EquipSlot): HTMLElement {
    const s = this.inv.equipment[slot];
    const el = document.createElement('button');
    el.className = 'slot equip-slot' + (s ? '' : ' ghost');
    el.title = s ? `${SLOT_NAMES[slot]}: ${s.item.name}` : SLOT_NAMES[slot];
    el.appendChild(slotContent(this.atlas, s?.item ?? PLACEHOLDERS[slot], s?.count ?? 0));
    el.addEventListener('click', () => {
      const chosen = this.selected === null ? null : this.inv.slots[this.selected];
      if (chosen?.item.equip === slot) {
        this.inv.equip(this.selected!);
        this.selected = null;
      } else if (s && !this.inv.unequip(slot)) {
        this.actions.notify('Your bag is full');
      }
      this.render(true);
    });
    return el;
  }

  private inventoryView(): HTMLElement {
    const wrap = document.createElement('div');
    wrap.className = 'inv-view';
    wrap.appendChild(this.equipPanel());
    const grid = document.createElement('div');
    grid.className = 'inv-grid';
    for (let i = 0; i < INVENTORY_SIZE; i++) {
      const s = this.inv.slots[i];
      const el = document.createElement('button');
      el.className = 'slot' + (i < HOTBAR_SIZE ? ' hot' : '') + (i === this.selected ? ' selected' : '');
      el.appendChild(slotContent(this.atlas, s?.item ?? null, s?.count ?? 0, s?.durability));
      el.addEventListener('click', () => {
        // Click one slot, then another, to move or merge.
        if (this.selected !== null && this.selected !== i) {
          this.inv.move(this.selected, i);
          this.selected = null;
        } else {
          this.selected = this.selected === i || !s ? null : i;
          this.drawnVersion = -1;
        }
        this.render();
      });
      grid.appendChild(el);
    }
    const { weight, capacity } = this.actions.load();
    const load = document.createElement('p');
    load.className = 'hint inv-load' + (weight > capacity ? ' over' : '');
    load.textContent = `Load ${Math.round(weight)} / ${capacity}` + (weight > capacity ? ' · too heavy: you move slowly and cannot run' : '');
    const sort = document.createElement('button');
    sort.className = 'btn inv-sort';
    sort.textContent = 'Sort bag';
    sort.title = 'Tidy everything below the hotbar';
    sort.addEventListener('click', () => {
      this.inv.sort();
      this.selected = null;
      this.render(true);
    });
    load.appendChild(sort);
    wrap.append(grid, this.details(), load);
    return wrap;
  }

  private details(): HTMLElement {
    const box = document.createElement('div');
    box.className = 'inv-details';
    const s = this.selected === null ? null : this.inv.slots[this.selected];
    if (!s) {
      box.innerHTML = `<p class="hint">Select an item. Click another slot to move it. The top row is your hotbar.</p>`;
      return box;
    }
    const { item } = s;
    box.appendChild(itemIcon(this.atlas, item, 48));
    const effects: string[] = [];
    if (item.food?.hunger) effects.push(`+${item.food.hunger} hunger`);
    if (item.food?.thirst) effects.push(`+${item.food.thirst} thirst`);
    if (item.food?.health) effects.push(`+${item.food.health} health`);
    if (item.tool) effects.push(`Tier ${item.tool.tier} ${item.tool.kind}, used automatically`);
    if (item.armor) effects.push(`+${Math.round(item.armor * 100)}% armor when worn`);
    if (item.shield) effects.push(`Blocks ${Math.round((1 - item.shield.pass) * 100)}% of a blow`);
    const w = item.weapon;
    if (w) {
      effects.push(`${w.damage} ${w.element ? `${ELEMENT_NAMES[w.element].toLowerCase()} ` : ''}damage`, `${w.kind === 'bow' ? 'range' : 'reach'} ${w.reach} tiles`, `${+(1 / w.cooldown).toFixed(1)} hits/s`);
      if (s.durability !== undefined) effects.push(`Durability ${s.durability}/${w.durability}`);
    }
    effects.push(`Weight ${+(weightOf(item) * s.count).toFixed(2)}`);
    const info = document.createElement('div');
    info.innerHTML = `<h3>${item.name}</h3><div class="rarity r${item.rarity}">${RARITY_NAMES[item.rarity]}</div>
      <p>${item.description}</p>${effects.length ? `<p class="effects">${effects.join(' · ')}</p>` : ''}`;
    box.appendChild(info);
    if (item.food || item === Items.schematic) {
      const use = document.createElement('button');
      use.className = 'btn';
      use.textContent = 'Use';
      use.addEventListener('click', () => {
        this.actions.use(this.selected!);
        if (!this.inv.slots[this.selected!]) this.selected = null;
        this.render(true);
      });
      box.appendChild(use);
    }
    if (item.equip) {
      const equip = document.createElement('button');
      equip.className = 'btn';
      equip.textContent = item.equip === 'offhand' ? 'Hold in off hand' : 'Equip';
      equip.addEventListener('click', () => {
        this.inv.equip(this.selected!);
        this.selected = null;
        this.render(true);
      });
      box.appendChild(equip);
    }
    const drop = document.createElement('button');
    drop.className = 'btn';
    drop.textContent = 'Drop';
    drop.title = 'Leave it on the ground. Walk back over it to pick it up.';
    drop.addEventListener('click', () => {
      this.actions.drop(this.selected!);
      if (!this.inv.slots[this.selected!]) this.selected = null;
      this.render(true);
    });
    box.appendChild(drop);
    return box;
  }

  private skillsView(): HTMLElement {
    const wrap = document.createElement('div');
    const p = this.actions.progression;
    const points = p.skillPoints;
    const mastered = SKILLS.every((d) => p.rank(d.id) >= MAX_RANK);
    const note = mastered ? 'Every skill is mastered.' : points > 0 ? `<b>${points} to spend.</b>` : 'No points to spend: level up to earn more.';
    wrap.innerHTML = `<p class="hint">Each level gives a skill point. ${note}</p>`;
    for (const def of SKILLS) {
      const rank = p.rank(def.id);
      const row = document.createElement('div');
      row.className = 'recipe skill' + (points > 0 && rank < MAX_RANK ? ' ready' : '');
      const pips = '●'.repeat(rank) + '○'.repeat(MAX_RANK - rank);
      const text = document.createElement('div');
      text.className = 'recipe-text';
      text.innerHTML = `<b></b> <span class="pips"></span><div></div>`;
      text.querySelector('b')!.textContent = def.name;
      text.querySelector('.pips')!.textContent = pips;
      text.querySelector('div')!.textContent = def.effect;
      const btn = document.createElement('button');
      btn.className = 'btn';
      btn.textContent = rank >= MAX_RANK ? 'Mastered' : 'Learn';
      btn.disabled = points <= 0 || rank >= MAX_RANK;
      btn.addEventListener('click', () => {
        this.actions.learn(def.id);
        this.render(true);
      });
      row.append(text, btn);
      wrap.appendChild(row);
    }
    return wrap;
  }

  private questsView(): HTMLElement {
    const wrap = document.createElement('div');
    const quests = this.actions.quests();
    if (!quests.length) wrap.innerHTML = '<p class="hint">No quests yet. Villagers with a ! over their heads have work for you.</p>';
    wrap.appendChild(this.legendsView());
    for (const q of quests) {
      const box = document.createElement('div');
      box.className = 'quest' + (q.done ? ' done' : '');
      const items = q.reward.items.map(([id, n]) => `${n} ${itemById(id)?.name ?? id}`);
      const reward = [`${q.reward.coins} coins`, `${q.reward.xp} XP`, ...items].join(' · ');
      box.innerHTML = `<b></b> <span class="giver"></span><p class="quest-text"></p><div class="quest-progress"></div><div class="quest-reward"></div>`;
      box.querySelector('b')!.textContent = q.done ? `✓ ${q.title}` : q.title;
      box.querySelector('.giver')!.textContent = `from ${q.giver}`;
      box.querySelector('.quest-text')!.textContent = q.text;
      box.querySelector('.quest-progress')!.textContent = q.done ? 'Complete' : q.progress;
      box.querySelector('.quest-reward')!.textContent = `Reward: ${reward}`;
      if (!q.done) {
        const give = document.createElement('button');
        give.className = 'btn quest-abandon';
        give.textContent = 'Abandon';
        give.addEventListener('click', () => {
          if (!confirm(`Abandon "${q.title}"?`)) return;
          this.actions.abandon(q.id);
          this.render(true);
        });
        box.appendChild(give);
      }
      wrap.appendChild(box);
    }
    return wrap;
  }

  /** Legendary creatures: a goal for the far lands, during the story and after. */
  private legendsView(): HTMLElement {
    const box = document.createElement('div');
    box.className = 'legends';
    const { trophies } = this.actions.progression;
    const rows = LEGENDS.map((sp) => {
      const n = trophies[sp.id] ?? 0;
      return `<li class="${n ? 'have' : ''}">${n ? '✓' : '○'} ${sp.name}${n > 1 ? ` ×${n}` : ''}</li>`;
    }).join('');
    const found = LEGENDS.filter((sp) => trophies[sp.id]).length;
    box.innerHTML = `<h4>Legends of the land (${found}/${LEGENDS.length})</h4><p class="hint">Rare and mighty, they roam further out, each in its own land. Arenas hold a guardian.</p><ul>${rows}</ul>`;
    return box;
  }

  private lanternView(): HTMLElement {
    const wrap = document.createElement('div');
    const memories = this.actions.memories();
    wrap.innerHTML = `<p class="hint">The lantern remembers places the world has forgotten. Walk where they stood and its light will show them.</p>`;
    if (!memories.length) {
      wrap.insertAdjacentHTML('beforeend', '<p class="hint">Nothing yet. The world has not forgotten anything you found… so far.</p>');
      return wrap;
    }
    for (const m of [...memories].reverse()) {
      const row = document.createElement('div');
      row.className = 'quest';
      row.innerHTML = `<b></b> <span class="giver"></span>`;
      row.querySelector('b')!.textContent = m.name;
      row.querySelector('.giver')!.textContent = `at ${Math.round(m.x + m.w / 2)}, ${Math.round(m.y + m.h / 2)} · forgotten on day ${m.day}`;
      wrap.appendChild(row);
    }
    return wrap;
  }

  private settingsView(): HTMLElement {
    const wrap = document.createElement('div');
    wrap.className = 'settings';
    const { settings } = this.actions;
    for (const [key, label] of SETTING_LABELS) {
      const row = document.createElement('label');
      row.className = 'setting';
      const box = document.createElement('input');
      box.type = 'checkbox';
      box.checked = settings.values[key];
      box.addEventListener('change', () => settings.set(key, box.checked));
      row.append(box, document.createTextNode(label));
      wrap.appendChild(row);
    }
    const slider = (label: string, min: number, max: number, step: number, value: number, set: (v: number) => void) => {
      const row = document.createElement('label');
      row.className = 'setting';
      const input = document.createElement('input');
      input.type = 'range';
      input.min = String(min);
      input.max = String(max);
      input.step = String(step);
      input.value = String(value);
      input.addEventListener('input', () => set(Number(input.value)));
      row.append(document.createTextNode(label), input);
      wrap.appendChild(row);
    };
    for (const [key, label] of VOLUME_LABELS) slider(label, 0, 1, 0.05, settings.values[key], (v) => settings.set(key, v));
    // Applied on release: resizing under the finger would move the slider away.
    const size = document.createElement('label');
    size.className = 'setting';
    const sizeInput = document.createElement('input');
    sizeInput.type = 'range';
    sizeInput.min = '0.8';
    sizeInput.max = '1.5';
    sizeInput.step = '0.1';
    sizeInput.value = String(settings.values.uiScale);
    sizeInput.addEventListener('change', () => settings.set('uiScale', Number(sizeInput.value)));
    size.append(document.createTextNode('Text and HUD size'), sizeInput);
    wrap.appendChild(size);
    wrap.insertAdjacentHTML('beforeend', '<p class="hint">Turn effects off for smoother play on older phones and laptops.</p>');
    if (!matchMedia('(pointer: coarse)').matches) wrap.appendChild(this.keysView());
    return wrap;
  }

  /** Key bindings: click an action, then press its new key. */
  private keysView(): HTMLElement {
    const { settings } = this.actions;
    const box = document.createElement('div');
    box.className = 'keys';
    box.innerHTML = '<h4>Keys</h4><p class="hint">Click a key, then press the new one (Esc cancels). Arrow keys always move.</p>';
    const keys = bindings(settings.values.keys);
    for (const action of Object.keys(ACTION_LABELS) as Action[]) {
      const row = document.createElement('div');
      row.className = 'key-row';
      const name = document.createElement('span');
      name.textContent = ACTION_LABELS[action];
      const b = document.createElement('button');
      b.className = 'btn key-btn';
      b.textContent = keyName(keys[action][0]);
      b.addEventListener('click', () => {
        b.textContent = 'Press a key…';
        const capture = (e: KeyboardEvent) => {
          // Taken before the game sees it, so Esc does not close the menu.
          e.preventDefault();
          e.stopImmediatePropagation();
          window.removeEventListener('keydown', capture, true);
          if (e.code === 'Escape') {
            b.textContent = keyName(keys[action][0]);
            return;
          }
          if (RESERVED_KEYS.has(e.code)) {
            this.actions.notify(`${keyName(e.code)} is kept for the game`);
            b.textContent = keyName(keys[action][0]);
            return;
          }
          const custom = { ...settings.values.keys };
          // A key does one thing: the action that had it gets the old key back.
          for (const other of Object.keys(DEFAULT_KEYS) as Action[]) {
            if (other !== action && bindings(custom)[other][0] === e.code) custom[other] = keys[action][0];
          }
          custom[action] = e.code;
          settings.set('keys', custom);
          this.render(true);
        };
        window.addEventListener('keydown', capture, true);
      });
      row.append(name, b);
      box.appendChild(row);
    }
    const reset = document.createElement('button');
    reset.className = 'btn';
    reset.textContent = 'Reset keys';
    reset.addEventListener('click', () => {
      settings.set('keys', {});
      this.render(true);
    });
    box.appendChild(reset);
    return box;
  }

  private craftingView(): HTMLElement {
    const stations = this.actions.stations();
    const wrap = document.createElement('div');
    wrap.className = 'craft-view';
    const near = [...stations].filter((s) => s !== 'hand').map((s) => STATION_NAMES[s]);
    const head = document.createElement('p');
    head.className = 'hint';
    head.textContent = near.length ? `Nearby: ${near.join(', ')}` : 'No station nearby. Campfires are found in camps; anvils in villages and castles.';
    wrap.appendChild(head);
    const known = this.actions.progression.recipes;
    let hidden = 0;
    for (const r of RECIPES) {
      // Rare recipes stay hidden until a Forgotten Schematic teaches them.
      if (r.rare && !known.has(r.output.id)) {
        hidden++;
        continue;
      }
      const row = document.createElement('div');
      const atStation = stations.has(r.station);
      const ready = atStation && hasInputs(this.inv, r);
      row.className = 'recipe' + (ready ? ' ready' : '');
      row.appendChild(itemIcon(this.atlas, r.output));
      const text = document.createElement('div');
      text.className = 'recipe-text';
      const inputs = r.inputs
        .map(([item, n]) => `<span class="${this.inv.count(item) >= n ? 'have' : 'need'}">${this.inv.count(item)}/${n} ${item.name}</span>`)
        .join(' ');
      text.innerHTML = `<b>${r.output.name}</b> <span class="station ${atStation ? '' : 'away'}">${STATION_NAMES[r.station]}</span><div>${inputs}</div>`;
      const btn = document.createElement('button');
      btn.className = 'btn';
      btn.textContent = 'Craft';
      btn.disabled = !ready;
      btn.addEventListener('click', () => {
        this.actions.craft(r);
        this.render(true);
      });
      row.append(text, btn);
      // As many as the bag allows, up to 20 at once.
      const most = atStation ? Math.min(20, ...r.inputs.map(([item, n]) => Math.floor(this.inv.count(item) / n))) : 0;
      if (most > 1) {
        const many = document.createElement('button');
        many.className = 'btn';
        many.textContent = `×${most}`;
        many.title = `Craft ${most}`;
        many.addEventListener('click', () => {
          this.actions.craft(r, most);
          this.render(true);
        });
        row.appendChild(many);
      }
      wrap.appendChild(row);
    }
    if (hidden) {
      const more = document.createElement('p');
      more.className = 'hint';
      more.textContent = `${hidden} rare recipe${hidden > 1 ? 's' : ''} still to discover: Forgotten Schematics teach them. They turn up in old chests and on legendary creatures.`;
      wrap.appendChild(more);
    }
    return wrap;
  }
}
