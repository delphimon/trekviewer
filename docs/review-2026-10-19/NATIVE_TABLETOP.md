# Quest 3 tabletop baseline: quality regression remains open

On October 19, 2026, the user tested Olympus/Bailey in MR on the published `9cc6afa` client. Their assessment was that performance, tile loading/resolution and terrain shape looked noticeably worse than before, and that the earlier Bing/Google experience looked better. **This build is not accepted for visual quality or performance.** Restoring the diorama experience takes priority over additional flyover features.

## Completed capture

The executed entry was `index-CXtPO2AM.js`, with build ID `9cc6afa-2026-10-20T03:32:03.732Z`. The route was prepared at progress 0.3555875547854273, High/Aerial, 1× vertical exaggeration, tour timing and 1× speed, paused. Resource caches were already warm; this is not a controlled cold-start comparison.

The **154.9-second** report was committed to device storage and copied to the host immediately on MR exit. There are 153 report windows, of which **152 have native stereo state**; the final window records session exit. Runtime state confirms alpha-blend MR, a projection layer of 3360×1760 with two 1680×1760 eye viewports, requested/reported foveation 0, and a 72 Hz target. These are runtime-reported settings, not proof of display sharpness. The host observed no page exceptions or graphics-context loss.

[Profile](native-tabletop/profile.json), [computed analysis](native-tabletop/analysis.json), [analysis script](native-tabletop/analyze.mjs). Reproduce the aggregates with `node docs/review-2026-10-19/native-tabletop/analyze.mjs`. The profile contains route/build/browser/performance metadata, without recorded room images or head/controller pose arrays. Raw CPU/Perfetto captures remain local in ignored `.review-cache/quest-diorama-9cc6afa/`.

The user exercised two short playback segments totaling **10.26 seconds**. A complete 90-second tour, sustained thermal acceptance, VR/MR transitions and restart recovery are not established by this run.

## Performance and loading evidence

The eight-second native trace contains 144,914 slices over 8.025 seconds. [Trace validation](native-tabletop/trace-quality.json), [runtime counters](native-tabletop/trace-counters.json), [browser CPU threads](native-tabletop/trace-cpu.json).

| Measurement | Observed result | Meaning and limit |
| --- | --- | --- |
| Browser FPS runtime counter | Sample mean **39.408**, range 30–48, 319 samples | Below the 72 Hz application target during this short, instrumented trace. Not a sustained acceptance result. |
| Browser `app_gpu_ms` | Sample mean **12.693 ms**, maximum **17.056 ms**, eight samples | GPU cost can exceed the 13.9 ms target budget. Sparse runtime samples are not a per-frame p95 distribution. |
| Active browser renderer main thread | 5,655.7 ms scheduled CPU during the trace | Substantial CPU work alongside GPU pressure; not evidence that only one side limits performance. |
| App callback rate outside marked diagnostics and first ten seconds | Mean of window callback rates **35.07 Hz**, across 96 windows / 97.59 s | Browser scheduling measurement, separate from compositor/frame-delivery metrics. |
| CPU submission outside those intervals | Mean of window p95 values **21.98 ms** | This is not an overall p95. Frame-weighted measured render phase averages 10.66 ms; imagery averages 1.76 ms. |
| Three.js draw calls | Peak **1,156** | Reported frame submission count, not a claim about a single eye or material alone. |
| Imagery turnover within native windows | **3,016 creations and 3,016 disposals** | Broad inspection/manipulation occurred; this does not prove all turnover happened while stationary. |
| Selected imagery coverage | Incomplete in **152/152 native windows** | This counter is selected tile coverage, not the percentage of visible pixels left blank. |
| HUD redraw-upload requests | Sampled increase **1,514** | Logical source requests, not measured GPU transfer bytes. Frequent uploads during a mostly paused run warrant investigation. |

The recorder marked CPU sampling at 31.454–39.896 s and the broader Perfetto setup/capture/copy interval at 64.049–100.659 s. Baseline aggregates exclude every window overlapping those intervals and the first ten seconds. Native GPU/FPS results necessarily come from the instrumented trace. System GPU/shader counters include other runtime work; the runtime `Stale` counter is not interpreted as a browser stale-frame percentage. Thermal endurance and compositor stale/reprojection percentages remain unmeasured.

## Why a local 1 m source does not establish whole-model fidelity

A read-only [terrain snapshot](native-tabletop/terrain.json) after the session found real elevation data, rather than a completely missing or zero-height DEM:

- The whole base spans **40.90 × 26.93 km**. Its 434×286 mesh cells are approximately **94 m** apart.
- The whole-model USGS export is 1024×675 samples, approximately **44 m** apart. It contains elevations from about 114 m to 2,408 m.
- Base mesh heights span about 2,255 m at the prepared **1×** exaggeration. This proves the mesh has relief, not that ridge shapes or the user's view were satisfactory.
- The approximately 1 m local source sampling seen in profile windows applies to refinement rasters, with approximately 5 m rendered local cells. It must not be presented as the whole model's resolution or a verified 1 m native survey everywhere.

Low-detail or unfinished imagery, coarse whole-model geometry, normal vertical proportions over a large geographic footprint and streaming instability must be evaluated separately. The user's report of flat-looking terrain remains a failed acceptance result; the existence of nonzero height data does not resolve it.

## Source comparison and recovery priority

History before `889fd7f` shows Esri World Imagery as the default, with an optional Bing Aerial path through Cesium ion. That commit changed auto selection to public imagery and enabled the USGS elevation preference. This verifies a source-policy change, not which optional token/provider was active in the user's remembered run. The original elevation implementation used AWS Terrarium. A Google photorealistic 3D model is a separate source/renderer path from this app's aerial imagery draped over a DEM.

Bing/Google options should be compared under the user's existing free personal/internal-use constraint, including eligible account access where needed. Cesium's [content guide](https://cesium.com/learn/ion/content-usage-and-attribution-guide/) only promises Bing access at least through September 2026; that is not confirmation of current October availability. Google's [Map Tiles overview](https://developers.google.com/maps/documentation/tile/overview) distinguishes 2D imagery and Photorealistic 3D Tiles. Do not silently substitute those products or promise an account/source is available before verifying it.

The next work is to reproduce a fixed paused tabletop view, compare current versus earlier eligible imagery and DEM at identical route/progress/framing, and preserve useful detail until replacements are ready. Measure time-to-sharp, whole-model ridge shape and loaded detail alongside frame delivery. Prototype batching compatible imagery sharing a source raster to reduce submission cost while preserving exact UVs, per-eye visibility, fallback coverage and High's detail. Investigate unnecessary HUD uploads separately. Recheck a matched native scene after a concrete change; do not claim restoration from unit tests or source pixel sizes alone.
