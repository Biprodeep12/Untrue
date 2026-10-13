// Draws the virtual stick while a touch is steering the player. On touch
// screens a faint stick rests at the bottom left, to show where to steer.

import { STICK_RADIUS, type Stick } from '../game/Input';

/** Resting stick gap from the screen's left and bottom edges (CSS pixels). */
const REST_GAP = 40;

export class TouchStick {
  private readonly base: HTMLElement;
  private readonly knob: HTMLElement;
  private readonly touch = matchMedia('(pointer: coarse)');

  constructor(private readonly root: HTMLElement) {
    this.base = document.createElement('div');
    this.base.className = 'stick';
    this.knob = document.createElement('div');
    this.knob.className = 'stick-knob';
    this.base.appendChild(this.knob);
    root.appendChild(this.base);
  }

  update(stick: Stick): void {
    const rest = !stick.active && this.touch.matches;
    this.base.style.display = stick.active || rest ? 'block' : 'none';
    this.base.classList.toggle('rest', rest);
    if (!stick.active && !rest) return;
    const x = stick.active ? stick.originX : REST_GAP + STICK_RADIUS;
    const y = stick.active ? stick.originY : this.restY();
    this.base.style.left = `${x - STICK_RADIUS}px`;
    this.base.style.top = `${y - STICK_RADIUS}px`;
    this.knob.style.transform = `translate(${stick.dx * STICK_RADIUS}px, ${stick.dy * STICK_RADIUS}px)`;
  }

  /** Bottom left, or above the hotbar when a narrow screen puts it underneath. */
  private restY(): number {
    const y = window.innerHeight - REST_GAP - STICK_RADIUS;
    const bar = this.root.querySelector('.hotbar')?.getBoundingClientRect();
    if (!bar || bar.left > REST_GAP + STICK_RADIUS * 2 + 8) return y;
    return Math.min(y, bar.top - 16 - STICK_RADIUS);
  }
}
