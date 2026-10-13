// Story playground (development builds, ?playground): a panel for testing the
// story end to end. Start any chapter, travel to any story place, trigger an
// ending or an epilogue find, and play on with god mode.

import type { PlaceId } from '../story/StoryPlaces';
import { ENDINGS, type Ending } from '../story/StoryScript';
import type { Stage, StorySystem } from '../story/StorySystem';

export type PlaygroundFind = 'echo' | 'fragment' | 'cabin';

export interface PlaygroundActions {
  goTo(place: PlaceId | 'spawn'): void;
  jump(stage: Stage): void;
  ending(e: Ending): void;
  find(kind: PlaygroundFind): void;
  setHour(hour: number): void;
  restart(): void;
}

const CHAPTERS: Array<[Stage, string]> = [
  ['waking', '1 · Waking'],
  ['bell', '2 · The bell'],
  ['village', '3 · Village'],
  ['night', '4 · The night'],
  ['observatory', '5 · Observatory'],
  ['archive', '6 · Archive'],
  ['return', '7 · Return'],
  ['anchor', '8 · Anchor'],
];

const PLACES: Array<[PlaceId | 'spawn', string]> = [
  ['spawn', 'Spawn'],
  ['monument', 'Monument'],
  ['graves', 'Village'],
  ['observatory', 'Observatory'],
  ['archive', 'Archive'],
  ['anchor', 'Anchor'],
];

const FINDS: Array<[PlaygroundFind, string]> = [
  ['echo', 'Echo monument'],
  ['fragment', 'Memory fragment'],
  ['cabin', 'Quiet cabin'],
];

export class Playground {
  /** Vitals stay full. */
  god = true;
  private readonly root: HTMLElement;
  private readonly status: HTMLElement;
  private readonly finds: HTMLButtonElement[] = [];

  constructor(parent: HTMLElement, actions: PlaygroundActions) {
    this.root = document.createElement('div');
    this.root.className = 'panel playground';
    this.root.innerHTML = `
      <h3 class="pg-title">Story playground</h3>
      <div class="pg-hint">Not saved · F4 or the title folds this panel</div>
      <pre class="pg-status"></pre>
      <h4>Start chapter</h4><div class="pg-row pg-chapters"></div>
      <h4>Endings</h4><div class="pg-row pg-endings"></div>
      <h4>Epilogue finds (after an ending)</h4><div class="pg-row pg-finds"></div>
      <h4>Travel</h4><div class="pg-row pg-places"></div>
      <h4>World</h4><div class="pg-row pg-world"></div>`;
    this.status = this.root.querySelector('.pg-status')!;
    // Touch screens have no F4: tap the title. The panel starts folded there,
    // and folds again after each button, to keep the game in view.
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
    for (const [stage, label] of CHAPTERS) add('.pg-chapters', label, () => actions.jump(stage));
    for (const e of Object.keys(ENDINGS) as Ending[]) add('.pg-endings', ENDINGS[e].name, () => actions.ending(e));
    for (const [kind, label] of FINDS) this.finds.push(add('.pg-finds', label, () => actions.find(kind)));
    for (const [place, label] of PLACES) add('.pg-places', label, () => actions.goTo(place));
    const god = add('.pg-world', '', () => {
      this.god = !this.god;
      god.textContent = `God mode: ${this.god ? 'on' : 'off'}`;
    });
    god.textContent = 'God mode: on';
    add('.pg-world', 'Night', () => actions.setHour(22));
    add('.pg-world', 'Morning', () => actions.setHour(8));
    add('.pg-world', 'Restart', () => actions.restart());
    parent.appendChild(this.root);
  }

  toggle(): void {
    this.root.classList.toggle('hidden');
  }

  update(story: StorySystem): void {
    const goal = story.objective();
    this.status.textContent = [
      `Stage:     ${story.stage}`,
      `Objective: ${goal?.text ?? '–'}`,
      `Ending:    ${story.ending ? ENDINGS[story.ending].name : '–'}`,
      `Flags:     ${story.flagList.join(', ') || '–'}`,
    ].join('\n');
    for (const b of this.finds) b.disabled = !story.ending;
  }
}
