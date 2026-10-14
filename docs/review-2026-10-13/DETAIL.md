# Close-up detail and terrain raycast continuation

Implemented October 14, 2026, after the [imagery lifecycle work](IMAGERY.md).

## Close-up image quality

Desktop zoom could move far inside the previous inspection distance, but imagery selection still treated every camera as at least 0.2 scene units from the terrain. This kept the sampled imagery coarse even when the model filled the screen. Desktop detail selection now uses the actual camera-to-surface distance with a numerical floor of `1e-7`. The existing 0.2 distance floor is preserved for immersive sessions.

The movement gate also used a fixed 0.04-unit camera threshold. A substantial close-up zoom could therefore be ignored. Desktop camera movement now triggers evaluation at four percent of the previous viewed distance, capped at the existing 0.04 threshold. The normal evaluation interval, promotion dwell, demotion dwell, footprint stabilization and tile budgets still apply. Static close views do not reevaluate continuously. Changing between immersive and desktop modes marks selection dirty even if the pose is unchanged.

The production-browser comparison holds the camera, orbit target, terrain revision, 24 detailed terrain chunks and 80-patch budget fixed. It emulates the previous sampling floor by wrapping the zoom calculator in the current build, then restores the actual-distance calculation. DEM publication is paused during the comparison; rendering and imagery streaming keep running.

| Same close-up view | Previous sampling floor | Corrected desktop sampling |
| --- | --- | --- |
| Camera-to-orbit-target distance | 0.025 | 0.025 |
| Selected imagery zoom | 16 | 19 |
| Visible tiles by zoom | 16 at z15, 36 at z16 | 16 at z18, 36 at z19 |
| Resident imagery patches | 67 | 80 |
| Configured patch limit | 80 | 80 |
| Desired high-resolution coverage | 100% | 100% |
| Terrain revision / chunks | 50 / 24 | 50 / 24 |
| GL error | Zero | Zero |

The comparison also zooms from 0.05 to 0.025, a movement below the former 0.04 gate, and verifies promotion from zoom 18 to 19. Camera and target comparisons use a `1e-12` tolerance for OrbitControls rounding.

The [previous-floor image](detail/close-floor.png) and [corrected close-up](detail/close-detail.png) show finer glacier texture in the foreground. [Raw browser results](detail/browser.json) record selection, coverage, view and budget checks. Provider zoom describes requested source tiles; this does not establish survey accuracy or guarantee that every source image contains detail at its nominal pixel resolution. Terrain geometry and the existing trail direction chevrons are unchanged by this pass.

## Terrain raycast work

The grid raycaster previously continued through later cells after finding the nearest valid intersection on a mesh. It now stops once that intersection lies within the current cell's ray interval. Later cells cannot contain an earlier hit on the same mesh. The outer loop still compares all visible terrain meshes, including detailed chunks, and retains near/far rejection and front/back material handling.

[The isolated benchmark](detail/raycast-benchmark.json) uses a synthetic 400 m square grid with a flat interior and two remote corner height extremes. Those extremes widen the bounding box and exercise unnecessary traversal after a near-surface hit. It verifies both implementations against Three.js native hits, warms up for 40 samples, and records 200 batches of 24 diagonal rays in Node 24.21.0. Results are per-ray CPU time, not application frame time or GPU duration.

| Grid | Previous median / p95 per ray | Current median / p95 per ray | Triangle tests for first ray |
| --- | --- | --- | --- |
| 128 × 128 cells, 16,641 vertices | 0.00854 / 0.01107 ms | 0.00172 / 0.00273 ms | 244 → 26 |
| 446 × 446 cells, 199,809 vertices | 0.02889 / 0.03304 ms | 0.00336 / 0.00391 ms | 848 → 86 |

These hit-heavy synthetic cases show approximately five to nine times lower median raycast CPU cost. Misses and rays that first hit near the far edge still require longer traversal. This is not a claim about the speedup of every ray or the whole application.

The [benchmark harness](detail/benchmark-raycast.mjs) imports the [saved pre-change raycaster](detail/TerrainRaycast-before.ts) and current production source. Run it from the repository root with `node --experimental-transform-types docs/review-2026-10-13/detail/benchmark-raycast.mjs`. Node emits its normal experimental transform warning.

## Verification and limits

| Check | Result |
| --- | --- |
| Source and test TypeScript checks | Passed |
| Vitest | [475 passed, 5 POSIX packaging fixtures skipped on Windows](detail/tests.log); 92 files passed / 1 skipped |
| Production build | Passed; main JS 906.21 kB / 237.15 kB gzip; worker 210.77 kB |
| Production Edge | Same-view imagery, small zoom steps, patch budgets, coverage and GL checks passed; no page errors or console warnings/errors |
| Git whitespace check | Passed; existing line-ending notices only |
| Meta device listing | Empty |

New regressions verify close desktop sampling, relative movement triggering, preserved promotion dwell, static-view skips, immersive distance handling, mode changes, Topo's provider ceiling, early ray traversal termination, native hit agreement, nonuniform transforms and near/far limits. Existing rendered-index, refined-surface, elevation, visibility and material-side raycast regressions also pass.

The [browser harness](detail/browser-detail.mjs) uses the Windows Edge/Playwright paths and runs from the repository root with `node docs/review-2026-10-13/detail/browser-detail.mjs`. Its saved [five-second profile](detail/close-profile.json) is a diagnostic capture with DEM publication paused: maximum JavaScript/render submission is 1.9 ms, with 77 draw calls and 84 textures observed. Those texture counts are not a GPU-memory total, and this short desktop capture does not establish normal streaming or sustained headset frame delivery.

The Meta VR plugin documentation search again identified the [official WebXR performance workflow](https://developers.meta.com/vr/documentation/web/webxr-perf-workflow). The browser uses ANGLE D3D11 on an NVIDIA RTX 4060. Quest GPU duration, compositor FPS, thermals, memory peaks and immersive comfort remain pending hardware validation. The existing main-bundle size warning and terrain/imagery overlay draw overhead remain follow-up work.
