// The world map (spec 6.4): explored chunks under fog of war, landmarks,
// forgotten places, the story's next destination and the player's markers.

import { CHUNK_SIZE } from '../config';
import { keyX, keyY } from '../coords';
import type { Memory } from '../story/StorySystem';
import type { ExplorationSystem } from '../systems/ExplorationSystem';

/** Colours by biome palette (type * 2 + variant). */
const BIOME_COLORS = ['#5f9e3a', '#c08a3a', '#e0bf7d', '#cf7f52', '#dfe9f2', '#b8b0e8'];
const MIN_ZOOM = 2;
const MAX_ZOOM = 40;

export interface Landmark {
  name: string;
  x: number;
  y: number;
  w: number;
  h: number;
  story: boolean;
}

export interface MapSource {
  exploration: ExplorationSystem;
  player(): { x: number; y: number };
  landmarks(): Landmark[];
  memories(): readonly Memory[];
  objective(): { text: string; x: number; y: number } | null;
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
  private drag: { x: number; y: number; moved: boolean } | null = null;

  constructor(private readonly src: MapSource) {
    this.root = document.createElement('div');
    this.root.className = 'map-view';
    this.root.innerHTML = `
      <div class="map-main"><canvas width="560" height="360"></canvas>
      <div class="map-readout hint"></div></div>
      <div class="map-side"><button class="btn map-centre">Centre on me</button><h4>Markers</h4><div class="map-markers"></div>
      <p class="hint">Click the map to drop a marker. Drag to pan, scroll to zoom.</p></div>`;
    this.canvas = this.root.querySelector('canvas')!;
    this.ctx = this.canvas.getContext('2d')!;
    this.list = this.root.querySelector('.map-markers')!;
    this.readout = this.root.querySelector('.map-readout')!;
    this.root.querySelector('.map-centre')!.addEventListener('click', () => this.centre());
    this.canvas.addEventListener('pointerdown', (e) => {
      this.drag = { x: e.offsetX, y: e.offsetY, moved: false };
      this.canvas.setPointerCapture(e.pointerId);
    });
    this.canvas.addEventListener('pointermove', (e) => {
      const [tx, ty] = this.toTiles(e.offsetX, e.offsetY);
      this.readout.textContent = `${Math.round(tx)}, ${Math.round(ty)}`;
      if (!this.drag) return;
      const dx = e.offsetX - this.drag.x;
      const dy = e.offsetY - this.drag.y;
      if (Math.abs(dx) + Math.abs(dy) > 3) this.drag.moved = true;
      if (!this.drag.moved) return;
      this.cx -= (dx / this.zoom) * CHUNK_SIZE;
      this.cy -= (dy / this.zoom) * CHUNK_SIZE;
      this.drag.x = e.offsetX;
      this.drag.y = e.offsetY;
      this.draw();
    });
    this.canvas.addEventListener('pointerup', (e) => {
      if (this.drag && !this.drag.moved) {
        const [tx, ty] = this.toTiles(e.offsetX, e.offsetY);
        this.src.exploration.addMarker(Math.round(tx), Math.round(ty));
        this.refresh();
      }
      this.drag = null;
    });
    this.canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      this.zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, this.zoom * (e.deltaY > 0 ? 0.8 : 1.25)));
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
    return [(tx - this.cx) / CHUNK_SIZE * this.zoom + this.canvas.width / 2, (ty - this.cy) / CHUNK_SIZE * this.zoom + this.canvas.height / 2];
  }

  private toTiles(sx: number, sy: number): [number, number] {
    return [this.cx + ((sx - this.canvas.width / 2) / this.zoom) * CHUNK_SIZE, this.cy + ((sy - this.canvas.height / 2) / this.zoom) * CHUNK_SIZE];
  }

  private draw(): void {
    const { ctx, canvas, zoom } = this;
    const { exploration } = this.src;
    ctx.fillStyle = '#1a1612';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    // Explored chunks.
    for (const [key, palette] of exploration.explored) {
      const [sx, sy] = this.toScreen(keyX(key) * CHUNK_SIZE, keyY(key) * CHUNK_SIZE);
      if (sx < -zoom || sy < -zoom || sx > canvas.width || sy > canvas.height) continue;
      ctx.fillStyle = BIOME_COLORS[palette - 1] ?? '#555';
      ctx.fillRect(Math.floor(sx), Math.floor(sy), Math.ceil(zoom), Math.ceil(zoom));
    }

    // Places the world forgot, kept by the lantern.
    ctx.setLineDash([3, 3]);
    ctx.strokeStyle = '#7fd8ff';
    for (const m of this.src.memories()) {
      const [sx, sy] = this.toScreen(m.x, m.y);
      ctx.strokeRect(sx, sy, Math.max(3, (m.w / CHUNK_SIZE) * zoom), Math.max(3, (m.h / CHUNK_SIZE) * zoom));
    }
    ctx.setLineDash([]);

    for (const l of this.src.landmarks()) {
      const [sx, sy] = this.toScreen(l.x + l.w / 2, l.y + l.h / 2);
      ctx.fillStyle = l.story ? '#ffd040' : '#f6dfa8';
      ctx.strokeStyle = '#3b2412';
      ctx.beginPath();
      ctx.arc(sx, sy, l.story ? 5 : 3.5, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      if (zoom >= 8 || l.story) this.label(l.name, sx + 7, sy + 4);
    }

    const goal = this.src.objective();
    if (goal) {
      const [sx, sy] = this.toScreen(goal.x, goal.y);
      this.star(sx, sy);
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

  private star(x: number, y: number): void {
    const { ctx } = this;
    ctx.fillStyle = '#ffd040';
    ctx.strokeStyle = '#3b2412';
    ctx.beginPath();
    for (let i = 0; i < 10; i++) {
      const r = i % 2 ? 3.5 : 8;
      const a = (i / 10) * Math.PI * 2 - Math.PI / 2;
      ctx.lineTo(x + Math.cos(a) * r, y + Math.sin(a) * r);
    }
    ctx.closePath();
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
