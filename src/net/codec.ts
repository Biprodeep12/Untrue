// Binary reading and writing for network messages. One `Writer` is reused for
// every message a peer sends, so encoding allocates nothing once its buffer
// has grown to fit; `Reader` checks every read against the end of the data
// and, instead of throwing, marks itself failed, so a decoder can finish and
// return null for anything short, long or malformed.

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder('utf-8', { fatal: false });

/** Longest short string (names, ids, versions), in bytes. */
export const MAX_SHORT_STRING = 255;
/** Longest long string (session descriptions), in bytes. */
export const MAX_LONG_STRING = 16 * 1024;

export class Writer {
  private buf: Uint8Array;
  private view: DataView;
  pos = 0;

  constructor(size = 1500) {
    this.buf = new Uint8Array(size);
    this.view = new DataView(this.buf.buffer);
  }

  /** Starts a new message, reusing the buffer. */
  reset(): this {
    this.pos = 0;
    return this;
  }

  /** Overwrites a byte already written (a count known only at the end). */
  patchU8(at: number, v: number): void {
    this.buf[at] = v;
  }

  /** The message so far: a view into the shared buffer, valid until the next
   *  `reset`. Send it (or copy it) straight away. */
  finish(): Uint8Array {
    return this.buf.subarray(0, this.pos);
  }

  private room(n: number): void {
    const need = this.pos + n;
    if (need <= this.buf.length) return;
    let size = this.buf.length * 2;
    while (size < need) size *= 2;
    const next = new Uint8Array(size);
    next.set(this.buf.subarray(0, this.pos));
    this.buf = next;
    this.view = new DataView(next.buffer);
  }

  u8(v: number): this {
    this.room(1);
    this.buf[this.pos++] = v;
    return this;
  }

  bool(v: boolean): this {
    return this.u8(v ? 1 : 0);
  }

  u16(v: number): this {
    this.room(2);
    this.view.setUint16(this.pos, v, true);
    this.pos += 2;
    return this;
  }

  i16(v: number): this {
    this.room(2);
    this.view.setInt16(this.pos, v, true);
    this.pos += 2;
    return this;
  }

  u32(v: number): this {
    this.room(4);
    this.view.setUint32(this.pos, v >>> 0, true);
    this.pos += 4;
    return this;
  }

  i32(v: number): this {
    this.room(4);
    this.view.setInt32(this.pos, v | 0, true);
    this.pos += 4;
    return this;
  }

  f32(v: number): this {
    this.room(4);
    this.view.setFloat32(this.pos, v, true);
    this.pos += 4;
    return this;
  }

  f64(v: number): this {
    this.room(8);
    this.view.setFloat64(this.pos, v, true);
    this.pos += 8;
    return this;
  }

  /** Raw bytes of a known, fixed length (keys, hashes). */
  fixed(bytes: Uint8Array, length: number): this {
    this.room(length);
    if (bytes.length >= length) this.buf.set(bytes.subarray(0, length), this.pos);
    else {
      this.buf.set(bytes, this.pos);
      this.buf.fill(0, this.pos + bytes.length, this.pos + length);
    }
    this.pos += length;
    return this;
  }

  /** Bytes with a u16 length (at most 65535). */
  bytes(bytes: Uint8Array): this {
    const n = Math.min(bytes.length, 0xffff);
    this.u16(n);
    this.room(n);
    this.buf.set(bytes.subarray(0, n), this.pos);
    this.pos += n;
    return this;
  }

  /** A string of at most 255 UTF-8 bytes, cut at a character boundary. */
  str(s: string): this {
    this.room(1 + MAX_SHORT_STRING * 1);
    const start = this.pos++;
    const { written } = textEncoder.encodeInto(s, this.buf.subarray(this.pos, this.pos + MAX_SHORT_STRING));
    this.buf[start] = written;
    this.pos += written;
    return this;
  }

  /** A string of at most 16 KiB of UTF-8, with a u16 length. */
  longStr(s: string): this {
    this.room(2 + MAX_LONG_STRING);
    const start = this.pos;
    this.pos += 2;
    const { written } = textEncoder.encodeInto(s, this.buf.subarray(this.pos, this.pos + MAX_LONG_STRING));
    this.view.setUint16(start, written, true);
    this.pos += written;
    return this;
  }
}

export class Reader {
  private data: Uint8Array = new Uint8Array(0);
  private view: DataView = new DataView(this.data.buffer);
  pos = 0;
  /** False once any read ran past the end or found a bad value. */
  ok = true;

  /** Reads `data` from the start; reuses this reader. */
  reset(data: Uint8Array): this {
    this.data = data;
    this.view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    this.pos = 0;
    this.ok = true;
    return this;
  }

  get left(): number {
    return this.data.length - this.pos;
  }

  /** True if every byte was read and nothing failed. */
  get done(): boolean {
    return this.ok && this.pos === this.data.length;
  }

  private has(n: number): boolean {
    if (this.ok && this.pos + n <= this.data.length) return true;
    this.ok = false;
    return false;
  }

  /** Marks the data bad (a value out of range). */
  fail(): void {
    this.ok = false;
  }

  u8(): number {
    if (!this.has(1)) return 0;
    return this.data[this.pos++];
  }

  bool(): boolean {
    const v = this.u8();
    if (v > 1) this.ok = false;
    return v === 1;
  }

  u16(): number {
    if (!this.has(2)) return 0;
    const v = this.view.getUint16(this.pos, true);
    this.pos += 2;
    return v;
  }

  i16(): number {
    if (!this.has(2)) return 0;
    const v = this.view.getInt16(this.pos, true);
    this.pos += 2;
    return v;
  }

  u32(): number {
    if (!this.has(4)) return 0;
    const v = this.view.getUint32(this.pos, true);
    this.pos += 4;
    return v;
  }

  i32(): number {
    if (!this.has(4)) return 0;
    const v = this.view.getInt32(this.pos, true);
    this.pos += 4;
    return v;
  }

  /** A finite float; NaN or infinity marks the data bad. */
  f32(): number {
    if (!this.has(4)) return 0;
    const v = this.view.getFloat32(this.pos, true);
    this.pos += 4;
    if (!Number.isFinite(v)) {
      this.ok = false;
      return 0;
    }
    return v;
  }

  /** A finite double; NaN or infinity marks the data bad. */
  f64(): number {
    if (!this.has(8)) return 0;
    const v = this.view.getFloat64(this.pos, true);
    this.pos += 8;
    if (!Number.isFinite(v)) {
      this.ok = false;
      return 0;
    }
    return v;
  }

  /** A copy of `length` raw bytes. */
  fixed(length: number): Uint8Array {
    if (!this.has(length)) return new Uint8Array(length);
    const out = this.data.slice(this.pos, this.pos + length);
    this.pos += length;
    return out;
  }

  /** A copy of u16-length bytes, refused past `max`. */
  bytes(max = 0xffff): Uint8Array {
    const n = this.u16();
    if (n > max) {
      this.ok = false;
      return new Uint8Array(0);
    }
    return this.fixed(n);
  }

  str(): string {
    const n = this.u8();
    if (!this.has(n)) return '';
    const s = textDecoder.decode(this.data.subarray(this.pos, this.pos + n));
    this.pos += n;
    return s;
  }

  longStr(max = MAX_LONG_STRING): string {
    const n = this.u16();
    if (n > max) {
      this.ok = false;
      return '';
    }
    if (!this.has(n)) return '';
    const s = textDecoder.decode(this.data.subarray(this.pos, this.pos + n));
    this.pos += n;
    return s;
  }
}

/** Hex for keys and hashes. */
export function toHex(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += bytes[i].toString(16).padStart(2, '0');
  return s;
}

/** Bytes from hex, or null if it is not even-length hex. */
export function fromHex(hex: string): Uint8Array | null {
  if (hex.length % 2 || !/^[0-9a-f]*$/i.test(hex)) return null;
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/** Byte-wise comparison: negative, zero or positive, like `localeCompare`. */
export function compareBytes(a: Uint8Array, b: Uint8Array): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return a.length - b.length;
}

export function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && compareBytes(a, b) === 0;
}
