import { expect, it } from 'vitest';
import { isInstalledApp } from '../src/core/InstalledApp.ts';

const withModes = (modes: string[]) => ({ matchMedia: (q: string) => ({ matches: modes.some(m => q.includes(m)) }) }) as unknown as Window;

it('treats only the standalone or fullscreen display modes as the installed app', () => {
  expect(isInstalledApp(withModes(['standalone']))).toBe(true);
  expect(isInstalledApp(withModes(['fullscreen']))).toBe(true);
  // An ordinary Quest Browser tab: "browser" display mode, even though PWA-only APIs exist there.
  expect(isInstalledApp(withModes(['browser']))).toBe(false);
});

it('fails closed when matchMedia is missing or throws', () => {
  expect(isInstalledApp({} as Window)).toBe(false);
  expect(isInstalledApp({ matchMedia: () => { throw new Error('no'); } } as unknown as Window)).toBe(false);
});
