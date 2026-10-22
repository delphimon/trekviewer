# TrekViewer completion plan

Updated October 21, 2026 (America/Los_Angeles), incorporating the supplied architecture reviews, the user's diorama/flyover priority and the question about installed offline route packs. The work from [the prior chat](codex://threads/01a1367f-44dc-7a92-9f73-5542191e510a) remains the baseline, including caching, source provenance, worker recovery and entry integrity. Checkpoint 1 is implemented with regression/browser evidence in [XR quality](review-2026-10-17/XR_QUALITY.md); native checkpoints remain open. This is the authoritative remaining-work plan; dated checkpoint reports describe historical results rather than current completion status.

## Outcome and constraints

Deliver a consistently sharp, stable and usable Quest VR/MR terrain viewer, with the best verified source data available under the user's no-paid-license personal-use constraint and sustained performance at the requested runtime target. Keep desktop inspection, horizon controls and direction chevrons working.

**Product priority, October 19:** focus current development and acceptance on the tabletop diorama and route tours/flyover. Pause new 1:1 slope-walking and ground-level fidelity work; retain the existing mode and its regression safeguards. First-person acceptance is deferred and no longer blocks a diorama checkpoint. A tour should work independently of multi-day GPS timestamps. The user's latest clarification requires Play to follow the hiker in diorama mode. Desktop follows with its inspection camera; XR follows by translating the model beneath an anchored focus while leaving the tracked camera under runtime control. Spatial Stop following and manual manipulation release ownership.

**Native feedback, October 19 evening:** the connected Quest 3 run on `9cc6afa` failed subjective acceptance: slow/low-resolution tiles, flat-looking terrain and worse performance than the earlier experience. The later private Bing Aerial run on `2099bf6` also failed: the user reports about the same, less detailed DEM, slow loading and missing hiker follow. The [Bing native report](review-2026-10-19/NATIVE_BING.md) preserves that result and its measurement limits; the [earlier baseline](review-2026-10-19/NATIVE_TABLETOP.md) includes the scoped runtime/GPU trace. Restore visible terrain/loading quality alongside the explicitly requested follow behavior. No quality/performance acceptance is claimed.

**Source policy clarification, October 17:** this is the user's personal/internal application, with no public product release planned. Free API-key imagery, DEM and lidar-derived sources are allowed when the applicable personal/internal plan costs nothing. An API key is not itself a reason to reject a finer or faster source. Verify hard limits, eligibility, attribution and caching rights; avoid plans that can incur usage charges. Keep private keys out of hosted bundles/repositories, using device-local configuration, a private backend or local data preparation as appropriate. Existing test-site publication remains a checkpoint workflow, distinct from a public product release.

- High is the fidelity mode. Keep broad surrounding terrain, source-native detail, accurate geometry/UVs and readable spatial controls as explicit requirements. Preserve existing 1:1 capabilities while their new development and native acceptance are deferred.
- Balanced is an explicit user choice. Do not hide quality cuts inside High to make a performance result pass.
- Source sampling is not native survey resolution, and neither is rendered mesh spacing or eye-buffer resolution. Report each honestly.
- Preserve bounded memory/work and coarse coverage while fine data arrives. Do not increase limits blindly or promise full-detail coverage of an entire arbitrary route at once.
- Cache reusable source data whenever terms permit. Preserve original encoded bytes, bound disk/staging/decoded/GPU memory separately, retain freshness and recovery guards, and provide clear/pause controls. Do not trade image or elevation precision for cache savings.
- Use Meta VR tools and current primary documentation for Quest work. Browser timing and automated tests do not certify GPU/compositor performance or subjective comfort.
- Commit and publish every completed checkpoint: relevant checks, commit/push, passing CI, clean stamped rebuild, publication and hosted-build verification. Keep raw room/head/controller data and credentials out of artifacts.

## Already implemented; retain as regression gates

- [x] Existing route direction chevrons.
- [x] Close desktop zoom, adaptive clipping, fit controls and preservation of manual inspection on resize.
- [x] Persistent horizon lock and one-action leveling; native interaction acceptance remains below.
- [x] Public default imagery/elevation policy, source attribution, bounded decoding and retries.
- [x] Broad overscanned imagery/DEM selection and approximately 5 m High refinement meshes.
- [x] Stable publication until actual eviction; atomic terrain/imagery replacement.
- [x] Serialized worker preparation for streamed imagery with exact geometry parity, stale-result rejection and bounded pending work.
- [x] Worker module readiness before buffer transfer, bounded startup retry/local recovery and automatic return to worker use; [startup validation](review-2026-10-17/WORKER_STARTUP.md).
- [x] Exact application-entry integrity and bounded startup retries following reproduced corrupt hosting responses; [delivery validation and limits](review-2026-10-18/ENTRY_DELIVERY.md). Underlying hosting stability remains unproven.
- [x] Eviction preference for visible warm imagery over hidden obsolete work; eligible-only scoring and eviction counters.
- [x] Comfortable locomotion defaults, exclusive input ownership, workload limits, responsive controls and desktop graphics recovery.
- [x] Opt-in completed-report persistence and build provenance.

These checkmarks mean implemented and tested in their documented environments. They do not mark the immersive experience accepted.

## Remaining checkpoints, in execution order

### 0. Diorama route tour and optional desktop flyover

- [x] Add a 90-second, distance-based tour at 1x, with 0.5x/1x/2x/3x speeds, pause/resume, scrubbing, replay and end-of-route stopping. Preserve recorded/estimated track timing as an explicit alternate.
- [x] Share playback presentation policy between DOM and spatial controls; switching the time basis preserves route position and resets speed to 1x.
- [x] Add optional desktop camera follow from above. Manual orbit/zoom, Fit terrain, route replacement, view-mode changes and XR entry release follow ownership.
- [x] Complete local browser/lifecycle and automated validation: 615 tests pass (5 skipped), production build/typechecking pass, and desktop/mobile tour flows pass. The release gate still requires CI and hosted verification of the exact clean commit.
- [x] Publish the clean `c2aab97` tour checkpoint after passing [CI](https://github.com/delphimon/trekviewer/actions/runs/39350321491); hosted desktop/mobile checks confirm the exact build and route-tour controls. [Hosted evidence](review-2026-10-19/diorama-tour/hosted-c2aab97.json).
- [ ] Accept the anchored tabletop tour, spatial controls and manipulation on-device. This does not depend on resuming 1:1 work.

### 0b. Share diorama landmark navigation

- [x] Resolve and sort landmark route positions once per committed route for desktop chips/dropdown/profile and spatial navigation/profile. Preserve derived route-distance stations across repeated coordinates.
- [x] Preserve loop Start/Finish as separate route positions, keep nearby named camps, and forward the exact selected progress instead of projecting the same coordinates back to Start. Preserve parenthesized waypoint names in dropdown selection.
- [x] Verify focused landmark regressions, the full 619-test suite (5 skipped), typechecking/build and desktop/mobile loop-route controls. Publish using the same clean-commit/CI/hosted gate.
- [x] Publish clean `08e305c` after passing [CI](https://github.com/delphimon/trekviewer/actions/runs/39354309521); [hosted desktop/mobile checks](review-2026-10-19/landmarks/hosted-08e305c.json) confirm that exact client and loop-route navigation.

### 0c. Keep spatial controls clear and make tabletop profiles comparable

- [x] Reproduce status-message obstruction with a canvas comparison, then move status/progress into the footer below the controls. Keep credits and controls visible, with no panel-size or target-size reduction.
- [x] Record tour/track timing, speed, play/pause, follow state, route progress and HUD redraw requests in profile snapshots; mark playback-context changes. Label window-end samples and logical RGBA source bytes accurately, without treating them as GPU transfers.
- [x] Verify that hidden HUDs request no uploads, preserve older report compatibility, and check actual client entry plus build metadata during browser validation. Keep Finish distinct when a day boundary occupies the same endpoint.
- [x] Publish clean `412c9b3` after passing [CI](https://github.com/delphimon/trekviewer/actions/runs/39355373089); desktop/mobile hosted checks confirmed the executed client and exact build ID.
- [ ] Native tabletop baseline and sustained acceptance remain open. The October 19 device query returned no connected headsets; complete the prepared baseline only when hardware is available. See [HUD evidence and baseline protocol](review-2026-10-19/HUD_STATUS.md).

### 0d. Make imported diorama routes use one XML reader

- [x] Replace browser DOM parsing and the Node regex fallback with one bounded, namespace-aware XML reader. Support reversed coordinate attributes, prefixed GPX 1.0/1.1, self-closing points, entities/CDATA and fitness extensions while preserving segment boundaries and track-before-route selection.
- [x] Keep validation/DEM finalization downstream; reject malformed XML, missing/invalid coordinates and excessive inputs. Confirm exact finalized-data parity for all eight bundled routes (27,772 points) against `412c9b3`.
- [x] Verify desktop/mobile imports, failed-import preservation of the current diorama, tour/follow and landmark controls. See [shared GPX reader evidence](review-2026-10-19/GPX_XML.md). Publish through the clean-commit, CI and hosted-client checks.
- [x] Publish clean `b9e6993` after passing [CI](https://github.com/delphimon/trekviewer/actions/runs/39357687712); hosted desktop/mobile checks confirmed the exact client, imports, recovery and diorama controls.

### 0e. Keep desktop Follow route above sampled terrain

- [x] Reproduce ridge obstruction in the previous production build using a shaped base mesh and its actual triangle sampler. Raise the desktop follow camera using the current rendered surface and exaggeration, checking both the intended and smoothed positions.
- [x] Bound work to 32 surface queries per active desktop follow frame; preserve manual takeover, terrain/model transforms and High's detail. Replace terrain references on route commit and release them during teardown. Drain orbit inertia before starting follow.
- [x] Verify six clearance regressions, 642 passing tests (5 skipped), typechecking/build and desktop/mobile browser ridge, tour, landmark and import flows. See [clearance evidence and limits](review-2026-10-19/FOLLOW_CLEARANCE.md). Publish through the existing clean-commit, CI and hosted-client gate.
- [x] Publish clean `9cc6afa` after passing [CI](https://github.com/delphimon/trekviewer/actions/runs/39364797237); hosted desktop/mobile checks confirm the exact client. The subsequent native run establishes a baseline and fails visual/performance acceptance.

### 0f. Restore the diorama's visible quality and loading stability

- [x] Capture and retrieve a current-build native MR baseline with eye/layer state, playback context, actual browser FPS/GPU samples and user observations. See [October 19 evidence](review-2026-10-19/NATIVE_TABLETOP.md).
- [ ] Reproduce a fixed paused tabletop view and compare the earlier eligible Esri/Bing imagery paths and DEM against current sources, at identical framing. Verify actual detail, source availability and applicable free personal/internal-use access. A Google 3D tileset is a separate integration, not an interchangeable aerial URL.
  - [x] Probe identical Olympus crops, confirm the user's existing Bing account access, and support a private in-memory Aerial launch without publishing its credential; [source comparison and launch evidence](review-2026-10-19/PRIVATE_BING.md). Matched native visuals, provider-wide coverage and full attribution/style integration remain open.
- [ ] Correct imagery selection/publication/retention churn and measure time-to-sharp without shrinking High's coverage or removing native source detail.
  - [x] Reserve current-view request admission and cancel abandoned physical downloads while preserving live shared consumers and valid cached bytes; [cancellation checkpoint](review-2026-10-19/IMAGERY_CANCELLATION.md). Controlled transport/scheduler checks pass; native time-to-sharp and broader churn acceptance remain open.
- [ ] Verify whole-model ridge/slope fidelity separately from local source resolution. Current Olympus/Bailey base mesh cells are approximately 94 m; the approximately 1 m local export does not describe the whole model.
  - [x] Reproduce and correct implicit DEM footprint adjustment: the live Olympus base export misplaced outer north/south samples by about 8.5 m; [registration evidence](review-2026-10-19/DEM_REGISTRATION.md). This is a mapping correction, not native visual acceptance or a finer whole-model mesh.
- [ ] Use measured CPU submission/GPU evidence to prototype compatible imagery batching and investigate excessive paused-HUD uploads. Require exact UV/coverage parity and a matched native rerun before claiming improvement.

**Next architecture work:** use a tabletop native baseline to choose terrain batching or bounded publication work. Extend the shared UI presentation layer incrementally; extract XR manipulation state only with transition regressions. Investigate explicit cached/offline route packs for curated routes, accounting for source terms, archive size, decode/upload time and memory. Do not promise instant loading, remove live imports/caches, or replace the complete terrain pipeline without matched visual and device evidence. See [review response and checkpoint evidence](review-2026-10-19/DIORAMA_TOUR.md).

### 0g. Follow the hiker during diorama playback and overlap fine DEM acquisition

- [x] Play starts desktop camera following or XR model following. Keep the XR viewer pose untouched, preserve model rotation/scale, and provide spatial Follow hiker / Stop following. Manual orbit or XR model manipulation, resets, view changes, route replacement and XR exit release ownership.
- [x] Prioritize the hiker's ground during following while retaining broad visible terrain anchors. Overlap up to three DEM acquisitions in High (one in Balanced), including resolved staging grids; retain one geometry/publication lane, existing source precision, mesh budgets and coarse coverage. Cancel obsolete queued acquisitions and keep failure backoff.
- [x] Verify production desktop/mobile automatic follow, spatial toggling, controlled XR branch wiring and sampled ridge clearance. Controlled browser input is not native tracking or comfort validation. See [implementation and evidence](review-2026-10-19/HIKER_FOLLOW.md).
- [x] Publish clean `e8f0d28` after passing [CI](https://github.com/delphimon/trekviewer/actions/runs/39383606341); exact hosted desktop/mobile and private Bing checks pass. The subsequent evidence-only commit retains that measured app build.
- [ ] Complete a native follow tour and measure time-to-detail. The coarse whole-model DEM/mesh and imagery churn remain unresolved acceptance items under 0f. The new guarded headset preparation stopped because the debugger exposed no browser targets; USB connection alone is not a prepared session.

### 0h. Remove reproduced terrain waits and HUD upload bypasses

- [x] Reproduce both terrain stalls and HUD upload bursts in the exact published `e8f0d28` client. Publish completed DEM sections while another request remains pending; retain validated terrain when imagery preparation must retry. Preserve per-frame publication, resident budgets and stale/disposal guards.
- [x] Enforce the same 85 ms display cap for all HUD redraw causes, keeping input callbacks immediate and the final display correct. The controlled production replay changes from 1,441 requests to 12; these are not measured GPU transfers.
- [x] Check the newly supplied [second architecture review](review-2026-10-20/REVIEW_RESPONSE.md) against current code and capture scope. Keep the whole-model DEM regression open. See [scheduling and display evidence](review-2026-10-20/TERRAIN_READINESS.md).
- [x] Publish clean `62893a4` after full verification and passing [CI](https://github.com/delphimon/trekviewer/actions/runs/39386529420). The actual hosted client passes the controlled worker/HUD fixture and desktop/mobile controls. The evidence-only follow-up retains that measured app build. Native detail, time-to-detail and frame delivery acceptance remain open.
- [x] Implement an opt-in compatible imagery batching prototype with preserved UVs, normals/lighting, per-layer mips, fades/overlaps and broad High coverage. Controlled browser pixel, stereo, capped-capacity and context-recovery checks pass; see [implementation and limits](review-2026-10-20/IMAGERY_BATCHING.md). Keep the normal URL on the existing renderer.
- [x] Publish clean `a570fcb` after full verification and passing [CI](https://github.com/delphimon/trekviewer/actions/runs/39442246522). Exact hosted batching and normal desktop/mobile tour checks pass. The evidence-only follow-up retains this measured application build.
- [x] Check real public imagery/3DEP streaming with paired same-scene legacy/batch renders and object attribution. Add CPU preparation diagnostics/soft copying allowance and correct fine-raster classification. See [live evidence and remaining terrain gaps](review-2026-10-20/LIVE_IMAGERY_BATCHING.md); partial desktop hiker coverage and indivisible publication outliers remain unresolved.
- [x] Publish clean `3436e8d` after full verification and passing [CI](https://github.com/delphimon/trekviewer/actions/runs/39455297023). Exact hosted real-source comparisons and normal desktop/mobile tour checks pass; the evidence-only follow-up retains this measured app build. Keep the default renderer until native acceptance.
- [ ] Evaluate acquisition/publication ahead of tour progress against measured fine-mesh coverage under the hiker, preserving broad High anchors and resident budgets. Resident chunk count alone does not establish useful moving-hiker detail.
- [ ] Compare matched real-source/native full-tour submission, publication, memory and visual results before replacing the renderer. The prototype's synthetic draw reduction is not native acceptance. Do not assume an unlit material, default exaggeration change or a fixed near plane repairs the reported native quality regression.

### 0i. Remove duplicate terrain rendering and opaque marker submissions

- [x] Render compatible opaque streamed imagery directly on authoritative terrain, retaining lit materials, native imagery dimensions/mips, broad selection, source/mesh precision and bounded fallback. Avoid repeated clipping for transferred imagery during terrain promotion; rebuild stale CPU fallback geometry on rare release.
- [x] Instance opaque waypoint diamonds/stalks while preserving logical pins, hit targets, colors, glow, labels and transparent feedback. Verify geographic views, fades, stereo, graphics recovery, marker appearance and desktop/mobile flows. See [direct terrain evidence and limits](review-2026-10-20/DIRECT_TERRAIN.md).
- [x] Enable the guarded direct path and marker instancing by default after measured desktop submission/draw/triangle improvements. The earlier clipped-mesh experiment stays opt-in; original rendering remains selectable for comparisons. This supersedes the earlier prototype's default policy, without marking native performance accepted.
- [x] Publish clean `607d97b` after passing [CI](https://github.com/delphimon/trekviewer/actions/runs/39463946179); exact hosted geographic/recovery, live-source and desktop/mobile flow checks pass. Private Bing compatibility also passes without publishing its token. [Release evidence](review-2026-10-20/DIRECT_TERRAIN.md).
- [ ] Complete matched native High/Aerial performance and visual acceptance when the user returns to headset testing. The connected headset exposed no debugger tab, and the user deferred opening/wearing it; continue independent engineering without repeated unprepared test requests. Keep the 72 Hz, whole-model detail and loading/coverage gates open.

### 0j. Keep terrain work responsive as the hiker moves

- [x] Reproduce and repair stale acquisition priority when desired membership stays unchanged. Admit the current ground tile under full download occupancy without dropping completed grids or retained terrain; preserve High/Balanced acquisition and residency limits.
- [x] Separate decoding from geometry in two bounded reusable worker lanes. Cancel callers immediately, drain stale execution responses, retain source caches and bound abandoned jobs; preserve startup handshake, recovery and detached-buffer guards.
- [x] Reduce anchor selection and tile-planning work while proving ordered-anchor/complete-plan equality against the previous algorithms. Verify 694 Windows tests, typechecking/build, live source compatibility, worker reuse and graphics recovery. See [terrain scheduling evidence and limits](review-2026-10-20/TERRAIN_SCHEDULING.md).
- [x] Publish clean `787ece6` after passing [CI](https://github.com/delphimon/trekviewer/actions/runs/39492902086); exact hosted real-source, worker reuse, geographic/recovery and desktop/mobile flow checks pass. [Release evidence](review-2026-10-20/TERRAIN_SCHEDULING.md).
- [ ] Complete native 72 Hz, full-tour loading/coverage and whole-model detail acceptance; the user has deferred the next headset test.

### 0k. Refine the ground the displayed hiker follows

- [x] Reproduce the analytical GPS/smoothed visual-route mismatch and prioritize the marker's model-local ground during desktop and XR diorama Follow. Preserve telemetry, inspected focus when stopped, room transforms and existing resource/source policy.
- [x] Verify 696 Windows tests, typechecking/build, full 90-second real-source desktop playback and desktop/mobile controls. See [visible-ground evidence and loading limits](review-2026-10-20/VISUAL_GROUND.md).
- [x] Publish clean `e3d5b88` after passing [CI](https://github.com/delphimon/trekviewer/actions/runs/39501376903). Exact hosted full-tour and desktop/mobile checks pass; 264/367 fine-ground samples leave loading acceptance open. [Release evidence](review-2026-10-20/VISUAL_GROUND.md).
- [ ] Resolve remaining full-tour fine-terrain gaps, broad overview detail and native performance/visual acceptance. Focus correctness alone does not close these gates.

### 0l. Avoid copying unchanged terrain into the worker

- [x] Measure surface/geometry message copying and loading stages during a complete real-source desktop tour. Reproduce delayed current-tile admission below the 60 m movement threshold.
- [x] Reuse unchanged versioned surface arrays across metadata revisions and one immutable chunk base. Preserve bounded cache lifetime, fresh coverage holes, restart/cancellation behavior and source/geometry quality. Fix immediate current-tile admission at boundaries.
- [x] Verify 703 Windows tests, typechecking and the production build. Local full-tour auditing eliminates 78.85% of equivalent surface/base-array bytes without quality changes; geographic/recovery and desktop/mobile checks pass. See [worker transport evidence and limits](review-2026-10-20/WORKER_TRANSPORT.md).
- [x] Publish clean `b030fe9` after passing [CI](https://github.com/delphimon/trekviewer/actions/runs/39516535269). Exact hosted full-tour auditing reduces equivalent surface/base bytes by 78.17%; imagery/recovery, private account-path compatibility and desktop/mobile checks pass. Fine-ground coverage remains incomplete (286/368 samples). [Release evidence](review-2026-10-20/WORKER_TRANSPORT.md).
- [ ] Complete native performance and full-tour fine-terrain/overview-detail acceptance; reduced copying alone does not close these gates.

### 0m. Prepare upcoming ground during Follow playback

- [x] Trace repeated terrain builds/publications and browser export requests by tile ID. Correct warm eviction recency without changing the desired set or resource limits.
- [x] Predict 1.5 real seconds of Tour/Track playback without advancing state, then prioritize upcoming ground after current ground within the existing radius/tile/vertex budget. Clear the hint on pause/follow release and retain broad parent coverage, view-driven surrounding detail and source quality.
- [x] Verify 709 Windows tests, typechecking and the production build. See [terrain look-ahead evidence and limits](review-2026-10-20/TERRAIN_LOOKAHEAD.md).
- [x] Publish clean `4dbc044` after passing [CI](https://github.com/delphimon/trekviewer/actions/runs/39520987794). Exact hosted full-tour checks reproduce 97.3% fine hiker coverage; geographic/recovery, look-ahead/pause controls and private account-path compatibility pass. [Release evidence](review-2026-10-20/TERRAIN_LOOKAHEAD.md). Terrain-work counts remain substantial; no native frame-rate acceptance is claimed.
- [ ] Resolve remaining terrain churn, full-tour loading, broad overview detail and native performance/visual acceptance.

### 0n. Adopt worker-prepared terrain without rebuilding it on the render thread

- [x] Transfer prepared indices/bounds and adopt the worker-owned arrays using a constant-size grid shell. Preserve regular-grid traversal/clipping, exact geometry/UVs/normals, terrain sampling, exaggeration, source quality and all selection/resource limits.
- [x] Verify 711 Windows tests, both typechecks and the production build; benchmark exact prepared-geometry parity and add real-transfer/16-bit/32-bit index/picking regressions. Exclude the unproven tile-retention experiment. See [terrain publication evidence](review-2026-10-20/TERRAIN_PUBLICATION.md).
- [x] Publish clean `279b2f5` after passing [CI](https://github.com/delphimon/trekviewer/actions/runs/39526299157). Exact hosted full-tour checks reproduce 0.1 ms median / 0.2 ms p95 construction (previous 3.7/5.9 ms), with control, graphics-recovery and private account-path checks passing. [Release evidence and limits](review-2026-10-20/TERRAIN_PUBLICATION.md). Remaining churn, loading and native gates stay open.
- [ ] Resolve repeated terrain work, loading consistency, overview DEM detail and native performance/visual acceptance.

### 0o. Reuse exact latitude projection across terrain rows

- [x] Reuse only the most recent exact Mercator latitude, preserving current source/grid/data/validity inputs, all numeric sampling behavior and existing quality/resource limits.
- [x] Verify 712 Windows tests, both typechecks and the production build. Check 187,308 exact sample matches and complete chunk build-data parity; isolated median full construction falls 17.3%, with the scattered-sampling tradeoff stated. See [elevation projection evidence](review-2026-10-20/ELEVATION_PROJECTION.md).
- [x] Publish clean `30f45a2` after passing [CI](https://github.com/delphimon/trekviewer/actions/runs/39530766480). Exact hosted full-tour, desktop/mobile controls, geographic/stereo/context-recovery and private account-path checks pass. Fine ground is visible in 357/368 samples; churn remains substantial. [Release evidence and limits](review-2026-10-20/ELEVATION_PROJECTION.md).
- [ ] Complete loading/churn, overview-detail and native performance/visual acceptance.

### 0p. Share published terrain coverage with ray picking

- [x] Profile normal playback separately from image-comparison stress. Reuse the generator's exact cell mask across pickers with weak lifetime and index/version/range/dimension guards, preserving all terrain/imagery/quality limits.
- [x] Verify 716 Windows tests, typechecking/build, 3.97 million visibility decisions, native picking/freshness/fallback regressions and browser controls/recovery. Normal-playback sampled mask CPU falls 149.353 to 1.607 ms in the local prototype; this is a substep measurement. See [coverage reuse evidence](review-2026-10-20/TERRAIN_PICKING.md).
- [x] Publish clean `5f993f3` after passing [CI](https://github.com/delphimon/trekviewer/actions/runs/39534866770). Exact hosted CPU sampling records 3.183 ms in mask acquisition versus 149.353 ms before; full-tour, controls, geographic/stereo/recovery and private account-path checks pass. [Release evidence and limits](review-2026-10-20/TERRAIN_PICKING.md). Churn/loading and native acceptance remain open.
- [x] Resolve the recorded preexisting grid-boundary precision miss; see checkpoint 0q.
- [ ] Resolve remaining churn/loading/overview detail and native performance/visual acceptance.

### 0q. Pick the terrain's actual Float32 grid boundaries

- [x] Use stored grid coordinates for cell entry/crossings and include visible shared edges/corners beside coverage holes. Preserve bounded traversal, exact triangle hits and existing source/mesh/resource policy.
- [x] Verify 720 Windows tests, typechecking/build, 816 targeted native comparisons and 512 seeded relief rays. Local controls/recovery and real-source tour pass image gates, with an explicit isolated CPU tradeoff and incomplete fine-ground coverage. See [boundary evidence and limits](review-2026-10-21/TERRAIN_BOUNDARIES.md).
- [x] Repeat the current published and corrected full tours: 95.7%/96.7% fine-ground samples, with variable loading/churn and an explicit isolated CPU tradeoff. No overall performance improvement is established.
- [x] Publish clean `f47ed33` after passing [CI](https://github.com/delphimon/trekviewer/actions/runs/39560861976). Exact hosted full-tour, desktop/mobile controls and geographic/stereo/context recovery pass. Fine ground is visible in 357/367 samples (97.3%); 430 repeated builds leave churn unresolved. [Release evidence and CPU tradeoff](review-2026-10-21/TERRAIN_BOUNDARIES.md).
- [ ] Complete loading/churn, overview-detail and native performance/visual acceptance.

### 0r. Avoid full coarse-index uploads during terrain changes

- [x] Establish stationary and source-cache baselines. Reproduce 6.67 GB of coarse-index WebGL updates in one moving desktop tour; cache read aborts and settled-view churn are not reproduced.
- [x] Implement incremental whole-cell index compaction with exact triangle/winding/coverage parity, bounded pending upload blocks and preserved complete-surface normals. An isolated 1,000-change comparison requests 99.42% fewer index bytes with about 44.9% less CPU, adding about 1.1 MB of bounded CPU bookkeeping. See [index-update evidence and limits](review-2026-10-21/TERRAIN_INDEX.md).
- [x] Verify 726 Windows tests, typechecking/build, pending writes through 300 culled revisions, real-source full tours with exact normals through exaggeration, desktop/mobile controls and graphics recovery. Final local base-index updates total 14.11 MB; loading remains incomplete.
- [x] Publish clean `fa75d0b` after passing [CI](https://github.com/delphimon/trekviewer/actions/runs/39566075453). Exact hosted full-tour, normal/exaggeration, desktop/mobile and geographic/stereo/recovery checks pass. WebGL index bytes fall 99.71% against whole-prefix uploads for the same hosted update sequence; the native driver/frame-rate tradeoff remains unmeasured. [Release evidence](review-2026-10-21/TERRAIN_INDEX.md).
- [ ] Complete loading/churn, overview-detail and native performance/visual acceptance.

### 0s. Reuse exact geography for fine-terrain imagery

- [x] Trace moving-tour tile demand and cancellation without changing fidelity or budgets. Reduce duplicate coordinate/latitude projection during fine-terrain construction with exact full build-data parity; isolated median CPU falls 16.5%, with the scattered-mapping tradeoff stated. See [projection evidence and limits](review-2026-10-21/CHUNK_PROJECTION.md).
- [x] Verify both typechecks, 729 Windows tests and the production build.
- [x] Publish clean `3dce114` after passing [CI](https://github.com/delphimon/trekviewer/actions/runs/39613052050). Exact hosted full-tour, normal/exaggeration, desktop/mobile, geographic/stereo/recovery and private account-path checks pass. Fine ground is visible in 359/368 hosted samples (97.6%); loading/churn remains unresolved. [Release evidence](review-2026-10-21/CHUNK_PROJECTION.md).
- [ ] Complete loading/churn, overview-detail and native performance/visual acceptance.

### 0t. Validate the rendered DEM footprint before falling back

- [x] Count complete required bilinear support in the worker; tolerate only NoData outside that support, without invented heights. Keep valid partial encoded bytes and footprint-specific cache/backoff ownership. Preserve existing default request identities, source/mesh precision and resource limits.
- [x] Check 2,504,034 Float32 positions, three real source pairs and 738 Windows tests. The compact-request experiment reduces pixels/bytes but its first full tour has only 19% fine-ground coverage; keep it developer opt-in rather than changing the default. See [footprint evidence and limits](review-2026-10-21/TERRAIN_FOOTPRINT.md).
- [x] Complete exact local/hosted worker, full-tour, control/recovery and account-path validation; publish clean `7b204fd` after passing [CI](https://github.com/delphimon/trekviewer/actions/runs/39673689727). Hosted fine terrain appears in only 293/367 tour samples (79.8%), versus 97.0% locally; live loading remains inconsistent and is not accepted as improved. Evidence-only follow-up retains the measured build.
- [ ] Complete loading/churn, overview detail, interior NoData and native visual/performance/lifecycle acceptance.

### 0u. Investigate installed delivery and explicit offline route packs

- [x] Verify current Quest PWA/APK support, the repository's hosted-only wrapper and absent offline shell/pack manager. Record source-rights, storage, versioning, size and strict offline acceptance requirements in [the delivery proposal](OFFLINE_ROUTE_PACKS.md).
- [x] Confirm the user's scope: **all eight bundled routes, estimate sizes first**. Compare full model coverage with an explicitly declared 1 km high-detail route corridor and complete overview; preserve normal High coverage in the app.
- [x] Estimate every bundled route before bulk acquisition using exact terrain/imagery inventories and 24 validated public images (37.8 MB retained). Current lossless Z19 planning budgets are 66–174 GB full / 17–42 GB corridor, including raw elevation; see [all route/component/detail options](review-2026-10-21/offline-packs/SIZE_ESTIMATES.md). No pack-scale download or native-resolution equivalence is claimed.
- [x] Apply the user's next selection: **Rainier and Enchantments as default downloads**. Preserve full surrounding-model High public satellite coverage, with storage estimates before acquisition. See [implementation and acceptance limits](review-2026-10-21/OFFLINE_DEFAULTS.md).
- [x] Implement a hash-verified versioned offline shell and independently retained foreground pack download/resume/remove with atomic publication, corruption recovery, quota checks and browser-wide ownership. Keep live GPX imports and existing High quality/resource limits. Controlled browser storage/offline-worker checks pass; real complete packs remain unaccepted.
- [x] Publish clean `ef0b4ba` after passing [CI](https://github.com/delphimon/trekviewer/actions/runs/39687533140), 745 Windows tests and local/hosted offline, full-tour, control, graphics/recovery and private account checks. The exact hosted shell/worker work with networking disabled. Fixture storage validation is not complete acquisition or a real offline High tour of either default pack.
- [x] Remove raw-pixel capacity as a minimum-quota gate: retain original compressed sources, check shared storage before acquisition/each write, pause without phantom progress, and resume after freeing space. Validate elevation before imagery without changing source identities or quality. Exact release evidence follows in the offline checkpoint report.
- [x] Publish clean `f6f1150` after passing [CI](https://github.com/delphimon/trekviewer/actions/runs/39709807518), 752 Windows tests and exact hosted storage/offline-worker, full-tour, control/graphics/recovery and private compatibility checks. Hosted fine terrain is available in only 209/367 samples (56.9%); live loading remains unresolved, with no performance improvement claim from the capacity correction. See [release evidence](review-2026-10-21/OFFLINE_DEFAULTS.md#encoded-storage-capacity-follow-up).
- [x] Validate sixteen selected real default-plan sources (24.1 MB) with the production worker/Canvas validators, then revalidate their retained hashes without new downloads. Both overview DEM rasters and selected local support windows pass; selected Z16–19 imagery is opaque. Measure exact-byte lossless gzip DEM components: only 17–18% smaller in this sample, with original byte/SHA-256 round trips. See [real source/component evidence](review-2026-10-21/offline-real-defaults/COMPONENTS.md). This is not a full coverage audit, source-native bake, compressed runtime format or completed route pack.
- [ ] Validate a bounded source-native bake with complete source/NoData coverage and actual encoded/installed sizes, then finish acquisition and network-disabled High tours of both real default packs. Displayed raw budgets remain planning values, not measured encoded sizes or required free space.
- [x] Add bounded PC preparation and portable file import with original-source hashes/provenance, gzip elevation components, shared cancellation/ownership/quota checks and atomic publication. Cross-runtime request fingerprints account for final-ULP Mercator differences without changing live URLs or source precision. See [portable-pack implementation and acceptance limits](review-2026-10-21/PORTABLE_ROUTE_PACKS.md).
- [x] Publish clean `fad1dc2` after passing [CI](https://github.com/delphimon/trekviewer/actions/runs/39719048849), 765 Windows tests and exact hosted archive/storage, cached-shell/worker, full-tour, control/graphics/recovery and private compatibility checks. The first shell-readiness check timed out; an isolated retry passes with unchanged integrity checks, while the cause remains unresolved. Hosted fine terrain appears in only 247/367 samples (67.3%), so native/live-loading acceptance stays open.
- [ ] Add browser export of already-downloaded packs and a geographic source index beyond the initial renderer-compatible request inventory; verify complete multi-GB interruption/update recovery and native file selection/import.
- [ ] Verify completely network-disabled startup/reload, full tours, inspection boundaries and pack/update recovery, then test the signed installed Quest app. Native visual/performance/lifecycle acceptance remains separate.

### 1. Make High's actual XR rendering quality explicit

- [x] Implement an explicit foveation policy: High requests 0; Balanced uses a documented separate policy. Apply correctly at session creation and quality changes without overriding runtime head tracking.
- [x] Record requested and runtime-supported/applied foveation, actual eye/layer dimensions and refresh target. Mark unsupported values as unknown; do not infer success from a setter alone.
- [x] Add focused lifecycle/quality-policy regressions and verify full-resolution source/mesh settings remain unchanged.
- [x] Prepare a reproducible native comparison for the current policy and the corrected High policy. Disabling foveation may increase GPU work; record that cost without compensating through hidden quality reductions. The capture helper and protocol are prepared; native execution is still checkpoint 2.

**Done when:** the policy is explicit and tested, the published build is traceable, and actual supported runtime state can be captured. Subjective sharpness/performance acceptance belongs to checkpoints 2 and 5.

### 2. Capture a usable current-build native baseline

**October 17 status:** the exact `7d61b22` client was loaded and the Olympus/Bailey 1:1 position prepared. The user deferred headset testing. The host capture was stopped; no native run or acceptance is claimed. Reconfirm/reload the current published client and reattach capture when testing resumes, especially after another publication. Continue independent source/provenance work meanwhile.

**October 19 update:** a 154.9-second native MR diorama baseline on exact client `9cc6afa` was device-saved and host-copied, with a separately marked eight-second runtime/GPU trace and CPU sample. Native frame delivery and subjective quality fail acceptance. Full-tour, sustained thermal, transition and restart gates remain open; use checkpoint 0f and the linked baseline to select the next change. The absence-of-headset notes above describe earlier checks, not the current device state.

- [ ] Preconfigure the exact published build, route, progress, High/Aerial state and recorder before requesting headset participation. Preserve the `483e4d5` historical evidence; label it as a different run.
- [ ] Use one prepared session covering anchored tabletop inspection, route tour playback, manipulation, slow head turns and returns, and VR/MR transitions. Keep comparable portions separate in the report. First-person portions are deferred under the October 19 scope change.
- [ ] Retrieve the completed device-saved report promptly and verify its recorded client build, presentation/blend mode and eye count. Keep a host copy before browser closure; test restart recovery during lifecycle acceptance.
- [ ] Capture browser CPU stacks/Long Tasks and available Meta GPU, actual application/compositor frame delivery, dropped/reprojected frames, memory pressure and thermal metrics. Record measurement gaps explicitly.
- [ ] Attribute evictions using budget/visible/desired counters, resident/desired sets and the same terrain sample points over time. Record geometry/texture publication work outside animation timers where needed.

**Done when:** a comparable, retrievable report identifies the current limiting costs and shows whether the worker/retention changes affect actual head-turn clarity. An empty external recorder window or sleeping debugger is not a failed user test. Avoid repeated unprepared requests for the same manual run.

### 3. Reduce the measured rendering/streaming bottleneck

- [ ] If submission/draw calls dominate, prototype batching compatible tiles sharing source rasters/materials. Verify per-eye visibility, exact geographic UVs, texture filtering/mip boundaries, depth ordering and partial/fading sibling coverage.
- [ ] If publication/uploads dominate, schedule bounded preparation/upload/publication batches while preserving the visible surface until a complete replacement is ready. Measure time-to-sharp as well as frame cost.
- [ ] If selection-driven turnover remains material, reproduce it with stable route/view inputs and retain useful prior regions without omitting current sampled slopes or shrinking overscan. Distinguish cold exploration from stationary/revisited views.
- [ ] If GPU vertex/fragment work dominates, use captures to remove redundant work or improve spatial batching/culling. Keep the full-quality High baseline and require matched visual evidence for any rendering change.
- [ ] Test combined changes on-device using checkpoint 2 conditions; maintain bounded CPU/GPU resources and document the tradeoff if the fidelity/refresh target remains unattainable.

**Done when:** the limiting device cost is measurably lower at matching quality, stationary/revisit tile churn is controlled, and the native frame budget passes the acceptance gate below. Do not substitute isolated operation counts for a native result.

### 4. Finish source coverage and fidelity provenance

**October 17 progress:** all eight bundled summit-point catalogs were audited, with preferred-service timeouts and alternative native imagery resolutions/dates retained. Published patch source reporting now distinguishes actual supplying services from provider configuration, including Hybrid and alternative ordering after service cooldown. See [source audit and limits](review-2026-10-17/SOURCE_AUDIT.md). Whole-route/native-resolution validation, representative imported-route runtime tests and regional provider integration remain open; the partial evidence does not close the checklist below.

The [persistent source-cache checkpoint](review-2026-10-17/RESOURCE_CACHE.md) adds bounded device storage for reviewed public imagery/terrain bytes and updates the free-key candidate review for personal/internal use. New keyed providers are not enabled until an eligible account/key and appropriate browser/private-key path are configured and validated.

**October 18 progress:** [Swiss aerial detail](review-2026-10-18/SWISS_IMAGERY.md) is integrated for imports within the official service envelope, with exact masked PNG validation, global overview retention, revision-aware device caching and actual source reporting. Imported Swiss-route browser checks exercise real imagery, disk reuse, update/failure guards and missing coverage. Swiss DEM/lidar integration, native inspection, full 10 cm source sampling beyond the current Z19 cap, additional regions and route-wide provenance remain open. Free API-key services remain eligible; no key or paid plan is required for this improvement.

- [ ] Audit bundled routes plus representative imported routes inside/outside supported US coverage. Record the selected dataset, verified native resolution where available, export sample spacing, rendered cell spacing, source date, terms/attribution and fallback reason.
- [ ] Verify whether higher-detail free regional sources exist for locations currently using the coarse global fallback; add applicable providers with coverage, NoData, response-size, cache and failure guards. Verify terms and endpoint behavior before recommending or integrating a source.
- [ ] Ensure unavailable coverage is visibly explained and that a coarse fallback is never mislabeled as fine imagery. Keep commercial providers explicit opt-ins.

**Done when:** the supported-route/source matrix is documented and tested, better verified applicable free sources are selected, and remaining geographic limits are clear. No universal native-resolution claim is made for unsurveyed or unaudited regions.

### 5. Consolidated usability, stability and sustained acceptance

- [ ] Check controller and hand ownership, tracking loss/reacquisition, physical movement/recenter, seated tabletop use, tour playback/scrubbing, horizon lock/reset and spatial text/target usability. Native first-person walking/stepped movement/snap-turn acceptance is deferred; retain automated regressions.
- [ ] Check VR and MR entry, in-app exit and headset/system exit, repeated mode changes, reference-space reset, graphics interruption/recovery and clean re-entry. Confirm the observed XR frame-lifetime error does not recur in covered scenarios.
- [ ] Complete a 15-minute mixed inspection/transition run, including cold loading and revisiting established views. Record thermal state and separate loading intervals from settled frame delivery.
- [ ] Exit, wait for a committed report save, restart Quest Browser and verify that the same report/build remains downloadable.
- [ ] Re-run desktop/mobile zoom, clipping, horizon, imports and normal published-site checks; close the status matrix with actual evidence and publish the final accepted checkpoint.

## Acceptance gate

These are completion targets, not claims already established:

| Area | Required evidence |
| --- | --- |
| Native performance | Meet the requested 72 Hz application target in settled High scenes, with CPU/GPU work inside the approximately 13.9 ms frame budget and measured headroom. Report p95/p99, dropped/reprojected frames, loading spikes and thermal behavior; compositor synthesis alone is not application frame delivery. |
| Visual fidelity | Confirm High's runtime rendering policy, consistent source/DEM detail across center and upper/lower/side inspection samples, and subjective clarity in both eyes. No quality reductions introduced to pass performance. |
| Continuity | No terrain holes or loss of published imagery during replacement. Established views that fit the retained working set remain sharp through head turns/returns; no unexplained repeated sharp-to-blurry cycling. New cold regions may require loading, which is measured separately. |
| Residency | No desired-tile pressure evictions during steady-state scenarios whose desired set fits the configured limit. Warm eviction remains bounded and is explained by actual capacity pressure. |
| Source policy | Verified source/coverage/terms matrix, explicit geographic/native-resolution limits, correct credits and no implicit paid/commercial fallback. |
| Usability/lifecycle | Desktop controls pass regression checks; native manipulation, comfort, tracking, exits/re-entry and browser-restart report recovery pass the consolidated checklist without application exceptions. |
| Release | Passing relevant automated checks and CI, clean committed/published build, successful production verification, and evidence tied to that exact client revision. |

If a gate cannot be met at the requested fidelity on the target device, keep it open and present the measured constraint and concrete options. Do not mark the work complete based only on test counts or successful deployment.
