# Prepare streamed terrain imagery outside the animation thread

The [completed native MR run](MR_COMPLETED.md) recorded thousands of patch replacements and 178 browser Long Tasks. Each incoming tile previously clipped its terrain mesh synchronously in an image-completion callback. Those callbacks run on the browser's main thread, outside the animation phase timers. This checkpoint removes that repeated clipping from the normal worker-enabled loading path; it does not establish that clipping caused every recorded stall.

Incoming tiles now use the existing serialized terrain worker and the same triangle-clipping implementation as surface promotion. Positions, smooth normals, Mercator UVs, indices and culling bounds are preserved. Source imagery, mesh spacing, overscanned view samples, resident limits, anisotropy and material settings are unchanged.

The request retains its scheduler slot until preparation finishes. This bounds decoded images and queued preparation by the existing request concurrency. Surface revisions share one cached snapshot; the dispatcher sends it again when its identity changes or a worker restarts. The worker retains one source snapshot. Active terrain buffers are cloned, never transferred away from the renderer. Browsers without worker support retain the synchronous fallback.

Terrain promotion, removal and exaggeration invalidate the snapshot. A result from an older revision is retried before publication. Mode/style changes and disposal cancel pending preparation and prevent stale tiles from mounting. An obsolete image that cannot enter the resident set skips preparation. Existing imagery remains available while replacements prepare.

## Verification

- Five new tests cover bounded scheduling, exact geometry parity, snapshot reuse, terrain revision changes, cancellation, and source resend after a worker restarts.
- `npm run verify` passed type checking, **576 tests on Windows with five POSIX-only tests skipped**, and the production build. Linux CI runs all 581 tests. [Log](streamed-worker/verify.log).
- The [production-worker browser check](streamed-worker-browser.mjs) compared SHA-256 digests of positions, normals, UVs and indices, plus exact culling bounds, for 48 Z17 tiles over a synthetic surface with 4 m refined cells. All matched the synchronous implementation. The 5,444,400-byte source snapshot was sent once including warmup; source arrays remained intact. [Result](streamed-worker/browser.json).
- The actual built worker processed 261,161 triangles in 85.8 ms after warmup while the browser timer ran 18 times. This synthetic desktop observation demonstrates asynchronous execution; it is not a before/after speed comparison, rendering benchmark, or native Quest frame-rate result.
- The existing production-browser outage test reached 64 opaque visible Z19 tiles, each a full 256 × 256 crop. Four intentionally failed preferred-source requests were followed by public USGS imagery, with no repeated preferred-source requests after initial sharp coverage. GeoPlatform CORS failures were retained in the evidence; the next configured public source succeeded. No JavaScript exceptions, context loss or WebGL errors occurred. [Result](streamed-worker/streaming.json).

The initial development-server microbenchmark stalled during module loading and was replaced by a direct production-worker check. Its timeout is not treated as an application rendering result.

## Remaining work

Selection-driven eviction/recreation, texture upload cost and the high stereo draw-call count remain open. This checkpoint reduces main-thread preparation work while preserving quality; it does not claim to resolve tile turnover or meet the 72 Hz native target. A comparable physical-headset run is still needed to measure its effect.

Meta's [current WebXR performance workflow](https://developers.meta.com/horizon/documentation/web/webxr-perf-workflow/), verified through the Meta VR tools for this checkpoint, calls for separating CPU and GPU costs and measuring again after each optimization. No GPU or compositor timing is inferred from the browser timer above.
