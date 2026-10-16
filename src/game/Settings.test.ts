import { describe, expect, it } from 'vitest';
import { sanitize } from './Settings';

describe('stored settings', () => {
  it('keep what is valid and drop what is damaged', () => {
    const v = sanitize({ music: 0.5, sfx: 'loud', uiScale: NaN, fps30: true, keys: { up: 'KeyI', jump: 'KeyX', down: 7 } });
    expect(v.music).toBe(0.5);
    expect(v.sfx).toBe(0.6);
    expect(v.uiScale).toBe(1);
    expect(v.fps30).toBe(true);
    expect(v.keys).toEqual({ up: 'KeyI' });
  });

  it('fall back to the defaults for anything but an object', () => {
    expect(sanitize(null).keys).toEqual({});
    expect(sanitize({ keys: null }).keys).toEqual({});
    expect(sanitize(42).music).toBe(0.35);
  });
});
