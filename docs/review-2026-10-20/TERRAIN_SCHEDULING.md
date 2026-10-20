# Terrain acquisition priority, worker reuse and planning cost

Terrain loading now refreshes priority when the hiker moves within an unchanged desired footprint. The current ground tile can replace one less urgent unfinished acquisition when all download slots are occupied. Completed grids, active geometry/publication, previously visible terrain, retry backoff and High/Balanced resource limits remain retained. This corrects a reproducible wait; it does not establish that network loading or full-tour fine coverage is solved.

## Reproduced waits and cancellation behavior

The previous streamer compared sorted tile IDs and updated its ordered `wanted` map only when membership changed. A hiker crossing a footprint could therefore keep the old acquisition order. A regression moves between opposite corners of the same 16-tile footprint: the previous implementation leaves `0:0` first and starts no request for `3:3`. The updated implementation puts `3:3` first and admits it immediately, cancelling exactly one unfinished lower-priority request while keeping three active acquisitions. Further movement inside that tile causes no repeated cancellations. Another regression verifies that completed staging grids survive the same move and that the urgent request starts once publication frees a slot. The network bounds remain three in High and one in Balanced.

`TerrainJobs` previously serialized every kind of work on one worker and terminated it whenever an active caller cancelled. The baseline live desktop tour observed five worker contexts created and four closed. Decoding a newly downloaded DEM could also wait behind unrelated imagery clipping or chunk construction.

There are now at most two reusable workers: one lane for elevation decoding/route finalization and one for surface/chunk geometry. Each lane executes one job at a time and owns its own startup state and surface-source cache. The existing startup readiness handshake still precedes transfer of sole-owned buffers, with two bounded attempts and a ten-second cooldown/local recovery when startup fails. Execution errors after transfer do not invoke a fallback against detached data.

Caller cancellation rejects immediately, including while queued or starting. A queued cancelled job transfers no buffers. An executing job drains its response before its lane is reused, so a late response cannot satisfy another caller. A message cannot interrupt synchronous clipping mid-computation; this implementation does not claim cooperative mid-job cancellation. An abandoned execution that fails to drain within five seconds is terminated so it cannot occupy the lane indefinitely. Actual worker errors and application teardown also terminate the affected workers. Generation guards reject work queued before teardown. Surface sources remain reusable across cancelled tile/style/mode consumers when the geometry revision is unchanged; real surface changes still send fresh snapshots.

The two lanes permit more concurrent CPU work and retain a second worker runtime. They do not increase DEM acquisition, mesh, decoded-grid-cache, imagery-array or resident-vertex limits. Worker-runtime/transient memory and sustained mobile scheduling costs still need native measurement; two contexts are not a total-memory measurement.

## Planning without reducing detail

Farthest-point view anchors now cache each candidate's nearest squared distance instead of recalculating distances to every previously chosen anchor. The 64-candidate, 25-anchor, 60 m spacing policy and stable input-order ties remain unchanged. `scripts/benchmark-terrain-focus.mjs` checks exact ordered point identity against the previous algorithm across 1,000 seeded geographic-scale point clouds. Its three 2,000-iteration pairs measure about 687–691 ms previously versus 21.5–22.2 ms after the change, approximately 31× faster for this isolated operation. See [focus benchmark](terrain-scheduling/focus-benchmark.json).

Tile planning now visits each anchor's radius instead of testing all anchors against the full rectangle between distant samples. It retains the original bounds-distance admission, boundary contacts, ordering, partial edge tiles and budgets. `scripts/benchmark-terrain-planner.mjs` compares complete plans with committed `607d97b` over 1,000 seeded parent/focus layouts, including single-focus and broad views. All plans match exactly. Three 1,000-plan pairs measure 421–434 ms previously versus 309–315 ms after the change, about 26% less time. See [planner benchmark](terrain-scheduling/planner-benchmark.json). These are Node desktop operation benchmarks, not frame-rate or headset measurements.

## Live desktop evidence and limits

The updated live driver records worker context creation/closure and the existing application's frame phases, alongside imagery comparisons, terrain source/spacing and hiker coverage. It retains the same real public Olympus route/services and Quest geometry budget in desktop Edge. The paired imagery frames share scene state, but different cold tour runs have different network contents/timing and uncontrolled system activity. Profiling also includes the driver's explicit render comparisons. Do not derive GPU time or native FPS from these callback/submission measurements.

| Observation | Baseline `607d97b` | Final local build |
| --- | ---: | ---: |
| Worker contexts created / closed before test teardown | 5 / 4 | 2 / 0 |
| Captured application callbacks | 1,010 | 1,003 |
| Frame-weighted terrain phase mean | 1.135 ms | 0.930 ms |
| Terrain phase maximum | 5.2 ms | 4.9 ms |
| Render phase mean | 3.108 ms | 3.005 ms |
| Render phase maximum | 74.5 ms | 65.7 ms |
| Fine hiker samples during playing/following | 113 / 124 | 105 / 124 |
| First fine observation after monitoring starts | 2.017 s | 3.000 s |

The final local build is `622d3e7-modified-2026-10-20T17:34:22.137Z`, entry `index-DQL9EcFx.js`. [Baseline](terrain-scheduling/baseline.json) and [final local run](terrain-scheduling/local.json) retain the reports. The final run has no page or GL errors; real USGS overview and approximately 1 m requested local export samples remain in use, with the same approximately 94 m overview mesh and approximately 5 m fine mesh. Its imagery-only paired draw counts are 108→99, 127→74 and 180→105. The earlier direct imagery and marker instancing improvements remain active.

Worker restart churn is eliminated in the covered updated runs, and the isolated planning improvements preserve exact output. The desktop terrain-phase reduction is indicative rather than a controlled full-frame percentage. Fine coverage and cold time-to-detail are not consistently better: an intermediate run observed 116/123 fine samples, while the final run above still has gaps and a slower first observation. The hiker-priority regressions demonstrate the repaired scheduler behavior, not universal faster service responses. Large render/publication spikes also remain.

`npm run verify` passes both typechecks, **694 Windows tests with five platform skips**, and the production build. Worker regressions cover queue cancellation, cancellation during startup/execution, late-response isolation, independent decode/geometry progress, source reuse, startup failure/recovery, detached-buffer failure behavior, bounded abandoned-job recovery and disposal of both lanes. Terrain regressions cover unchanged-membership reprioritization, retained staging grids, original resource bounds, anchor policy and exact circle-edge contacts. [Geographic imagery/stereo/fade/context checks](terrain-scheduling/controlled-local.json) preserve the previous visual tolerance and restore bitwise-identical images after actual context loss. Desktop/mobile follow, imports, landmarks and lifecycle checks are recorded with the release.

## Remaining acceptance

The user deferred the next headset test. Native High performance at 72 Hz, CPU/GPU tails, loading spikes, thermal/memory behavior and subjective terrain clarity remain open. Broad overview DEM/mesh detail, geographic coverage and complete tour time-to-detail are separate unresolved items. This checkpoint changes scheduling and planning cost; it preserves source samples, terrain geometry precision, imagery dimensions/coverage and lighting.

## Published checkpoint

Application commit `787ece64c2ca0c4fcfdfb6306ac3d30d558d66ca` passed [CI](https://github.com/delphimon/trekviewer/actions/runs/39492902086), was rebuilt with a clean working tree and published successfully to [TrekViewer](https://trekviewer.surge.sh/). Exact build: `787ece6-2026-10-20T20:33:01.748Z`, executed entry `index-C09485Ch.js`. Credential scans pass across repository/evidence and the clean distribution.

[Hosted real-source validation](terrain-scheduling/hosted-live-787ece6.json) confirms the exact client, two workers created with zero closed before teardown, no page/GL errors, and fine hiker terrain in 117/124 playing/following samples. Its imagery-only paired draws are 98→90, 127→75 and 179→105; maximum mean image error is 0.054/255, RMS 1.51/255 and changed pixels 0.624%. The reported terrain-phase mean is 1.060 ms. Other browser checks ran concurrently, so that figure is not a controlled timing comparison with the earlier local run. Coverage gaps remain open.

The [hosted geographic/stereo/fade/recovery fixture](terrain-scheduling/hosted-controlled-787ece6.json) reproduces the previous visual results and bitwise-identical context restoration. [Hosted desktop/mobile tour checks](terrain-scheduling/hosted-tour-787ece6.json) pass controls, hiker following/model ownership, manual takeover, sampled ridge clearance, imports, route replacement and landmarks. The evidence-only follow-up retains this measured application build.
