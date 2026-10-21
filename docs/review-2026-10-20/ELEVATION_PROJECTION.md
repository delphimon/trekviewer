# Reuse exact latitude projection during terrain sampling

DEM sampling calculated the same inverse hyperbolic/Mercator latitude twice per vertex. Regular terrain rows also repeat the same latitude for every column. The sampler now retains only the most recent exact latitude and its dimensionless projection, independently of grid identity, bounds, source values and validity. `Object.is` preserves signed-zero/NaN input distinctions. Different latitudes recalculate normally; changing grids, raster bounds, decoded data or validity masks always resamples those current inputs. No DEM data, coordinates or image pixels are rounded or approximated, and resource/selection limits remain unchanged.

## Controlled measurement

The [alternating Node benchmark](elevation-projection/benchmark.json) compares with committed `83721f9`. It checks **187,308 exact sample matches** across regular rows, scattered points, USGS-style export bounds, XYZ tiles, missing tiles, NaN/Infinity samples, negative/extreme latitudes and out-of-range positions. A complete 23,409-vertex chunk built through each sampler has identical full build data, including positions, normals, UVs, indices, heights, bounds and fallback diagnostics.

Across three alternating 50-chunk passes, the median complete construction time falls from **712.9 ms to 589.9 ms**: approximately **14.26 to 11.80 ms per chunk (17.3% less)**. Regular-row sampling takes a median 64.57 to 36.80 ms per 468,180 samples. Scattered sampling takes 61.07 to 67.41 ms (about 10% more, or 6.34 ms per 468,180 samples). This is a deliberate optimization for the repeated rows dominating streamed grid construction; it is not a universal sampler speedup. The cache holds two scalars, with no retained DEM or historical coordinate collection.

Reproduce on Node 24 with `node --experimental-transform-types scripts/benchmark-elevation-projection.mjs`. These are isolated desktop CPU measurements, excluding message transport, GPU uploads, frames and native headset performance.

## Validation

`npm run verify` passes both typechecks, **712 Windows tests with five platform skips**, and the production build. The new regression alternates same-latitude samples across grids with different bounds, edits data and validity, changes latitude, returns to the original latitude and checks NoData. Existing registration, fallback, source and terrain tests remain passing.

The [local full tour](elevation-projection/local-tour.json) passes actual-image/marker gates without page/GL errors. Fine hiker ground appears in 350/367 samples (95.4%); 1,234 chunk jobs include 497 repeats. Neither loading nor churn is solved. Main-thread construction remains 0.1 ms median / 0.2 ms p95 after the preceding buffer-adoption checkpoint. Local/overview mesh spacing remains approximately 4.96/94 m and requested local DEM export spacing approximately 1.0001 m. Modified build: `83721f9-modified-2026-10-21T01:58:16.980Z`, entry `index-BSh1uPxU.js`.

[Desktop/mobile controls](elevation-projection/controls-local.json) and [geographic/stereo/fade/recovery checks](elevation-projection/controlled-local.json) pass. The latter restores a bitwise-identical image after actual context loss.

## Published checkpoint

Application `30f45a22d686b3a99ebe5a7279da03c2092bbb47` passed [CI](https://github.com/delphimon/trekviewer/actions/runs/39530766480), was rebuilt with a clean tree, credential-scanned and published successfully to [TrekViewer](https://trekviewer.surge.sh/). Exact build: `30f45a2-2026-10-21T02:02:45.804Z`, entry `index-Dun4cvqI.js`.

The [hosted complete-tour audit](elevation-projection/hosted-tour-30f45a2.json) confirms that exact client. Fine terrain is visible under the hiker in **357/368 samples (97.0%)**, with seven fetching, two decoded and two building samples. Upcoming ground is selected in all 368 samples. Main-thread construction remains **0.1 ms median / 0.2 ms p95**, with 242.7 ms total across 1,233 observations and a 13.8 ms maximum. The isolated 17.3% construction improvement above is a CPU benchmark result; this hosted tour does not establish the same percentage frame-time or source-loading improvement.

There are still 1,235 builds across 741 tile IDs (494 repeats), 1,207 publications (473 repeats) and 1,173 removals. The browser emits 1,386 export request events for 886 distinct URLs, including cancelled/cached requests rather than proven wire transfers. Application-ready takes 3.757 seconds and overview 4.999 seconds after navigation; first fine observation is 2.001 seconds after monitoring begins. Service/phasing variation remains uncontrolled, and churn/loading acceptance stays open.

Two workers remain alive without restarts. Source/mesh detail remains approximately 1.0001 m requested local export spacing and 4.96/94 m local/overview mesh cells. All image/marker gates pass without page/GL errors: maximum mean 0.05492/255, RMS 1.5137/255 and 0.650% changed pixels. [Hosted desktop/mobile controls](elevation-projection/controls-hosted-30f45a2.json) and [geographic/stereo/fade/context-recovery checks](elevation-projection/controlled-hosted-30f45a2.json) pass, retaining a bitwise-identical recovered image.

The separate [private account-path check](elevation-projection/private-bing-30f45a2.json) passes a 30-second hosted run with 119/124 fine-ground samples and the existing image/marker tolerances. Its imagery is still grouped as “other”; this verifies account-path compatibility rather than certifying Bing source quality/coverage. Credentials remain memory-only and absent from repository/hosted files. The evidence-only follow-up preserves this exact tested build.

## Remaining work

This reduces terrain CPU construction cost while preserving numeric results. Repeated builds/decoded grids, source latency, broad overview detail, GPU work and native 72 Hz/visual acceptance remain open. The user deferred headset testing; desktop measurements do not certify the headset experience.
