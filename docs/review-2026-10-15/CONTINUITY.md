# VR/MR imagery continuity

Head movement changed the requested tile footprint immediately. The previous visibility pass then hid resident tiles outside that footprint, including imagery already shown at full resolution. An expanded or evicted sibling group could hide its surviving children too. View-mode changes explicitly cleared the selection and hid every resident patch. Keeping textures in a warm cache did not preserve their visible coverage.

Publication now has its own bounded lifetime: a tile admitted for display stays eligible until eviction or style replacement. Published imagery does not expire by age while there is spare resident capacity. New finest-detail groups still appear atomically when their selected siblings are ready; coarse parents can fill incomplete regions, and incomplete replacements cannot revoke previously published detail. A coarse fallback disappears only when opaque descendants cover all four child regions, including coverage through an evicted intermediate level. If one child is evicted, surviving detail remains visible above the fallback.

Partial fine coverage and coarse fallback can coexist. Imagery now renders from coarse to fine with increasing depth bias, below the trail's render order and depth bias. Eviction favors unselected residents over selected tiles, preventing repeated eviction and downloading of requested children. Loading parents have a retention preference rather than an absolute exemption from the memory budget. Bulk eviction updates visibility once after the batch.

High tabletop coverage now uses the existing geographic hysteresis for its central tile footprint. View sampling unprojects both eyes' actual projection matrices and world transforms, including asymmetric frusta. Per-eye viewport height takes precedence over the combined XR framebuffer height. Existing source resolution, High/Balanced budgets, filtering, native DEM selection and terrain mesh spacing remain unchanged.

## Regression checks

Four new continuity cases failed before the implementation: repeated selection changes with delayed replacements, cleared selection during a mode switch, expansion of a published perimeter group, and sibling eviction. They now pass. The eleven new cases cover those failures plus age retention with spare capacity, bounded eviction during fading, coverage through missing intermediate levels, asymmetric eye rays, per-eye viewport dimensions, admission of incomplete new groups and depth ordering relative to the trail.

Existing tests that required hiding published imagery during a mode switch or sibling eviction now require preserving it. Initial sibling-group atomicity, fades, retries, cancellation, source policies, resource cleanup and mesh promotion checks remain enabled.

`npm run verify` passed source and test type checking, **554 tests**, five POSIX-only tests skipped on Windows, and the production build. Linux CI runs those five tests as well. The existing main-chunk size and LERC Node-module build advisories remain. [Verification log](continuity/verify.log).

## Browser reproduction

[Browser harness](continuity/browser-continuity.mjs). It runs actual desktop Edge WebGL, loads live public Rainier imagery with Quest High budgets, then supplies synthetic stereo cameras with asymmetric projections to the production XR imagery update path. It waits for detail outside the stable nearby core before holding subsequent exports, alternates 40 yaw/pitch poses, resets the selection through both view modes and returns to the original pose. Each checkpoint checks that retained Z19 imagery stays visible, the resident tile/terrain vertex budgets hold, and WebGL reports no error.

For comparison, the harness runs the visibility method from `a7b06c2623c7850d5e3673c847f18504184f00ce` synchronously on the same state, records lost detail and restores current visibility before the frame renders. This is a visibility comparison, not a pixel-identity test. It explicitly requires the previous method to lose coverage during mode changes and requires at least one actual delayed export request.

[Final browser result](continuity/browser.json), [returned view](continuity/returned.png): 308 resident tiles, 232 tracked published Z19 tiles. The previous method hid up to **52** tracked tiles during head turns and all **232** during each mode reset. The fixed method hid **zero**, including after deliberately aging the tracked tiles with spare capacity. None of the tracked tiles were evicted. The final terrain retained 461,041 local vertices, below the 800,000 Quest High resident limit. The run recorded one deliberately held export, zero JavaScript exceptions and zero WebGL errors. One public USGS export produced a CORS/network failure, recorded as two console messages; existing published detail stayed visible. The test checks continuity of downloaded detail while replacement data is delayed, rather than requiring every new request to finish.

The harness renders the desktop view monoscopically; the synthetic cameras exercise selection and retention, not a native XR compositor. No Quest was connected. Actual headset GPU timing, memory pressure, thermal behavior and subjective clarity remain unverified, following the [Meta WebXR profiling workflow](https://developers.meta.com/vr/documentation/web/webxr-perf-workflow).

## Reproduction commands

Run `npm run verify`, then `node docs/review-2026-10-15/continuity/browser-continuity.mjs`. The browser harness records its local Edge/Playwright paths and starts/closes its own HTTPS preview. Output defaults to ignored `.review-cache/continuity/browser`.

Run `node --experimental-transform-types docs/review-2026-10-15/continuity/benchmark-continuity.mjs` for the isolated CPU check. It uses inert meshes and real broad tile selections with changed view anchors, compares visibility against the same baseline commit, and measures visibility passes only. It does not measure network latency, complete frame time, GPU work or Quest performance.

## CPU cost

[Raw CPU result](continuity/benchmark.json). The benchmark fills 479 of 512 and 735 of 768 resident slots with real broad selections, then changes the view anchors without completing any new downloads. It alternates version order and measures 100 batches after 40 warmup batches, with ten visibility passes per batch.

| Resident patches | Previous fine tiles lost | Current fine tiles lost | Previous median / p95 | Current median / p95 |
| --- | --- | --- | --- | --- |
| 479 | 92 | 0 | 0.379 / 0.408 ms | 0.519 / 0.555 ms |
| 735 | 228 | 0 | 0.625 / 0.671 ms | 0.812 / 0.859 ms |

Preserving published coverage and resolving overlapping ancestors adds approximately 0.14–0.19 ms to these desktop CPU fixtures. This is a fidelity/stability fix with a measured CPU cost, not a frame-rate improvement. Retained textures and meshes remain within their existing budgets. More retained meshes may be eligible for rendering, subject to normal frustum culling; actual Quest draw cost still needs a headset measurement.
