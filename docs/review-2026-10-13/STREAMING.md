# Terrain streaming recovery and idle-work continuation

Implemented October 14, 2026, after the [local trail lookup work](LOOKUP.md).

## Behavior and resource bounds

A missing detail DEM or rejected preparation previously blocked that tile for the rest of the route load. Wanted terrain now retries after 60 seconds, then 120, 240 and at most 300 seconds between consecutive failures. The first delay respects the shared image cache's maximum one-minute negative-cache lifetime. The visible base remains in place during acquisition and preparation. Successful detail still publishes together with its imagery, at most one prepared child per frame.

Failures outside the wanted footprint are forgotten, successful publication clears their retry record, and changing quality clears the records. Geometry that fails validation stays unpublished and blocked for that footprint until the plan discards it or quality/route changes. Stale geometry caused by a view or exaggeration change is disposed without blacklisting the tile. Disposal cancels work and prevents later retries. Retry state is bounded by the wanted tile plan; no interval or background retry timer is added.

Settled views previously created an asynchronous preparation probe and scanned resident/wanted tiles every frame. The scheduler now sleeps until the plan, mode, quality, exaggeration or ready publication changes, or a retry deadline arrives. Unchanged route progress reuses its geographic focus, and unchanged geographic coordinates reuse the local conversion. This preserves the existing 60 m planning threshold and tile selection.

## Isolated idle CPU measurements

The [benchmark](streaming/benchmark-idle.mjs) compares the [saved previous streamer](streaming/TiledTerrainStreamer-before.ts) against current source. It uses real Rainier and Glacier Peak GPX telemetry at progress 0.4, with all 24 planned desktop tiles represented by inert resident placeholders. It excludes network, geometry publication and rendering. Forty batches of 72 updates warm up the methods; 200 further batches are measured in Node 24.21.0.

| Paused view / 24 resident tiles | Previous median / p95 per update | Current median / p95 per update |
| --- | --- | --- |
| Rainier | 0.00369 / 0.00552 ms | 0.000142 / 0.000175 ms |
| Glacier Peak | 0.00282 / 0.00432 ms | 0.000136 / 0.000144 ms |

Across all 17,280 warm-up and measured updates per fixture, the previous implementation makes 17,280 preparation probes and route-telemetry calls; the current implementation makes zero after its initial settlement. Resident tile keys match. This reduces this small idle method's median CPU cost by approximately 21–26 times. It is not a whole-app, moving-view, GPU or FPS speedup. Rendering and active streaming continue to cost substantially more than this isolated operation.

[Raw measurements](streaming/idle-benchmark.json) record the sample counts and counters. Run from the repository root with `node --experimental-transform-types docs/review-2026-10-13/streaming/benchmark-idle.mjs`. The harness adapts Vite's JSON imports for native Node and loads the saved streamer with the same current dependencies; Node emits its normal experimental warnings.

## Production-browser outage verification

The [browser harness](streaming/browser-streaming.mjs) aborts AWS Terrarium zoom-15 detail requests while allowing the base DEM and imagery to load. It waits until all 24 wanted detail tiles have failed, restores network access, and allows the normal cooldown to elapse. It uses the production build in Edge with ANGLE D3D11 on an NVIDIA RTX 4060.

The [base view during the outage](streaming/base-during-outage.png) remains visible. The [recovered view](streaming/detail-after-recovery.png) regains 24 detailed chunks and 57,624 refinement vertices within the existing desktop limit of 24 tiles / 160,000 vertices. No route reload is performed. The surface revision advances as the recovered children publish; camera, orbit target and progress stay fixed. Three seconds of settled rendering add no preparation probes or surface revisions. No page errors or unexpected console messages occur; the deliberate aborted requests produce expected browser network errors.

[Raw browser results](streaming/browser.json) include recovery timing, base triangle counts, retry delays, revisions, budgets and GL checks. A null retry delay means no finite deadline is scheduled, including work currently being prepared. These screenshots document outage/recovery behavior rather than a pixel-equivalence comparison: finer terrain intentionally changes the rendered surface.

Run the Windows harness from the repository root with `node docs/review-2026-10-13/streaming/browser-streaming.mjs`. It uses the installed Edge/Playwright paths and takes at least a minute because it tests the real cooldown.

## Validation and limits

| Check | Result |
| --- | --- |
| Source and test TypeScript checks | Passed |
| Local full verification | [493 tests passed, 5 POSIX packaging fixtures skipped on Windows](streaming/tests.log); 92 files passed / 1 skipped; build passed |
| Production build before checkpoint commit | Main JS 910.22 kB / 238.31 kB gzip; worker 210.77 kB |
| Production Edge | Coarse coverage, cooldown, automatic recovery, idle settlement and budgets verified |
| Git whitespace check | Passed; existing line-ending notices only |
| Meta VR device listing | Empty |

Seven new regressions cover idle scheduler/telemetry work, cooldown and atomic publication, capped repeated-error backoff, forgotten out-of-focus failures, exaggeration-invalidated geometry, permanently invalid geometry and route disposal. The existing terrain seam, normal, budget, parent coverage and atomic-retirement tests still pass. The checkpoint release workflow additionally requires passing [GitHub Linux CI](https://github.com/delphimon/trekviewer/actions), publication from a clean commit and hosted desktop/mobile checks.

Meta VR plugin verification again identified the [official WebXR performance workflow](https://developers.meta.com/vr/documentation/web/webxr-perf-workflow) and [performance best practices](https://developers.meta.com/vr/documentation/web/webxr-perf-bp). Sustained Quest frame delivery, GPU duration, thermals and immersive comfort require hardware validation. The existing main-bundle size warning remains.
