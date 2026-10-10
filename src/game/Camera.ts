// Follows the player smoothly; zoom scales the render area with it (spec 2.2).

export const MIN_ZOOM = 0.25;
export const MAX_ZOOM = 2;

export class Camera {
  x = 0;
  y = 0;
  zoom = 1;

  follow(tx: number, ty: number, dt: number): void {
    const t = 1 - Math.exp(-dt * 10);
    this.x += (tx - this.x) * t;
    this.y += (ty - this.y) * t;
  }

  snap(x: number, y: number): void {
    this.x = x;
    this.y = y;
  }

  zoomBy(steps: number): void {
    this.zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, this.zoom * Math.pow(0.8, steps)));
    // Keep 1x exact so pixel art stays crisp.
    if (Math.abs(this.zoom - 1) < 0.05) this.zoom = 1;
  }
}
