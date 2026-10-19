// Join codes: eight characters of Crockford base32 (40 bits), shown as
// XXXX-XXXX. Typing is forgiving: case, spaces and dashes are ignored, and
// O, I and L read as 0, 1 and 1. A host also limits how fast joins are tried.

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
export const CODE_LENGTH = 8;

/** A fresh random code, normalised (no dash). */
export function newCode(random: (bytes: Uint8Array<ArrayBuffer>) => Uint8Array = (b) => crypto.getRandomValues(b)): string {
  const bytes = random(new Uint8Array(5));
  // 40 bits, 5 at a time.
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += ALPHABET[(value >> bits) & 31];
    }
    value &= (1 << bits) - 1;
  }
  return out;
}

/** The code as typed, made canonical; null if it cannot be a code. */
export function normalizeCode(typed: string): string | null {
  let out = '';
  for (const raw of typed.toUpperCase()) {
    if (raw === '-' || raw === ' ' || raw === '\t') continue;
    const c = raw === 'O' ? '0' : raw === 'I' || raw === 'L' ? '1' : raw;
    if (!ALPHABET.includes(c)) return null;
    out += c;
    if (out.length > CODE_LENGTH) return null;
  }
  return out.length === CODE_LENGTH ? out : null;
}

/** XXXX-XXXX, for showing. */
export function formatCode(code: string): string {
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}

/** How fast join attempts may come: overall, and from any one sender. */
export interface JoinLimits {
  /** Attempts allowed per window, from everyone together. */
  total: number;
  /** Attempts allowed per window from one sender. */
  perSender: number;
  windowMs: number;
}

export const DEFAULT_JOIN_LIMITS: JoinLimits = { total: 8, perSender: 3, windowMs: 30_000 };

/** Counts join attempts in a sliding window; refuses past the limits. */
export class JoinLimiter {
  private readonly all: number[] = [];
  private readonly bySender = new Map<string, number[]>();

  constructor(
    private readonly limits: JoinLimits = DEFAULT_JOIN_LIMITS,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /** Records an attempt from `sender`; false if it is over the limit (and not recorded). */
  allow(sender: string): boolean {
    const t = this.now();
    const since = t - this.limits.windowMs;
    prune(this.all, since);
    let mine = this.bySender.get(sender);
    if (mine) prune(mine, since);
    if (this.all.length >= this.limits.total || (mine && mine.length >= this.limits.perSender)) return false;
    this.all.push(t);
    if (!mine) this.bySender.set(sender, (mine = []));
    mine.push(t);
    // Forget quiet senders, so the map cannot grow without end.
    if (this.bySender.size > 256) {
      for (const [k, v] of this.bySender) {
        prune(v, since);
        if (!v.length) this.bySender.delete(k);
      }
    }
    return true;
  }
}

function prune(times: number[], since: number): void {
  let n = 0;
  while (n < times.length && times[n] <= since) n++;
  if (n) times.splice(0, n);
}
