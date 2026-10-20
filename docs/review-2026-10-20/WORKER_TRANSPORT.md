# Reduce terrain worker copying

The full-tour loading audit identifies work that existing animation-phase timers omit: synchronous structured cloning when sending geometry jobs to a worker. On the published `e3d5b88` desktop build, surface jobs send 3,437,401,464 bytes of positions/normals in 90 seconds. Their synchronous `postMessage` calls total 2,175 ms and peak at 21.5 ms. Chunk jobs also copy the same immutable base height grid repeatedly. This is a desktop observation, not native GPU/frame timing; the audit includes deliberate imagery readback/recovery comparisons, and a short unit-test run overlapped the baseline. Its totals must not be interpreted as normal headset workload.

## Change and correctness

Surface messages now refer to unchanged arrays in the previous worker source set. Each source still sends fresh grid, placement, version and coverage-hole metadata. Buffer identity plus Three.js position/normal attribute versions determine eligibility; new arrays or edits resend the data. Reordering sources resolves against the previous complete set before replacing it. Retired sources disappear from that set: there is no growing historical registry. The existing shortcut for an unchanged complete snapshot remains supported.

Chunk jobs retain one immutable, unexaggerated base height grid rather than cloning it on every build. A different base object replaces it, and worker replacement/disposal clears the caller's cache state. This adds at most one base height grid to worker residency (about 0.8 MB at the existing 200,000-vertex maximum). Local DEM grids, geometry precision, imagery dimensions, lighting, acquisition/resident limits and High's broad-view selection are unchanged.

Caller cancellation still rejects promptly while active work drains. The worker and caller advance their source/base state only for messages actually sent; failed startup never loses input buffers. A real worker failure causes fresh data to be sent to its replacement. A missing source reference fails explicitly rather than sampling an unrelated surface.

Tile selection also replans immediately when the current focus crosses its tile boundary, even if movement is below the usual 60 m threshold. A reproduced 14 m corner crossing previously left the old tile prioritized. The regression now admits the new current tile, cancels at most one unfinished lower-priority acquisition and keeps the three-slot High bound; movement within the new tile causes no additional cancellations.

## Verification

`npm run verify` passes both typechecks, **703 Windows tests with five platform skips**, and the production build. New regressions cover source reordering, changed holes/placement, in-place position/normal edits, missing references, base replacement, source/base resending after worker failure, restoring complete inputs after a handler error without restarting a healthy worker, and tile-boundary urgency. Existing worker startup, cancellation, exact clipping, disposal and queue isolation regressions remain passing.

The opt-in `TREK_TERRAIN_PIPELINE_AUDIT=1` browser driver records only numeric job metadata/timing and loading stages. It counts actual position/normal/base bytes and the equivalent bytes the previous transport would send for those same jobs. It stores no buffers, credentials or room/head poses. That within-run byte comparison avoids conflating fewer copied bytes with changes in cold service timing or job counts. It is not a memory-usage or native frame-rate measurement.

Native 72 Hz acceptance, fine-ground loading throughout the tour, terrain churn and broad overview detail remain open. The user deferred the headset run; desktop checks do not close those gates.

## Local desktop results

The [baseline audit](worker-transport/baseline.json) runs the clean published `e3d5b88` application. The [updated full tour](worker-transport/local.json) uses `83571fa-modified-2026-10-20T23:35:35.316Z`, entry `index-Czq3QQ20.js`. This local client precedes the final additional error-response recovery guard; the clean hosted release is verified separately.

| Same updated jobs | Previous transport's equivalent bytes | Actual bytes sent |
| --- | ---: | ---: |
| Surface positions/normals | 1,765,508,616 | 489,675,816 |
| Immutable chunk base heights | 551,814,900 | 499,380 |
| Combined | 2,317,323,516 | 490,175,196 |

This eliminates **78.85%** of those array bytes for exactly the same updated jobs: 72.26% of surface arrays and 99.91% of base heights. It does not count local DEM grid data, result buffers, metadata, total memory or avoided work as a frame-rate improvement. Surface post calls in the updated run total 331 ms with a 15.2 ms maximum; chunk post calls total 1,044 ms with a 3.7 ms maximum. Network/phasing and job counts differ between runs (369 versus 189 surface jobs, 1,017 versus 1,105 chunk jobs), so total elapsed reductions are not a controlled percentage speedup. Geometry churn remains material.

Fine ground is ready in 293/368 updated playing/following samples (79.6%), versus 266/368 in the separate baseline. Cold-network variability prevents attributing that difference entirely to this change. The updated stages are 293 visible, 42 fetching, 17 decoded, 15 ready and one building, with no queued or unplanned current tile. The baseline has 11 unplanned current-tile samples. First fine observation is 1.755 s versus 2.005 s after monitoring starts; neither is universal service latency. Two workers remain alive without restarts, and page/GL errors are absent. Source spacing and approximately 4.96 m local / 94 m broad mesh spacing remain unchanged.

[Controlled geographic/stereo/fade/recovery checks](worker-transport/controlled-local.json) pass the existing image tolerances and restore a bitwise-identical image after actual context loss. [Desktop/mobile controls](worker-transport/controls-local.json) pass following, anchored model ownership, manual takeover, imports, landmarks and sampled ridge clearance. The full real-source tour also passes image and marker parity gates.

## Published checkpoint

Application `b030fe92b6b778488515686debfbb1830ac68821` passed [CI](https://github.com/delphimon/trekviewer/actions/runs/39516535269), was rebuilt with a clean working tree and credential-scanned, and published successfully to [TrekViewer](https://trekviewer.surge.sh/). Exact build: `b030fe9-2026-10-20T23:40:30.749Z`, entry `index-DXbbfaqQ.js`.

The [hosted full-tour audit](worker-transport/hosted-full-tour-b030fe9.json) confirms that exact client and finishes progress 1. Surface/base array traffic is **484,413,828 bytes versus 2,218,954,380 equivalent previous-transport bytes**, a **78.17%** reduction within the same jobs. Two workers remain alive without restarts. Fine ground is ready in **286/368** playing/following samples (77.7%), with first fine observation 2.003 seconds after monitoring starts. Its remaining stages are 46 fetching, 18 decoded, 15 building and three ready, with no queued/unplanned current tile. The run still creates 1,135 chunk jobs and 201 surface jobs; transport optimization has not solved terrain churn.

Actual surface post calls total 311 ms (14.2 ms maximum), while chunk posts total 1,002 ms (2.7 ms maximum). These remain desktop instrumentation with deliberate comparison work, not a native frame budget. Image gates pass with at most 0.05591/255 mean error, 1.5691/255 RMS and 0.672% changed pixels; marker checks pass. No page/GL errors occur. The [hosted geographic/stereo/fade/recovery fixture](worker-transport/controlled-hosted-b030fe9.json) retains the earlier image results and bitwise-identical recovery. [Hosted desktop/mobile controls](worker-transport/controls-hosted-b030fe9.json) pass the normal lifecycle, following, import and navigation gates.

The clean client's [private Bing account-path compatibility check](worker-transport/private-bing-b030fe9.json) passes a separate 30-second tour, focus and visual gates without exposing the token. Its supplying imagery aggregates under the existing “other” source label, so this is an account-path compatibility check, not a provider-wide Bing quality/coverage certification. Private configuration remains confined to browser memory; the published distribution uses the public default.

The evidence-only follow-up retains the measured clean application build. Native acceptance and the remaining loading/DEM-quality gates stay open.
