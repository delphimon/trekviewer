# Imagery visibility CPU checkpoint

The broader High-detail selection and shared-source scheduling increase the number of imagery tiles that can arrive together. Previously, each visibility pass repeatedly split the same tile keys and reconstructed their parent and child keys. Queue sorting also refreshed the same sibling group once for each queued sibling.

The manager now retains fixed tile relationships in a per-instance, FIFO-bounded cache of at most 4,096 keys. A tile's style, coordinates and zoom determine those relationships. Loaded state, selected state, fade state and readiness are not retained in that cache. Style replacement and disposal clear it.

Each queue sort computes readiness once per parent, then discards those counts. Later sorts see newly loaded children immediately. This preserves the synchronous priority of a missing fourth sibling and the existing atomic visibility rules. No source data, selected tiles, mesh spacing, texture filtering, image resolution or GPU budgets change.

## Isolated CPU measurement

[Benchmark script](relations/benchmark-relations.mjs), [raw result](relations/benchmark.json). Baseline: `4b26935db4fc44e3a63348732c4730205fc3806f`.

Both versions run their production visibility and queue-sort methods in Node 24.21. The broad High selections use the real candidate generator with synthetic view anchors and inert patch meshes. Half the selected tiles are loaded; the remainder are queued. Samples alternate version order, discard 40 warmup batches and measure 100 batches of ten combined operations.

| Selection | Loaded / queued | Previous median / p95 | Current median / p95 |
| --- | --- | --- | --- |
| 478 tiles, 512 budget | 239 / 239 | 1.362 / 1.527 ms | 0.376 / 0.457 ms |
| 491 tiles, 768 budget | 245 / 246 | 1.385 / 1.439 ms | 0.343 / 0.389 ms |

Median CPU time for this isolated operation fell approximately 72–75%. These fixtures do not fill every budget slot and do not measure application frame rate, GPU time, source latency or Quest performance. The small CPU metadata cache is additional memory; image and GPU budgets remain unchanged.

The same script compares 48 states against the baseline: four loading fractions, fading on/off, and full, restricted or empty selections for each fixture. Visible tile keys, refinement-group states and ready children, and sorted queue keys/priorities match exactly. This includes retained tiles from previous selections.

## Verification

`npm run verify` passed source/test type checking, **540 tests** with five POSIX-only tests skipped on Windows, and the production build. Linux CI runs those five tests too. [Verification log](relations/verify.log).

Three new regression cases check once-per-parent sorting with fresh readiness on the next sort, bounded cache eviction/recomputation, and separation/release across style and zoom changes. Existing atomic promotion, partial coverage, first-person selection, fading, source policy and cancellation tests remain enabled. The existing main-chunk and Node-only LERC build advisories remain.

The [browser harness](../review-2026-10-13/sources/browser-sources.mjs) checks actual Edge WebGL with live public sources: Rainier at progress 0.4, 25 screen rays, then a 25° turn. Each terrain hit must have Z19 imagery, a USGS local grid and approximately 5 m mesh cells; retained terrain stays under the Quest High vertex limit. It also checks unique export groups, mobile fitting and attribution bounds. Quest user-agent selection is a desktop budget test only.

The [final quality run](relations/browser/browser.json) passed: all 25 walking terrain hits and all 23 turned terrain hits had Z19 imagery and USGS local grids (two turned rays hit sky). Walking retained 48 native chunks / 451,632 local vertices; turning retained 50 / 470,450. All sampled mesh cells remained approximately 5 m. Mobile credits stayed inside the 390 px viewport, and visual inspection confirmed centred terrain after Fit. JavaScript exceptions, WebGL errors and console warnings/errors were all zero. Additional guard-region requests remained queued.

Public-service refinement took 40.3 s initially and 65.3 s after the turn in this run. This checkpoint does not claim a download-latency improvement; its measured gain is CPU work with fixed resident/queued data. Live service/cache state is uncontrolled, and response delays remain material.

For the visual diagnostic, the benchmark generates the baseline visibility/sort methods from the recorded commit. A [focused browser script](relations/browser-pixels.mjs) stops the animation loop after initial aerial patches load, warms the renderer, then reads the same scene directly from WebGL with current code, an unchanged-code control and baseline code. Visibility/queue state matched exactly, with 12 visible patches and no JavaScript, console or WebGL errors.

**Exact pixel equality is inconclusive in this browser environment.** The unchanged-code control itself differed in 1,178 of 4,049,172 channels, with a maximum change of one 8-bit colour step. The baseline comparison differed in 1,141 channels, also by at most one step. The [raw comparison](relations/pixels/comparison.json) explicitly records the inconclusive result. No exact pixel-match or cause for that variation is claimed. The initial strict PNG/raw equality checks failed on their unchanged-code controls; the diagnostic now treats repeatability as a precondition for an exact-pixel conclusion. The independent state comparisons and live quality checks remain the rendering-behavior evidence.

No Quest device was connected. On-headset CPU/GPU timing, memory pressure, thermal behavior and subjective clarity remain pending, following the [Meta WebXR profiling workflow](https://developers.meta.com/vr/documentation/web/webxr-perf-workflow).

## Reproduction

Run `node --experimental-transform-types docs/review-2026-10-15/relations/benchmark-relations.mjs` from the repository root. It requires the baseline Git commit and generates the result and browser baseline in ignored `.review-cache/relations`.

After `npm run build`, set `TREK_SOURCES_OUT=.review-cache/relations/quality` and `TREK_SOURCE_STYLE=satellite`, then run `node docs/review-2026-10-13/sources/browser-sources.mjs`. Run `node docs/review-2026-10-15/relations/browser-pixels.mjs` for the separate pixel diagnostic after generating its baseline with the benchmark. Each script records local Edge/Playwright paths and starts/closes its own preview process. Archived quality results are under `relations/browser`; diagnostic results are under `relations/pixels`.
