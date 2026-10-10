// Keyboard, mouse, wheel and touch input. A touch drives a virtual stick from
// wherever it starts. The mouse aims: left button attacks, right button blocks.

/** Stick radius in CSS pixels. */
export const STICK_RADIUS = 48;
/** Stick deflection beyond which the player runs. */
const RUN_DEFLECTION = 0.8;

export interface Stick {
  active: boolean;
  /** Where the touch started, in CSS pixels. */
  originX: number;
  originY: number;
  /** Deflection, clamped to the unit circle. */
  dx: number;
  dy: number;
}

export class Input {
  private readonly down = new Set<string>();
  private readonly pressed = new Set<string>();
  wheel = 0;

  readonly stick: Stick = { active: false, originX: 0, originY: 0, dx: 0, dy: 0 };
  private stickId: number | null = null;
  /** Mouse position in CSS pixels, once the mouse has moved over the game. */
  mouse: { x: number; y: number } | null = null;
  /** Left button pressed this frame. */
  mouseAttack = false;
  /** Right button held. */
  mouseBlock = false;

  constructor(target: Window, surface: HTMLElement) {
    target.addEventListener('keydown', (e) => {
      if (e.code === 'F3' || e.code === 'Tab' || e.code.startsWith('Arrow') || e.code === 'Space') e.preventDefault();
      if (e.code === 'KeyS' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        this.pressed.add('Save');
        return;
      }
      if (!this.down.has(e.code)) this.pressed.add(e.code);
      this.down.add(e.code);
    });
    target.addEventListener('keyup', (e) => this.down.delete(e.code));
    target.addEventListener('blur', () => {
      this.down.clear();
      this.mouseBlock = false;
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

  /** Movement direction from the keys or the touch stick, normalised. */
  axis(): { x: number; y: number } {
    if (this.stick.active && Math.hypot(this.stick.dx, this.stick.dy) > 0.2) {
      const len = Math.hypot(this.stick.dx, this.stick.dy);
      return { x: this.stick.dx / len, y: this.stick.dy / len };
    }
    const x = (this.held('KeyD', 'ArrowRight') ? 1 : 0) - (this.held('KeyA', 'ArrowLeft') ? 1 : 0);
    const y = (this.held('KeyS', 'ArrowDown') ? 1 : 0) - (this.held('KeyW', 'ArrowUp') ? 1 : 0);
    const len = Math.hypot(x, y) || 1;
    return { x: x / len, y: y / len };
  }

  running(): boolean {
    if (this.stick.active) return Math.hypot(this.stick.dx, this.stick.dy) > RUN_DEFLECTION;
    return this.held('ShiftLeft', 'ShiftRight');
  }

  endFrame(): void {
    this.pressed.clear();
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
    if (e.pointerType !== 'touch' || this.stickId !== null) return;
    this.stickId = e.pointerId;
    Object.assign(this.stick, { active: true, originX: e.clientX, originY: e.clientY, dx: 0, dy: 0 });
  }

  private pointerMove(e: PointerEvent): void {
    if (e.pointerType === 'mouse') this.mouse = { x: e.clientX, y: e.clientY };
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
    if (e.pointerId !== this.stickId) return;
    this.stickId = null;
    Object.assign(this.stick, { active: false, dx: 0, dy: 0 });
  }
}
