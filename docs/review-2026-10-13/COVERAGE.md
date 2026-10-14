# Terrain coverage update continuation

Implemented October 13, 2026, after the [graphics recovery work](RECOVERY.md).

## Change and fidelity

Publishing or retiring terrain refinements previously tested every coarse-grid cell against every visible chunk, then copied retained triangles one index at a time. This work now rasterizes chunk footprints into a reusable one-byte-per-cell mask and copies contiguous runs of unchanged indices. It runs when coverage changes, while the existing signature check skips repeated notifications with identical footprints.

The new path preserves the previous inclusive cell-center comparisons, triangle order and winding, vertex attributes, smooth normals, refinement boundaries, and parent restoration. Binary searches use the exact previous center expression to preserve its floating-point rounding at footprint edges. Terrain resolution, imagery resolution, refinement budgets, and the existing direction chevrons are unchanged.

The mask adds **32,092 bytes** for the captured Rainier grid and **197,989 bytes** for the larger benchmark grid. It is allocated once per loaded terrain, rather than allocating callbacks for each cell during every update. Existing DEM, imagery, and GPU memory budgets remain separate; this is not a reduction in total retained memory.

Only the drawn index prefix is marked for GPU upload. Pending spans are merged until rendering consumes them, so a full parent restore followed by another promotion in the same frame remains correct. Full exaggeration still computes normals from the complete base surface before restoring its coverage mask.

## Measurements

The [benchmark](coverage/benchmark.json) compares the prior cell-by-footprint loop with the production coverage implementation using identical source indices and 24 aligned footprints. Each case warms up for 40 iterations and records 200 samples in Node 24.21.0. The former loop uses cached bounds and direct typed-array writes, avoiding getter/setter overhead, so this comparison isolates the coverage algorithm.

| Grid | Previous median / p95 | Current median / p95 | Index comparison |
| --- | --- | --- | --- |
| Captured Rainier, 226 × 142 cells | 1.415 / 1.647 ms | 0.056 / 0.086 ms | Exact match |
| Larger bounded grid, 439 × 451 cells | 11.395 / 12.608 ms | 0.608 / 0.802 ms | Exact match |

These are isolated desktop CPU measurements, not frame times or Quest GPU results. The [harness](coverage/benchmark-coverage.mjs) imports the production TypeScript module; run it from the repository root with `node --experimental-transform-types docs/review-2026-10-13/coverage/benchmark-coverage.mjs` after the browser harness produces `.review-cache/coverage/browser.json`. Node emits its normal experimental transform warning.

In the production browser, Rainier had 24 visible refinements. Exaggeration uploaded **366,672 index bytes** for the drawn prefix, versus **385,104 bytes** for the complete allocation, approximately 4.8% less for that update. Retirement restored and uploaded the complete parent indices. [Raw browser evidence](coverage/browser.json) records actual WebGL writes and exact index checks before exaggeration, after exaggeration, and after retirement.

## Verification and limits

| Check | Result |
| --- | --- |
| Source and test TypeScript checks | Passed |
| Full Vitest suite | [455 passed, 5 POSIX fixtures skipped on Windows](coverage/tests.log); 90 files passed / 1 skipped |
| Strengthened pending-upload checks | Coverage and rendering regression files passed again, 16 tests |
| Production build | Passed; main JS 906.84 kB / 236.55 kB gzip; worker 212.63 kB |
| Production Edge | Refinement, exaggeration, parent retirement, index uploads and GL error checks passed; no page errors or console warnings/errors |
| Meta device listing | Empty |

Regression coverage includes both 16-bit and 32-bit indices, overlapping footprints, out-of-grid bounds, exact inclusive center boundaries, invalid bounds, completely hidden surfaces, consecutive changes, unchanged-notification skips, full restoration, retained buffer identity, and smooth normals. Existing surface/raycast tests continue to verify that rendered and sampled heights agree.

The browser used ANGLE D3D11 on an NVIDIA RTX 4060. [Refined close view](coverage/refined-close.png) and [restored parent](coverage/parent-restored.png) show the test viewpoints. The harness pauses normal animation to inspect uploads deterministically; these images are not a timed close-up imagery streaming benchmark. It raises the inspection target after exaggeration so the camera remains above the changed terrain. Run [the browser harness](coverage/browser-coverage.mjs) from the repository root with `node docs/review-2026-10-13/coverage/browser-coverage.mjs`; its local Edge and Playwright paths are Windows-specific.

The Meta VR plugin documentation search again identified the [official WebXR performance workflow](https://developers.meta.com/vr/documentation/web/webxr-perf-workflow). Its device listing returned no headset. Sustained headset performance, GPU duration, thermals, memory peaks and immersive comfort remain pending device validation. The existing main-bundle size warning and terrain/imagery overlay draw overhead remain follow-up work.
