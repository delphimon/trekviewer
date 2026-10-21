# Adopt prepared terrain geometry on the render thread

Local terrain publication previously constructed and rotated a complete `PlaneGeometry` on the main thread, then overwrote its positions, normals and UVs with the worker result and recalculated its bounds. The worker had already generated that same grid. A typical Olympus refinement contains 23,409 vertices, so this repeated grid generation also created sizeable temporary JavaScript arrays and typed buffers for every publication.

The worker now transfers its existing index buffer along with its vertex arrays and unscaled heights, and supplies its already calculated bounding box/sphere. The main thread adopts those buffers using a constant-size plane shell. The shell retains accurate regular-grid metadata for exact grid ray traversal, imagery clipping and surface snapshots. This preserves the original topology, geographic UVs, normals, sampled relief, source imagery, lit material, exaggeration behavior and all selection/resource limits. Unprepared construction and local fallback remain supported. Prepared data transfers array ownership to the receiving chunk.

## Measured scope

The [instrumented published baseline](terrain-publication/baseline-hosted-4dbc044.json) executes clean application `4dbc044-2026-10-21T00:23:18.315Z`, entry `index-CYdkHLp5.js`. Across 1,230 observed terrain constructions in a complete Olympus browser tour, worker-message receipt through async chunk construction totals **4,857.5 ms**, with **3.7 ms median, 5.9 ms p95 and 15.7 ms maximum**. This interval includes promise scheduling and excludes subsequent validation, imagery promotion and GPU upload. It is a measured CPU substep, not frame time or native headset performance.

The [isolated construction benchmark](terrain-publication/publication-benchmark.json) compares the previous constructor from `35a7f1a` with buffer adoption over the same prepared 23,409-vertex result. Full positions/normals/UVs, indices, bounds and terrain sample agree exactly. Three alternating 200-construction/disposal passes take **1,103–1,319 ms before** and **2.66–3.92 ms after**: approximately **5.6 ms versus 0.016 ms per construction** at the median pass. This synthetic desktop benchmark excludes worker work, message transfer, GPU upload and the rest of a frame. It must not be presented as an application or native frame-rate multiplier.

Reproduce with `node --experimental-transform-types scripts/benchmark-terrain-publication.mjs` on Node 24. The browser driver now records worker completion through async construction separately and supports exact expected-build stamps from another directory, allowing before/after measurement against the published checkpoint without rebuilding it.

An [equal-distance tile retention experiment](terrain-publication/retention-experiment.json) still builds 1,211 chunks with 486 repeats versus the previous checkpoint's separately recorded 1,251/516. A repeat baseline itself varies to 1,231/501. That small, uncontrolled change does not establish a useful churn reduction. The selection experiment is **excluded from this release**; terrain planning/acquisition/eviction policy remains unchanged.

## Validation and release

`npm run verify` passes both typechecks, **711 Windows tests with five platform skips**, and the production build. Added regressions transfer actual buffers with `structuredClone`, cover both 16-bit and 32-bit indices, verify buffer ownership, exact topology/positions, supplied bounds, terrain sampling, ray picking, exaggeration updates and disposal. Grid raycasting is checked explicitly against accidental fallback to triangle-by-triangle traversal.

The [final local complete tour](terrain-publication/full-local.json) uses the original selection policy and measures 1,244 constructions: **222.4 ms total, 0.1 ms median, 0.2 ms p95 and 14.1 ms maximum**. The 95% reduction in this aggregate substep versus the baseline is an observation across separate service/phasing runs, not a 95% frame-time improvement. Promise scheduling and occasional stalls remain in the interval. There are still 1,245 chunk jobs across 747 IDs (498 repeats), so overall terrain-work reduction is not established.

Fine ground is visible in 356/368 playing/following samples (96.7%), with nine fetching, two decoded and one ready sample remaining. Two workers stay alive without restarts. Local requested export spacing remains approximately 1.0001 m and local/overview mesh spacing approximately 4.96/94 m. All real-source image/marker gates pass, with at most 0.056/255 mean error, 1.512/255 RMS and 0.656% changed pixels, and no page/GL errors. This is modified build `35a7f1a-modified-2026-10-21T01:12:32.798Z`, entry `index-BXuqJoHW.js`.

[Desktop/mobile controls](terrain-publication/controls-local.json) pass Follow, upcoming-ground/pause cleanup, manual takeover, anchored model/camera ownership, sampled ridge clearance, imports and landmark navigation. [Geographic/stereo/fade/recovery checks](terrain-publication/controlled-local.json) retain the previous visual results and recover a bitwise-identical image after actual graphics-context loss. Earlier local experiments had inconsistent initial imagery readiness, including two 90-second readiness timeouts and a separate 37-second overview. The final full tour reaches overview in 4.0 seconds; this variation leaves cold loading acceptance open.

Clean hosted release evidence is recorded below after completion.

## Remaining acceptance

This removes duplicated main-thread grid construction; it does not cache or eliminate repeated tile jobs, decoded DEM exports, imagery promotion, GPU uploads or draw work. Full-tour terrain churn, cold-service loading consistency, broad overview DEM detail and native 72 Hz/visual acceptance remain open. The user deferred headset testing; desktop browser timing does not close those gates.
