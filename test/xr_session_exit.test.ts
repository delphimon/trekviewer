import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { endXRSessionAfterFrame } from '../src/core/XRSessionExit.ts';

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

it('keeps the frame usable for renderer reads after an in-frame exit request', async () => {
  let ended = false;
  const session = { end: vi.fn(async () => { ended = true; }) };
  const frame = { get detectedPlanes() {
    if (ended) throw new DOMException('XRFrame is no longer active', 'InvalidStateError');
    return new Set();
  } };
  // Three.js reads detectedPlanes after the application's animation callback.
  const exit = endXRSessionAfterFrame(session);
  expect(() => frame.detectedPlanes).not.toThrow();
  expect(session.end).not.toHaveBeenCalled();
  await vi.runAllTimersAsync();
  await exit;
  expect(session.end).toHaveBeenCalledOnce();
  expect(ended).toBe(true);
});

it('propagates a failed asynchronous session exit so the UI can handle it', async () => {
  const session = { end: vi.fn(async () => { throw Error('Runtime rejected exit'); }) };
  const exit = endXRSessionAfterFrame(session);
  const rejected = expect(exit).rejects.toThrow('Runtime rejected exit');
  await vi.runAllTimersAsync();
  await rejected;
});
