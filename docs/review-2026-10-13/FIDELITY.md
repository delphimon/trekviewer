# Broad view coverage and 1:1 fidelity

Implemented October 14, 2026, in response to visible imagery/DEM reductions just above and below the inspected terrain, and insufficient clarity in 1:1 / stand-on-trail mode. The comparison baseline is published revision `914f526a18e63ab7838ddf873c014c349a0e656c`.

## Quality behavior

High now favors broad detail instead of a small central footprint. At imagery zoom 19, its concentric core selects 144 finest tiles, with 100 zoom-18 and 49 zoom-17 tiles providing surrounding coverage and complete parent fallbacks. The previous Quest first-person selection had only 16 zoom-19 tiles. Terrain bounds can clip these counts. The core depends on position rather than head direction.

A 7×7 set of terrain rays covers the visible frame and extends 15% beyond its edges. Actual terrain hits receive finest-detail sibling groups before spare capacity is spent on their surrounding guard tiles. Recent view targets are retained in a bounded history, and High delays zoom demotion for 8–10 seconds. Desktop and XR High both use actual inspection distance; the previous 0.2-scene-unit XR floor no longer suppresses close-up detail. Pointing a controller at distant terrain no longer reduces the density or replaces the broad coverage of a close view. Provider ceilings still apply: the configured satellite ceiling is zoom 19, while Topo remains capped at 16.

High DEM refinements now target 5 m mesh spacing. Selection covers the main focus plus up to 25 spatially distributed view anchors, including upper/lower slopes and side terrain. Tile distances are computed once per plan before sorting. Loaded terrain remains visible when focus changes; previously loaded tiles retire only when replacement needs their bounded resident capacity. Geometry and matching imagery still publish together, at most one prepared terrain tile per frame. Retry/backoff and coarse coverage during acquisition remain.

Balanced retains its explicit power-saving settings. High remains the default. No automatic High-to-Balanced switch was added.

| Resource limit | Quest High | Desktop High | Balanced |
| --- | --- | --- | --- |
| Imagery patches, tabletop / 1:1 | 448 / 512 | 640 / 768 | 28 / 36 |
| Decoded image cache entries / bytes | 768 / 192 MiB | 1,024 / 256 MiB | 160 / 40 MiB |
| Desired DEM tiles / vertices | 48 / 600,000 | 96 / 1,200,000 | 9 / 40,000 |
| Resident DEM tiles / vertices, including retained detail | 64 / 800,000 | 128 / 1,600,000 | 9 / 40,000 |
| Target refined mesh spacing | ≤5 m | ≤5 m | ≤25 m |

These are resource bounds rather than expected allocations in every view. Base grids retain their existing 125,000-vertex Quest / 200,000-vertex desktop caps and High's 60 m base target. Local DEM decode caching remains separately bounded to 64 MiB. Image cache limits do not include all GPU textures, terrain arrays, base grids or worker staging. The larger High working set deliberately spends more memory, bandwidth and rendering work to preserve visible quality.

A denser mesh samples the available elevation data more closely; it cannot recover terrain detail absent from the source. Satellite zoom describes requested source tiles and does not guarantee native survey resolution, image sharpness or accuracy everywhere.

## Production-browser comparison

The [comparison harness](fidelity/browser-fidelity.mjs) loads Rainier at route progress 0.4. It compares the previous published build with the new local production build, using the same viewport, source imagery and Quest user agent / High profile. This tests the Quest quality policy on desktop Edge; it does not create a native immersive session.

Tabletop inspection uses the same base-derived geographic target and camera offset. First-person views use the app's normal grounded desktop walking camera, two metres above the rendered surface. Horizontal position and heading match between versions; eye height changes by about 0.53 m because the refined surface changes. The turned view applies a 25° yaw after the normal walking update. These are quality comparisons, not pixel-matched rendering or equal-work performance benchmarks.

Each view is sampled across a 5×5 screen grid. Sky misses are excluded; imagery quality is the finest visible resident patch covering each actual terrain hit, and DEM quality is the intersected detailed chunk's cell spacing or the base spacing when no chunk covers it.

| View | Previous zoom-19 samples | Current zoom-19 samples | Previous detailed DEM samples | Current detailed DEM samples |
| --- | --- | --- | --- | --- |
| Close tabletop, including upper/lower slopes | 2 / 21 | 21 / 21 | 17 / 21 | 21 / 21 |
| Grounded 1:1 trail view | 0 / 25 | 25 / 25 | 25 / 25 | 25 / 25 |
| 1:1 after 25° turn | 0 / 23 | 23 / 23 | 23 / 23 | 23 / 23 |

The current detailed samples use approximately 4.98 × 4.97 m cells, versus 9.96 × 9.94 m in previous refinements. Previous tabletop samples outside those refinements used approximately 60 m base cells. The new tabletop comparison holds 48 DEM chunks / 451,632 vertices; the turned walking view retains 64 / 602,176, within its resident limits. The previous Quest views held 12 / 28,812. Current walking imagery remains within 512 resident patches, and all desired fine coverage settles to 100%. All checks reported GL error zero and no page errors or console warnings/errors.

The [raw results](fidelity/browser.json) include every sample, camera pose, cell size and imagery diagnostic. Screenshots show [previous tabletop](fidelity/previous-tabletop.png), [current tabletop](fidelity/current-tabletop.png), [previous 1:1](fidelity/previous-walking.png), [current 1:1](fidelity/current-walking.png), [previous turned view](fidelity/previous-turned.png) and [current turned view](fidelity/current-turned.png). These sampled views demonstrate the improvement; finite budgets cannot guarantee finest detail across every possible distant terrain point or an entire route simultaneously.

For a fresh comparison, run `node docs/review-2026-10-13/fidelity/browser-fidelity.mjs` from the repository root with `TREK_BASELINE_URL` pointing to a hosted baseline build with `?profile=1`. The default baseline URL is the live site, which changes after publication. `--current-only` reuses the recorded previous measurements from the local cache or archived JSON and runs the current build again. The harness explicitly uses the Windows Edge/Playwright installation paths.

## Performance, controls and verification

The [five-second settled desktop profile](fidelity/current-profile.json) records maximum JavaScript/render submission of 2.8 ms, no long tasks, 138 draw calls and 344 WebGL textures. The sampled image cache holds about 161.3 MiB decoded data. Desired imagery coverage stays at 100%, with no patch creation/disposal or terrain focus changes during the capture. This is a short stationary desktop measurement, not startup/streaming performance, GPU duration or sustained headset frame delivery. Headless callback spacing is about 32 Hz and cannot establish Quest compositor FPS. Texture counts are not total GPU memory.

The separate [desktop/mobile controls harness](fidelity/browser-controls.mjs) switches High → Balanced → High through the UI, verifies the different terrain spacing and limits, and confirms camera, orbit target, model transform and progress remain unchanged. It checks 390-pixel Settings/Fit access and entering/exiting walking mode with no page or GL errors. [Raw controls results](fidelity/controls.json) and [mobile High screenshot](fidelity/mobile-high.png) are saved.

Source and test TypeScript checks pass. The [full verification log](fidelity/tests.log) records 516 passing tests and five POSIX fixtures skipped on Windows, across 94 passing files and one skipped file. New regressions cover the broad all-direction hierarchy, complete sibling/ancestor coverage, sampled-slope priority before guard tiles, provider limits, multi-anchor 5 m DEM plans, hiker priority when distant anchors tie, retaining terrain until resident capacity requires atomic replacement, and preserving close XR view density while the controller points elsewhere. Existing retry, stale publication, grounding, clipping, worker, surface equivalence and lifecycle regressions remain passing. The build passes: main JS 917.38 kB / 240.47 kB gzip; worker 211.36 kB. The existing bundle-size warning remains.

The Meta VR plugin's verification/WebXR/immersive-design guidance informed this work. Its documentation search identified the official [WebXR performance workflow](https://developers.meta.com/vr/documentation/web/webxr-perf-workflow) and [fixed foveated rendering guidance](https://developers.meta.com/vr/documentation/web/webxr-ffr). The device listing returned no connected headset. Sustained Quest CPU/GPU timing, compositor FPS, thermal behavior and subjective comfort require hardware validation. High's larger working set has not been certified to meet a particular headset refresh rate; Balanced remains available when lower resource use is preferred.
