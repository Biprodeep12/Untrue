// Joining by code, both sides: a guest makes an offer, sends it through
// signaling and opens the link with the answer; a host answers offers on its
// code (through `Session.admit`), refusing those that come too fast.

import { fromHex } from './codec';
import { JoinLimiter } from './codes';
import type { Welcome } from './protocol';
import type { Session } from './session';
import { CodeHost, requestJoin, type Bus, type JoinOffer, type Signer } from './signaling';
import type { Linker } from './transport';

export interface CodeOptions {
  /** PBKDF2 rounds for the code's keys (tests use few). */
  iterations?: number;
  /** Longest wait for the host's answer, in ms. */
  timeoutMs?: number;
  /** Longest wait for the link and the host's welcome, in ms. */
  connectMs?: number;
  /** The host's key (hex), if known (a board's note): only it may answer. */
  expectHost?: string;
}

/** Join requests a host weighs at once; more wait their turn by being dropped (they post again). */
const MAX_ADMITTING = 3;

/** Guest: joins the session behind `code` (normalised). Throws `JoinError`
 *  (refused or unanswered) or `ConnectError` (the link failed or the host
 *  refused the Hello). */
export async function joinByCode(session: Session, linker: Linker, bus: Bus, code: string, who: { name: string; key: string }, options: CodeOptions = {}): Promise<Welcome> {
  const made = await linker.offer();
  try {
    const answer = await requestJoin(bus, code, { sdp: made.sdp, name: who.name, key: who.key }, options);
    await made.complete(answer);
  } catch (e) {
    made.link.close();
    throw e;
  }
  const expect = options.expectHost ? fromHex(options.expectHost) : null;
  return session.connect(made.link, { expectHost: expect && expect.length === 32 ? expect : null, timeoutMs: options.connectMs });
}

/** Host: answers join requests on `code` until the returned function is
 *  called; answers are signed by `signer` (the host's identity). Requests
 *  past the rate limit, or while a few are being weighed, are dropped without
 *  a word: answering a flood is what a flood wants. */
export async function hostByCode(session: Session, bus: Bus, code: string, options: CodeOptions & { limiter?: JoinLimiter; signer?: Signer } = {}): Promise<() => void> {
  const limiter = options.limiter ?? new JoinLimiter();
  let admitting = 0;
  const handle = async (host: CodeHost, offer: JoinOffer) => {
    // The claimed key, when there is one, so retries with fresh ids still count.
    if (admitting >= MAX_ADMITTING || !limiter.allow(offer.key || offer.from)) {
      host.drop(offer.from);
      return;
    }
    admitting++;
    try {
      const key = offer.key ? fromHex(offer.key) : null;
      const res = await session.admit(offer.sdp, offer.name, key && key.length === 32 ? key : null);
      if ('answer' in res) await host.answer(offer.from, res.answer);
      else await host.reject(offer.from, res.reject);
    } finally {
      admitting--;
    }
  };
  const host: CodeHost = await CodeHost.listen(bus, code, (offer) => void handle(host, offer).catch(() => {}), options);
  return () => host.close();
}
