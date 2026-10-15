# Exact imagery projection CPU checkpoint

Terrain patch vertices on the same row previously recalculated the same geographic latitude and Web Mercator ordinate. Main-thread patch creation and worker surface promotion also maintained separate copies of that projection.

Both now use `createTileUVMapper`. It precomputes the constant longitude scale and tile span, then caches the vertical texture coordinate by exact local Z. The cache retains at most 4,096 numeric rows and lasts for one patch build. Eviction recomputes the original expression. The arithmetic order, latitude clamp and mapping at tile edges stay the same.

This reduces CPU work while preserving source pixels, mesh density, geometry clipping, smooth normals, tile selection, filtering, and the broad High-detail field. It adds no GPU resource and makes no source-provider or licensing changes.

## Measured construction cost

[Benchmark](projection/benchmark-projection.mjs), [raw results](projection/benchmark.json). Baseline: `24acdf8310873db1930c5ecfc2eb934b899fc2df`.

The benchmark runs the actual previous and current worker surface-patch builders. Its synthetic source combines a 62.5 m base grid and 5 m detail grid, including the masked base surface and clipped tile boundaries. Each fixture alternates version order, discards 40 warmup batches and measures 120 batches.

| Zoom / patches | Output vertices / triangles | Previous median / p95 | Current median / p95 |
| --- | --- | --- | --- |
| Z16 / 4 | 24,876 / 43,403 | 12.255 / 16.284 ms | 9.739 / 13.524 ms |
| Z18 / 9 | 6,950 / 9,334 | 3.755 / 5.782 ms | 3.074 / 5.285 ms |
| Z19 / 16 | 4,516 / 4,904 | 2.446 / 3.785 ms | 2.087 / 3.633 ms |

Median CPU construction time fell approximately 15–21% in these fixtures. Every position, normal, UV and index buffer matched the previous builder bit for bit. These measurements exclude worker messaging, network access, GPU rendering and application frame rate. They do not establish a Quest FPS gain or faster public-service downloads.

## Verification

The new regression coverage compares 700 exact double-precision UV pairs at multiple zooms and latitudes, including polar and antimeridian tiles, latitude clamping, tile corners and fractional clipped coordinates. It also checks shared-row reuse, exact recomputation after eviction and independence between projection contexts. Existing surface-promotion tests continue to compare complete terrain triangles, normals and geographic UVs, including atomic publication and parent restoration.

The [verification log](projection/verify.log) records source/test type checking, **543 passed tests** with five POSIX-only tests skipped on Windows, and the production build. Linux CI runs those five tests too. A [focused rerun](projection/edge-tests.log) also covers the extended latitude-clamp inputs. The existing large-main-chunk and Node-only LERC branch advisories remain. The [live browser harness](../review-2026-10-13/sources/browser-sources.mjs) checks full-field walking and turning detail, native USGS grids, approximately 5 m mesh cells, resident vertex limits, distinct export groups and mobile fitting. Archived results are under `projection/browser`.

The [final live result](projection/browser/browser.json) passed all 25 walking terrain hits and all 23 turned terrain hits with Z19 imagery and USGS local grids; two turned rays hit sky. Walking retained 48 native chunks / 451,632 local vertices, and turning retained 50 / 470,450. Sampled cells remained approximately 5 m, and retained vertices stayed below 800,000. Mobile credits remained within the 390 px viewport, and visual inspection confirmed centred terrain after Fit. JavaScript exceptions, console warnings/errors and WebGL errors were zero. Additional guard-region downloads remained queued.

Public-service refinement took 60.3 s initially and 40.2 s after turning. Those are live network observations, not the CPU construction benchmark or evidence of a download-latency change.

No Quest was connected. The browser uses real desktop Edge WebGL with a Quest user-agent to select Quest High budgets; it does not measure headset GPU time, thermals, comfort or memory pressure. Device profiling remains pending under the [Meta WebXR performance workflow](https://developers.meta.com/vr/documentation/web/webxr-perf-workflow). The earlier [pixel-repeatability limitation](VISIBILITY.md) also remains; this checkpoint's exact comparison concerns geometry buffers and UV values.

## Reproduction

From the repository root, run `node --experimental-transform-types docs/review-2026-10-15/projection/benchmark-projection.mjs`. It reads the baseline builder from Git history and writes ignored output under `.review-cache/projection`.

After `npm run build`, set `TREK_SOURCES_OUT=.review-cache/projection/browser` and `TREK_SOURCE_STYLE=satellite`, then run `node docs/review-2026-10-13/sources/browser-sources.mjs`. The script records its local Edge/Playwright dependency paths and starts/closes its own preview process. Public imagery/elevation services must be reachable.
