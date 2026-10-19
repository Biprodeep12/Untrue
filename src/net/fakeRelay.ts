// An in-memory Nostr relay for tests: keeps stored (non-ephemeral) events,
// answers subscriptions, passes new events on, and can drop every connection.

import type { Filter, NostrEvent, SocketLike } from './nostr';

/** An in-memory relay: stores (non-ephemeral) events, answers REQs, fans out. */
export class FakeRelay {
  readonly stored: NostrEvent[] = [];
  readonly sockets = new Set<FakeSocket>();
  connects = 0;

  socket(): SocketLike {
    const s = new FakeSocket(this);
    this.connects++;
    this.sockets.add(s);
    setTimeout(() => {
      s.readyState = 1;
      s.onopen?.({});
    }, 1);
    return s;
  }

  handle(from: FakeSocket, text: string): void {
    const m = JSON.parse(text) as unknown[];
    if (m[0] === 'EVENT') {
      const e = m[1] as NostrEvent;
      from.deliver(['OK', e.id, true, '']);
      if (e.kind < 20000 || e.kind >= 30000) this.stored.push(e);
      for (const s of this.sockets) for (const [id, filters] of s.subs) if (filters.some((f) => matches(f, e))) s.deliver(['EVENT', id, e]);
    } else if (m[0] === 'REQ') {
      const id = m[1] as string;
      const filters = m.slice(2) as Filter[];
      from.subs.set(id, filters);
      for (const e of this.stored) if (filters.some((f) => matches(f, e))) from.deliver(['EVENT', id, e]);
      from.deliver(['EOSE', id]);
    } else if (m[0] === 'CLOSE') from.subs.delete(m[1] as string);
  }

  /** Drops every connection, as a relay restart would. */
  restart(): void {
    for (const s of this.sockets) s.drop();
    this.sockets.clear();
  }
}

function matches(f: Filter, e: NostrEvent): boolean {
  if (f.kinds && !f.kinds.includes(e.kind)) return false;
  if (f.since && e.created_at < f.since) return false;
  const t = f['#t'];
  if (t && !e.tags.some((tag) => tag[0] === 't' && t.includes(tag[1]))) return false;
  return true;
}

class FakeSocket implements SocketLike {
  readyState = 0;
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev: unknown) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  readonly subs = new Map<string, Filter[]>();
  constructor(private readonly relay: FakeRelay) {}
  send(data: string): void {
    setTimeout(() => this.relay.handle(this, data), 1);
  }
  deliver(m: unknown[]): void {
    setTimeout(() => this.onmessage?.({ data: JSON.stringify(m) }), 1);
  }
  close(): void {
    this.drop();
  }
  drop(): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.relay.sockets.delete(this);
    this.onclose?.({});
  }
}
