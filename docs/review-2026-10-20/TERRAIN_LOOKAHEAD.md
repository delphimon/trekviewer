# Prepare upcoming ground during diorama tours

Diorama Follow now gives upcoming hiker terrain second priority after the current ground tile. A pure playback query predicts distance progress 1.5 real seconds ahead using the active Tour/Track time basis and speed. The terrain loader samples the same smoothed visual route as the hiker, then reserves selection/acquisition priority for that ground within the existing focus radius, tile count and vertex budget. Current ground remains first, and completed useful work can still publish while its download is pending.

Pause, Stop following, manual takeover and leaving diorama playback remove the hint. Prediction does not advance playback, change telemetry, or move the camera/model. The selected fine tiles can differ because imminent route ground precedes peripheral view anchors; the view-driven remainder, broad parent coverage, source-native imagery, approximately 1 m requested local DEM exports, approximately 5 m local meshes, lighting and all High/Balanced limits remain retained. Predictions outside the existing focus radius cannot expand coverage or resource limits. Without a prediction, tile planning retains its original ordering and membership.

Warm terrain now records recent demand rather than retaining its original creation order. When capacity is needed, an older tile that was just useful again outlives stale unused coverage. Current desired tiles remain protected and old geometry stays visible until its replacement is prepared. This corrects a demonstrated eviction decision; it does not promise that an entire moving tour fits the bounded working set.

## Reproduction and limits

The clean `b030fe9` baseline produces 1,149 chunk builds across 688 distinct tile IDs in a complete desktop Olympus tour: **461 repeated builds**. It publishes 1,123 chunks across 684 IDs. The browser emits 1,345 USGS export request events for 856 distinct URLs. Those events include cancelled requests and browser HTTP caching; they are not a count of wire transfers or downloaded bytes. Only aggregate counts are saved, never request URLs.

Updating recency alone corrects the targeted regression but does not demonstrate lower tour churn: the separate recency-only run produces 1,174 builds across 692 IDs, with fine hiker terrain in 286/367 samples versus 277/368 in the baseline. Cold service timing and view/publication phasing vary. Keep churn and full-tour loading acceptance open, and measure prediction separately rather than attributing this variation to the eviction change.

An initial prototype only reordered tiles already selected by view anchors. It found upcoming ground in just 3/369 samples and did not improve the tour: 278/369 fine samples with 1,154 builds. The final planner reserves priority before applying its existing tile/vertex budget, retaining the same candidate radius and broad-view anchors. This directly addresses the measured admission problem rather than claiming the initial prototype helped.

`npm run verify` passes both typechecks, **709 Windows tests with five platform skips**, and the production build. Regressions check predicted Tour/Track progress against actual playback advancement, speed, pause/end behavior, no first-person prediction, current-before-upcoming preparation, priority admission under a crowded budget, ignored out-of-radius predictions, retained useful work when prediction stops, and corrected warm eviction. Application-loop tests cover desktop and XR wiring while preserving model-local focus through room transforms.

The full raw desktop reports remain locally under `.review-cache/terrain-churn/`. Committed audit summaries preserve build/entry identity, phase counts, per-tile build/publication counts, source/mesh spacing, all visual checks and worker state. They distinguish derived counts from native performance evidence. The driver records numeric terrain/job metadata, not credentials or room/head poses.

Native 72 Hz performance, subjective DEM quality, broad overview detail and complete tour loading remain open. The user deferred headset testing; this checkpoint does not request another run.

## Local full-tour result

The [baseline summary](terrain-lookahead/baseline.json), [recency-only summary](terrain-lookahead/recency-only.json), [initial reorder-only prototype](terrain-lookahead/reorder-only.json) and [reserved look-ahead summary](terrain-lookahead/reserved-local.json) retain the comparison. Reserving upcoming ground raises fine hiker coverage from **277/368 (75.3%)** in this baseline to **358/368 (97.3%)** locally. The prediction is admitted in all 368 playing/following samples. Remaining stages are eight fetching and two building samples, compared with 63 fetching, nine decoded, 11 ready, seven building and one queued in the baseline. Whole-tour playback finishes at progress 1, preserving model-local focus alignment.

The reserved run builds 1,091 chunks across 677 IDs (414 repeats) and publishes 1,063 across 673 IDs (390 repeats), versus 1,149 builds/461 repeats and 1,123 publications/439 repeats in the baseline. It emits 1,259 export request events for 828 unique URLs. These reductions are observations from uncontrolled cold-service/phasing runs, not proof of a fixed percentage CPU/network improvement. Churn remains material. One validation process overlaps part of this local run, so its timings are not an isolated performance comparison.

Sources, approximately 1 m requested local export spacing, approximately 4.96 m local / 94 m overview mesh cells and existing visual tolerances remain retained. Two workers remain alive without restarts. All real-source image/marker checks pass with no page/GL errors. This report is `62a1d95-modified-2026-10-21T00:19:20.289Z`, entry `index-Bhkpw1kR.js`; the final build also caches candidate priority classification before sorting without changing its order. Exact clean hosted validation is recorded separately.

## Published checkpoint

Application `4dbc044f5f50dec5020b21b7bffd3192f03d0ce8` passed [CI](https://github.com/delphimon/trekviewer/actions/runs/39520987794), was rebuilt with a clean working tree and credential-scanned, and published successfully to [TrekViewer](https://trekviewer.surge.sh/). Exact build: `4dbc044-2026-10-21T00:23:18.315Z`, entry `index-CYdkHLp5.js`.

The [hosted complete-tour audit](terrain-lookahead/hosted-full-tour-4dbc044.json) confirms that exact client. Fine DEM is ready under the hiker in **357/367 playing/following samples (97.3%)**, reproducing the local 97.3% result. Upcoming ground is selected in all 367 samples. The remaining stages are eight fetching and two decoded samples; there are no unplanned/queued current-tile samples. First fine observation is 2.775 seconds after monitoring begins; application-ready is 3.250 seconds after navigation. Service timing remains uncontrolled, and this does not certify all routes or native time-to-detail.

The hosted run still sends 1,251 chunk jobs across 735 IDs (516 repeats) and publishes 1,214 chunks across 731 IDs (483 repeats). Its 1,387 export request events cover 886 unique URLs. These counts exceed the separate baseline; **look-ahead improves hiker-ground availability, not proven overall terrain-work reduction**. Keep churn and frame-tail acceptance open. Two workers remain alive without restarts. Requested local export spacing is approximately 1.0001 m and rendered local/overview cells remain approximately 4.96/94 m.

All hosted imagery/marker gates pass with no page/GL errors: at most 0.05602/255 mean error, 1.5211/255 RMS and 0.662% changed pixels. [Hosted geographic/stereo/fade/recovery checks](terrain-lookahead/controlled-hosted-4dbc044.json) retain the previous image results and restore a bitwise-identical image after actual context loss. [Hosted desktop/mobile controls](terrain-lookahead/controls-hosted-4dbc044.json) pass upcoming-ground hint activation, pause cleanup, camera/model ownership, manual takeover, imports, sampled ridge clearance and navigation.

The clean application's [private Bing account-path check](terrain-lookahead/private-bing-4dbc044.json) passes a separate 30-second run with 119/124 fine hiker samples and the existing visual gates. Its supplying imagery is still grouped under “other”; this validates account-path compatibility, not Bing-wide source quality/coverage. Credentials remain browser-memory-only and the hosted default stays public-source.

The evidence-only follow-up retains this measured clean build. Native performance, broader DEM detail and remaining churn/loading gates remain open.
