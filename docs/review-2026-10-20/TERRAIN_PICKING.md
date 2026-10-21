# Share authoritative terrain coverage with ray picking

Normal playback profiling identified repeated reconstruction of ray-picking masks from compacted base indices. `BaseTerrainCoverage` already owns the exact hidden-cell mask used to generate those indices. Terrain publication now lends that mask to all pickers through one weak geometry cache. Each record is bound to the index attribute identity/version, draw range and grid dimensions. Changed indexed coverage falls back to the existing scan, shared across picker instances. No image, DEM, vertex, normal, topology, light, LOD or resource limit changes.

The borrowed mask is updated synchronously with coverage publication; no per-picker mask copy is allocated for the generated base terrain. Weak geometry keys release the record with its owning geometry. Coverage with no holes resets the existing mask. Shortened index buffers use their actual count when the draw range is unlimited, and incomplete cells/fractional constructor metadata use native picking.

## Measurements

The [published baseline CPU profile](terrain-picking/baseline-cpu-30f45a2.json) samples the first 15 seconds of ordinary desktop Olympus playback, ending before any legacy/direct image comparison. `getCellMask` and its descendants account for **149.353 ms**. The [local prototype profile](terrain-picking/local-cpu.json) records **1.607 ms** for that same call-tree component. These are sampled main-thread CPU intervals from separate service/phasing runs, not complete frame times, worker CPU, GPU or native headset performance. Profile collection is opt-in and restricted to public sources; only condensed summaries and raw-file hashes are committed.

The [isolated benchmark](terrain-picking/benchmark.json) checks **3,971,968 identical cell-visibility decisions** on a 434×286 base grid, including overlapping holes, full coverage and no holes. Across alternating 300-revision passes with two pickers, mask acquisition takes a median **625.236 ms before / 0.475 ms after**. It excludes coverage generation/publication, intersections and frames. Each prior revision allocates two 124,124-byte masks; the new path borrows the existing 124,124-byte coverage allocation with **zero extra mask bytes per revision**. Reproduce using `node --experimental-transform-types scripts/benchmark-terrain-picking.mjs` on Node 24.

A [retired-geometry cache simulation](terrain-picking/retired-cache-simulation.json) found just 26 potential hits among 1,235 builds with 14 cached retired tiles, before source-cache interference or other costs. This does not justify adding a geometry-history cache or increasing memory limits. No such cache/selection change is included.

## Verification

`npm run verify` passes both typechecks, **716 Windows tests with five platform skips**, and the production build. New regressions compare native hits under transformed 16-bit/32-bit grids, reuse across independent pickers, changed index versions/attributes/draw ranges, shortened buffers and native fallback for incomplete/fractional grids. A strengthened replacement-index case also passes the focused picking suite.

The [local full tour](terrain-picking/local-tour.json) passes image/marker gates without page/GL errors. Fine hiker ground is visible in 354/369 samples (95.9%), with 1,239 builds and 496 repeats; churn/loading are still substantial. Local/overview mesh cells remain approximately 4.96/94 m and requested local export spacing approximately 1.0001 m. This prototype is `aa7c9ec-modified-2026-10-21T02:38:10.703Z`, entry `index-BwN34K4k.js`; final code additionally guards fractional constructor metadata. [Controls](terrain-picking/controls-local.json) and [geographic/stereo/fade/recovery checks](terrain-picking/controlled-local.json) use the final guard, modified build `aa7c9ec-modified-2026-10-21T02:42:44.308Z`, entry `index-DxyprRRe.js`, and pass. Actual graphics-context recovery remains bitwise identical.

## Published checkpoint

Application `5f993f36940b4dfcaf2f2fa820efd086985b670b` passed [CI](https://github.com/delphimon/trekviewer/actions/runs/39534866770), was rebuilt with a clean tree, credential-scanned and published successfully to [TrekViewer](https://trekviewer.surge.sh/). Exact build: `5f993f3-2026-10-21T02:46:49.847Z`, entry `index-CSbKeTJ1.js`.

The [hosted normal-playback CPU sample](terrain-picking/hosted-cpu-5f993f3.json) confirms the final code and records **3.183 ms** in mask acquisition and its descendants versus **149.353 ms** in the prior published baseline. This is about 98% less sampled CPU for that component over the first 15 seconds. Sampling variability and source/phasing differences apply; the result is not an overall frame-time or native GPU claim.

The [hosted complete tour](terrain-picking/hosted-tour-5f993f3.json) retains fine hiker ground in **356/367 samples (97.0%)**, with ten fetching and one building sample. Upcoming ground is selected in all 367 samples. There are still 1,257 builds across 741 IDs (516 repeats), 1,220 publications (485 repeats), and 1,186 removals. The browser emits 1,386 export request events for 876 distinct URLs, including cancelled/cached requests rather than proven wire transfers. This does not establish a reduction in terrain churn or loading time. Application-ready is 10.536 seconds and overview 11.509 seconds after navigation; first fine observation is 1.752 seconds after monitoring begins.

Source/mesh detail remains approximately 1.0001 m requested local export spacing and 4.96/94 m local/overview mesh cells. Both workers remain alive without restarts. All image/marker gates pass without page/GL errors: maximum mean 0.05541/255, RMS 1.5160/255 and 0.676% changed pixels. Main-thread chunk reconstruction remains 0.1 ms median / 0.2 ms p95. [Hosted desktop/mobile controls](terrain-picking/controls-hosted-5f993f3.json) and [geographic/stereo/fade/recovery checks](terrain-picking/controlled-hosted-5f993f3.json) pass; actual context recovery remains bitwise identical.

The separate [private account-path check](terrain-picking/private-bing-5f993f3.json) passes a 30-second hosted run with 121/124 fine-ground samples and the existing image/marker tolerances. Its imagery remains grouped as “other,” so this is private Cesium/Bing account-path compatibility rather than a source-quality/coverage certification. CPU recording is explicitly disabled for that run; credentials remain memory-only and absent from repository/hosted files. The evidence-only follow-up retains this exact tested application build.

## Remaining acceptance

The new native-comparison fixture exposed a [preexisting nominal-grid boundary precision miss](terrain-picking/preexisting-boundary.json): a transformed 260×260 grid misses a native hit at local x=3.2, z=-2.3 in both committed `aa7c9ec` and the new picker. Interior/native parity and coverage-mask parity do not close this separate boundary issue. The reproduced fixture is retained for follow-up; this checkpoint does not claim universal boundary precision.

Terrain churn, source/loading consistency, broad overview DEM detail and native 72 Hz/visual acceptance remain open. The user deferred headset testing; the desktop CPU savings do not certify native performance.
