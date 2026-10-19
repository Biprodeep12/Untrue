// Proving a key on a link. Public keys are not secret (the board shows
// hosts' keys, a Welcome lists every member's), so a Hello must show its
// sender holds the key it names: the host sends a random challenge, and the
// Hello carries a Schnorr signature over that challenge, the link's binding
// (both ends' DTLS fingerprints) and the key. A signature made on one link is
// worthless on any other, so a go-between cannot pass one on.

import { schnorr } from '@noble/curves/secp256k1.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { NONCE_BYTES } from './protocol';

const enc = new TextEncoder();
const TAG = enc.encode('untrue/hello/v1');
/** The host's proof is tagged apart, so neither signature stands for the other. */
const HOST_TAG = enc.encode('untrue/host/v1');

function digest(tag: Uint8Array, nonce: Uint8Array, binding: string, key: Uint8Array): Uint8Array {
  const b = enc.encode(binding);
  const msg = new Uint8Array(tag.length + NONCE_BYTES + b.length + key.length);
  let at = 0;
  for (const part of [tag, nonce.subarray(0, NONCE_BYTES), b, key]) {
    msg.set(part, at);
    at += part.length;
  }
  return sha256(msg);
}

/** What a Hello's signature covers. */
export function helloDigest(nonce: Uint8Array, binding: string, key: Uint8Array): Uint8Array {
  return digest(TAG, nonce, binding, key);
}

/** What the host's signature in a Challenge covers: the same, tagged as the host's. */
export function hostDigest(nonce: Uint8Array, binding: string, key: Uint8Array): Uint8Array {
  return digest(HOST_TAG, nonce, binding, key);
}

export function signDigest(secret: Uint8Array, digest: Uint8Array): Uint8Array {
  return schnorr.sign(digest, secret);
}

export function verifyDigest(key: Uint8Array, digest: Uint8Array, sig: Uint8Array): boolean {
  try {
    return schnorr.verify(sig, digest, key);
  } catch {
    return false;
  }
}

export const newNonce = (): Uint8Array => crypto.getRandomValues(new Uint8Array(NONCE_BYTES));
