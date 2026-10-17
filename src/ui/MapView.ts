// The map (spec 6.4): explored chunks under fog of war and the player's markers.

import { CHUNK_SIZE } from '../config';
import { keyX, keyY } from '../coords';
import type { ExplorationSystem } from '../systems/ExplorationSystem';

/** Colours by biome palette (type * 2 + variant). */
const BIOME_COLORS = ['#5f9e3a', '#c08a3a', '#e0bf7d', '#cf7f52', '#dfe9f2', '#b8b0e8'];
const MIN_ZOOM = 2;
const MAX_ZOOM = 40;
/** The map's size in CSS pixels. The canvas holds up to twice as many on
 *  sharp screens, so labels stay crisp; drawing is in CSS pixels. */
const MAP_W = 560;
const MAP_H = 360;

export interface MapSource {
  exploration: ExplorationSystem;
  player(): { x: number; y: number };
}

export class MapView {
  readonly root: HTMLElement;
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly list: HTMLElement;
  private readonly readout: HTMLElement;
  /** Map centre in tiles, and pixels per chunk. */
  private cx = 0;
  private cy = 0;
  private zoom = 16;
  private drawQueued = false;
  private drag: { x: number; y: number; moved: boolean } | null = null;

  constructor(private readonly src: MapSource) {
    this.root = document.createElement('div');
    this.root.className = 'map-view';
    this.root.innerHTML = `
      <div class="map-main"><canvas></canvas>
      <div class="map-readout hint"></div></div>
      <div class="map-side"><div class="map-buttons"><button class="btn map-centre">Centre on me</button><button class="btn map-zoom-in" title="Zoom in">+</button><button class="btn map-zoom-out" title="Zoom out">−</button></div><h4>Markers</h4><div class="map-markers"></div>
      <p class="hint">Tap or click the map to drop a marker. Drag to pan; zoom with + and −, the wheel or a pinch.</p></div>`;
    this.canvas = this.root.querySelector('canvas')!;
    this.ctx = this.canvas.getContext('2d')!;
    this.canvas.style.width = `${MAP_W}px`;
    this.fitCanvas();
    this.list = this.root.querySelector('.map-markers')!;
    this.readout = this.root.querySelector('.map-readout')!;
    this.root.querySelector('.map-centre')!.addEventListener('click', () => this.centre());
    this.root.querySelector('.map-zoom-in')!.addEventListener('click', () => this.zoomBy(1.25));
    this.root.querySelector('.map-zoom-out')!.addEventListener('click', () => this.zoomBy(0.8));
    // Pointers on the map: one drags (or taps a marker), two pinch.
    const touches = new Map<number, [number, number]>();
    let pinch = 0;
    const spread = () => {
      const [a, b] = [...touches.values()];
      return Math.hypot(a[0] - b[0], a[1] - b[1]);
    };
    this.canvas.addEventListener('pointerdown', (e) => {
      const [x, y] = this.local(e);
      touches.set(e.pointerId, [x, y]);
      this.canvas.setPointerCapture(e.pointerId);
      if (touches.size === 2) {
        pinch = spread();
        this.drag = null;
      } else if (touches.size === 1) this.drag = { x, y, moved: false };
    });
    this.canvas.addEventListener('pointermove', (e) => {
      const [x, y] = this.local(e);
      const [tx, ty] = this.toTiles(x, y);
      this.readout.textContent = `${Math.round(tx)}, ${Math.round(ty)}`;
      if (touches.has(e.pointerId)) touches.set(e.pointerId, [x, y]);
      if (touches.size === 2 && pinch > 0) {
        const d = spread();
        if (d > 0) this.zoomBy(d / pinch);
        pinch = d;
        return;
      }
      if (!this.drag) return;
      const dx = x - this.drag.x;
      const dy = y - this.drag.y;
      if (Math.abs(dx) + Math.abs(dy) > 3) this.drag.moved = true;
      if (!this.drag.moved) return;
      this.cx -= (dx / this.zoom) * CHUNK_SIZE;
      this.cy -= (dy / this.zoom) * CHUNK_SIZE;
      this.drag.x = x;
      this.drag.y = y;
      this.requestDraw();
    });
    const up = (e: PointerEvent) => {
      touches.delete(e.pointerId);
      if (touches.size < 2) pinch = 0;
      if (e.type === 'pointerup' && this.drag && !this.drag.moved) {
        const [tx, ty] = this.toTiles(...this.local(e));
        this.src.exploration.addMarker(Math.round(tx), Math.round(ty));
        this.refresh();
      }
      this.drag = null;
    };
    this.canvas.addEventListener('pointerup', up);
    this.canvas.addEventListener('pointercancel', up);
    this.canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      this.zoomBy(e.deltaY > 0 ? 0.8 : 1.25);
    });
  }

  private zoomBy(factor: number): void {
    this.zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, this.zoom * factor));
    this.requestDraw();
  }

  /** Pointer position in map pixels; the canvas may be shown scaled down. */
  private local(e: PointerEvent): [number, number] {
    const r = this.canvas.getBoundingClientRect();
    return [((e.clientX - r.left) * MAP_W) / (r.width || 1), ((e.clientY - r.top) * MAP_H) / (r.height || 1)];
  }

  /** Matches the canvas to the screen's pixel density (it changes with the
   *  browser zoom or another monitor). Returns the scale to draw at. */
  private fitCanvas(): number {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = Math.round(MAP_W * dpr);
    if (this.canvas.width !== w) {
      this.canvas.width = w;
      this.canvas.height = Math.round(MAP_H * dpr);
    }
    return dpr;
  }

  /** Draws once per frame at most, however many events arrive. */
  private requestDraw(): void {
    if (this.drawQueued) return;
    this.drawQueued = true;
    requestAnimationFrame(() => {
      this.drawQueued = false;
      this.draw();
    });
  }

  /** Opens centred on the player. */
  show(): HTMLElement {
    this.centre();
    return this.root;
  }

  private centre(): void {
    const p = this.src.player();
    this.cx = p.x;
    this.cy = p.y;
    this.refresh();
  }

  private refresh(): void {
    this.draw();
    this.drawList();
  }

  private toScreen(tx: number, ty: number): [number, number] {
    return [(tx - this.cx) / CHUNK_SIZE * this.zoom + MAP_W / 2, (ty - this.cy) / CHUNK_SIZE * this.zoom + MAP_H / 2];
  }

  private toTiles(sx: number, sy: number): [number, number] {
    return [this.cx + ((sx - MAP_W / 2) / this.zoom) * CHUNK_SIZE, this.cy + ((sy - MAP_H / 2) / this.zoom) * CHUNK_SIZE];
  }

  private draw(): void {
    const { ctx, zoom } = this;
    const { exploration } = this.src;
    const dpr = this.fitCanvas();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = '#1a1612';
    ctx.fillRect(0, 0, MAP_W, MAP_H);

    // Explored chunks.
    for (const [key, palette] of exploration.explored) {
      const [sx, sy] = this.toScreen(keyX(key) * CHUNK_SIZE, keyY(key) * CHUNK_SIZE);
      if (sx < -zoom || sy < -zoom || sx > MAP_W || sy > MAP_H) continue;
      ctx.fillStyle = BIOME_COLORS[palette - 1] ?? '#555';
      ctx.fillRect(Math.floor(sx), Math.floor(sy), Math.ceil(zoom), Math.ceil(zoom));
    }

    for (const m of exploration.markers) {
      const [sx, sy] = this.toScreen(m.x, m.y);
      ctx.fillStyle = m.id === exploration.tracked ? '#ff4040' : '#c8402c';
      ctx.beginPath();
      ctx.moveTo(sx, sy);
      ctx.lineTo(sx - 4, sy - 8);
      ctx.lineTo(sx + 4, sy - 8);
      ctx.fill();
      ctx.beginPath();
      ctx.arc(sx, sy - 9, 4, 0, Math.PI * 2);
      ctx.fill();
      if (zoom >= 6) this.label(m.label, sx + 6, sy - 6);
    }

    const p = this.src.player();
    const [px, py] = this.toScreen(p.x, p.y);
    ctx.fillStyle = '#ffffff';
    ctx.strokeStyle = '#000';
    ctx.beginPath();
    ctx.arc(px, py, 4, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
  }

  private label(text: string, x: number, y: number): void {
    const { ctx } = this;
    ctx.font = '11px "Pixelify Sans", monospace';
    ctx.strokeStyle = '#1a1612';
    ctx.lineWidth = 3;
    ctx.strokeText(text, x, y);
    ctx.lineWidth = 1;
    ctx.fillStyle = '#f6dfa8';
    ctx.fillText(text, x, y);
  }

  private drawList(): void {
    const { exploration } = this.src;
    this.list.replaceChildren(
      ...exploration.markers.map((m) => {
        const row = document.createElement('div');
        row.className = 'map-marker';
        const name = document.createElement('span');
        name.textContent = `${m.label} (${m.x}, ${m.y})`;
        const track = document.createElement('button');
        track.className = 'btn';
        track.textContent = exploration.tracked === m.id ? 'Untrack' : 'Track';
        track.addEventListener('click', () => {
          exploration.tracked = exploration.tracked === m.id ? null : m.id;
          this.refresh();
        });
        const del = document.createElement('button');
        del.className = 'btn';
        del.textContent = '✕';
        del.title = 'Remove marker';
        del.setAttribute('aria-label', 'Remove marker');
        del.addEventListener('click', () => {
          exploration.removeMarker(m.id);
          this.refresh();
        });
        row.append(name, track, del);
        return row;
      }),
    );
    if (!exploration.markers.length) this.list.innerHTML = '<p class="hint">None yet.</p>';
  }
}
