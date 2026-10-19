// A link to one other peer: two channels, one reliable and ordered (ctrl),
// one unreliable and unordered (snap). `RtcTransport` is the real one, over
// RTCPeerConnection with both data channels pre-negotiated (ids 0 and 1), so
// either side can make the offer and nothing waits for a channel to be
// announced. Session descriptions are exchanged whole (no trickle): the side
// making one waits for ICE gathering first, up to a cap.
//
// A `Linker` makes links from session descriptions; the session asks it for
// offers and answers and hands the strings to signaling, or to a host that
// relays them inside an instance.

import { CTRL, MAX_CTRL_BYTES, MAX_SNAP_BYTES, SNAP, type Channel } from './protocol';

/** Why a link closed. */
export type CloseReason = 'timeout' | 'ice-failed' | 'remote-closed' | 'local-closed' | 'error';

export const CLOSE_TEXT: Record<CloseReason, string> = {
  timeout: "Couldn't connect in time. One of your networks may block peer-to-peer (common on mobile data and school or office Wi-Fi).",
  'ice-failed': "Couldn't connect directly. One of your networks blocks peer-to-peer. Try another network, or the manual code.",
  'remote-closed': 'The other player left.',
  'local-closed': 'Disconnected.',
  error: 'The connection failed.',
};

/** How the link was made: on the same machine or LAN, through a NAT, or relayed. */
export type PathType = 'host' | 'srflx' | 'prflx' | 'relay' | 'unknown';

export interface Transport {
  readonly open: boolean;
  /** Sends on a channel; false if it is not open, too big, or (snap) backed up. */
  send(channel: Channel, data: Uint8Array): boolean;
  onOpen: (() => void) | null;
  onMessage: ((channel: Channel, data: Uint8Array) => void) | null;
  /** Called once, when the link closes for any reason. */
  onClose: ((reason: CloseReason) => void) | null;
  close(): void;
  /** How the link was made, for the debug overlay. */
  pathType(): Promise<PathType>;
  /** The same string on both ends of this link and on no other link (its
   *  DTLS fingerprints): signatures made over it cannot be replayed on
   *  another link. */
  binding(): string;
}

/** Makes links from session descriptions. */
export interface Linker {
  /** A new link and its offer. Complete it with the answer. */
  offer(): Promise<{ sdp: string; link: Transport; complete(answer: string): Promise<void> }>;
  /** A new link answering an offer. */
  answer(offer: string): Promise<{ sdp: string; link: Transport }>;
}

/** Public STUN servers: they only tell a browser its own public address. */
export const STUN_SERVERS: RTCIceServer[] = [
  { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] },
  { urls: 'stun:stun.cloudflare.com:3478' },
];

export interface RtcOptions {
  iceServers?: RTCIceServer[];
  /** Longest wait for ICE gathering before sending what is known, in ms. */
  gatherMs?: number;
  /** Longest wait for the link to open, in ms. */
  connectMs?: number;
  /** Relay-only, when a TURN server is configured. */
  relayOnly?: boolean;
}

const GATHER_MS = 3000;
const CONNECT_MS = 15_000;
/** Snap messages are dropped while this much is waiting to go out. */
const SNAP_BACKLOG = 64 * 1024;
/** Ctrl messages are refused past this backlog: the peer is not keeping up. */
const CTRL_BACKLOG = 4 * 1024 * 1024;

export class RtcTransport implements Transport {
  readonly pc: RTCPeerConnection;
  private readonly ctrl: RTCDataChannel;
  private readonly snap: RTCDataChannel;
  onOpen: (() => void) | null = null;
  onMessage: ((channel: Channel, data: Uint8Array) => void) | null = null;
  onClose: ((reason: CloseReason) => void) | null = null;
  private closed = false;
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly options: RtcOptions = {}) {
    this.pc = new RTCPeerConnection({
      iceServers: options.iceServers ?? STUN_SERVERS,
      iceTransportPolicy: options.relayOnly ? 'relay' : 'all',
    });
    this.ctrl = this.pc.createDataChannel('ctrl', { negotiated: true, id: 0, ordered: true });
    this.snap = this.pc.createDataChannel('snap', { negotiated: true, id: 1, ordered: false, maxRetransmits: 0 });
    for (const [ch, id] of [
      [this.ctrl, CTRL],
      [this.snap, SNAP],
    ] as const) {
      ch.binaryType = 'arraybuffer';
      ch.onmessage = (e) => {
        if (e.data instanceof ArrayBuffer) this.onMessage?.(id, new Uint8Array(e.data));
      };
      ch.onopen = () => this.checkOpen();
      ch.onclose = () => this.finish('remote-closed');
      ch.onerror = () => this.finish('error');
    }
    this.pc.oniceconnectionstatechange = () => {
      if (this.pc.iceConnectionState === 'failed') this.finish('ice-failed');
    };
    this.pc.onconnectionstatechange = () => {
      const s = this.pc.connectionState;
      if (s === 'failed') this.finish('ice-failed');
      else if (s === 'closed') this.finish('remote-closed');
    };
    this.timer = setTimeout(() => this.finish('timeout'), options.connectMs ?? CONNECT_MS);
  }

  get open(): boolean {
    return !this.closed && this.ctrl.readyState === 'open' && this.snap.readyState === 'open';
  }

  private checkOpen(): void {
    if (!this.open) return;
    clearTimeout(this.timer);
    this.timer = undefined;
    this.onOpen?.();
  }

  send(channel: Channel, data: Uint8Array): boolean {
    if (!this.open) return false;
    const ch = channel === CTRL ? this.ctrl : this.snap;
    if (channel === SNAP ? data.length > MAX_SNAP_BYTES || ch.bufferedAmount > SNAP_BACKLOG : data.length > MAX_CTRL_BYTES || ch.bufferedAmount > CTRL_BACKLOG) return false;
    try {
      ch.send(data as Uint8Array<ArrayBuffer>);
      return true;
    } catch {
      return false;
    }
  }

  close(): void {
    this.finish('local-closed');
  }

  private finish(reason: CloseReason): void {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.timer);
    try {
      this.ctrl.close();
      this.snap.close();
      this.pc.close();
    } catch {
      // Already gone.
    }
    this.onClose?.(reason);
  }

  /** The local description once ICE gathering is complete, or after the cap. */
  async localDescription(): Promise<string> {
    const pc = this.pc;
    if (pc.iceGatheringState !== 'complete') {
      await new Promise<void>((resolve) => {
        const done = () => {
          clearTimeout(t);
          pc.removeEventListener('icegatheringstatechange', check);
          resolve();
        };
        const check = () => {
          if (pc.iceGatheringState === 'complete') done();
        };
        const t = setTimeout(done, this.options.gatherMs ?? GATHER_MS);
        pc.addEventListener('icegatheringstatechange', check);
      });
    }
    return pc.localDescription?.sdp ?? '';
  }

  binding(): string {
    const prints = (sdp: string | undefined) => (sdp?.match(/^a=fingerprint:.+$/gm) ?? []).map((l) => l.trim().toLowerCase()).join(',');
    return [prints(this.pc.localDescription?.sdp), prints(this.pc.remoteDescription?.sdp)].sort().join('|');
  }

  async pathType(): Promise<PathType> {
    try {
      const stats = await this.pc.getStats();
      let pairId: string | undefined;
      stats.forEach((s) => {
        if (s.type === 'transport' && s.selectedCandidatePairId) pairId = s.selectedCandidatePairId;
      });
      if (!pairId) {
        stats.forEach((s) => {
          if (s.type === 'candidate-pair' && s.state === 'succeeded' && s.nominated) pairId = s.id;
        });
      }
      const pair = pairId ? stats.get(pairId) : undefined;
      const local = pair ? stats.get(pair.localCandidateId) : undefined;
      const type = local?.candidateType as PathType | undefined;
      return type === 'host' || type === 'srflx' || type === 'prflx' || type === 'relay' ? type : 'unknown';
    } catch {
      return 'unknown';
    }
  }
}

/** Longest session description accepted from anyone, in characters. */
export const MAX_SDP = 16 * 1024;

export class RtcLinker implements Linker {
  constructor(private readonly options: RtcOptions = {}) {}

  async offer(): Promise<{ sdp: string; link: Transport; complete(answer: string): Promise<void> }> {
    const link = new RtcTransport(this.options);
    try {
      await link.pc.setLocalDescription(await link.pc.createOffer());
      const sdp = await link.localDescription();
      return {
        sdp,
        link,
        complete: async (answer: string) => {
          if (answer.length > MAX_SDP) throw new Error('Answer too long');
          await link.pc.setRemoteDescription({ type: 'answer', sdp: answer });
        },
      };
    } catch (e) {
      link.close();
      throw e;
    }
  }

  async answer(offer: string): Promise<{ sdp: string; link: Transport }> {
    if (offer.length > MAX_SDP) throw new Error('Offer too long');
    const link = new RtcTransport(this.options);
    try {
      await link.pc.setRemoteDescription({ type: 'offer', sdp: offer });
      await link.pc.setLocalDescription(await link.pc.createAnswer());
      return { sdp: await link.localDescription(), link };
    } catch (e) {
      link.close();
      throw e;
    }
  }
}
