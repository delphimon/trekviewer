# Terrain picking allocation continuation

Implemented October 14, 2026, after the [startup and layout work](STARTUP.md).

Terrain queries now reuse a matrix, local ray, box interval and vector workspace within each `TerrainRaycast` instance. Previously, every tested grid cloned its ray and world matrix, allocated interval arrays and created traversal vectors. Triangle hits also cloned points before distance rejection. The new path copies into reusable storage and creates an owned result point only when a grid has an accepted hit.

Returned points remain independent across meshes, repeated queries and separate picker instances. The native fallback can issue a nested query without overwriting an earlier grid hit. The grid traversal, nearest-surface comparisons, rendered-cell masks, material-side handling, transforms and near/far checks retain their existing behavior. Terrain resolution, imagery selection, streaming budgets, shadows and trail geometry are unchanged.

## Isolated CPU measurements

The [benchmark](picking/benchmark-picking.mjs) compares the [saved previous implementation](picking/TerrainRaycast-before.ts) with production source in Node 24.21.0. Both receive the same grids and 26 rays: 24 hits and two misses. It verifies exact previous-result agreement and native Three.js hit agreement within `1e-8`. Timing alternates implementation order, excludes 100 warmup batches and records 500 batches of 26 queries. Clone instrumentation runs separately from timing.

| Synthetic fixture | Previous median / p95 | Current median / p95 |
| --- | --- | --- |
| 199,809-vertex base grid | 0.650 / 1.719 microseconds/query | 0.512 / 1.312 microseconds/query |
| Base plus 25 detail tiles, 262,309 vertices | 6.177 / 9.081 microseconds/query | 5.150 / 7.081 microseconds/query |

These fixtures show approximately 17–21% lower median CPU time. In the second fixture's 26-query batch, explicit ray clones fall from 676 to zero and matrix clones from 676 to zero. Result-vector clones remain at 48 because accepted hits retain owned points. These clone counts exclude other object allocations and do not measure garbage-collection pauses. The synthetic second fixture includes one more detail tile than the desktop's 24-tile limit to exercise a larger surface list; production budgets are unchanged.

[Raw measurements](picking/benchmark.json) describe isolated picking CPU cost, not application frame time, GPU time or headset FPS. Run from the repository root with `node --experimental-transform-types docs/review-2026-10-13/picking/benchmark-picking.mjs`.

## Production browser

The [browser harness](picking/browser-picking.mjs) loads the production build in hardware-accelerated Edge, waits for 24 Rainier refinement chunks and settles a close inspection view. It pauses further DEM publication and animation for matched queries and captures; this is a controlled comparison rather than a normal streaming profile.

| Check | Result |
| --- | --- |
| Visible terrain surfaces | 25: base plus 24 detailed chunks |
| Detailed terrain vertices | 57,624 |
| Queries | 15: 13 hits, including three detailed-surface hits, and two misses |
| Previous-result agreement | Exact hit coordinates, distances and selected meshes |
| Native Three.js coordinate difference | Zero maximum in this run |
| Saved hit ownership | Preserved after subsequent queries |
| Imagery | Zoom 17, 67 resident patches, 100% desired coverage |
| Matched screenshot difference | Four of 1,012,293 pixels, maximum channel difference one |
| Rendering | 72 draw calls, GL error zero |
| Desktop/mobile browser | Passed, including 390-pixel Settings and Fit terrain |
| Page errors / console warnings or errors | None |

The [before](picking/before.png), [after](picking/after.png), [mobile](picking/mobile.png) and [raw browser results](picking/browser.json) are saved. The harness allows at most four pixels differing by one channel step for GPU/compositor rounding; it does not claim pixel identity. Queries do not modify surface geometry or imagery. It uses the Windows Edge/Playwright installation paths and runs from the repository root with `node docs/review-2026-10-13/picking/browser-picking.mjs`.

## Verification and limits

Source and test TypeScript checks passed. The [full verification log](picking/tests.log) records 498 passing tests and five POSIX fixtures skipped on Windows, across 92 passing files and one skipped file. The production build passed: main JS 911.53 kB / 238.70 kB gzip, worker 210.77 kB. New regressions cover saved-point ownership, surface ordering, subsequent queries, independent instances and nested native fallback queries. Existing elevation, visibility, compacted indices, nonuniform transform, early-exit, material-side and near/far regressions also pass.

The Meta VR plugin's documentation search again identified the official [WebXR performance workflow](https://developers.meta.com/vr/documentation/web/webxr-perf-workflow) and [performance tools](https://developers.meta.com/vr/documentation/web/webxr-perf-tools). Its device listing returned no connected headset. Desktop rendering used ANGLE D3D11 on an NVIDIA RTX 4060; sustained Quest CPU/GPU performance, compositor FPS, thermals and immersive comfort still require hardware validation. The existing main-bundle size warning and terrain/imagery draw overhead remain follow-up work.
