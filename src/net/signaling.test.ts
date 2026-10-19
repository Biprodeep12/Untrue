import { describe, expect, it } from 'vitest';
import { formatCode, JoinLimiter, newCode, normalizeCode } from './codes';
import { deriveCodeKeys, deflateRaw, fromBase64Url, inflateRaw, open, seal, toBase64Url } from './crypto';
import { RejectReason } from './protocol';
import { BroadcastBus, CodeHost, JoinError, manualCode, MemoryHub, readManualCode, requestJoin } from './signaling';

const FAST = { iterations: 10 };

describe('join codes', () => {
  it('makes eight characters of Crockford base32', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) {
      const c = newCode();
      expect(c).toMatch(/^[0-9A-HJKMNP-TV-Z]{8}$/);
      seen.add(c);
    }
    expect(seen.size).toBe(200);
    expect(formatCode('K7QF2M9A')).toBe('K7QF-2M9A');
  });

  it('reads codes as people type them', () => {
    expect(normalizeCode('k7qf-2m9a')).toBe('K7QF2M9A');
    expect(normalizeCode(' K7QF 2M9A ')).toBe('K7QF2M9A');
    expect(normalizeCode('O1IL-0000')).toBe('01110000');
    expect(normalizeCode('K7QF-2M9')).toBeNull();
    expect(normalizeCode('K7QF-2M9AA')).toBeNull();
    expect(normalizeCode('K7QF-2M9U')).toBeNull();
  });

  it('limits join attempts, overall and per sender', () => {
    let now = 0;
    const lim = new JoinLimiter({ total: 4, perSender: 2, windowMs: 1000 }, () => now);
    expect([lim.allow('a'), lim.allow('a'), lim.allow('a')]).toEqual([true, true, false]);
    expect([lim.allow('b'), lim.allow('c'), lim.allow('d')]).toEqual([true, true, false]);
    now = 1001;
    expect(lim.allow('a')).toBe(true);
  });
});

describe('crypto', () => {
  it('derives the same keys from the same code, other keys from another', async () => {
    const a = await deriveCodeKeys('K7QF2M9A', 10);
    const b = await deriveCodeKeys('K7QF2M9A', 10);
    const c = await deriveCodeKeys('K7QF2M9B', 10);
    expect(a.topic).toBe(b.topic);
    expect(a.topic).not.toBe(c.topic);
    expect(a.topic).not.toContain('K7QF');
    const sealed = await seal(a.key, new Uint8Array([1, 2, 3]));
    expect([...(await open(b.key, sealed))!]).toEqual([1, 2, 3]);
    expect(await open(c.key, sealed)).toBeNull();
    sealed[sealed.length - 1] ^= 1;
    expect(await open(a.key, sealed)).toBeNull();
  });

  it('round-trips base64url and raw deflate, and refuses bombs', async () => {
    const data = new Uint8Array(5000).map((_, i) => i % 7);
    expect([...fromBase64Url(toBase64Url(data))!]).toEqual([...data]);
    expect(fromBase64Url('a+b')).toBeNull();
    const packed = await deflateRaw(data);
    expect(packed.length).toBeLessThan(200);
    expect([...(await inflateRaw(packed, 5000))!]).toEqual([...data]);
    expect(await inflateRaw(packed, 4999)).toBeNull();
    expect(await inflateRaw(new Uint8Array([255, 255, 255]), 100)).toBeNull();
  });
});

describe('joining by code', () => {
  it('carries an offer to the host and its answer back, sealed', async () => {
    const hub = new MemoryHub();
    const offers: string[] = [];
    const host = await CodeHost.listen(hub.bus(), 'K7QF2M9A', (o) => {
      offers.push(o.name);
      void host.answer(o.from, `answer to ${o.sdp}`);
    }, FAST);
    const answer = await requestJoin(hub.bus(), 'K7QF2M9A', { sdp: 'v=0 offer', name: 'Ana', key: 'a'.repeat(64) }, FAST);
    expect(answer).toBe('answer to v=0 offer');
    expect(offers).toEqual(['Ana']);
    // The bus saw neither the code nor the descriptions.
    for (const { topic, payload } of hub.log) {
      expect(topic + payload).not.toContain('K7QF');
      expect(payload).not.toContain('offer');
    }
    host.close();
  });

  it('passes on refusals, and times out on a wrong code', async () => {
    const hub = new MemoryHub();
    const host = await CodeHost.listen(hub.bus(), 'AAAAAAAA', (o) => void host.reject(o.from, RejectReason.Full), FAST);
    await expect(requestJoin(hub.bus(), 'AAAAAAAA', { sdp: 'x', name: 'B', key: '' }, FAST)).rejects.toMatchObject({ reason: RejectReason.Full });
    const wrong = requestJoin(hub.bus(), 'BBBBBBBB', { sdp: 'x', name: 'B', key: '' }, { ...FAST, timeoutMs: 300 });
    await expect(wrong).rejects.toBeInstanceOf(JoinError);
    await expect(wrong).rejects.toMatchObject({ reason: 'no-answer' });
    host.close();
  });

  it('answers a repeated offer once, and ignores stale messages', async () => {
    const hub = new MemoryHub();
    let offers = 0;
    let now = 1_000_000;
    const host = await CodeHost.listen(hub.bus(), 'CCCCCCCC', (o) => {
      offers++;
      void host.answer(o.from, 'ok');
    }, { ...FAST, now: () => now });
    // An offer sent "three minutes ago" (its clock behind the host's).
    const late = requestJoin(hub.bus(), 'CCCCCCCC', { sdp: 'x', name: 'Old', key: '' }, { ...FAST, timeoutMs: 400, now: () => now - 180_000 });
    await expect(late).rejects.toMatchObject({ reason: 'no-answer' });
    expect(offers).toBe(0);
    now = Date.now();
    await expect(requestJoin(hub.bus(), 'CCCCCCCC', { sdp: 'x', name: 'New', key: '' }, FAST)).resolves.toBe('ok');
    expect(offers).toBe(1);
    host.close();
  });

  it('works across BroadcastChannel buses (two tabs)', async () => {
    const a = new BroadcastBus();
    const b = new BroadcastBus();
    const host = await CodeHost.listen(a, 'DDDDDDDD', (o) => void host.answer(o.from, 'hi'), FAST);
    await expect(requestJoin(b, 'DDDDDDDD', { sdp: 'x', name: 'T', key: '' }, FAST)).resolves.toBe('hi');
    host.close();
    a.close();
    b.close();
  });
});

describe('manual codes', () => {
  it('pack a session description and read it back', async () => {
    const sdp = 'v=0\r\no=- 123 2 IN IP4 127.0.0.1\r\n' + 'a=candidate:1 1 udp 2122260223 192.168.1.2 54321 typ host\r\n'.repeat(4);
    const code = await manualCode('invite', sdp);
    expect(code.startsWith('UNTRUE1I.')).toBe(true);
    expect(code.length).toBeLessThan(sdp.length);
    expect(await readManualCode('invite', code)).toBe(sdp);
    expect(await readManualCode('reply', code)).toBeNull();
    expect(await readManualCode('invite', 'UNTRUE1I.!!!')).toBeNull();
  });
});
