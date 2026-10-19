// A tiny pixel font for labels drawn on the low-resolution canvas (players'
// names). Canvas text is antialiased and then scaled up with nearest
// filtering, which smears small sizes; these glyphs are whole pixels, drawn
// once per label into a small texture, with a one-pixel outline.

import { CanvasSource, Texture } from 'pixi.js';

/** Glyphs five pixels tall, rows top to bottom, '#' set. Letters show as capitals. */
const GLYPHS: Record<string, readonly string[]> = {
  A: ['.#.', '#.#', '###', '#.#', '#.#'],
  B: ['##.', '#.#', '##.', '#.#', '##.'],
  C: ['.##', '#..', '#..', '#..', '.##'],
  D: ['##.', '#.#', '#.#', '#.#', '##.'],
  E: ['###', '#..', '##.', '#..', '###'],
  F: ['###', '#..', '##.', '#..', '#..'],
  G: ['.##', '#..', '#.#', '#.#', '.##'],
  H: ['#.#', '#.#', '###', '#.#', '#.#'],
  I: ['###', '.#.', '.#.', '.#.', '###'],
  J: ['..#', '..#', '..#', '#.#', '.#.'],
  K: ['#.#', '#.#', '##.', '#.#', '#.#'],
  L: ['#..', '#..', '#..', '#..', '###'],
  M: ['#...#', '##.##', '#.#.#', '#...#', '#...#'],
  N: ['#..#', '##.#', '#.##', '#..#', '#..#'],
  O: ['.#.', '#.#', '#.#', '#.#', '.#.'],
  P: ['##.', '#.#', '##.', '#..', '#..'],
  Q: ['.#.', '#.#', '#.#', '##.', '.##'],
  R: ['##.', '#.#', '##.', '#.#', '#.#'],
  S: ['.##', '#..', '.#.', '..#', '##.'],
  T: ['###', '.#.', '.#.', '.#.', '.#.'],
  U: ['#.#', '#.#', '#.#', '#.#', '###'],
  V: ['#.#', '#.#', '#.#', '#.#', '.#.'],
  W: ['#...#', '#...#', '#.#.#', '##.##', '#...#'],
  X: ['#.#', '#.#', '.#.', '#.#', '#.#'],
  Y: ['#.#', '#.#', '.#.', '.#.', '.#.'],
  Z: ['###', '..#', '.#.', '#..', '###'],
  '0': ['###', '#.#', '#.#', '#.#', '###'],
  '1': ['.#.', '##.', '.#.', '.#.', '###'],
  '2': ['##.', '..#', '.#.', '#..', '###'],
  '3': ['##.', '..#', '.#.', '..#', '##.'],
  '4': ['#.#', '#.#', '###', '..#', '..#'],
  '5': ['###', '#..', '##.', '..#', '##.'],
  '6': ['.##', '#..', '###', '#.#', '###'],
  '7': ['###', '..#', '.#.', '.#.', '.#.'],
  '8': ['###', '#.#', '###', '#.#', '###'],
  '9': ['###', '#.#', '###', '..#', '##.'],
  ' ': ['..', '..', '..', '..', '..'],
  '.': ['.', '.', '.', '.', '#'],
  ',': ['.', '.', '.', '#', '#'],
  "'": ['#', '#', '.', '.', '.'],
  '!': ['#', '#', '#', '.', '#'],
  ':': ['.', '#', '.', '#', '.'],
  '-': ['...', '...', '###', '...', '...'],
  _: ['...', '...', '...', '...', '###'],
  '+': ['...', '.#.', '###', '.#.', '...'],
  '?': ['##.', '..#', '.#.', '...', '.#.'],
  '(': ['.#', '#.', '#.', '#.', '.#'],
  ')': ['#.', '.#', '.#', '.#', '#.'],
  '/': ['..#', '..#', '.#.', '#..', '#..'],
  '&': ['.#.', '#.#', '.#.', '#.#', '.##'],
  '#': ['#.#', '###', '#.#', '###', '#.#'],
};
/** Anything the font lacks. */
const MISSING = GLYPHS['?'];
const ROWS = 5;
/** Characters past this are cut, so a label stays a sensible width. */
const MAX_CHARS = 24;

function glyphOf(ch: string): readonly string[] {
  return GLYPHS[ch] ?? MISSING;
}

/** The text as the font can show it: capitals, accents dropped (É → E). */
export function pixelChars(text: string): string[] {
  return [...text.normalize('NFD').replace(/\p{M}/gu, '').toUpperCase()].slice(0, MAX_CHARS);
}

/** Width in pixels of a label, outline included. */
export function pixelTextWidth(text: string): number {
  const chars = pixelChars(text);
  let w = 0;
  for (const ch of chars) w += glyphOf(ch)[0].length;
  return w + Math.max(0, chars.length - 1) + 2;
}

/** A label's texture: `fill` letters with an `outline` one pixel round them. */
export function pixelText(text: string, fill: [number, number, number], outline: [number, number, number]): Texture {
  const chars = pixelChars(text);
  const w = Math.max(1, pixelTextWidth(text));
  const h = ROWS + 2;
  const mask = new Uint8Array(w * h);
  let x = 1;
  for (const ch of chars) {
    const g = glyphOf(ch);
    for (let r = 0; r < ROWS; r++) {
      const row = g[r];
      for (let c = 0; c < row.length; c++) if (row.charCodeAt(c) === 35) mask[(r + 1) * w + x + c] = 1;
    }
    x += g[0].length + 1;
  }
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d')!;
  const img = ctx.createImageData(w, h);
  const d = img.data;
  for (let y = 0; y < h; y++) {
    for (let px = 0; px < w; px++) {
      const i = y * w + px;
      let c: [number, number, number] | null = null;
      if (mask[i]) c = fill;
      else {
        // The outline: any of the eight neighbours set.
        for (let dy = -1; dy <= 1 && !c; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const nx = px + dx;
            const ny = y + dy;
            if (nx >= 0 && ny >= 0 && nx < w && ny < h && mask[ny * w + nx]) {
              c = outline;
              break;
            }
          }
        }
      }
      if (!c) continue;
      d[i * 4] = c[0];
      d[i * 4 + 1] = c[1];
      d[i * 4 + 2] = c[2];
      d[i * 4 + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  // Not through Texture.from: that caches by resource, and labels are
  // destroyed when a name changes.
  return new Texture({ source: new CanvasSource({ resource: canvas, scaleMode: 'nearest' }) });
}
