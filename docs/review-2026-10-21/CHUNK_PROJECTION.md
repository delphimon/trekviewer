# Reuse exact geography during fine-terrain construction

The [instrumented moving-tour baseline](chunk-projection/plan-baseline-fa75d0b.json) records 786 terrain plans, 3,363 tile admissions (2,000 returns) and 300 cancelled acquisitions. The median completed desired-tile interval is 723 ms; 2,394/3,338 intervals last less than one second. Most cancellations follow removal from the desired set; 24 abort still-wanted, less urgent work to admit the current hiker footprint, and 36 happen after acquisition settled. Only four successive plan changes have identical hiker focus, all with surface revisions. This accelerated-tour run does not establish sustained stationary oscillation or justify delaying requested detail, changing selection, raising memory caps or adding a history cache. The earlier fixed-view test settled without churn.

The [same baseline tour](chunk-projection/tour-baseline-fa75d0b.json) still has 693 builds, including 215 repeats, and fine ground visible in 333/367 samples (90.7%). Worker chunk request-to-response time is 16.3 ms median / 22.8 ms p95, including transport and scheduling rather than isolated worker CPU. Service/phasing variation prevents comparisons with earlier runs from proving a loading change.

## Change and controlled measurement

Fine terrain previously projected each vertex twice: once for DEM sampling, then again for imagery UVs. Construction now uses the existing exact geographic coordinates for both. Imagery mapping retains only the last exact latitude and its dimensionless Mercator projection, avoiding repeated trigonometry across a regular row. `Object.is` distinguishes signed zero/NaN. Every call still reads its current longitude, zoom and grid bounds; there is no geographic rounding, retained source data, historical cache or resource/selection change. Prepared worker geometry and later map-grid replacement retain their existing paths.

The [alternating benchmark](chunk-projection/benchmark.json) compares both original chunk construction and original UV projection from committed `fa75d0b`, checking complete positions, normals, UVs, indices, heights, bounds and diagnostics for exact equality. Across five alternating 60-chunk passes, median construction is **850.833 ms before / 710.593 ms after**, approximately **14.18 / 11.84 ms per 23,409-vertex chunk (16.5% less CPU)**. It also checks 46,818 exact row/scattered UV matches. Median row projection is 49.06 / 24.92 ms per 468,180 calls; scattered projection is 51.95 / 53.93 ms, about 3.8% more. The two-scalar projection reuse favors regular grids and is not a universal mapping speedup.

Reproduce on Node 24 with `node --experimental-transform-types scripts/benchmark-chunk-projection.mjs`. This excludes message transport, source loading, publication, GPU work and native frame timing. It does not establish a 16.5% overall frame-rate or loading improvement.

## Validation

`npm run verify` passes both typechecks, **729 Windows tests with five platform skips**, and the production build. Regressions cover exact full-grid UVs at nonzero chunk offsets, initial versus later map assignment, changed grids/zoom/bounds, changing and repeated latitudes, signed zero, extreme/nonfinite inputs and current longitude. Existing DEM/source, coverage, normal, worker, follow and graphics checks remain passing.

The [local full tour](chunk-projection/local-tour.json) passes image/marker gates without page/GL errors: maximum mean 0.05618/255, RMS 1.51565/255 and 0.675% changed pixels. Its modified build is `ebe3282-modified-2026-10-21T13:57:05.328Z`, entry `index-BZULcVak.js`. Fine ground is visible in 355/368 samples (96.5%), with twelve fetching and one decoded sample. There are 1,026 builds (432 repeats); neither fine-ground availability nor churn is resolved. Selection/budgets are unchanged; faster construction, service timings and scheduling can all change how much background work completes during a moving tour.

Two workers remain alive. With 33 streamed chunks, 2×/1× exaggeration retains exact complete-surface normals, index bytes, index attribute identity and draw count. [Desktop/mobile controls](chunk-projection/controls-local.json) and [geographic/stereo/fade/recovery checks](chunk-projection/controlled-local.json) pass; actual graphics recovery is bitwise identical.

Hosted application checks are recorded below after completion. Loading/churn, overview DEM detail and native 72 Hz/visual acceptance remain open. The user has deferred headset testing.
