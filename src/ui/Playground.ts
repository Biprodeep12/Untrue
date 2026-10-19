// Story playground (development builds, ?playground): a panel for testing in
// a fresh world that is never saved. Travel to the spawn, set the clock, play
// on with god mode, open a rift beside the player, jump into any outer world
// (alone, or into a shared instance), skip straight to any of its sites, and
// count every world as cleared (so a rift offers the retune chooser).

import { DIMENSIONS, type SiteKind } from '../dimension/Dimension';

export interface PlaygroundActions {
  goToSpawn(): void;
  setHour(hour: number): void;
  restart(): void;
  /** Tears a rift open near the player. */
  riftNearby(): void;
  /** Straight into an outer dimension (by id; the nearest rift's own if none). */
  enterHollow(id?: string): void;
  /** Into an outer dimension through a rift's passage, meeting others there
   *  (a public instance; with ?net=local, other tabs of this browser). */
  enterHollowShared(): void;
  /** Into a dimension (if not in one) and on to its site of this kind; the
   *  Warden's and the vault with what bars them done. */
  skipTo(kind: SiteKind): void;
  /** Counts every outer world as cleared, so rifts offer to be retuned. */
  clearAll(): void;
}

export class Playground {
  /** Vitals stay full. */
  god = true;
  private readonly root: HTMLElement;

  constructor(parent: HTMLElement, actions: PlaygroundActions) {
    this.root = document.createElement('div');
    this.root.className = 'panel playground';
    this.root.innerHTML = `
      <h3 class="pg-title">Story playground</h3>
      <div class="pg-hint">Not saved · F4 or the title folds this panel</div>
      <h4>Travel</h4><div class="pg-row pg-places"></div>
      <h4>World</h4><div class="pg-row pg-world"></div>
      <h4>Rifts</h4><div class="pg-row pg-rifts"></div>`;
    // Touch screens have no F4: tap the title. The panel starts folded there,
    // and folds again after each travel button, to keep the game in view.
    const touch = matchMedia('(pointer: coarse)').matches;
    this.root.classList.toggle('hidden', touch);
    const title = this.root.querySelector('.pg-title')!;
    title.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.toggle();
    });
    const add = (row: string, label: string, fn: () => void) => {
      const b = document.createElement('button');
      b.className = 'btn';
      b.textContent = label;
      // Keep focus on the game, so Space and E do not press the button again.
      b.addEventListener('mousedown', (e) => e.preventDefault());
      b.addEventListener('click', () => {
        fn();
        if (touch && b.parentElement !== this.root.querySelector('.pg-world')) this.root.classList.add('hidden');
      });
      this.root.querySelector(row)!.appendChild(b);
      return b;
    };
    add('.pg-places', 'Spawn', () => actions.goToSpawn());
    const god = add('.pg-world', '', () => {
      this.god = !this.god;
      god.textContent = `God mode: ${this.god ? 'on' : 'off'}`;
    });
    god.textContent = 'God mode: on';
    add('.pg-world', 'Night', () => actions.setHour(22));
    add('.pg-world', 'Morning', () => actions.setHour(8));
    add('.pg-world', 'Restart', () => actions.restart());
    add('.pg-rifts', 'Rift nearby', () => actions.riftNearby());
    for (const d of DIMENSIONS) add('.pg-rifts', `Enter ${d.name.replace(/^The /, 'the ')}`, () => actions.enterHollow(d.id));
    add('.pg-rifts', 'Enter (shared)', () => actions.enterHollowShared());
    add('.pg-rifts', 'Clear all worlds', () => actions.clearAll());
    const skips: Array<[SiteKind, string]> = [['combat', 'Waves'], ['hazard', 'Path'], ['tide', 'Tide'], ['puzzle', 'Glyphs'], ['boss', 'Boss'], ['vault', 'Vault']];
    for (const [kind, label] of skips) add('.pg-rifts', `→ ${label}`, () => actions.skipTo(kind));
    parent.appendChild(this.root);
  }

  toggle(): void {
    this.root.classList.toggle('hidden');
  }
}
