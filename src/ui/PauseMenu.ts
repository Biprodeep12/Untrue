// The pause menu: resume, save, settings, full screen, controls, or start a
// new world.

import { keyName, type Action, type Bindings } from '../game/Keys';
import { fullscreenSupported, isFullscreen, onFullscreenChange, toggleFullscreen } from './Fullscreen';

/** Keyboard controls, naming the player's own keys. */
function controls(keys: Bindings): Array<[string, string]> {
  const k = (a: Action) => keyName(keys[a][0]);
  return [
    [`${k('up')}${k('left')}${k('down')}${k('right')} / arrows`, 'Move'],
    [k('run'), 'Run'],
    [`Click / ${k('attack')}`, 'Attack'],
    [`Right-click / ${k('block')}`, 'Block'],
    [k('dodge'), 'Dodge roll'],
    [k('interact'), 'Talk, gather, open, read'],
    ['1–8', 'Select hotbar slot'],
    [k('use'), 'Use the selected item'],
    [k('drop'), 'Drop the selected item'],
    [`${k('bag')} / I`, 'Bag, crafting, quests'],
    [k('map'), 'Map'],
    [`Wheel / ${k('zoomIn')} ${k('zoomOut')}`, 'Zoom'],
    ['Ctrl+S', 'Save'],
    ['Esc', 'Pause'],
    ['F3', 'Debug overlay'],
  ];
}

const TOUCH_CONTROLS: Array<[string, string]> = [
  ['Drag on the left half', 'Move (push far to run)'],
  ['Tap the game or the prompt', 'Talk, gather, open, read'],
  ['Hit', 'Attack the nearest enemy'],
  ['Hold Block', 'Block'],
  ['Roll', 'Dodge roll'],
  ['Tap a hotbar slot', 'Select it; tap again to use it'],
  ['Bag', 'Bag, crafting, quests'],
  ['Pinch', 'Zoom'],
  ['Full', 'Full screen'],
  ['Pause', 'This menu'],
];

export interface PauseActions {
  save(): void;
  settings(): void;
  newWorld(): void;
}

export class PauseMenu {
  isOpen = false;
  private readonly root: HTMLElement;
  /** The controls last listed, so a settings change that keeps them is free. */
  private listed = '';

  constructor(parent: HTMLElement, actions: PauseActions) {
    this.root = document.createElement('div');
    this.root.className = 'menu-backdrop pause';
    this.root.innerHTML = `
      <div class="panel menu pause-panel">
        <h2>Paused</h2>
        <div class="pause-buttons"></div>
        <table class="controls"></table>
      </div>`;
    const buttons = this.root.querySelector('.pause-buttons')!;
    const add = (label: string, fn: () => void) => {
      const b = document.createElement('button');
      b.className = 'btn';
      b.textContent = label;
      b.addEventListener('click', fn);
      buttons.appendChild(b);
      return b;
    };
    add('Resume', () => this.close());
    add('Save', () => actions.save());
    add('Settings', () => {
      this.close();
      actions.settings();
    });
    if (fullscreenSupported()) {
      const full = add('Full screen', () => toggleFullscreen());
      onFullscreenChange(() => (full.textContent = isFullscreen() ? 'Exit full screen' : 'Full screen'));
    }
    add('New world', () => {
      if (confirm('Start a new world? Your current world will be lost.')) actions.newWorld();
    });
    parent.appendChild(this.root);
  }

  /** Lists the controls: touch ones on touch screens, else the player's keys. */
  setKeys(keys: Bindings): void {
    const table = this.root.querySelector('.controls')!;
    const touch = matchMedia('(pointer: coarse)').matches;
    const rows = touch ? TOUCH_CONTROLS : controls(keys);
    const listed = rows.join('|');
    if (listed === this.listed) return;
    this.listed = listed;
    table.replaceChildren();
    for (const [key, what] of rows) {
      const row = document.createElement('tr');
      row.innerHTML = '<td></td><td></td>';
      row.children[0].textContent = key;
      row.children[1].textContent = what;
      table.appendChild(row);
    }
  }

  toggle(): void {
    if (this.isOpen) this.close();
    else this.open();
  }

  open(): void {
    this.isOpen = true;
    this.root.classList.add('open');
  }

  close(): void {
    this.isOpen = false;
    this.root.classList.remove('open');
  }
}
