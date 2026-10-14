import { it, expect, vi } from 'vitest';
import { GraphicsRecovery } from '../src/core/GraphicsRecovery.ts';

function fixture() {
  const canvas = new EventTarget();
  const callbacks = { canvas, isContextLost: vi.fn(() => false), pause: vi.fn(), prepare: vi.fn(async () => {}), resume: vi.fn(), status: vi.fn() };
  return { canvas, callbacks, recovery: new GraphicsRecovery(callbacks) };
}

it('pauses on context loss and resumes rendering after preparation without requesting playback', async () => {
  const { canvas, callbacks, recovery } = fixture();
  await recovery.recover(); expect(callbacks.resume).toHaveBeenCalledTimes(1);
  const lost = new Event('webglcontextlost', { cancelable: true }); canvas.dispatchEvent(lost);
  expect(lost.defaultPrevented).toBe(true); expect(recovery.isSuspended).toBe(true);
  expect(callbacks.pause).toHaveBeenCalledTimes(1);
  const ready = recovery.waitUntilReady();
  await recovery.recover(); await ready;
  expect(callbacks.resume).toHaveBeenCalledTimes(2); expect(recovery.isSuspended).toBe(false);
  recovery.dispose();
});

it('does not let stale initial shader preparation restart a lost context', async () => {
  const { canvas, callbacks, recovery } = fixture(); let complete!: () => void;
  callbacks.prepare.mockImplementationOnce(() => new Promise<void>(resolve => { complete = resolve; }));
  const initial = recovery.recover(); await Promise.resolve();
  canvas.dispatchEvent(new Event('webglcontextlost', { cancelable: true }));
  complete(); await initial;
  expect(callbacks.resume).not.toHaveBeenCalled(); expect(recovery.isSuspended).toBe(true);
  await recovery.recover(); expect(callbacks.resume).toHaveBeenCalledTimes(1);
  recovery.dispose();
});

it('allows retry after preparation failure and retains route waiters for successful recovery', async () => {
  const { callbacks, recovery } = fixture();
  callbacks.prepare.mockRejectedValueOnce(Error('GPU preparation failed'));
  const ready = recovery.waitUntilReady();
  await recovery.recover();
  expect(recovery.isSuspended).toBe(true); expect(callbacks.status).toHaveBeenLastCalledWith(expect.stringContaining('Try again'), true);
  await recovery.recover(); await ready; expect(recovery.isSuspended).toBe(false);
  recovery.dispose();
});

it('cancels route waiters independently and releases every waiter/listener on disposal', async () => {
  const { canvas, callbacks, recovery } = fixture(), controller = new AbortController();
  const cancelled = recovery.waitUntilReady(controller.signal);
  const rejected = expect(cancelled).rejects.toHaveProperty('name', 'AbortError'); controller.abort(); await rejected;
  const waiting = recovery.waitUntilReady(), disposed = expect(waiting).rejects.toHaveProperty('name', 'AbortError');
  recovery.dispose(); await disposed;
  canvas.dispatchEvent(new Event('webglcontextlost')); await recovery.recover();
  expect(callbacks.pause).not.toHaveBeenCalled(); expect(callbacks.resume).not.toHaveBeenCalled();
});

it('waits for the browser to restore a lost context and waits for XR shutdown before preparation', async () => {
  const { canvas, callbacks, recovery } = fixture(); await recovery.recover();
  let finishPause!: () => void;
  callbacks.pause.mockReturnValue(new Promise<void>(resolve => { finishPause = resolve; }));
  canvas.dispatchEvent(new Event('webglcontextlost'));
  callbacks.isContextLost.mockReturnValue(true); await recovery.recover(); expect(callbacks.prepare).toHaveBeenCalledTimes(1);
  callbacks.isContextLost.mockReturnValue(false); const restoring = recovery.recover();
  await Promise.resolve(); expect(callbacks.prepare).toHaveBeenCalledTimes(1);
  finishPause(); await restoring; expect(callbacks.prepare).toHaveBeenCalledTimes(2);
  recovery.dispose();
});
