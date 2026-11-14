import { expect, it } from 'vitest';
import { desktopShortcut } from '../src/ui/DesktopOverlay.ts';

const key = (k: string, extra: Partial<KeyboardEvent> = {}, tagName = 'BODY') =>
  desktopShortcut({ key: k, shiftKey: false, ctrlKey: false, metaKey: false, altKey: false, target: { tagName } as unknown as EventTarget, ...extra });

it('maps Space, arrows, F and 1/2/3', () => {
  expect(key(' ')).toEqual({ type: 'play' });
  expect(key('ArrowRight')).toEqual({ type: 'scrub', delta: 0.01 });
  expect(key('ArrowLeft', { shiftKey: true })).toEqual({ type: 'scrub', delta: -0.05 });
  expect(key('f')).toEqual({ type: 'fit' });
  expect(key('3')).toEqual({ type: 'style', style: 'topo' });
  expect(key('x')).toBeNull();
});

it('ignores keys while typing in a field or with a modifier held', () => {
  for (const tag of ['INPUT', 'SELECT', 'TEXTAREA']) expect(key(' ', {}, tag)).toBeNull();
  expect(key('f', { metaKey: true })).toBeNull();
  expect(key('1', { ctrlKey: true })).toBeNull();
});
