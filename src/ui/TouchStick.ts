// Draws the virtual stick while a touch is steering the player.

import { STICK_RADIUS, type Stick } from '../game/Input';

export class TouchStick {
  private readonly base: HTMLElement;
  private readonly knob: HTMLElement;

  constructor(root: HTMLElement) {
    this.base = document.createElement('div');
    this.base.className = 'stick';
    this.knob = document.createElement('div');
    this.knob.className = 'stick-knob';
    this.base.appendChild(this.knob);
    root.appendChild(this.base);
  }

  update(stick: Stick): void {
    this.base.style.display = stick.active ? 'block' : 'none';
    if (!stick.active) return;
    this.base.style.left = `${stick.originX - STICK_RADIUS}px`;
    this.base.style.top = `${stick.originY - STICK_RADIUS}px`;
    this.knob.style.transform = `translate(${stick.dx * STICK_RADIUS}px, ${stick.dy * STICK_RADIUS}px)`;
  }
}
