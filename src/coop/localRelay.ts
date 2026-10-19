// A relay for testing on one machine (?net=local): the tabs of this browser
// share the board of open instances over a BroadcastChannel, as public Nostr
// relays share it between strangers. Each tab keeps the notes it has heard
// and, when asked, repeats them to a tab that has just opened, so a new tab
// sees instances posted before it was there. Join codes travel by the
// network's own BroadcastChannel signaling.

import type { Filter, NostrEvent, SocketFactory, SocketLike } from '../net/nostr';

const CHANNEL = 'untrue-local-relay';
/** Notes kept per tab. */
const MAX_STORED = 200;
/** How long a new subscription waits for other tabs to repeat their notes. */
const SYNC_MS = 150;

type Wire = { t: 'event'; e: NostrEvent } | { t: 'sync' };

class LocalRelay {
  private readonly stored: NostrEvent[] = [];
  readonly sockets = new Set<LocalSocket>();
  private readonly channel: BroadcastChannel | null;

  constructor() {
    this.channel = typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel(CHANNEL);
    if (this.channel) this.channel.onmessage = (m: MessageEvent<Wire>) => this.heard(m.data);
  }

  private heard(m: Wire): void {
    if (m?.t === 'event' && m.e && typeof m.e.id === 'string') this.take(m.e);
    else if (m?.t === 'sync') for (const e of this.stored) this.channel?.postMessage({ t: 'event', e } satisfies Wire);
  }

  /** Keeps a note (a newer one replaces its instance's last), and passes it on to subscribers here. */
  private take(e: NostrEvent): void {
    if (this.stored.some((s) => s.id === e.id)) return;
    if (e.kind < 20000 || e.kind >= 30000) {
      const d = e.tags.find((t) => t[0] === 'd')?.[1];
      const old = d === undefined ? -1 : this.stored.findIndex((s) => s.kind === e.kind && s.pubkey === e.pubkey && s.tags.some((t) => t[0] === 'd' && t[1] === d));
      if (old >= 0) this.stored.splice(old, 1);
      this.stored.push(e);
      if (this.stored.length > MAX_STORED) this.stored.shift();
    }
    for (const s of this.sockets) s.offer(e);
  }

  handle(from: LocalSocket, text: string): void {
    let m: unknown[];
    try {
      m = JSON.parse(text) as unknown[];
    } catch {
      return;
    }
    if (m[0] === 'EVENT') {
      const e = m[1] as NostrEvent;
      from.deliver(['OK', e.id, true, '']);
      this.take(e);
      this.channel?.postMessage({ t: 'event', e } satisfies Wire);
    } else if (m[0] === 'REQ') {
      const id = m[1] as string;
      const filters = m.slice(2) as Filter[];
      from.subs.set(id, filters);
      for (const e of this.stored) if (filters.some((f) => matches(f, e))) from.deliver(['EVENT', id, e]);
      // Other tabs repeat what they hold; then the subscription has all there is.
      this.channel?.postMessage({ t: 'sync' } satisfies Wire);
      setTimeout(() => from.deliver(['EOSE', id]), SYNC_MS);
    } else if (m[0] === 'CLOSE') from.subs.delete(m[1] as string);
  }
}

function matches(f: Filter, e: NostrEvent): boolean {
  if (f.kinds && !f.kinds.includes(e.kind)) return false;
  if (f.since && e.created_at < f.since) return false;
  const t = f['#t'];
  if (t && !e.tags.some((tag) => tag[0] === 't' && t.includes(tag[1]))) return false;
  return true;
}

class LocalSocket implements SocketLike {
  readyState = 0;
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev: unknown) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  readonly subs = new Map<string, Filter[]>();

  constructor(private readonly relay: LocalRelay) {
    setTimeout(() => {
      this.readyState = 1;
      this.onopen?.({});
    }, 0);
  }

  send(data: string): void {
    setTimeout(() => this.relay.handle(this, data), 0);
  }

  offer(e: NostrEvent): void {
    for (const [id, filters] of this.subs) if (filters.some((f) => matches(f, e))) this.deliver(['EVENT', id, e]);
  }

  deliver(m: unknown[]): void {
    if (this.readyState !== 1) return;
    setTimeout(() => this.onmessage?.({ data: JSON.stringify(m) }), 0);
  }

  close(): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.relay.sockets.delete(this);
    this.onclose?.({});
  }
}

let relay: LocalRelay | null = null;

/** Sockets onto this browser's shared relay, for `Net`'s `socket` option. */
export const localRelay: SocketFactory = () => {
  relay ??= new LocalRelay();
  const s = new LocalSocket(relay);
  relay.sockets.add(s);
  return s;
};

/** The relay list to pair with `localRelay`. */
export const LOCAL_RELAYS = ['local://tabs'];
