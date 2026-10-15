# Quest 3 validation and terrain publication cost

The published `bbe298e` build was inspected on an authorized physical Quest 3 running Quest Browser 152.1.0.34.52, Chrome 152.0.7977.83, Android 14. The headset entered native VR with two eye cameras and a 72 Hz target. Normal proximity behavior was restored after browser setup. This is separate from the earlier desktop stereo-camera simulation.

## Native VR result

[Aggregate capture](native/vr-summary.json), [application profiler report](native/vr-profile.json).

There were 74 one-second native XR snapshots. Head pose, route position, terrain scale and vertical exaggeration changed during the run. Sixteen published Z19 tiles were observed near the end, in four XR snapshots; none became hidden while still resident, and none were evicted. There were no JavaScript exceptions or WebGL context losses. This is a short retention check, **not proof of full-view Z19 coverage**, memory-pressure behavior or a sustained thermal result.

The actual local terrain source was USGS 3DEP best available. Sampled mesh cells remained approximately 4.98 × 4.97 m. Resident local geometry peaked at 602,176 vertices and imagery at 386 patches, within the existing Quest High limits. No imagery zoom, source quality, mesh density, filtering or residency budget was reduced for this checkpoint.

The baseline did not consistently meet its 72 Hz target. After the first 15 seconds, median one-second callback rate was 61.8 Hz and median per-window CPU-submission p95 was 17.9 ms. One window's CPU-submission p95 reached 1,164.6 ms during this interactive run. Render counters reached 606 calls and approximately 5.0 million triangles across the stereo render. These are browser/application counters, **not GPU completion times or compositor FPS**. Route, scale and exaggeration changed, so this capture cannot serve as a controlled before/after frame-rate comparison. Larger frame stalls and render cost remain performance work.

Quest Browser reported an unsupported `KHR_parallel_shader_compile` capability and a resize-during-XR warning. Eight image requests were cancelled during changing selections; these were `ERR_ABORTED`, not demonstrated public-source outages. The subsequent trail/MR capture contained zero XR snapshots and is excluded from the native VR result. **MR and a sustained 1:1 trail test remain pending.**

## Reuse prepared geometry bounds

`buildSurfacePatchGeometry` already computes a bounding box and sphere from the final Float32 positions in the terrain worker. Previously, publication discarded those bounds, recreated the same geometry and scanned its vertices again for the same box and sphere on the render thread.

The worker result now carries ten additional numeric bounds components per patch. `createPromotedPatchGeometry` attaches the original vertex/index arrays and restores those prepared bounds without scanning positions. Existing generation, source-surface and exaggeration checks still guard publication. The synchronous fallback uses the same result format.

Positions, normals, UVs, indices and culling volumes remain identical. Tests cover structured-clone transfer for flat, exaggerated and empty clipped geometry, compare the bounds with fresh Three.js scans, and check frustum decisions. This matters because incorrect bounds could themselves cause the terrain to disappear near the edges of either eye's view.

## Native isolated CPU comparison

[Benchmark script](native/quest-bounds-benchmark.mjs), [raw result](native/bounds-benchmark.json).

The comparison ran in JavaScript on the actual Quest, **outside XR**, using 24 live terrain patches totaling 512,877 vertices. It injects the exact new geometry factory from source and compares it with the previous publication path. Both paths retain the original typed arrays and index types; reference-identity checks reject a constructor that would silently copy or convert them. Bounds must match exactly before timing begins.

After 15 warmup pairs, 45 measured pairs alternate execution order. Each measurement publishes all 24 inert geometries and disposes them without submitting draws.

| Publication of 24 patches | Median | p95 |
| --- | --- | --- |
| Previous vertex rescans | 21.6 ms | 22.8 ms |
| Restore prepared bounds | 0.2 ms | 0.2 ms |

The new timing is close to the browser timer's granularity. This removes redundant CPU work from one publication step. It is **not a measured improvement to complete XR frame rate**, GPU time or public-source latency. A new sustained native XR run is still needed to quantify the application's resulting frame pacing.

## XR resize lifecycle

The native warning also identified a window-resize handler calling `renderer.setSize` while an XR session owned the framebuffer. The handler now defers changes while presenting. A session-end listener applies the latest panel dimensions after Three.js restores desktop rendering, and disposal removes the listener. The XR runtime retains control of its framebuffer throughout the immersive session.

## Verification and reproduction

`npm run verify` passed source/test type checking, **558 tests** on Windows with five POSIX-only tests skipped, and the production build. Linux CI also runs those five tests. [Verification log](native/verify.log). Existing main-chunk and LERC Node-module build advisories remain.

[Production browser harness](native/browser-worker.mjs), [browser result](native/browser.json). Actual Edge loaded live public terrain, observed an existing imagery geometry replaced by a worker-prepared promotion, and compared 15 nonempty published patches with fresh box/sphere scans. Every bound matched exactly. Four local chunks were present, session-end sizing restored the current aspect ratio, and JavaScript, console and WebGL errors were zero. This browser check is desktop rendering, not native XR.

For native reproduction, open the profiling URL on an authorized headset as described in [QUEST_PROFILE.md](../QUEST_PROFILE.md), then use `metavr adb forward tcp:9231 localabstract:chrome_devtools_remote`. Run `node --experimental-transform-types docs/review-2026-10-15/native/quest-bounds-benchmark.mjs` from the repository root while XR is inactive and terrain has loaded. The benchmark stops if XR starts; it does not alter the rendered scene. Its output is written to ignored `.review-cache/quest-native/bounds-benchmark.json`.

Meta's [browser debugging guide](https://developers.meta.com/horizon/documentation/web/browser-remote-debugging/) and [WebXR performance workflow](https://developers.meta.com/horizon/documentation/web/webxr-perf-workflow/) were verified through the Meta VR tools. Headset-room screenshots and raw head-pose snapshots remain outside the published evidence.
