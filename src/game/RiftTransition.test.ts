import { describe, expect, it } from 'vitest';
import { passageTiming, RiftTransition, type RiftPassage } from './RiftTransition';

function make() {
  const calls: string[] = [];
  const tr = new RiftTransition({
    switch: (k) => calls.push(`switch:${k}`),
    collapse: (k) => calls.push(`collapse:${k}`),
    done: (k) => calls.push(`done:${k}`),
  });
  return { tr, calls };
}

/** Runs a passage at 60 frames a second, recording when each hook fired. */
function run(kind: RiftPassage, reduced = false, dt = 1 / 60) {
  const { tr, calls } = make();
  expect(tr.start(kind, reduced)).toBe(true);
  let t = 0;
  const at: Record<string, number> = {};
  let frames = 0;
  while (tr.active && frames++ < 1000) {
    const before = calls.length;
    tr.update(dt);
    t += dt;
    for (const c of calls.slice(before)) at[c] = t;
  }
  return { tr, calls, at, t };
}

describe('passages through rifts', () => {
  it('switches once, under cover, then finishes', () => {
    const { calls, at, t } = run('enter');
    expect(calls).toEqual(['switch:enter', 'done:enter']);
    const timing = passageTiming('enter', false);
    expect(at['switch:enter']).toBeCloseTo(timing.pull, 1);
    expect(t).toBeCloseTo(timing.pull + timing.reveal, 1);
    // A short beat, not a wait.
    expect(t).toBeGreaterThan(1);
    expect(t).toBeLessThan(1.6);
  });

  it('reports its progress through each phase', () => {
    const { tr } = make();
    tr.start('leave', false);
    expect(tr.active).toBe(true);
    tr.update(0.3);
    expect(tr.pull).toBeCloseTo(0.5);
    expect(tr.past).toBe(false);
    expect(tr.reveal).toBe(0);
    tr.update(0.6);
    expect(tr.past).toBe(true);
    expect(tr.pull).toBe(1);
    expect(tr.reveal).toBeCloseTo(0.5);
  });

  it('closing collapses the tear after the reveal', () => {
    const { calls, at } = run('close');
    expect(calls).toEqual(['switch:close', 'collapse:close', 'done:close']);
    const timing = passageTiming('close', false);
    expect(at['collapse:close']).toBeCloseTo(timing.pull + timing.reveal, 1);
  });

  it('fires every hook in order even on one long frame', () => {
    const { tr, calls } = make();
    tr.start('close', false);
    tr.update(10);
    expect(calls).toEqual(['switch:close', 'collapse:close', 'done:close']);
    expect(tr.active).toBe(false);
    tr.update(1);
    expect(calls.length).toBe(3);
  });

  it('will not start a second passage while one runs', () => {
    const { tr, calls } = make();
    expect(tr.start('enter', false)).toBe(true);
    expect(tr.start('eject', false)).toBe(false);
    tr.update(5);
    expect(calls).toEqual(['switch:enter', 'done:enter']);
    // Over: another may begin.
    expect(tr.start('leave', false)).toBe(true);
  });

  it('is shorter with reduced motion', () => {
    for (const kind of ['enter', 'leave', 'close', 'eject'] as const) {
      expect(run(kind, true).t).toBeLessThan(run(kind, false).t);
      expect(run(kind, true).t).toBeLessThanOrEqual(0.85);
    }
  });

  it('does nothing when idle', () => {
    const { tr, calls } = make();
    tr.update(1);
    expect(tr.active).toBe(false);
    expect(calls).toEqual([]);
  });

  it('finishes at once when the page is left, firing every hook left in order', () => {
    const { tr, calls } = make();
    tr.start('close', false);
    tr.update(0.1);
    tr.finish();
    expect(tr.active).toBe(false);
    expect(calls).toEqual(['switch:close', 'collapse:close', 'done:close']);
    tr.finish();
    expect(calls).toHaveLength(3);
  });
});
