// A shared overworld's messages, all of type `Msg.World`, then a kind byte.
// The host streams its land to its guests (chunks of terrain as the host
// generated them, the objects stamped over them, what was gathered, what lies
// on the ground) and keeps them up to date; guests ask for chunks and objects,
// and ask the host to let them gather, open, pick up, drop and close.
//
// Every decoder returns null for anything malformed: a peer can send any bytes.

import { Layout, type BuildingStyle } from '../generation/StructureGenerator';
import { Msg, quantizePos, unquantizePos, type Reader, type Writer } from '../net';

export const W = {
  /** Host to a new guest: the world's seed, where the host stands, the clock. */
  Info: 1,
  /** Guest to host: where they stand (outside, if indoors or behind a rift) and how much they see. */
  View: 2,
  ChunkReq: 3,
  /** Host: that chunk is not in reach yet; ask again. */
  ChunkLater: 4,
  Chunk: 5,
  ObjectDef: 6,
  /** Guest: a chunk named an object it does not have. */
  ObjectNeed: 7,
  /** Guest: it let an object go (its chunks left); send it again if needed. */
  ObjectForget: 8,
  ObjectGone: 9,
  ObjectState: 10,
  Harvest: 11,
  GroundAdd: 12,
  GroundGone: 13,
  Time: 14,
  /** Where a player is: outdoors, in a room (which), or behind a rift. */
  Where: 15,
  /** A player is in a shared instance behind a rift: friends can follow. */
  RiftInstance: 16,
  /** Guest: send creatures in full again (it lost track, e.g. back from a rift). */
  Resync: 17,
  /** Guest, once it is listening: send the world's Info. */
  Hello: 18,
  HarvestReq: 20,
  ChestReq: 21,
  PickupReq: 22,
  DropReq: 23,
  CloseRiftReq: 24,
  /** Guest: mined or gathered something inside a building. */
  MineReq: 25,
  ChestReply: 30,
  /** Host to a guest: what they picked up (or a drop given back). */
  Give: 31,
  HarvestReply: 32,
} as const;
export type WKind = (typeof W)[keyof typeof W];

/** The kind of a World message, or -1. */
export function worldKind(data: Uint8Array): number {
  return data.length >= 2 && data[0] === Msg.World ? data[1] : -1;
}

const STYLES: readonly BuildingStyle[] = ['house', 'cabin', 'stone', 'keep', 'city', 'mine'];
/** Most things one message may list (an object's chests, a chunk's objects). */
const MAX_LIST = 1024;
const MAX_GROUND = 300;
const MAX_LAYOUT = 512 * 512;
const CHUNK_BYTES = 2048;

const head = (w: Writer, kind: WKind): Writer => w.reset().u8(Msg.World).u8(kind);
const open = (r: Reader, data: Uint8Array, kind: WKind): boolean => {
  r.reset(data);
  return r.u8() === Msg.World && r.u8() === kind;
};

// ---------------------------------------------------------------------------

export interface WorldInfo {
  seed: number;
  /** Where the host stands, in tiles. */
  x: number;
  y: number;
  day: number;
  minutes: number;
  /** The weather's spells, as `WeatherSystem.save()` JSON. */
  weather: string;
  /** A test world: nothing a guest does there is saved. */
  playground: boolean;
}

export function writeInfo(w: Writer, m: WorldInfo): Uint8Array {
  return head(w, W.Info).f64(m.seed).f64(m.x).f64(m.y).u32(m.day).f64(m.minutes).str(m.weather).bool(m.playground).finish();
}

export function readInfo(r: Reader, data: Uint8Array): WorldInfo | null {
  if (!open(r, data, W.Info)) return null;
  const m: WorldInfo = { seed: r.f64(), x: r.f64(), y: r.f64(), day: r.u32(), minutes: r.f64(), weather: r.str(), playground: r.bool() };
  return r.done && Number.isInteger(m.seed) ? m : null;
}

/** A guest's view: what they see (around `x`, `y`) and their spot in the
 *  world (`px`, `py`: outside, if indoors or behind a rift), in tiles. */
export interface ViewMsg {
  x: number;
  y: number;
  px: number;
  py: number;
  halfW: number;
  halfH: number;
  dirX: number;
  dirY: number;
}

/** The most a guest may claim to see, in tiles each way: more would make the
 *  host generate and keep half the world. */
export const MAX_HALF_W = 64;
export const MAX_HALF_H = 40;

export function writeView(w: Writer, v: ViewMsg): Uint8Array {
  const hw = Math.max(1, Math.min(MAX_HALF_W, Math.ceil(v.halfW)));
  const hh = Math.max(1, Math.min(MAX_HALF_H, Math.ceil(v.halfH)));
  return head(w, W.View).i32(quantizePos(v.x)).i32(quantizePos(v.y)).i32(quantizePos(v.px)).i32(quantizePos(v.py)).u8(hw).u8(hh).i16(Math.sign(v.dirX)).i16(Math.sign(v.dirY)).finish();
}

export function readView(r: Reader, data: Uint8Array): ViewMsg | null {
  if (!open(r, data, W.View)) return null;
  const m = { x: unquantizePos(r.i32()), y: unquantizePos(r.i32()), px: unquantizePos(r.i32()), py: unquantizePos(r.i32()), halfW: r.u8(), halfH: r.u8(), dirX: r.i16(), dirY: r.i16() };
  if (!r.done || m.halfW > MAX_HALF_W || m.halfH > MAX_HALF_H || m.halfW < 1 || m.halfH < 1) return null;
  // What they see must be around where they stand.
  if (Math.abs(m.x - m.px) > MAX_HALF_W * 2 || Math.abs(m.y - m.py) > MAX_HALF_H * 2) return null;
  m.dirX = Math.sign(m.dirX);
  m.dirY = Math.sign(m.dirY);
  return m;
}

// Chunks ---------------------------------------------------------------------

export function writeChunkAt(w: Writer, kind: typeof W.ChunkReq | typeof W.ChunkLater, cx: number, cy: number): Uint8Array {
  return head(w, kind).i32(cx).i32(cy).finish();
}

export function readChunkAt(r: Reader, data: Uint8Array, kind: typeof W.ChunkReq | typeof W.ChunkLater): { cx: number; cy: number } | null {
  if (!open(r, data, kind)) return null;
  const at = { cx: r.i32(), cy: r.i32() };
  return r.done ? at : null;
}

export interface BiomeWire {
  id: number;
  type: number;
  variant: number;
  seed: number;
}

export interface GroundWire {
  id: number;
  item: number;
  count: number;
  /** -1 for none. */
  durability: number;
  x: number;
  y: number;
  visit: number;
}

export interface ChunkMsg {
  cx: number;
  cy: number;
  visit: number;
  biome: BiomeWire | null;
  /** The chunk's base tiles then decorations, raw-deflated (2048 bytes inflated). */
  packed: Uint8Array;
  /** The host's ids of every object over the chunk. */
  objects: number[];
  /** What was gathered there: flat triples of cell, decoration, minute. */
  harvest: number[];
  ground: GroundWire[];
}

function writeGround(w: Writer, g: GroundWire): void {
  w.u32(g.id).u16(g.item).u16(Math.min(0xffff, g.count)).u16(g.durability < 0 ? 0 : Math.min(0xfffe, g.durability) + 1).i32(quantizePos(g.x)).i32(quantizePos(g.y)).u32(g.visit);
}

function readGround(r: Reader): GroundWire {
  return { id: r.u32(), item: r.u16(), count: r.u16(), durability: r.u16() - 1, x: unquantizePos(r.i32()), y: unquantizePos(r.i32()), visit: r.u32() };
}

function writeCells(w: Writer, cells: readonly number[]): void {
  const n = Math.min(MAX_LIST, Math.floor(cells.length / 3));
  w.u16(n);
  for (let i = 0; i < n; i++) w.u16(cells[i * 3]).u8(cells[i * 3 + 1]).f64(cells[i * 3 + 2]);
}

function readCells(r: Reader): number[] | null {
  const n = r.u16();
  if (n > MAX_LIST) return null;
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    const cell = r.u16();
    const deco = r.u8();
    const at = r.f64();
    if (cell >= CHUNK_BYTES / 2) return null;
    out.push(cell, deco, at);
  }
  return out;
}

export function writeChunk(w: Writer, m: ChunkMsg): Uint8Array {
  head(w, W.Chunk).i32(m.cx).i32(m.cy).u32(m.visit);
  if (m.biome) w.bool(true).u32(m.biome.id).u8(m.biome.type).u8(m.biome.variant).u32(m.biome.seed);
  else w.bool(false);
  w.bytes(m.packed);
  const n = Math.min(MAX_LIST, m.objects.length);
  w.u16(n);
  for (let i = 0; i < n; i++) w.u32(m.objects[i]);
  writeCells(w, m.harvest);
  const g = Math.min(MAX_GROUND, m.ground.length);
  w.u16(g);
  for (let i = 0; i < g; i++) writeGround(w, m.ground[i]);
  return w.finish();
}

export function readChunk(r: Reader, data: Uint8Array): ChunkMsg | null {
  if (!open(r, data, W.Chunk)) return null;
  const cx = r.i32();
  const cy = r.i32();
  const visit = r.u32();
  const biome = r.bool() ? { id: r.u32(), type: r.u8(), variant: r.u8(), seed: r.u32() } : null;
  const packed = r.bytes(CHUNK_BYTES * 2);
  const n = r.u16();
  if (n > MAX_LIST) return null;
  const objects: number[] = [];
  for (let i = 0; i < n; i++) objects.push(r.u32());
  const harvest = readCells(r);
  if (!harvest) return null;
  const g = r.u16();
  if (g > MAX_GROUND) return null;
  const ground: GroundWire[] = [];
  for (let i = 0; i < g; i++) ground.push(readGround(r));
  return r.done ? { cx, cy, visit, biome, packed, objects, harvest, ground } : null;
}

// Objects ----------------------------------------------------------------------

export interface ObjectMsg {
  net: number;
  id: string;
  kind: string;
  name: string;
  x: number;
  y: number;
  w: number;
  h: number;
  /** The layout's tiles then decorations, raw-deflated (2·w·h bytes inflated). */
  packed: Uint8Array;
  buildings: Layout['buildings'];
  anchor: string;
  emptyChests: boolean;
  closed: boolean;
  dimension: string;
  opened: number[];
}

function writeOpened(w: Writer, opened: Iterable<number>): void {
  const at = w.pos;
  w.u16(0);
  let n = 0;
  for (const i of opened) {
    if (n >= MAX_LIST) break;
    w.u32(i);
    n++;
  }
  // Patch the count in, little-endian.
  w.patchU8(at, n & 0xff);
  w.patchU8(at + 1, n >> 8);
}

function readOpened(r: Reader): number[] | null {
  const n = r.u16();
  if (n > MAX_LIST) return null;
  const out: number[] = [];
  for (let i = 0; i < n; i++) out.push(r.u32());
  return out;
}

export function writeObject(w: Writer, m: Omit<ObjectMsg, 'opened'> & { opened: Iterable<number> }): Uint8Array {
  head(w, W.ObjectDef).u32(m.net).str(m.id).str(m.kind).str(m.name).i32(m.x).i32(m.y).u16(m.w).u16(m.h).bytes(m.packed);
  const b = Math.min(64, m.buildings.length);
  w.u8(b);
  for (let i = 0; i < b; i++) {
    const s = m.buildings[i];
    w.u16(s.x).u16(s.y).u8(s.w).u8(s.h).u8(s.door).u8(Math.max(0, STYLES.indexOf(s.style))).u32(s.seed);
  }
  w.str(m.anchor).bool(m.emptyChests).bool(m.closed).str(m.dimension);
  writeOpened(w, m.opened);
  return w.finish();
}

export function readObject(r: Reader, data: Uint8Array): ObjectMsg | null {
  if (!open(r, data, W.ObjectDef)) return null;
  const net = r.u32();
  const id = r.str();
  const kind = r.str();
  const name = r.str();
  const x = r.i32();
  const y = r.i32();
  const w = r.u16();
  const h = r.u16();
  const packed = r.bytes();
  const b = r.u8();
  if (b > 64) return null;
  const buildings: Layout['buildings'] = [];
  for (let i = 0; i < b; i++) {
    const s = { x: r.u16(), y: r.u16(), w: r.u8(), h: r.u8(), door: r.u8(), style: STYLES[r.u8()], seed: r.u32() };
    if (!s.style || s.x + s.w > w || s.y + s.h > h) return null;
    buildings.push(s);
  }
  const anchor = r.str();
  const emptyChests = r.bool();
  const closed = r.bool();
  const dimension = r.str();
  const opened = readOpened(r);
  if (!opened || !r.done || !id || !w || !h || w * h > MAX_LAYOUT) return null;
  return { net, id, kind, name, x, y, w, h, packed, buildings, anchor, emptyChests, closed, dimension, opened };
}

/** A layout from its inflated bytes (tiles then decorations), or null if they do not fit. */
export function layoutFrom(w: number, h: number, bytes: Uint8Array | null, buildings: Layout['buildings']): Layout | null {
  if (!bytes || bytes.length !== w * h * 2) return null;
  const l = new Layout(w, h);
  l.tiles.set(bytes.subarray(0, w * h));
  l.decos.set(bytes.subarray(w * h));
  l.buildings = buildings;
  return l;
}

export function writeNet(w: Writer, kind: typeof W.ObjectNeed | typeof W.ObjectForget | typeof W.ObjectGone | typeof W.CloseRiftReq | typeof W.PickupReq | typeof W.GroundGone, net: number): Uint8Array {
  return head(w, kind).u32(net).finish();
}

export function readNet(r: Reader, data: Uint8Array, kind: typeof W.ObjectNeed | typeof W.ObjectForget | typeof W.ObjectGone | typeof W.CloseRiftReq | typeof W.PickupReq | typeof W.GroundGone): number | null {
  if (!open(r, data, kind)) return null;
  const n = r.u32();
  return r.done ? n : null;
}

export interface ObjectStateMsg {
  net: number;
  emptyChests: boolean;
  closed: boolean;
  opened: number[];
}

export function writeObjectState(w: Writer, net: number, emptyChests: boolean, closed: boolean, opened: Iterable<number>): Uint8Array {
  head(w, W.ObjectState).u32(net).bool(emptyChests).bool(closed);
  writeOpened(w, opened);
  return w.finish();
}

export function readObjectState(r: Reader, data: Uint8Array): ObjectStateMsg | null {
  if (!open(r, data, W.ObjectState)) return null;
  const net = r.u32();
  const emptyChests = r.bool();
  const closed = r.bool();
  const opened = readOpened(r);
  return opened && r.done ? { net, emptyChests, closed, opened } : null;
}

// Harvest, ground, clock ---------------------------------------------------------

export function writeHarvest(w: Writer, cx: number, cy: number, cells: readonly number[]): Uint8Array {
  head(w, W.Harvest).i32(cx).i32(cy);
  writeCells(w, cells);
  return w.finish();
}

export function readHarvest(r: Reader, data: Uint8Array): { cx: number; cy: number; cells: number[] } | null {
  if (!open(r, data, W.Harvest)) return null;
  const cx = r.i32();
  const cy = r.i32();
  const cells = readCells(r);
  return cells && r.done ? { cx, cy, cells } : null;
}

export function writeGroundAdd(w: Writer, g: GroundWire, armed: boolean): Uint8Array {
  head(w, W.GroundAdd);
  writeGround(w, g);
  return w.bool(armed).finish();
}

export function readGroundAdd(r: Reader, data: Uint8Array): { g: GroundWire; armed: boolean } | null {
  if (!open(r, data, W.GroundAdd)) return null;
  const g = readGround(r);
  const armed = r.bool();
  return r.done ? { g, armed } : null;
}

export function writeTime(w: Writer, day: number, minutes: number, weather: string): Uint8Array {
  return head(w, W.Time).u32(day).f64(minutes).str(weather).finish();
}

export function readTime(r: Reader, data: Uint8Array): { day: number; minutes: number; weather: string } | null {
  if (!open(r, data, W.Time)) return null;
  const m = { day: r.u32(), minutes: r.f64(), weather: r.str() };
  return r.done ? m : null;
}

/** Where a player is. */
export const Place = { Outdoors: 0, Indoors: 1, Away: 2 } as const;

export interface WhereMsg {
  slot: number;
  place: number;
  /** Indoors: the building's object (host's id), which building, which floor. */
  object: number;
  index: number;
  floor: number;
  /** The mover's state tick when it moved: older states (the unreliable
   *  channel reorders) belong to where it was before. */
  tick: number;
}

export function writeWhere(w: Writer, m: WhereMsg): Uint8Array {
  return head(w, W.Where).u8(m.slot).u8(m.place).u32(m.object).u8(m.index).u8(m.floor).u32(m.tick).finish();
}

export function readWhere(r: Reader, data: Uint8Array): WhereMsg | null {
  if (!open(r, data, W.Where)) return null;
  const m = { slot: r.u8(), place: r.u8(), object: r.u32(), index: r.u8(), floor: r.u8(), tick: r.u32() };
  return r.done && m.place <= 2 ? m : null;
}

export function writeRiftInstance(w: Writer, slot: number, dimension: string, code: string): Uint8Array {
  return head(w, W.RiftInstance).u8(slot).str(dimension).str(code).finish();
}

export function readRiftInstance(r: Reader, data: Uint8Array): { slot: number; dimension: string; code: string } | null {
  if (!open(r, data, W.RiftInstance)) return null;
  const m = { slot: r.u8(), dimension: r.str(), code: r.str() };
  return r.done ? m : null;
}

export function writeEmpty(w: Writer, kind: typeof W.Resync | typeof W.Hello): Uint8Array {
  return head(w, kind).finish();
}

// Requests and replies -------------------------------------------------------------

/** Gathering outdoors: `req` (non-zero) asks for a word back (`HarvestReply`)
 *  before what it gave is handed over. */
export function writeHarvestReq(w: Writer, req: number, gx: number, gy: number, deco: number): Uint8Array {
  return head(w, W.HarvestReq).u16(req).i32(gx).i32(gy).u8(deco).finish();
}

export function readHarvestReq(r: Reader, data: Uint8Array): { req: number; gx: number; gy: number; deco: number } | null {
  if (!open(r, data, W.HarvestReq)) return null;
  const m = { req: r.u16(), gx: r.i32(), gy: r.i32(), deco: r.u8() };
  return r.done ? m : null;
}

/** Mining or gathering inside a building: the object, and the id in its opened set. */
export function writeMineReq(w: Writer, req: number, net: number, id: number): Uint8Array {
  return head(w, W.MineReq).u16(req).u32(net).u32(id).finish();
}

export function readMineReq(r: Reader, data: Uint8Array): { req: number; net: number; id: number } | null {
  if (!open(r, data, W.MineReq)) return null;
  const m = { req: r.u16(), net: r.u32(), id: r.u32() };
  return r.done ? m : null;
}

/** The host's word on a gathering or mining request. */
export function writeHarvestReply(w: Writer, req: number, ok: boolean): Uint8Array {
  return head(w, W.HarvestReply).u16(req).bool(ok).finish();
}

export function readHarvestReply(r: Reader, data: Uint8Array): { req: number; ok: boolean } | null {
  if (!open(r, data, W.HarvestReply)) return null;
  const m = { req: r.u16(), ok: r.bool() };
  return r.done ? m : null;
}

export function writeChestReq(w: Writer, req: number, net: number, index: number): Uint8Array {
  return head(w, W.ChestReq).u16(req).u32(net).u32(index).finish();
}

export function readChestReq(r: Reader, data: Uint8Array): { req: number; net: number; index: number } | null {
  if (!open(r, data, W.ChestReq)) return null;
  const m = { req: r.u16(), net: r.u32(), index: r.u32() };
  return r.done ? m : null;
}

export function writeChestReply(w: Writer, req: number, ok: boolean): Uint8Array {
  return head(w, W.ChestReply).u16(req).bool(ok).finish();
}

export function readChestReply(r: Reader, data: Uint8Array): { req: number; ok: boolean } | null {
  if (!open(r, data, W.ChestReply)) return null;
  const m = { req: r.u16(), ok: r.bool() };
  return r.done ? m : null;
}

export interface StackWire {
  item: number;
  count: number;
  /** -1 for none. */
  durability: number;
}

export function writeStack(w: Writer, kind: typeof W.Give | typeof W.DropReq, s: StackWire, x = 0, y = 0): Uint8Array {
  head(w, kind).u16(s.item).u16(Math.min(0xffff, s.count)).u16(s.durability < 0 ? 0 : Math.min(0xfffe, s.durability) + 1);
  if (kind === W.DropReq) w.i32(quantizePos(x)).i32(quantizePos(y));
  return w.finish();
}

export function readStack(r: Reader, data: Uint8Array, kind: typeof W.Give | typeof W.DropReq): (StackWire & { x: number; y: number }) | null {
  if (!open(r, data, kind)) return null;
  const s = { item: r.u16(), count: r.u16(), durability: r.u16() - 1, x: 0, y: 0 };
  if (kind === W.DropReq) {
    s.x = unquantizePos(r.i32());
    s.y = unquantizePos(r.i32());
  }
  return r.done && s.count > 0 ? s : null;
}
