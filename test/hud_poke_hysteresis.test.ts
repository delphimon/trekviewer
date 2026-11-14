import { expect, it } from 'vitest';
import { isHUDPokePressing } from '../src/core/XRManager.ts';

/** Drives the poke rule like the per-frame hand loop and counts presses. */
function presses(depthsMm: number[], frameMs = 11, startPrevMm = 30): number {
  let prev: number | null = startPrevMm / 1000, pressing = false, releasedAt = -Infinity, count = 0;
  depthsMm.forEach((mm, frame) => {
    const z = mm / 1000, now = frame * frameMs;
    const next = isHUDPokePressing(z, prev, pressing, now - releasedAt);
    if (next && !pressing) count++;
    if (!next && pressing) releasedAt = now;
    pressing = next; prev = z;
  });
  return count;
}

it('fires one press for a fingertip jittering around the press depth', () => {
  expect(presses([11, 13, 11, 13])).toBe(1);
});

it('releases past 20 mm and ignores a re-press within 150 ms', () => {
  expect(presses([11, 25, 11])).toBe(1); // backed out and straight back in: suppressed
  expect(presses([11, 25, ...Array(14).fill(25), 11])).toBe(2); // 165 ms later: a new press
});

it('needs the fingertip to arrive from in front of the panel', () => {
  expect(presses([5, 5, 5], 11, 5)).toBe(0);
  expect(presses([-40, 5])).toBe(0);
});
