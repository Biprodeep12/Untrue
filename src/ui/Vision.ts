// Full-screen story visions: a title and pages of text, read one at a time.

import type { Vision as VisionText } from '../story/StoryScript';

export class Vision {
  isOpen = false;
  private readonly root: HTMLElement;
  private pages: readonly string[] = [];
  private page = 0;
  private then?: () => void;
  /** Visions that arrive while one is showing wait their turn. */
  private readonly queue: Array<[VisionText, (() => void) | undefined]> = [];

  constructor(parent: HTMLElement) {
    this.root = document.createElement('div');
    this.root.className = 'vision';
    this.root.innerHTML = `<div class="vision-box"><h2></h2><p></p><button class="btn">Continue ▸</button></div>`;
    this.root.querySelector('button')!.addEventListener('click', () => this.next());
    parent.appendChild(this.root);
  }

  show(v: VisionText, then?: () => void): void {
    if (this.isOpen) {
      this.queue.push([v, then]);
      return;
    }
    this.isOpen = true;
    this.pages = v.pages;
    this.page = 0;
    this.then = then;
    this.root.querySelector('h2')!.textContent = v.title;
    this.root.classList.add('open');
    this.render();
  }

  /** Advances a page; closes after the last. */
  next(): void {
    if (!this.isOpen) return;
    if (++this.page < this.pages.length) {
      this.render();
      return;
    }
    this.isOpen = false;
    this.root.classList.remove('open');
    const then = this.then;
    this.then = undefined;
    then?.();
    const queued = this.queue.shift();
    if (queued) this.show(...queued);
  }

  private render(): void {
    const p = this.root.querySelector('p')!;
    p.textContent = this.pages[this.page];
    p.classList.remove('fade-in');
    void p.offsetWidth;
    p.classList.add('fade-in');
  }
}
