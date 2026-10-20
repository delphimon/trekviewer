# Opt-in lit imagery batching

`?imageryBatch=1` enables a bounded submission prototype. The normal URL retains the existing renderer. This addresses the independent imagery draw submissions identified in the [second review](REVIEW_RESPONSE.md); it does not replace CPU surface clipping, improve the DEM source, or establish native frame delivery.

`ImageryBatchRenderer` copies compatible opaque patches into Three.js `BatchedMesh` pages with 32-layer texture arrays. Pages share zoom/depth priority, native image dimensions, filtering, anisotropy and render order. Each layer retains its own full mip chain; adjacent images are not placed in a shared 2D atlas. Source positions, normals, indices and geographic UVs are copied unchanged. The existing lit Standard material remains in use with a texture-array sampling modification. This avoids changing relief cues while evaluating submission cost.

The actual runtime must expose WebGL2 texture arrays, at least 32 array layers and `WEBGL_multi_draw`. Otherwise every patch stays on the existing renderer. Fades, unsupported materials, unreadable images, oversized geometry and capacity overflow also retain their source rendering. High's selection, source resolution, resident tile limits, terrain precision and geographic coverage are unchanged. The experiment can therefore retain substantial legacy draw cost on unsuitable workloads.

At most two new layers are copied per frame. All stale batch copies are removed before that budget is applied, immediately exposing new source terrain rather than leaving obsolete geometry visible. Source mesh visibility stays available to selection/diagnostics; only successfully transferred source materials are hidden. Redundant source GPU handles are released, while CPU geometry and cache-owned source images remain available for fallback and terrain operations.

The prototype caps array storage, including theoretical mip levels, at 128 MiB and reserved vertex/index storage at 32 MiB (at most 11 pages). These are owned-buffer accounting limits, **not measured total GPU/process memory**. Original CPU arrays/images, renderer metadata, per-instance matrix/indirection textures and fallback resources remain additional costs. Batch release restores sources and destroys internal handles before the existing context-loss traversal; the next frame rebuilds from retained data. Profile windows report requested/supported batch status and actual batched patch count.

## Controlled production-browser evidence

Run `node scripts/check-imagery-batch-browser.mjs` after building. The driver uses the actual bundled manager/controller and desktop WebGL2 renderer, with generated 256-pixel label/color tiles and deformed, lit meshes. Source coordinates follow the production convention: model-local positions in vertices, identity member transforms, and a common placement parent. It compares every RGBA pixel at 640×480 and records aggregate Three.js calls/triangles. ArrayCamera tests exercise stereo rendering and culling; they are not native headset delivery.

| Condition | Legacy draws | Prototype draws |
| --- | ---: | ---: |
| 64 opaque patches | 64 | 2 |
| Same geometry in two eye views | 128 | 4 |
| First frame after all terrain copies invalidate | 64 | 63 |
| Hidden patches plus a visible fade | 51 | 3 |
| Coarse/fine overlap with a fade | 72 | 4 |
| Different eye-frustum edges | 144 | 6 |
| 448 patches at the memory cap | 448 | 131 |
| Missing multi-draw support | 448 | 448 |

All covered views, including oblique/distant mip sampling and translated/rotated/scaled parent placement, have maximum RGBA error zero. Triangle counts match except for the stereo-edge fixture, where per-eye batch culling removes fully invisible geometry while preserving identical pixels. The 448-patch fixture batches 328 patches in 11 pages and keeps 120 source meshes rendered. Its accounted arrays occupy 123,032,448 bytes (117.33 MiB), with 31,719,424 bytes (30.25 MiB) reserved geometry.

Real `WEBGL_lose_context` loss/restoration exercises the application's recovery handler: batch entries clear on loss and the restored rendering matches, without page exceptions, shader errors or GL errors. Three release/rebuild cycles return to identical renderer geometry/texture counts; this is a bounded lifecycle check, not a long-duration memory profile. The isolated test scene is attached to its owning trek during loss so the production traversal can release its source resources as it does for normal imagery.

The local [render evidence](imagery-batch/local.json) and [tour/control evidence](imagery-batch/tour-local.json) identify the tested build. `npm run verify` passes 676 Windows tests, with five platform-specific skips, both typechecks and the production build. The tour driver checks desktop/mobile playback, following, spatial controls, imports and sampled ridge clearance with deterministic fallback terrain; it does not establish real network loading or source fidelity.

Application commit **`a570fcb`** passed [CI](https://github.com/delphimon/trekviewer/actions/runs/39442246522), was rebuilt cleanly and published to the existing site. The [hosted render fixture](imagery-batch/hosted-a570fcb.json) reproduces the results above on exact entry `index-SnQSclZz.js`, build `a570fcb-2026-10-20T14:46:13.511Z`; the [hosted desktop/mobile tour checks](imagery-batch/hosted-tour-a570fcb.json) pass on the same client. Try the [opt-in experiment](https://trekviewer.surge.sh/?imageryBatch=1). Its absence from the normal URL is intentional until native acceptance. The evidence-only follow-up retains this measured app build.

## Remaining acceptance

Keep the default renderer until a matched native full-tour comparison establishes actual extension support, draw/CPU/GPU cost, cold and warm time-to-detail, sustained memory/thermal behavior and subjective clarity. The synthetic fixture does not reproduce 448 full-resolution, highly tessellated real-world patches or their allocation/streaming churn. Array copying and mip generation can add publication work; measure them rather than inferring a frame-rate gain from draw counts. The coarse overview DEM, native terrain detail and 72 Hz gate remain open. Coordinated terrain/imagery ownership remains the longer-term architecture.
