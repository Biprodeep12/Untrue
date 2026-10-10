// The pause menu: resume, save, settings, controls, or start a new world.

const CONTROLS: Array<[string, string]> = [
  ['WASD / arrows', 'Move'],
  ['Shift', 'Run'],
  ['Click / J', 'Attack'],
  ['Right-click / K', 'Block'],
  ['Space', 'Dodge roll'],
  ['E', 'Talk, gather, open, read'],
  ['1–8', 'Select hotbar slot'],
  ['F', 'Use the selected item'],
  ['Tab / I', 'Bag, crafting, quests, map'],
  ['M', 'Map'],
  ['Wheel / + −', 'Zoom'],
  ['Ctrl+S', 'Save'],
  ['Esc', 'Pause'],
  ['F3', 'Debug overlay'],
];

export interface PauseActions {
  save(): void;
  settings(): void;
  newWorld(): void;
}

export class PauseMenu {
  isOpen = false;
  private readonly root: HTMLElement;

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
    };
    add('Resume', () => this.close());
    add('Save', () => actions.save());
    add('Settings', () => {
      this.close();
      actions.settings();
    });
    add('New world', () => {
      if (confirm('Start a new world? Your current world will be lost.')) actions.newWorld();
    });
    const table = this.root.querySelector('.controls')!;
    for (const [key, what] of CONTROLS) {
      const row = document.createElement('tr');
      row.innerHTML = '<td></td><td></td>';
      row.children[0].textContent = key;
      row.children[1].textContent = what;
      table.appendChild(row);
    }
    parent.appendChild(this.root);
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
