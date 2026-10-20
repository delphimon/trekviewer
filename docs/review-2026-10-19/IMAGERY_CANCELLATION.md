# Prioritize current-view imagery and cancel abandoned transfers

The failed [native tabletop baseline](NATIVE_TABLETOP.md) makes imagery loading and fidelity restoration the immediate priority. This checkpoint corrects two request-lifecycle problems; it does not establish that native performance, time-to-sharp or DEM appearance has recovered.

## Change

Previously, obsolete requests with a loaded sibling or a nearby old focus could retain scheduler slots even when the resident cache was full. Their eventual results could not be admitted. Current-view requests waited behind that work. Reconciliation now reserves admission for missing selected tiles before retaining speculative downloads. Useful warm work still finishes when there is room, and published imagery retains its existing visibility/eviction protections.

The image cache previously detached a cancelled consumer while leaving its network request running. Simply releasing scheduler slots would therefore permit old downloads to continue behind new ones. Tile downloads and shared source rasters now each track live consumers: cancellation of the last consumer aborts the underlying image/fetch operation. Other consumers, including callers without an abort signal, retain their shared download. Immediate retries own a new entry, and stale completions cannot remove it or refill a cleared cache.

Intentional cancellation does not try mirrors, register a source outage or add a failed-tile cooldown. Cancelling a decode of valid persisted bytes retains those bytes. Existing source selection, High coverage, source pixels, mesh spacing and resource limits remain unchanged.

## Evidence

`npm run verify`: **652 tests passed, five platform-specific skips**, source/test type checks and production build passed. Regressions cover full-cache preemption, admission reserved for selected tiles, spare-capacity warm retention, shared tile/raster consumers, exact crop pixels, immediate retry, late success/failure after clearing, cancellation versus failover, and persisted-byte retention.

The [browser fixture](imagery-cancellation-browser.mjs) bundles the real cache modules separately and serves controlled delayed images from a local HTTP server. It tests both `Image` downloads and the persisted fetch/shared-raster path. For the latter, a reviewed service URL is redirected to the local fixture; no live imagery service is contacted. This is an isolated transport integration test, separate from the production app's desktop/mobile browser regressions.

| Identical controlled fixture | Previous cache at `c9336fa` | Corrected cache |
| --- | --- | --- |
| Cancel the first of two consumers | Connection retained | Connection retained |
| Cancel the last consumer | Old response still completes after its six-second delay | Physical connection closes before any delayed response |
| Abandoned transfer remains in cache accounting | Yes, until completion | No |
| Remaining/current image pixels | Preserved | Preserved, including exact shared-raster crop pixel `[18,52,86,255]` |
| JavaScript exceptions | None | None |

[Previous-cache result](imagery-cancellation/baseline.json), [corrected-cache result](imagery-cancellation/browser.json). The observed local connection-close times and current-image completion times are fixture timings, **not a headset or live-service speedup benchmark**. Direct cache calls in this fixture do not exercise scheduler contention; the full-cache scheduler regression does.

Reproduce the corrected transport check with `node docs/review-2026-10-19/imagery-cancellation-browser.mjs`. Set `TREK_CANCEL_BASELINE=1` and a separate `TREK_CANCEL_OUT` directory to substitute only the previous cache implementation in the same fixture. Playwright and Edge paths can be overridden using the environment variables documented in the script.

The production desktop/mobile driver also passes tour playback, pause/scrub, shared landmarks, spatial controls, camera clearance, GPX import recovery, hidden-HUD upload suppression and viewport overflow checks, with no page exceptions. External terrain/imagery are deliberately blocked in that driver; it verifies behavior rather than visual source quality. Clean hosted-build verification follows publication.

## Remaining acceptance

The last measured native app remains `9cc6afa`, with failed subjective quality/performance acceptance. No matched native rerun has been collected for this correction. Earlier eligible imagery versus current imagery, whole-model ridge fidelity, actual time-to-sharp, draw-call batching and paused-HUD uploads remain open in [checkpoint 0f](../COMPLETION_PLAN.md). Do not close those gates from cancellation tests.
