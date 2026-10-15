# Imagery patch construction continuation

Implemented October 14, 2026, after the [terrain picking work](PICKING.md).

Imagery patches clip the actual rendered terrain triangles so textures follow ridges and detailed surfaces. Previously, even fully interior cells created vertex objects and used two maps to find shared output vertices. Interior cells now read source attributes directly and reuse output indices through a compact typed cache covering only the intersecting grid rectangle. Boundary clipping still interpolates the same positions and smooth normals. It shares original vertices with the interior cache and stores output indices on private clipping objects. Clipping intersections use explicit fields, and edge definitions are prepared once per patch.

The optimization applies to both direct patch construction and worker preparation during terrain promotion/removal. It preserves vertex order, triangle winding, source-cell holes, the 0.04 m overlay lift, geographic UV mapping, floating-point interpolation and automatic 16/32-bit index selection. Terrain resolution, provider zoom ceilings, imagery budgets, promotion timing, materials and trail geometry are unchanged.

## Isolated construction measurements

The [benchmark](patches/benchmark-patches.mjs) compares the [saved previous builder](patches/SurfacePatchGeometry-before.ts) with production source in Node 24.21.0. The snapshot's type-only import path is adjusted for its archive location. Both builders receive the same deformed grids, smooth normals, patch bounds, refinement holes and UV function. Every output buffer and bounding volume must match exactly before timing. Construction order alternates; 30 warmup batches are excluded and 120 samples retained per implementation. Disposal occurs outside the measured construction interval.

| Synthetic fixture | Output vertices / triangles | Previous median / p95 | Current median / p95 |
| --- | --- | --- | --- |
| Full 128 × 96 base with refinement | 13,567 / 26,378 | 6.078 / 12.211 ms | 3.875 / 10.359 ms |
| Fractional patch with refinement | 7,138 / 12,236 | 3.487 / 6.481 ms | 2.418 / 5.109 ms |
| Small clipped patch on 199,809-vertex base | 210 / 204 | 0.1605 / 0.2043 ms | 0.1030 / 0.1467 ms |

The measured medians improve approximately 31–36%. These are isolated CPU construction measurements, not application frame time, worker message latency, GPU duration or headset FPS. They do not establish a universal improvement for every patch shape. [Raw results](patches/benchmark.json) are saved. Run from the repository root with `node --experimental-transform-types docs/review-2026-10-13/patches/benchmark-patches.mjs`.

## Maximum-detail browser comparison

The [production-browser harness](patches/browser-patches.mjs) loads Rainier in hardware-accelerated Edge, waits for 24 terrain refinements and settles imagery at provider zoom 19. It then pauses further DEM publication and animation. Both builders reconstruct every visible imagery patch from the same live terrain meshes and geographic UV function. The harness compares their arrays and bounds exactly, renders the previous geometry, renders the current geometry, and restores the app's original geometry before a mobile Settings/Fit check. This is a controlled comparison rather than a streaming or frame-rate profile.

| Check | Result |
| --- | --- |
| Detailed terrain | 24 chunks, 57,624 vertices |
| Imagery | Zoom 19, 67 resident patches, 100% desired coverage |
| Compared visible patches | 52, containing 2,173 vertices / 1,831 triangles |
| Positions, normals, UVs and index buffers | Exact typed-array agreement, including index type |
| Bounding boxes and spheres | Exact agreement |
| Previous/current rendering | Pixel-identical across 1,012,293 pixels |
| Repeated previous render control | Pixel-identical |
| Draw calls / textures | 69 / 73 for both versions |
| GL errors | Zero |
| Desktop/mobile browser | Passed, including 390-pixel Settings and Fit terrain |
| Page errors / console warnings or errors | None |

The [previous image](patches/previous.png), [current image](patches/current.png), [mobile image](patches/mobile.png) and [raw browser results](patches/browser.json) are saved. The harness retains the existing tolerance of up to four pixels differing by one channel step for GPU/compositor rounding; this run needed no tolerance. Its unchanged-render control is recorded in the JSON. The Windows Edge/Playwright installation paths are explicit; run from the repository root with `node docs/review-2026-10-13/patches/browser-patches.mjs`.

## Verification and limits

The [full verification log](patches/tests.log) records passing source/test TypeScript checks, 506 passing tests and five POSIX fixtures skipped on Windows, across 93 passing files and one skipped file. Eight new cases compare against the frozen builder: full shared grids, fractional clips with refinement holes, interior/boundary sharing, thin strips, small corners, outside bounds, zero-area rectangles and output exceeding 65,535 vertices. Comparisons use native typed-array assertions rather than boxing large arrays. Existing ridge/normal, worker promotion, stale publication, retirement and imagery lifecycle tests also pass.

The production build passed: main JS 912.08 kB / 238.91 kB gzip, worker 211.30 kB. The existing main-bundle size warning remains. The Meta VR plugin search again identified the official [WebXR performance workflow](https://developers.meta.com/vr/documentation/web/webxr-perf-workflow), and its device listing returned no connected headset. Desktop rendering used ANGLE D3D11 on an NVIDIA RTX 4060. Sustained Quest CPU/GPU performance, compositor FPS, thermals and immersive comfort still require hardware validation; this pass makes no headset performance claim.
