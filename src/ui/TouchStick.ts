// Draws the virtual stick while a touch is steering the player. On touch
// screens a faint stick rests at the bottom left, to show where to steer.
// Styles are written only when they change, and the stick moves by
// transform, so a resting stick costs no layout work per frame.

import { STICK_RADIUS, type Stick } from '../game/Input';

/** Resting stick gap from the screen's left and bottom edges (CSS pixels). */
const REST_GAP = 40;

export class TouchStick {
  private readonly base: HTMLElement;
  private readonly knob: HTMLElement;
  private readonly touch = matchMedia('(pointer: coarse)');
  /** Resting centre; recomputed when the screen or the HUD size changes. */
  private rest: { x: number; y: number } | null = null;
  private shown = '';
  private placed = '';
  private knobAt = '';

  constructor(private readonly root: HTMLElement) {
    this.base = document.createElement('div');
    this.base.className = 'stick';
    this.knob = document.createElement('div');
    this.knob.className = 'stick-knob';
    this.base.appendChild(this.knob);
    root.appendChild(this.base);
    window.addEventListener('resize', () => this.relayout());
  }

  /** The screen or HUD layout changed: find the resting spot again. */
  relayout(): void {
    this.rest = null;
  }

  update(stick: Stick): void {
    const resting = !stick.active && this.touch.matches;
    const state = stick.active ? 'on' : resting ? 'rest' : 'off';
    if (state !== this.shown) {
      this.shown = state;
      this.base.style.display = state === 'off' ? 'none' : 'block';
      this.base.classList.toggle('rest', resting);
    }
    if (state === 'off') return;
    this.rest ??= this.restSpot();
    const x = stick.active ? stick.originX : this.rest.x;
    const y = stick.active ? stick.originY : this.rest.y;
    const at = `translate(${x - STICK_RADIUS}px, ${y - STICK_RADIUS}px)`;
    if (at !== this.placed) this.base.style.transform = this.placed = at;
    const knob = `translate(${stick.dx * STICK_RADIUS}px, ${stick.dy * STICK_RADIUS}px)`;
    if (knob !== this.knobAt) this.knob.style.transform = this.knobAt = knob;
  }

  /** Bottom left, or above the hotbar when a narrow screen puts it underneath. */
  private restSpot(): { x: number; y: number } {
    const x = REST_GAP + STICK_RADIUS;
    const y = window.innerHeight - REST_GAP - STICK_RADIUS;
    const bar = this.root.querySelector('.hotbar')?.getBoundingClientRect();
    if (!bar || bar.left > x + STICK_RADIUS + 8) return { x, y };
    return { x, y: Math.min(y, bar.top - 16 - STICK_RADIUS) };
  }
}
