// Small cryptographic helpers over WebCrypto: keys derived from a join code,
// sealing and opening payloads, hashing, base64url and raw deflate.
//
// A join code has only 40 bits, so its derived values are stretched with
// PBKDF2 first: guessing codes against a topic seen on a relay then costs
// 100 000 hashes per guess. HKDF then splits the stretched secret into a
// topic (published, so relays can route) and an AES-GCM key (never published).

const enc = new TextEncoder();
const SALT = enc.encode('untrue/signal/v1');
export const PBKDF2_ITERATIONS = 100_000;

export interface CodeKeys {
  /** Hex, safe to publish: where messages for this code are posted. */
  topic: string;
  /** Seals and opens messages for this code. */
  key: CryptoKey;
}

export async function deriveCodeKeys(code: string, iterations = PBKDF2_ITERATIONS): Promise<CodeKeys> {
  const subtle = crypto.subtle;
  const base = await subtle.importKey('raw', enc.encode(code), 'PBKDF2', false, ['deriveBits']);
  const stretched = await subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: SALT, iterations }, base, 256);
  const hkdf = await subtle.importKey('raw', stretched, 'HKDF', false, ['deriveBits', 'deriveKey']);
  const topicBits = await subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: SALT, info: enc.encode('topic') }, hkdf, 256);
  const key = await subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: SALT, info: enc.encode('key') }, hkdf, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  return { topic: hex(new Uint8Array(topicBits)), key };
}

/** IV (12 bytes) followed by the ciphertext and its tag. */
export async function seal(key: CryptoKey, plain: Uint8Array): Promise<Uint8Array> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plain as Uint8Array<ArrayBuffer>));
  const out = new Uint8Array(12 + ct.length);
  out.set(iv);
  out.set(ct, 12);
  return out;
}

/** The plaintext, or null if it was not sealed with this key or was altered. */
export async function open(key: CryptoKey, sealed: Uint8Array): Promise<Uint8Array | null> {
  if (sealed.length < 12 + 16) return null;
  try {
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: sealed.subarray(0, 12) as Uint8Array<ArrayBuffer> }, key, sealed.subarray(12) as Uint8Array<ArrayBuffer>);
    return new Uint8Array(plain);
  } catch {
    return null;
  }
}

export async function sha256(data: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', data as Uint8Array<ArrayBuffer>));
}

function hex(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += b.toString(16).padStart(2, '0');
  return s;
}

const B64URL = /^[A-Za-z0-9_-]*$/;

export function toBase64Url(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Bytes from base64url, or null if it is not base64url. */
export function fromBase64Url(text: string): Uint8Array | null {
  if (!B64URL.test(text) || text.length % 4 === 1) return null;
  try {
    const bin = atob(text.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (text.length % 4)) % 4));
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

async function pipe(data: Uint8Array, stream: TransformStream<Uint8Array, Uint8Array>, max: number): Promise<Uint8Array | null> {
  const writer = stream.writable.getWriter();
  // Errors surface on the reading side; the write side is only drained.
  writer.write(data).catch(() => {});
  writer.close().catch(() => {});
  const reader = stream.readable.getReader();
  const parts: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      // Refuse anything that inflates past the limit (a compression bomb).
      if (size > max) {
        reader.cancel().catch(() => {});
        return null;
      }
      parts.push(value);
    }
  } catch {
    return null;
  }
  const out = new Uint8Array(size);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

export async function deflateRaw(data: Uint8Array): Promise<Uint8Array> {
  return (await pipe(data, new CompressionStream('deflate-raw') as unknown as TransformStream<Uint8Array, Uint8Array>, Infinity))!;
}

/** Inflated bytes, or null if they are not raw deflate or exceed `max` bytes. */
export async function inflateRaw(data: Uint8Array, max: number): Promise<Uint8Array | null> {
  return pipe(data, new DecompressionStream('deflate-raw') as unknown as TransformStream<Uint8Array, Uint8Array>, max);
}
