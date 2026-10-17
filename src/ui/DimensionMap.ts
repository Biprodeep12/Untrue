// The map inside an outer dimension, the one place maps work: the tiles the
// player has seen, the chambers by name (ticked once done), the rift home,
// the portal and the player. Seen tiles are painted one pixel each into a
// small canvas, only when more has been seen; the map itself is drawn when
// the tab opens, never per frame (the world is paused behind the menu).

import type { DimensionRun } from '../dimension/Challenges';
import type { DimensionDef } from '../dimension/Dimension';
import { DimTile } from '../dimension/DimTile';
import { CHAMBER_NAMES } from '../game/RiftTrip';

const MAP_W = 560;
const MAP_H = 360;

/** Colours by dimension tile; void stays the background. */
const COLORS: Partial<Record<number, [number, number, number]>> = {
  [DimTile.Floor]: [110, 92, 128],
  [DimTile.Wall]: [58, 44, 74],
  [DimTile.Door]: [138, 116, 160],
  [DimTile.Glitch]: [94, 106, 144],
  [DimTile.Crumble]: [122, 104, 136],
  [DimTile.Plate]: [176, 122, 255],
  [DimTile.Glyph]: [176, 122, 255],
  [DimTile.Pillar]: [78, 62, 96],
  [DimTile.Crystal]: [90, 240, 232],
  [DimTile.Portal]: [159, 248, 242],
  [DimTile.Chest]: [242, 201, 106],
  [DimTile.Rift]: [255, 106, 184],
  [DimTile.Checkpoint]: [58, 200, 216],
  [DimTile.Rune]: [138, 116, 160],
};

export interface DimensionMapSource {
  readonly def: DimensionDef;
  readonly run: DimensionRun;
  /** Seen tiles, 1 each, row-major like the layout. */
  readonly seen: Uint8Array;
  /** Rises whenever more is seen. */
  readonly seenVersion: number;
  player(): { x: number; y: number };
}

export class DimensionMap {
  readonly root: HTMLElement;
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly title: HTMLElement;
  /** Seen tiles at one pixel each. */
  private readonly tiles = document.createElement('canvas');
  private painted: { run: DimensionRun | null; version: number } = { run: null, version: -1 };
  /** What has been seen so far, in tiles: the map frames it. */
  private readonly seenBox = { x0: 0, y0: 0, x1: 0, y1: 0 };

  constructor() {
    this.root = document.createElement('div');
    this.root.className = 'map-view';
    this.root.innerHTML = `
      <div class="map-main"><canvas></canvas></div>
      <div class="map-side"><h4 class="dim-map-title"></h4>
      <p class="hint">Maps work here, and only here: this place holds still. What you have seen is drawn; the rest is void.</p>
      <p class="hint"><span class="dim-key dim-key-rift"></span> the rift home · <span class="dim-key dim-key-portal"></span> the portal · <span class="dim-key dim-key-you"></span> you</p></div>`;
    this.canvas = this.root.querySelector('canvas')!;
    this.canvas.style.width = `${MAP_W}px`;
    this.ctx = this.canvas.getContext('2d')!;
    this.title = this.root.querySelector('.dim-map-title')!;
  }

  show(src: DimensionMapSource): HTMLElement {
    this.title.textContent = src.def.name;
    this.paintTiles(src);
    this.draw(src);
    return this.root;
  }

  /** Repaints the seen tiles, only when more were seen since the last time. */
  private paintTiles(src: DimensionMapSource): void {
    if (this.painted.run === src.run && this.painted.version === src.seenVersion) return;
    this.painted = { run: src.run, version: src.seenVersion };
    const { w, h, tiles } = src.run.layout;
    this.tiles.width = w;
    this.tiles.height = h;
    const ctx = this.tiles.getContext('2d')!;
    const img = ctx.createImageData(w, h);
    const box = this.seenBox;
    box.x0 = w;
    box.y0 = h;
    box.x1 = box.y1 = 0;
    for (let i = 0; i < w * h; i++) {
      const c = src.seen[i] ? COLORS[tiles[i]] : undefined;
      if (!c) continue;
      const x = i % w;
      const y = Math.floor(i / w);
      box.x0 = Math.min(box.x0, x);
      box.y0 = Math.min(box.y0, y);
      box.x1 = Math.max(box.x1, x + 1);
      box.y1 = Math.max(box.y1, y + 1);
      img.data[i * 4] = c[0];
      img.data[i * 4 + 1] = c[1];
      img.data[i * 4 + 2] = c[2];
      img.data[i * 4 + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
  }

  private draw(src: DimensionMapSource): void {
    const { ctx } = this;
    const { run } = src;
    const L = run.layout;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    this.canvas.width = Math.round(MAP_W * dpr);
    this.canvas.height = Math.round(MAP_H * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = '#120a24';
    ctx.fillRect(0, 0, MAP_W, MAP_H);
    // What has been seen fits, centred, at a whole number of pixels per tile.
    const box = this.seenBox;
    const bw = Math.max(1, box.x1 - box.x0) + 8;
    const bh = Math.max(1, box.y1 - box.y0) + 8;
    const scale = Math.max(2, Math.min(10, Math.floor(Math.min(MAP_W / bw, MAP_H / bh))));
    const ox = Math.floor(MAP_W / 2 - ((box.x0 + box.x1) / 2) * scale);
    const oy = Math.floor(MAP_H / 2 - ((box.y0 + box.y1) / 2) * scale);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(this.tiles, ox, oy, L.w * scale, L.h * scale);
    const at = (t: number): [number, number] => [ox + ((t % L.w) + 0.5) * scale, oy + (Math.floor(t / L.w) + 0.5) * scale];

    // Chambers the player has seen into, by name.
    ctx.font = '11px "Pixelify Sans", monospace';
    ctx.textAlign = 'center';
    L.chambers.forEach((c, i) => {
      const r = c.rect;
      const mid = Math.floor(r.y + r.h / 2) * L.w + Math.floor(r.x + r.w / 2);
      if (!this.seenNear(src, mid, Math.max(r.w, r.h) >> 1)) return;
      const done = run.challenges[i]?.done;
      const [x, y] = at(mid);
      this.label(`${CHAMBER_NAMES[c.kind]}${done ? ' ✓' : ''}`, x, oy + r.y * scale - 3 > 10 ? oy + r.y * scale - 3 : y);
    });
    if (src.seen[L.rift]) this.dot(...at(L.rift), '#ff6ab8', 4);
    if (src.seen[L.portal]) this.dot(...at(L.portal), run.portalOpen ? '#9ff8f2' : '#4a3a5e', 4);
    const p = src.player();
    this.dot(ox + p.x * scale, oy + (p.y - 0.3) * scale, '#ffffff', 3.5);
  }

  /** Any seen tile within `r` of tile `t`. */
  private seenNear(src: DimensionMapSource, t: number, r: number): boolean {
    const { w, h } = src.run.layout;
    const tx = t % w;
    const ty = Math.floor(t / w);
    for (let y = Math.max(0, ty - r); y <= Math.min(h - 1, ty + r); y++) {
      for (let x = Math.max(0, tx - r); x <= Math.min(w - 1, tx + r); x++) if (src.seen[y * w + x]) return true;
    }
    return false;
  }

  private dot(x: number, y: number, color: string, r: number): void {
    const { ctx } = this;
    ctx.fillStyle = color;
    ctx.strokeStyle = '#000';
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
  }

  private label(text: string, x: number, y: number): void {
    const { ctx } = this;
    ctx.strokeStyle = '#120a24';
    ctx.lineWidth = 3;
    ctx.strokeText(text, x, y);
    ctx.lineWidth = 1;
    ctx.fillStyle = '#e8d0ff';
    ctx.fillText(text, x, y);
  }
}
