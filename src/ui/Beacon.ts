// The Drift Beacon's panel: whether rift trips meet others (public) or go
// alone (private), who is with the player behind a rift, the open instances
// of the dimension ahead, the name others see, and this player's world:
// opening it to friends by its code (and sending guests home), or visiting a
// friend's world by theirs.

export interface BeaconStatus {
  /** The dimension behind the rift the player is in or near; null if none. */
  dimension: string | null;
  /** In a shared instance: everyone there, and its code. */
  names: string[];
  code: string;
  host: boolean;
}

/** This player's world and friends' visits. */
export interface WorldStatus {
  /** `alone`: not shared; `hosting`: friends may visit by its code; `visiting`: in a friend's world. */
  mode: 'alone' | 'hosting' | 'visiting';
  code: string;
  /** Hosting: who is visiting. */
  guests: Array<{ slot: number; name: string }>;
  /** Visiting: whose world it is. */
  host: string;
  /** Opening the world, or setting off to a friend's. */
  busy: boolean;
  /** Why the last try failed, if it did. */
  error: string;
}

export interface InstanceRow {
  id: string;
  label: string;
}

export interface BeaconActions {
  isPublic(): boolean;
  setPublic(v: boolean): void;
  status(): BeaconStatus;
  /** Open instances of the dimension ahead. Loads the network, the first time. */
  instances(): Promise<InstanceRow[]>;
  /** Go into this instance next time, if it still has room. */
  prefer(id: string | null): void;
  name(): Promise<string>;
  setName(v: string): Promise<string>;
  world(): WorldStatus;
  openWorld(): void;
  closeWorld(): void;
  /** Sends a guest home. */
  kick(slot: number): void;
  /** Visits a friend's world by its code. */
  visit(code: string): void;
  /** Leaves a friend's world for home. */
  goHome(): void;
}

export class Beacon {
  isOpen = false;
  private readonly root: HTMLElement;
  private readonly mode: HTMLButtonElement;
  private readonly here: HTMLElement;
  private readonly list: HTMLElement;
  private readonly nameInput: HTMLInputElement;
  private readonly worldPart: HTMLElement;
  private preferred: string | null = null;
  private asking = 0;

  constructor(parent: HTMLElement, private readonly actions: BeaconActions) {
    this.root = document.createElement('div');
    this.root.className = 'menu-backdrop beacon';
    this.root.innerHTML = `
      <div class="panel menu beacon-panel">
        <h2>Drift Beacon</h2>
        <h3>Behind the rifts</h3>
        <div class="beacon-row"><button class="btn beacon-mode"></button></div>
        <p class="beacon-here"></p>
        <div class="beacon-list"></div>
        <div class="beacon-row"><button class="btn beacon-refresh">Listen again</button></div>
        <h3>Your name</h3>
        <div class="beacon-row"><input class="beacon-name" maxlength="24" spellcheck="false" aria-label="Your name"><button class="btn beacon-save">Keep</button></div>
        <h3>Your world</h3>
        <div class="beacon-world"></div>
        <div class="beacon-row"><button class="btn beacon-close">Close</button></div>
      </div>`;
    const q = <T extends HTMLElement>(s: string) => this.root.querySelector<T>(s)!;
    this.mode = q<HTMLButtonElement>('.beacon-mode');
    this.here = q('.beacon-here');
    this.list = q('.beacon-list');
    this.nameInput = q<HTMLInputElement>('.beacon-name');
    this.worldPart = q('.beacon-world');
    this.mode.addEventListener('click', () => {
      actions.setPublic(!actions.isPublic());
      this.render();
    });
    q('.beacon-refresh').addEventListener('click', () => void this.listen());
    q('.beacon-save').addEventListener('click', () => void actions.setName(this.nameInput.value).then((n) => (this.nameInput.value = n)));
    q('.beacon-close').addEventListener('click', () => this.close());
    // Typing a name must not move the player or open other menus.
    this.nameInput.addEventListener('keydown', (e) => e.stopPropagation());
    this.root.addEventListener('pointerdown', (e) => {
      if (e.target === this.root) this.close();
    });
    parent.appendChild(this.root);
  }

  toggle(): void {
    if (this.isOpen) this.close();
    else this.open();
  }

  open(): void {
    this.isOpen = true;
    this.root.classList.add('open');
    this.render();
    void this.actions.name().then((n) => (this.nameInput.value = n));
    void this.listen();
  }

  close(): void {
    this.isOpen = false;
    this.root.classList.remove('open');
    this.nameInput.blur();
  }

  /** Draws the panel again if it is open (someone came or went). */
  refresh(): void {
    if (this.isOpen) this.render();
  }

  private render(): void {
    this.renderWorld();
    const pub = this.actions.isPublic();
    this.mode.textContent = pub ? 'Rift trips: public (meet others)' : 'Rift trips: private (go alone)';
    const s = this.actions.status();
    if (s.names.length) this.here.textContent = `With you behind the rift${s.host ? ' (you hold it open)' : ''}: ${s.names.join(', ')}. Code ${s.code}.`;
    else if (!s.dimension) this.here.textContent = 'No rift is near. Near one, the beacon hears who waits behind it.';
    else if (!pub) this.here.textContent = 'Private: you will go through alone.';
    else this.here.textContent = 'Others behind the rift ahead:';
  }

  /** Lists the open instances of the dimension ahead; choosing one goes there next. */
  private async listen(): Promise<void> {
    const s = this.actions.status();
    this.list.replaceChildren();
    if (!s.dimension || s.names.length || !this.actions.isPublic()) return;
    const ask = ++this.asking;
    this.list.textContent = 'Listening…';
    let rows: InstanceRow[];
    try {
      rows = await this.actions.instances();
    } catch {
      rows = [];
    }
    if (ask !== this.asking || !this.isOpen) return;
    this.list.replaceChildren();
    if (!rows.length) {
      this.list.textContent = 'No one answers. Step through, and others may find you.';
      return;
    }
    for (const r of rows) {
      const b = document.createElement('button');
      b.className = 'btn beacon-instance';
      b.textContent = r.label;
      b.classList.toggle('chosen', r.id === this.preferred);
      b.addEventListener('click', () => {
        this.preferred = this.preferred === r.id ? null : r.id;
        this.actions.prefer(this.preferred);
        for (const el of this.list.querySelectorAll('.beacon-instance')) el.classList.remove('chosen');
        if (this.preferred) b.classList.add('chosen');
      });
      this.list.appendChild(b);
    }
  }

  /** This player's world: open it, see who visits and send them home; or
   *  enter a friend's code; or, visiting, go home. */
  private renderWorld(): void {
    const w = this.actions.world();
    const part = this.worldPart;
    const row = (...children: HTMLElement[]) => {
      const r = document.createElement('div');
      r.className = 'beacon-row';
      r.append(...children);
      return r;
    };
    const button = (label: string, action: () => void, disabled = false) => {
      const b = document.createElement('button');
      b.className = 'btn';
      b.textContent = label;
      b.disabled = disabled;
      b.addEventListener('click', action);
      return b;
    };
    const text = (t: string, cls = 'beacon-here') => {
      const p = document.createElement('p');
      p.className = cls;
      p.textContent = t;
      return p;
    };
    const out: HTMLElement[] = [];
    if (w.mode === 'visiting') {
      out.push(text(`You are visiting ${w.host}'s world (code ${w.code}). What you carry and learn here comes home with you.`));
      out.push(row(button('Go home', () => this.actions.goHome(), w.busy)));
    } else if (w.mode === 'hosting') {
      out.push(text(`Your world is open to friends. Its code: ${w.code}`));
      if (!w.guests.length) out.push(text('No one has come yet. Give a friend the code: they enter it on their beacon.', 'beacon-soon'));
      for (const g of w.guests) {
        const name = document.createElement('span');
        name.textContent = g.name;
        name.className = 'beacon-guest';
        out.push(row(name, button('Send home', () => this.actions.kick(g.slot))));
      }
      out.push(row(button('Close my world', () => this.actions.closeWorld())));
    } else {
      out.push(text('Open your world and friends can visit it with its code, or enter a friend’s code to visit theirs.', 'beacon-soon'));
      const input = document.createElement('input');
      input.placeholder = 'XXXX-XXXX';
      input.maxLength = 12;
      input.spellcheck = false;
      input.autocomplete = 'off';
      input.setAttribute('aria-label', 'A friend’s code');
      // Typing a code must not move the player or open other menus.
      input.addEventListener('keydown', (e) => {
        e.stopPropagation();
        if (e.key === 'Enter' && input.value.trim()) this.actions.visit(input.value);
      });
      out.push(row(button(w.busy ? 'Opening…' : 'Open my world', () => this.actions.openWorld(), w.busy)));
      out.push(row(input, button('Visit', () => input.value.trim() && this.actions.visit(input.value), w.busy)));
    }
    if (w.error) out.push(text(w.error, 'beacon-soon beacon-error'));
    part.replaceChildren(...out);
  }
}
