// F3 overlay: streaming stats and a minimap of the cache area, so chunk
// lifecycle, biome records and object lifetimes can be watched live.

import { CHUNK_SIZE } from '../config';
import { chunkKey, inRect, type ChunkRect } from '../coords';
import type { Enemy } from '../entities/Enemy';
import type { WorldManager } from '../world/WorldManager';

const BIOME_COLORS = ['#5f9e3a', '#c08a3a', '#e0bf7d', '#cf7f52', '#dfe9f2', '#b8b0e8'];
const MAP_SIZE = 200;

export class DebugOverlay {
  private readonly root: HTMLElement;
  private readonly text: HTMLElement;
  private readonly ctx: CanvasRenderingContext2D;
  visible = false;

  constructor(parent: HTMLElement) {
    this.root = document.createElement('div');
    this.root.className = 'panel debug';
    this.root.innerHTML = `<pre></pre><canvas width="${MAP_SIZE}" height="${MAP_SIZE}"></canvas>
      <div class="debug-key"><i style="border-color:#fff"></i>render <i style="border-color:#ffd84a"></i>simulation
      <i style="border-color:#ff5a4a"></i>object
      <i style="border-color:#ff40ff"></i>enemy</div>`;
    this.text = this.root.querySelector('pre')!;
    this.ctx = this.root.querySelector('canvas')!.getContext('2d')!;
    this.root.style.display = 'none';
    parent.appendChild(this.root);
  }

  toggle(): void {
    this.visible = !this.visible;
    this.root.style.display = this.visible ? 'block' : 'none';
  }

  update(world: WorldManager, enemies: readonly Enemy[], fps: number, drawn: number, px: number, py: number): void {
    if (!this.visible) return;
    const cm = world.chunks;
    const ready = [...cm.chunks.values()].filter((c) => c.ready).length;
    this.text.textContent = [
      `seed     ${world.seed}`,
      `fps      ${fps.toFixed(0)}`,
      `chunks   cached ${cm.cached.size} · ready ${ready} · drawn ${drawn} · in flight ${cm.inFlight}`,
      `biomes   ${world.biomes.records.size} records`,
      `objects  ${world.objects.objects.size} live`,
      `enemies  ${enemies.length} (${enemies.filter((e) => e.state !== 'patrol' && e.state !== 'burrowed').length} hunting you)`,
      `regions  ${world.regions.size} tracked · visit here ${world.regions.visit(Math.floor(px / CHUNK_SIZE), Math.floor(py / CHUNK_SIZE))}`,
    ].join('\n');
    this.drawMap(world, enemies, px, py);
  }

  private drawMap(world: WorldManager, enemies: readonly Enemy[], px: number, py: number): void {
    const { ctx } = this;
    const cm = world.chunks;
    const cache = cm.cacheRect;
    if (!cache) return;
    const span = Math.max(cache.x1 - cache.x0, cache.y1 - cache.y0) + 1;
    const cell = MAP_SIZE / span;
    const sx = (cx: number) => (cx - cache.x0) * cell;
    const sy = (cy: number) => (cy - cache.y0) * cell;
    ctx.clearRect(0, 0, MAP_SIZE, MAP_SIZE);

    for (let cy = cache.y0; cy <= cache.y1; cy++) {
      for (let cx = cache.x0; cx <= cache.x1; cx++) {
        const key = chunkKey(cx, cy);
        const b = world.biomes.at(key);
        const chunk = cm.chunks.get(key);
        ctx.globalAlpha = chunk?.ready ? 1 : chunk ? 0.6 : 0.35;
        ctx.fillStyle = b ? BIOME_COLORS[b.type * 2 + b.variant] : '#333';
        ctx.fillRect(sx(cx), sy(cy), cell - 1, cell - 1);
      }
    }
    ctx.globalAlpha = 1;
    // Biome borders.
    ctx.strokeStyle = 'rgba(0,0,0,0.6)';
    for (let cy = cache.y0; cy <= cache.y1; cy++) {
      for (let cx = cache.x0; cx <= cache.x1; cx++) {
        const b = world.biomes.at(chunkKey(cx, cy));
        if (cx < cache.x1 && world.biomes.at(chunkKey(cx + 1, cy)) !== b) this.line(sx(cx + 1), sy(cy), sx(cx + 1), sy(cy + 1));
        if (cy < cache.y1 && world.biomes.at(chunkKey(cx, cy + 1)) !== b) this.line(sx(cx), sy(cy + 1), sx(cx + 1), sy(cy + 1));
      }
    }
    ctx.strokeStyle = '#ff5a4a';
    for (const o of world.objects.objects.values()) {
      const x = sx(o.x / CHUNK_SIZE);
      const y = sy(o.y / CHUNK_SIZE);
      ctx.strokeRect(x, y, (o.w / CHUNK_SIZE) * cell, (o.h / CHUNK_SIZE) * cell);
    }
    this.rect(cm.renderRect, cache, cell, '#fff');
    this.rect(cm.simRect, cache, cell, '#ffd84a');
    ctx.fillStyle = '#ff40ff';
    for (const e of enemies) ctx.fillRect(sx(e.x / CHUNK_SIZE) - 1, sy(e.y / CHUNK_SIZE) - 1, 3, 3);
    ctx.fillStyle = '#ff2';
    ctx.fillRect(sx(px / CHUNK_SIZE) - 2, sy(py / CHUNK_SIZE) - 2, 4, 4);
  }

  private line(x0: number, y0: number, x1: number, y1: number): void {
    this.ctx.beginPath();
    this.ctx.moveTo(x0, y0);
    this.ctx.lineTo(x1, y1);
    this.ctx.stroke();
  }

  private rect(r: ChunkRect | null, cache: ChunkRect, cell: number, color: string): void {
    if (!r || !inRect(cache, r.x0, r.y0)) return;
    this.ctx.strokeStyle = color;
    this.ctx.strokeRect((r.x0 - cache.x0) * cell + 0.5, (r.y0 - cache.y0) * cell + 0.5, (r.x1 - r.x0 + 1) * cell - 1, (r.y1 - r.y0 + 1) * cell - 1);
  }
}
