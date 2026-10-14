# Imagery ownership and streaming continuation

Implemented October 14, 2026, after the [terrain coverage work](COVERAGE.md).

## Changes

Terrain now shares one pending or completed composition per map style. Rapidly selecting Topo, Aerial, then Topo reuses the same Topo request instead of building overlapping canvases. The initial background Aerial request participates in the same cache. Progressive updates follow the currently selected style, while older completions cannot replace it or overwrite its status. Applying an already active texture skips redundant material and chunk updates.

The terrain owns completed and partially published textures, including inactive styles. Graphics recovery can therefore release stale GPU handles for a previously rendered partial Topo image while preserving its CPU pixels. Final terrain disposal cancels compositions, disposes their GPU textures once, shrinks owned canvas backing stores to 1 × 1, and removes the loading signal listener. Late results from loaders that ignore cancellation are released without being mounted.

Loading cancellation and committed-terrain ownership are separate. Once the route commits, its imagery lifetime detaches from the assembly request signal. Starting a replacement can cancel that old request context without clearing the still-visible terrain. The old terrain and its imagery are released only after the replacement is ready and commits atomically. Canceled staging terrain retains its load cancellation link.

Aerial, Hybrid and Topo now use one composition implementation. It checks cancellation before allocation and after tile/label awaits, keeps opaque fallback pixels for missing tiles, uploads progressive changes only when successful imagery changed, and enables mipmaps and trilinear filtering at completion. Entirely failed loads publish no fallback-only texture, return `null`, and release the unused canvas and texture. Shared tile downloads may still finish into the existing bounded cache after an individual compositor cancels.

The overview planner now continues below zoom 11 when needed to meet its **120-tile** budget. Mercator tiles cover less ground near the poles, so that previous floor could leave wide padded terrain bounds far above the intended request budget. The compositor also rejects oversized, inconsistent or invalid grids before allocating a canvas or requesting tiles. This affects overview planning for those oversized footprints; local inspection zoom, provider ceilings, terrain resolution, anisotropy and final mipmap settings are unchanged. [USGS service metadata](https://basemap.nationalmap.gov/arcgis/rest/services/USGSTopo/MapServer?f=pjson) exposes the coarse levels beginning at zero; regression tests verify the planner's budget and Mercator coverage.

## Browser evidence

The [production Edge harness](imagery/browser-imagery.mjs) makes 13 Topo selections interleaved with Aerial in one burst before tiles can complete. It captures DOM canvas creation and actual WebGL canvas uploads.

| Check | Saved result |
| --- | --- |
| Composite canvases created during the burst | One, 2560 × 1536 |
| Selected style and accessible button state | Topo / pressed |
| Captured initial composite upload | One `texSubImage2D`, 2560 × 1536 |
| Topo composition at capture | Partial, with mipmaps disabled |
| During deliberately delayed replacement GPX request | Rainier remains mounted; all three owned images retain their dimensions |
| Native WebGL context loss and restoration during replacement | Progress, camera and orbit target preserved; cached imagery retained; GL error zero |
| After Baker commits | Rainier disposed; all three old owned canvases resized to 1 × 1; GL error zero |
| Page errors and console warnings/errors | None |

The captured canvas is **15 MiB at four bytes per pixel**. That is a calculated RGBA backing-store estimate for one composition, not measured process RAM or GPU memory. The test establishes request/canvas sharing without claiming a frame-rate speedup or a measured historical memory peak. GPU textures, mipmaps, cached decoded tile images, terrain buffers, regional DEM grids and worker staging consume additional memory.

[Raw results](imagery/browser.json), [partial Topo](imagery/topographic.png), [old route while replacement loads](imagery/replacement-loading.png), and [new route after commit](imagery/replacement-ready.png) record the final build. The Topo image intentionally captures progressive composition: downloaded map tiles replace the complete Aerial fallback as they arrive. The harness uses the Windows Edge and Playwright paths and runs from the repository root with `node docs/review-2026-10-13/imagery/browser-imagery.mjs`.

## Verification and limits

| Check | Result |
| --- | --- |
| Source and test TypeScript checks | Passed |
| Vitest | [470 passed, 5 POSIX packaging fixtures skipped on Windows](imagery/tests.log); 91 files passed / 1 skipped |
| Production build | Passed; main JS 905.95 kB / 237.05 kB gzip; worker 210.77 kB |
| Browser lifecycle checks | Passed on ANGLE D3D11 / NVIDIA RTX 4060 |
| Git whitespace check | Passed; existing line-ending conversion notices only |
| Meta device listing | Empty |

New regressions cover all three styles failing or canceling, pre-aborted requests, late results, fallback ownership, suppression of unchanged uploads, final filtering, pending/completed request sharing, graphics recovery resources, retries, listener cleanup, committed imagery during replacement, actual terrain style selection, and oversized/polar overview grids. Existing pixel fallback, hybrid compositing, terrain/raycast, disposal and route transaction tests also pass.

The Meta VR plugin's documentation search was run again for texture/memory and WebXR performance guidance; see the [official performance workflow](https://developers.meta.com/vr/documentation/web/webxr-perf-workflow). Desktop lifecycle checks do not establish Quest GPU time, compositor frame delivery, thermal behavior, total native memory peaks or immersive comfort. Those measurements still require a connected headset. The main-bundle size warning and terrain/imagery overlay draw overhead remain follow-up work.
