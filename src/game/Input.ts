// Keyboard, mouse, wheel and touch input. A touch on the left part of the
// screen drives a virtual stick from wherever it starts; a quick tap anywhere
// acts like E. The mouse aims: left button attacks, right button blocks.

/** Stick radius in CSS pixels. */
export const STICK_RADIUS = 48;
/** Stick deflection beyond which the player runs. */
const RUN_DEFLECTION = 0.8;
/** Share of the screen width, from the left, where a touch starts the stick. */
export const STICK_ZONE = 0.5;
/** A touch shorter and stiller than this is a tap (ms, CSS pixels). */
const TAP_TIME = 300;
const TAP_SLOP = 12;
/** A second finger this soon after the first makes a pinch, not stick + tap (ms). */
const PINCH_WINDOW = 250;
/** Pinch spread change per zoom step. */
const PINCH_STEP = 1.2;

import { bindings, type Action, type Bindings } from './Keys';

export interface Stick {
  active: boolean;
  /** Where the touch started, in CSS pixels. */
  originX: number;
  originY: number;
  /** Deflection, clamped to the unit circle. */
  dx: number;
  dy: number;
}

/** Whether keys go to a text field: anything but the checkboxes and sliders of Settings. */
function typing(target: EventTarget | null): boolean {
  if (target instanceof HTMLInputElement) return !['checkbox', 'radio', 'range', 'button'].includes(target.type);
  return target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement || (target instanceof HTMLElement && target.isContentEditable);
}

export class Input {
  private readonly down = new Set<string>();
  private readonly pressed = new Set<string>();
  /** Actions done by touch this frame (a tap interacts). */
  private readonly touched = new Set<Action>();
  /** The keys of each action; Settings can change the main ones. */
  keys: Bindings = bindings();
  wheel = 0;

  readonly stick: Stick = { active: false, originX: 0, originY: 0, dx: 0, dy: 0 };
  private stickId: number | null = null;
  /** Touches that may still turn out to be taps. */
  private readonly taps = new Map<number, { x: number; y: number; t: number }>();
  /** Fingers on the game, for pinching. */
  private readonly touches = new Map<number, { x: number; y: number; t: number }>();
  /** Finger spread at the last pinch zoom step; 0 when not pinching. */
  private pinch = 0;
  /** Mouse position in CSS pixels, once the mouse has moved over the game. */
  mouse: { x: number; y: number } | null = null;
  /** Left button pressed this frame. */
  mouseAttack = false;
  /** Right button held. */
  mouseBlock = false;

  constructor(target: Window, surface: HTMLElement) {
    target.addEventListener('keydown', (e) => {
      // Typing in a text field is not playing.
      if (typing(e.target)) return;
      // Enter on a focused button presses that button, not a game key too.
      if (e.code === 'Enter' && e.target instanceof HTMLButtonElement) return;
      // Keys the browser would act on (scroll, focus, find) belong to the game.
      if (e.code === 'F3' || e.code === 'Tab' || e.code.startsWith('Arrow') || e.code === 'Space' || this.bound(e.code)) {
        if (!(e.target instanceof HTMLInputElement)) e.preventDefault();
      }
      if (e.code === 'KeyS' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        this.pressed.add('Save');
        return;
      }
      if (!this.down.has(e.code)) this.pressed.add(e.code);
      this.down.add(e.code);
    });
    target.addEventListener('keyup', (e) => {
      this.down.delete(e.code);
      // On macOS, keys let go while Cmd is held send no keyup: forget them all.
      if (e.key === 'Meta') this.down.clear();
    });
    // Losing focus (alt-tab, a system dialog) swallows the releases too.
    target.addEventListener('blur', () => {
      this.down.clear();
      this.mouseBlock = false;
      this.touches.clear();
      this.taps.clear();
      this.pinch = 0;
      this.stickId = null;
      Object.assign(this.stick, { active: false, dx: 0, dy: 0 });
    });
    // The right button may be let go over the HUD or off the canvas.
    target.addEventListener('pointerup', (e) => {
      if (e.pointerType === 'mouse' && e.button === 2) this.mouseBlock = false;
    });
    target.addEventListener('wheel', (e) => (this.wheel += Math.sign(e.deltaY)), { passive: true });

    surface.style.touchAction = 'none';
    surface.addEventListener('contextmenu', (e) => e.preventDefault());
    surface.addEventListener('pointerdown', (e) => this.pointerDown(e));
    surface.addEventListener('pointermove', (e) => this.pointerMove(e));
    surface.addEventListener('pointerup', (e) => this.pointerUp(e));
    surface.addEventListener('pointercancel', (e) => this.pointerUp(e));
  }

  held(...codes: string[]): boolean {
    return codes.some((c) => this.down.has(c));
  }

  /** True once per key press. */
  hit(code: string): boolean {
    return this.pressed.has(code);
  }

  /** An action's key was pressed this frame (or, for interact, a tap). */
  act(a: Action): boolean {
    return this.touched.has(a) || this.keys[a].some((c) => this.pressed.has(c));
  }

  /** An action's key is held. */
  holding(a: Action): boolean {
    return this.keys[a].some((c) => this.down.has(c));
  }

  private bound(code: string): boolean {
    for (const codes of Object.values(this.keys)) if (codes.includes(code)) return true;
    return false;
  }

  /** Movement direction from the keys or the touch stick, normalised. */
  axis(): { x: number; y: number } {
    if (this.stick.active && Math.hypot(this.stick.dx, this.stick.dy) > 0.2) {
      const len = Math.hypot(this.stick.dx, this.stick.dy);
      return { x: this.stick.dx / len, y: this.stick.dy / len };
    }
    const x = (this.holding('right') ? 1 : 0) - (this.holding('left') ? 1 : 0);
    const y = (this.holding('down') ? 1 : 0) - (this.holding('up') ? 1 : 0);
    const len = Math.hypot(x, y) || 1;
    return { x: x / len, y: y / len };
  }

  running(): boolean {
    if (this.stick.active) return Math.hypot(this.stick.dx, this.stick.dy) > RUN_DEFLECTION;
    return this.holding('run');
  }

  endFrame(): void {
    this.pressed.clear();
    this.touched.clear();
    this.wheel = 0;
    this.mouseAttack = false;
  }

  private pointerDown(e: PointerEvent): void {
    if (e.pointerType === 'mouse') {
      this.mouse = { x: e.clientX, y: e.clientY };
      if (e.button === 0) this.mouseAttack = true;
      if (e.button === 2) this.mouseBlock = true;
      return;
    }
    if (e.pointerType !== 'touch') return;
    const now = performance.now();
    this.touches.set(e.pointerId, { x: e.clientX, y: e.clientY, t: now });
    if (this.touches.size === 2 && this.startsPinch(e.pointerId, now)) {
      // Two fingers together zoom: no stick, no taps.
      this.taps.clear();
      this.stickId = null;
      Object.assign(this.stick, { active: false, dx: 0, dy: 0 });
      this.pinch = this.spread();
      return;
    }
    if (this.pinch) return;
    this.taps.set(e.pointerId, { x: e.clientX, y: e.clientY, t: now });
    if (this.stickId !== null || e.clientX > window.innerWidth * STICK_ZONE) return;
    this.stickId = e.pointerId;
    Object.assign(this.stick, { active: true, originX: e.clientX, originY: e.clientY, dx: 0, dy: 0 });
  }

  /** A second finger starts a pinch unless the first is already steering. */
  private startsPinch(second: number, now: number): boolean {
    for (const [id, f] of this.touches) {
      if (id === second) continue;
      if (id !== this.stickId) return true;
      return now - f.t < PINCH_WINDOW && Math.hypot(this.stick.dx, this.stick.dy) < 0.2;
    }
    return false;
  }

  private spread(): number {
    const [a, b] = [...this.touches.values()];
    return Math.hypot(a.x - b.x, a.y - b.y) || 1;
  }

  private pointerMove(e: PointerEvent): void {
    if (e.pointerType === 'mouse') this.mouse = { x: e.clientX, y: e.clientY };
    const finger = this.touches.get(e.pointerId);
    if (finger) {
      finger.x = e.clientX;
      finger.y = e.clientY;
    }
    if (this.pinch && this.touches.size === 2) {
      const d = this.spread();
      // Fingers apart zoom in, like the wheel rolled forward.
      if (d > this.pinch * PINCH_STEP) {
        this.wheel -= 1;
        this.pinch = d;
      } else if (d < this.pinch / PINCH_STEP) {
        this.wheel += 1;
        this.pinch = d;
      }
      return;
    }
    const tap = this.taps.get(e.pointerId);
    if (tap && Math.hypot(e.clientX - tap.x, e.clientY - tap.y) > TAP_SLOP) this.taps.delete(e.pointerId);
    if (e.pointerId !== this.stickId) return;
    let dx = (e.clientX - this.stick.originX) / STICK_RADIUS;
    let dy = (e.clientY - this.stick.originY) / STICK_RADIUS;
    const len = Math.hypot(dx, dy);
    if (len > 1) {
      dx /= len;
      dy /= len;
    }
    this.stick.dx = dx;
    this.stick.dy = dy;
  }

  private pointerUp(e: PointerEvent): void {
    if (e.pointerType === 'mouse' && e.button === 2) this.mouseBlock = false;
    this.touches.delete(e.pointerId);
    if (this.pinch) {
      if (!this.touches.size) this.pinch = 0;
      return;
    }
    const tap = this.taps.get(e.pointerId);
    this.taps.delete(e.pointerId);
    if (tap && e.type === 'pointerup' && performance.now() - tap.t < TAP_TIME) this.touched.add('interact');
    if (e.pointerId !== this.stickId) return;
    this.stickId = null;
    Object.assign(this.stick, { active: false, dx: 0, dy: 0 });
  }
}
