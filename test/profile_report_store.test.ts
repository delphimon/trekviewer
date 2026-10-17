import { afterEach, expect, it, vi } from 'vitest';
import { loadLastProfileReport, profileDownloadFilename } from '../src/core/ProfileReportStore.ts';
import type { ProfileReport } from '../src/core/PerformanceSessionRecorder.ts';

afterEach(() => vi.unstubAllGlobals());

it('keeps the recorded build and completion time in a filesystem-safe download name', () => {
  const report = { buildId: 'previous/build:123', endedAt: '2026-10-16T01:02:03.000Z' } as ProfileReport;
  const filename = profileDownloadFilename(report);
  expect(filename).toContain('previous_build_123');
  expect(filename).toContain('2026-10-16T01_02_03.000Z');
  expect(filename).not.toMatch(/[/:\\]/);
});

it('allows profiling when local database access is unavailable or denied', async () => {
  vi.stubGlobal('indexedDB', undefined);
  await expect(loadLastProfileReport()).resolves.toBeNull();
  vi.stubGlobal('indexedDB', { open: () => { throw new DOMException('Storage denied', 'SecurityError'); } });
  await expect(loadLastProfileReport()).resolves.toBeNull();
});
