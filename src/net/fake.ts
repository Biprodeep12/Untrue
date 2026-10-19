// In-memory links for tests: pairs of transports joined by timers, with
// configurable latency, jitter (which reorders the snap channel) and loss
// (snap only; ctrl stays reliable and ordered, as on a real data channel).
// `FakeSwitch` hands out linkers whose offers and answers are tokens, and can
// drop every link of one peer at once, as when a tab is closed.

import { CTRL, SNAP, type Channel } from './protocol';
import type { CloseReason, Linker, PathType, Transport } from './transport';

export interface FakeLinkOptions {
  /** One-way delay, in ms. */
  latency?: number;
  /** Extra random delay up to this, in ms. */
  jitter?: number;
  /** Share of snap messages lost, 0 to 1. */
  loss?: number;
  /** Delay before a completed link opens, in ms. */
  openDelay?: number;
  random?: () => number;
}

export class FakeTransport implements Transport {
  peer!: FakeTransport;
  open = false;
  private closed = false;
  onOpen: (() => void) | null = null;
  onMessage: ((channel: Channel, data: Uint8Array) => void) | null = null;
  onClose: ((reason: CloseReason) => void) | null = null;
  private lastCtrlAt = 0;
  /** Messages sent, per channel, for tests that count traffic. */
  readonly sent = [0, 0];

  constructor(
    private readonly opts: Required<FakeLinkOptions>,
    public owner: string,
    private readonly pairId: number,
  ) {}

  binding(): string {
    return `fake-${this.pairId}`;
  }

  /** Opens both ends after the open delay. */
  connect(): void {
    setTimeout(() => {
      if (this.closed || this.peer.closed) return;
      this.open = this.peer.open = true;
      this.onOpen?.();
      this.peer.onOpen?.();
    }, this.opts.openDelay);
  }

  send(channel: Channel, data: Uint8Array): boolean {
    if (!this.open) return false;
    this.sent[channel]++;
    const { latency, jitter, loss, random } = this.opts;
    if (channel === SNAP && random() < loss) return true;
    const copy = data.slice();
    const now = Date.now();
    let at = now + latency + jitter * random();
    if (channel === CTRL) {
      at = Math.max(at, this.lastCtrlAt);
      this.lastCtrlAt = at;
    }
    const peer = this.peer;
    setTimeout(() => {
      if (peer.open && !peer.closed) peer.onMessage?.(channel, copy);
    }, at - now);
    return true;
  }

  close(): void {
    this.end('local-closed', 'remote-closed');
  }

  /** The link breaks without either side closing it (a tab dies, a network drops). */
  cut(): void {
    this.end('ice-failed', 'ice-failed');
  }

  private end(mine: CloseReason, theirs: CloseReason): void {
    if (this.closed) return;
    this.closed = true;
    this.open = false;
    this.onClose?.(mine);
    const peer = this.peer;
    setTimeout(() => {
      if (peer.closed) return;
      peer.closed = true;
      peer.open = false;
      peer.onClose?.(theirs);
    }, this.opts.latency);
  }

  async pathType(): Promise<PathType> {
    return 'host';
  }
}

const defaults = (o: FakeLinkOptions): Required<FakeLinkOptions> => ({
  latency: o.latency ?? 20,
  jitter: o.jitter ?? 0,
  loss: o.loss ?? 0,
  openDelay: o.openDelay ?? 30,
  random: o.random ?? Math.random,
});

let pairs = 0;

/** Two ends of one link, not yet open (call `connect`). */
export function fakePair(options: FakeLinkOptions = {}, owners: [string, string] = ['a', 'b']): [FakeTransport, FakeTransport] {
  const opts = defaults(options);
  const id = ++pairs;
  const a = new FakeTransport(opts, owners[0], id);
  const b = new FakeTransport(opts, owners[1], id);
  a.peer = b;
  b.peer = a;
  return [a, b];
}

/** Hands out linkers for named peers, all on one in-memory network. */
export class FakeSwitch {
  private seq = 0;
  private readonly offers = new Map<string, FakeTransport>();
  readonly links: FakeTransport[] = [];

  constructor(private readonly options: FakeLinkOptions = {}) {}

  linker(owner: string): Linker {
    return {
      offer: async () => {
        const n = ++this.seq;
        const [mine, theirs] = fakePair(this.options, [owner, '?']);
        this.links.push(mine);
        const sdp = `fake-offer-${n}`;
        this.offers.set(sdp, theirs);
        return {
          sdp,
          link: mine,
          complete: async (answer: string) => {
            if (answer !== `fake-answer-${n}`) throw new Error('Wrong answer');
            mine.connect();
          },
        };
      },
      answer: async (offer: string) => {
        const theirs = this.offers.get(offer);
        if (!theirs) throw new Error('Unknown offer');
        this.offers.delete(offer);
        theirs.owner = owner;
        this.links.push(theirs);
        return { sdp: offer.replace('offer', 'answer'), link: theirs };
      },
    };
  }

  /** Breaks every link of one peer, as if its tab died. */
  drop(owner: string): void {
    // A copy: closing may start new links (a rejoin) that must not be cut.
    for (const t of [...this.links]) if (t.owner === owner) t.cut();
  }
}
