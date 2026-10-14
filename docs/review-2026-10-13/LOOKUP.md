# Local trail lookup continuation

Implemented October 14, 2026, after the [terrain framing work](FRAMING.md).

## Implementation

Terrain refinement reprojects the trail inside a local X/Z rectangle. The existing spatial index still inspected every occupied bucket and split its string key for each query. The index now stores numeric columns and rows and looks up cells inside small rectangles directly. For broad or sparse footprints it visits occupied buckets instead of iterating a large empty grid.

Query ranges are clamped to the indexed extent. Empty indexes and reversed, disjoint or NaN ranges return no vertices. Open-ended ranges use the bounded index; coordinates beyond safe integer increments use the occupied-bucket path. Bucket insertion order and vertex order are preserved, including trails that revisit a cell. Unbounded full-trail queries retain their original vertex order.

This changes lookup and index-construction work. Elevation sampling, ribbon station density, positions, normals, upload ranges, colors and direction chevrons use their existing algorithms. It introduces no render objects, textures or draw calls, and keeps the existing terrain and imagery budgets.

## Isolated CPU measurements

The [benchmark](lookup/benchmark-lookup.mjs) compares the [saved previous index](lookup/SurfaceVertexIndex-before.ts) with current production source. Rainier and Glacier Peak use their real GPX files and production tabletop ribbon construction with a flat elevation sampler. The synthetic case has 100,002 vertices along four approximately 100 km legs within a 100 km extent; it is a geometry stress fixture rather than a validated imported trek.

For each fixture and query size, the harness verifies identical ordered selections, warms up for 40 batches, then measures 200 batches of 24 queries. Construction uses 20 warm-up and 40 measured instances with normal adjacency disabled, matching the tabletop index. These are isolated Node 24.21.0 CPU timings; they exclude network, GPU, normal rebuilding and whole-route loading.

| Fixture / vertices | Footprint | Previous median / p95 per query | Current median / p95 per query |
| --- | --- | --- | --- |
| Rainier / 6,886 | 300 m square | 0.01173 / 0.01515 ms | 0.00262 / 0.00309 ms |
| Rainier / 6,886 | 1,300 m square | 0.01753 / 0.02261 ms | 0.00770 / 0.01015 ms |
| Rainier / 6,886 | Entire ribbon | 0.06816 / 0.08652 ms | 0.04935 / 0.06145 ms |
| Glacier Peak / 13,640 | 300 m square | 0.01903 / 0.02598 ms | 0.00248 / 0.00333 ms |
| Glacier Peak / 13,640 | 1,300 m square | 0.02611 / 0.03292 ms | 0.00765 / 0.00892 ms |
| Glacier Peak / 13,640 | Entire ribbon | 0.13054 / 0.15191 ms | 0.09022 / 0.11422 ms |
| Synthetic / 100,002 | 300 m square | 0.26751 / 0.28460 ms | 0.00250 / 0.00345 ms |
| Synthetic / 100,002 | 1,300 m square | 0.27657 / 0.29500 ms | 0.01010 / 0.01316 ms |
| Synthetic / 100,002 | Entire ribbon | 1.77438 / 1.86679 ms | 1.38832 / 1.45632 ms |

The real-trek 300 m lookups show approximately 4.5–7.7 times lower median CPU cost. The synthetic small-footprint gain is larger because the previous query scans many remote buckets. Broad queries still inspect many vertices; these results do not establish application FPS or whole-refinement speedups.

| Tabletop index construction | Previous median / p95 | Current median / p95 |
| --- | --- | --- |
| Rainier | 0.5934 / 0.6408 ms | 0.2646 / 0.3342 ms |
| Glacier Peak | 1.0378 / 1.1995 ms | 0.4771 / 0.5099 ms |
| Synthetic | 8.0936 / 8.6725 ms | 3.8572 / 4.3098 ms |

Construction is roughly twice as fast in these cases. This is not a measured cold-start improvement for the entire viewer. [Raw benchmark results](lookup/lookup-benchmark.json) retain the sample counts and selected vertex counts. Run from the repository root with `node --experimental-transform-types docs/review-2026-10-13/lookup/benchmark-lookup.mjs`; Node emits its normal experimental transform warning.

## Rendering and verification

The production [browser comparison](lookup/browser.json) uses the previous index to apply a reference reprojection to the live tabletop and walking ribbons, restores their original arrays, then invokes current production reprojection for the same 1,300 m footprint and rendered-surface sampler. It checks both complete position and normal buffers for exact equality. DEM publication and animation are paused for the comparison after imagery reaches 100% desired coverage with no queued or active requests.

The final [previous](lookup/previous-lookup.png) and [current](lookup/current-lookup.png) screenshots have zero differing decoded pixels out of 1,012,293. Unchanged-render controls also have zero differences. An earlier comparison differed by one channel step at one pixel; the harness allows at most four pixels differing by one channel step for GPU/compositor rounding. Geometry equality remains exact. Both final renders have 63 draw calls, 84 resident textures and zero GL errors; the 80-patch budget and 100% imagery coverage are preserved. Texture counts do not measure total GPU memory.

| Check | Result |
| --- | --- |
| Source and test TypeScript checks | Passed |
| Full Vitest suite | [486 passed, 5 POSIX packaging fixtures skipped on Windows](lookup/tests.log); 92 files passed / 1 skipped |
| Production build | Passed; main JS 909.16 kB / 238.01 kB gzip; worker 210.77 kB |
| Production Edge comparison | Exact trail buffers; final decoded screenshots match; no page errors or console warnings/errors |
| Git whitespace check | Passed; existing line-ending notices only |
| Meta VR device listing | Empty |

New regressions compare localized, broad and sparse queries against exhaustive membership, retain interleaved cell order, test inclusive positive/negative boundaries, and bound invalid, infinite and very large coordinate queries. Existing conservative trail bounds, pending uploads, localized smooth normals, refinement and exaggeration regressions continue to pass.

The [browser harness](lookup/browser-lookup.mjs) runs from the repository root with `node docs/review-2026-10-13/lookup/browser-lookup.mjs`. It uses this environment's Windows Edge/Playwright paths and Node's experimental TypeScript stripping to load the saved reference index for comparison.

The Meta VR plugin documentation search identified the [official WebXR performance workflow](https://developers.meta.com/vr/documentation/web/webxr-perf-workflow), [performance tools](https://developers.meta.com/vr/documentation/web/webxr-perf-tools) and [best practices](https://developers.meta.com/vr/documentation/web/webxr-perf-bp). Desktop rendering uses ANGLE D3D11 on an NVIDIA RTX 4060. No Quest is connected; sustained headset FPS, GPU duration, thermals and comfort remain unverified. The main-bundle size warning remains.
