# Native MR trail capture and imagery service failover

The physical Quest 3 test captured **94.5 seconds of Passthrough MR in Walk Trail (1:1)** on published build `feb2b33`. The app's completed report identifies that build, and its loaded script matches the release. The earlier recording attached to another tab captured no XR and is excluded.

[Native summary](native/mr-summary.json), [completed application profile](native/mr-profile.json).

## What the headset showed

There are 86 confirmed MR/first-person snapshots with two eye cameras, spanning 87.2 seconds within the session. The target initially reported 90 Hz before settling at 72 Hz. Sixteen published Z19 tiles were tracked near the end; none became hidden while still resident, and none were evicted. There were no JavaScript exceptions or WebGL context losses. The previous resize-during-XR warning did not recur; the unsupported parallel-shader extension warning remained.

This is **retention evidence, not satisfactory fine-detail coverage**. Only 9 of 93 one-second windows with terrain view samples had any Z19 view hits. Selected fine-tile readiness peaked at 7%; this percentage describes the selected tile set, not the fraction of screen pixels. The final sampled view still used Z14 imagery. The DEM remained USGS 3DEP best available, with approximately 1 m source sampling and 4.98 × 4.97 m local mesh cells.

For the 94 windows reporting a 72 Hz target, median callback rate was 69.1 Hz and median per-window CPU-submission p95 was 16.7 ms. Callback rate ranged from 37.2 to 73.5 Hz; short-window rates can exceed the target because of sampling boundaries. These are browser callback/submission measurements, not compositor FPS or GPU completion times. The user changed route progress and head pose, so this is not a controlled comparison with the earlier tabletop VR run.

## Repeated source timeouts stalled sharp imagery

Resource timing retrieved after the run showed eight requests to the preferred USGS NAIP+ export service ending at roughly 35 seconds each, with status zero. The recorder observed matching cancelled image requests. Eight requests to the configured GeoPlatform NAIP+ fallback returned status 200 in 1.14–2.25 seconds. Some resource completions occurred just after XR exit.

The cache already deduplicated each 1024-pixel source raster and temporarily remembered failures of its exact URL. Every new geographic export had a different bounding-box query, however, so each group could wait through another timeout at the same unavailable service. Four request groups repeatedly spent their slots waiting while much of the view remained coarse.

## Change

For shared raster loads, network failures now temporarily move that provider/service endpoint behind its other configured sources. The cooldown lasts five minutes and is scoped to the provider and URL path; different bounding-box queries share it, while other export services on the same host remain independent. State is bounded to 128 endpoints and cleared with the tile cache.

The provider's original source order is retained when no endpoint is cooling down and restored after expiry. Cached preferred rasters retain precedence. If healthier alternatives also fail, the loader still tries the cooling endpoint; a successful network response removes its cooldown. Geographic NoData/coverage rejection occurs outside this transport check and does not mark the whole service unavailable. Stale requests cannot repopulate failure state after a cache clear.

This keeps the same source list, image sizes, lossless formats, geographic crops, coverage checks, Z19 target, DEM resolution and resident budgets. It does not race extra downloads or replace fine imagery with an upscaled overview. The first failure may still take the existing 35-second timeout; the change prevents repeating that delay for every new export during the outage.

## Verification and limits

`npm run verify` passed TypeScript checks, **563 Windows tests with five POSIX-only tests skipped**, and the production build. Linux CI runs all 568 tests. [Verification log](native/mr-verify.log). Five new regressions cover cooldown expiry, reuse of cached preferred imagery, geographic coverage rejection, recovery when the alternate also fails, and stale completion after cache clear. Existing source, cache, request-group and imagery continuity tests remain in the suite.

[Production browser harness](native/browser-failover.mjs), [saved result](native/browser-failover.json). Actual Edge exercised desktop 1:1 mode with the preferred export endpoint deliberately aborted while loading real public terrain and the configured NAIP alternatives. Startup and the mode transition can each admit four source groups before failure callbacks arrive. In the saved run there were five initial preferred-service requests, with no additional requests to that endpoint while visible Z19 coverage grew from at least 16 to **70 tiles**. All were opaque 256-pixel crops from the actual USGS NAIP export, with zero JavaScript exceptions or WebGL errors.

GeoPlatform rejected this localhost browser origin with CORS errors, so this browser run also exercised the next configured USGS NAIP source. The expected blocked-request warnings and real CORS errors are retained in the result. This is a controlled transport regression, **not a new native MR result**. The native capture above predates this loader fix; a future headset run must establish the resulting view coverage and frame pacing.

No room screenshots or raw head-pose samples are included in these published artifacts. Meta's [browser debugging guide](https://developers.meta.com/horizon/documentation/web/browser-remote-debugging/) and [WebXR profiling workflow](https://developers.meta.com/horizon/documentation/web/webxr-perf-workflow/) guide the hardware checks.
