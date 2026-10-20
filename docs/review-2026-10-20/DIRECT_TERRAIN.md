# Direct terrain imagery and waypoint instancing

Streamed imagery now samples directly on the authoritative base and fine terrain meshes. It no longer needs a separate rendered copy of those triangles for every compatible opaque tile. Identical opaque waypoint diamonds/stalks share two instanced draws; logical pins, hit spheres, labels, transparent rings and hover/selection feedback retain their existing owners.

This replaces the normal application's imagery submission path on supported devices. The earlier clipped-mesh `?imageryBatch=1` experiment remains explicitly selectable. `?terrainImagery=0&markerBatch=0` provides the original rendering for comparisons. These controls change submission, not High's coverage, imagery selection, DEM precision, mesh spacing, eye-buffer scale or lighting policy. Native acceptance remains open: the connected headset exposed no browser target, and the user deferred wearing/opening it until later. No 72 Hz result is claimed.

## Rendering and publication

`TerrainImageryMaterial` wraps the existing lit Standard materials. Existing geographic terrain UVs locate the highest visible cached tile through a bounded page table. Tile images retain their native dimensions, sRGB treatment, per-layer mip chains and anisotropy in the existing 32-layer texture-array cache. Explicit derivatives avoid selecting an invalid mip level at tile boundaries. Missing, fading, incompatible, unreadable and capacity-overflow tiles keep their original patch/fallback path. The material retains the original streamed imagery roughness and shadow-receiving policy. GPU vertices retain the existing imagery's 4 cm model-space lift; the CPU elevation/sampling surface is unchanged.

The page table covers Z13–Z19, has a 16 MiB limit and checks actual device texture dimensions. Direct sampling requires WebGL2, at least 32 array layers and at least 16 texture units, but does not require multi-draw. Unsupported devices retain the original renderer. Array storage remains capped at 128 MiB including accounted mip levels, with at most 11 pages and two copies per frame under a soft 2 ms preparation allowance. A single indivisible copy/cleanup can exceed that allowance. Direct mode allocates no copied patch vertex/index buffers. CPU originals, source images, renderer metadata, fallback meshes and other app resources remain additional costs; these counters are not total process/GPU memory measurements.

Transferred source meshes leave camera layers as well as hiding their materials. Three updates geometry before checking material visibility, so hiding only the material could recreate redundant GPU buffers each frame. Logical mesh visibility remains available to selection and diagnostics; the original layer mask is restored on fallback.

Terrain promotion no longer clips another geometry copy for imagery already rendered on that terrain. Such CPU fallback copies become stale and are rebuilt only if needed. Rare individual fallback rebuilds synchronously; complete release/context recovery refreshes stale sources through the existing worker before the release promise completes. Publication still prepares fading/untransferred patches and rejects stale work. Context loss releases generic GPU resources immediately while the context is lost, then awaits fallback work before shader preparation/resume. Route preparation also warms the modified material before committing the scene.

Waypoint instancing preserves per-pin transforms, diffuse color and emissive intensity. Hidden pins compact out of the instance list. Original hit targets stay raycastable; the new render batches do not compete for input. Batch geometry/material/instance resources have explicit disposal before the remaining diorama owner is disposed.

## Desktop measurements

The live driver uses the Olympus route, real public USGS/imagery services and the Quest geometry budget in desktop Edge. The fixed-scene benchmark alternates original/all-optimized rendering twice, warms eight frames per pass and measures 60 requestAnimationFrame-paced renders per pass. Simulation, streaming updates and camera motion are stopped during those measurements. Main-thread elapsed render time measures submission; WebGL disjoint timer queries measure GPU elapsed time on an RTX 4060 through ANGLE/D3D11. Background activity and GPU scheduling/clocks are uncontrolled, so the GPU figures are observations rather than a universal percentage improvement.

[Final local evidence](direct-terrain/live-local.json), build `fd97a0f-modified-2026-10-20T17:06:16.014Z`, entry `index-TQFSCxLQ.js`:

| Fixed scene | Original | Direct imagery + marker instances |
| --- | ---: | ---: |
| Draw calls | 222 | 105 |
| Submitted triangles | 3,842,644 | 2,082,672 |
| Submission median, pair 1 | 3.7 ms | 2.5 ms |
| Submission p95, pair 1 | 4.3 ms | 2.9 ms |
| Submission median, pair 2 | 3.3 ms | 2.3 ms |
| Submission p95, pair 2 | 3.8 ms | 2.7 ms |
| GPU median, pair 1 | 6.28 ms | 4.66 ms |
| GPU median, pair 2 | 9.57 ms | 3.83 ms |

Every timer query was available and non-disjoint; all passes reported GL error zero. A separate earlier local run recorded 223→105 draws, 3.84M→2.08M triangles and submission medians 3.3→2.3 / 3.1→2.2 ms; see [repeat evidence](direct-terrain/live-repeat.json). Neither experiment establishes headset FPS, full-app frame time, loading-spike behavior or sustained thermal performance.

During the final 30-second live follow segment, 595 otherwise necessary opaque imagery reprojections were avoided. Array accounting reached 42.67 MiB plus a 3.26 MiB page table, with zero copied patch geometry. Observed maximum synchronous preparation was 8.4 ms, demonstrating the soft allowance is not a hard frame deadline. Fine terrain was present under the hiker in 98/125 playing/following samples; the other run observed 119/126. These are short, network-sensitive samples, not proof that loading or full-route coverage is fixed. The overview remains approximately 44 m sampled elevation and 94 m rendered cells; fine export requests remain approximately 1 m samples with approximately 5 m mesh cells. No source-resolution upgrade is part of this change.

## Fidelity and recovery checks

`scripts/check-terrain-imagery-browser.mjs` compares the actual production shader against original clipped patches using geographically placed labeled checker tiles, hills, Z13/Z19 overlap, distant mip sampling, close views, fade and stereo. It resets placement into metre coordinates, uses corresponding camera/depth ranges, clears previously prepared GPU state and requires visible non-uniform foreground in every view. Earlier drafts with tabletop scaling and metre camera distances were invalid and are excluded from evidence.

The [corrected fixture](direct-terrain/controlled-local.json) reports 20→1 draws for the whole view and 14→2 for close stereo. Rendering is not bitwise identical after removing clipped triangle edges and interpolating the geographic UVs on the original surface. Across the covered 800×600 views, mean absolute channel error is at most 0.079/255, RMS at most 1.85/255, and at most 2,253 pixels (0.47%) differ by more than two channel levels. Maximum isolated channel difference reaches 115. The gate explicitly allows mean ≤0.1, RMS ≤2 and changed pixels ≤0.6%; this does not establish arbitrary-view/native visual acceptance. Context restoration is bitwise identical and reports no page, shader or GL errors.

The live same-state 1000×800 imagery comparisons report means 0.013–0.053/255 and fewer than 0.63% changed pixels. The separate marker comparison changes four pixels over threshold at rest (mean 0.000081/255) and zero during mixed hover/selection (maximum error one); marker draws fall by 46 in that view. The source hit spheres and their layers stay intact. [Desktop/mobile flow checks](direct-terrain/tour-local.json) pass play/follow, spatial model-follow ownership, manual takeover, controls/footer layout, ridge clearance, imports and landmarks. Controlled XR branches and stereo cameras do not replace tracked headset testing.

`npm run verify` passes both typechecks, 686 Windows tests (five platform skips) and the production build. Focused fallback/publication and waypoint tests also pass after the final test assertion. Release provenance and hosted checks are recorded below after publication.

## Remaining acceptance

Measure the default build in the headset at matching High/Aerial framing, including cold/warm loading, a full route tour, head turns, manipulation, transitions and a sustained session. Record application frame delivery, CPU/GPU tails, dropped/reprojected frames, memory and thermal state. Compare subjectively in both eyes. The whole-model elevation detail, fine coverage gaps and network time-to-detail remain separate open problems. Keep the native 72 Hz gate open until measured; draw reduction and desktop timers alone do not close it.

## Published checkpoint

The main change `8f05a64` passed [CI](https://github.com/delphimon/trekviewer/actions/runs/39463745738). The final hidden-marker initialization guard `607d97ba9b4fa1e887f9118ad9623452565b9c0f` passed [CI](https://github.com/delphimon/trekviewer/actions/runs/39463946179), was rebuilt with a clean working tree and published successfully to [TrekViewer](https://trekviewer.surge.sh/). Exact build: `607d97b-2026-10-20T17:11:55.202Z`, executed entry `index-B8DhVjgZ.js`. The guard preallocates instance colors so shader warming also works when every marker starts hidden. Typechecks and the focused marker test pass; the final CI covers the full suite.

The [hosted geographic fixture](direct-terrain/hosted-controlled-607d97b.json) reproduces the corrected local visual/stereo/fade results and bitwise-identical graphics restoration without page/shader/GL errors. [Hosted desktop/mobile tour checks](direct-terrain/hosted-tour-607d97b.json) pass on the same exact client. The [hosted live run](direct-terrain/hosted-live-607d97b.json) reports imagery-only paired draws 105→94, 126→75 and 178→104 with marker instancing enabled on both sides. Mean error stays ≤0.055/255 and at most 0.64% of pixels exceed two channel levels. Its separate marker comparison removes 46 draws, matching the local appearance results. It avoids 566 repeated imagery reprojections by the 30-second checkpoint, records a 5.8 ms maximum synchronous preparation call, and observes fine hiker terrain in 92/124 playing/following samples. The coverage gaps remain open.

The [private Bing compatibility run](direct-terrain/private-bing-607d97b.json), using the same clean build and the user's already-authorized account, passes without page/GL errors. Imagery-only draws are 104→95, 128→76 and 179→105; mean image error stays ≤0.072/255, RMS ≤1.68/255 and changed pixels ≤0.85%. Fine hiker coverage is 118/125 samples. The token is injected only in browser memory; no credential-bearing URLs/messages, private bootstrap values or imagery screenshots enter this evidence. Credential scans pass across the repository/evidence and the clean distribution. The public site retains its public-source default. The evidence-only follow-up retains this measured application build.
