# TrekViewer completion plan

Updated October 19, 2026 (America/Los_Angeles), incorporating the supplied architecture review, its verification against `edeb169`, and the user's revised diorama/flyover priority. The work from [the prior chat](codex://threads/01a1367f-44dc-7a92-9f73-5542191e510a) remains the baseline, including caching, source provenance, worker recovery and entry integrity. Checkpoint 1 is implemented with regression/browser evidence in [XR quality](review-2026-10-17/XR_QUALITY.md); native checkpoints remain open. This is the authoritative remaining-work plan; dated checkpoint reports describe historical results rather than current completion status.

## Outcome and constraints

Deliver a consistently sharp, stable and usable Quest VR/MR terrain viewer, with the best verified source data available under the user's no-paid-license personal-use constraint and sustained performance at the requested runtime target. Keep desktop inspection, horizon controls and direction chevrons working.

**Product priority, October 19:** focus current development and acceptance on the tabletop diorama and route tours/flyover. Pause new 1:1 slope-walking and ground-level fidelity work; retain the existing mode and its regression safeguards. First-person acceptance is deferred and no longer blocks a diorama checkpoint. A tour should work independently of multi-day GPS timestamps. Desktop camera follow is opt-in; tabletop XR playback keeps the model anchored and leaves the tracked camera under runtime control.

**Native feedback, October 19 evening:** the connected Quest 3 run on `9cc6afa` failed subjective acceptance: slow/low-resolution tiles, flat-looking terrain and worse performance than the earlier experience. Restoring imagery/DEM appearance, loading stability and frame delivery now takes priority over additional flyover features. The [native baseline](review-2026-10-19/NATIVE_TABLETOP.md) records the saved MR report, scoped runtime/GPU trace, coarse whole-model versus fine local sampling, historical source selection and remaining limits. No quality/performance acceptance is claimed.

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
- [ ] Correct imagery selection/publication/retention churn and measure time-to-sharp without shrinking High's coverage or removing native source detail.
  - [x] Reserve current-view request admission and cancel abandoned physical downloads while preserving live shared consumers and valid cached bytes; [cancellation checkpoint](review-2026-10-19/IMAGERY_CANCELLATION.md). Controlled transport/scheduler checks pass; native time-to-sharp and broader churn acceptance remain open.
- [ ] Verify whole-model ridge/slope fidelity separately from local source resolution. Current Olympus/Bailey base mesh cells are approximately 94 m; the approximately 1 m local export does not describe the whole model.
  - [x] Reproduce and correct implicit DEM footprint adjustment: the live Olympus base export misplaced outer north/south samples by about 8.5 m; [registration evidence](review-2026-10-19/DEM_REGISTRATION.md). This is a mapping correction, not native visual acceptance or a finer whole-model mesh.
- [ ] Use measured CPU submission/GPU evidence to prototype compatible imagery batching and investigate excessive paused-HUD uploads. Require exact UV/coverage parity and a matched native rerun before claiming improvement.

**Next architecture work:** use a tabletop native baseline to choose terrain batching or bounded publication work. Extend the shared UI presentation layer incrementally; extract XR manipulation state only with transition regressions. Investigate explicit cached/offline route packs for curated routes, accounting for source terms, archive size, decode/upload time and memory. Do not promise instant loading, remove live imports/caches, or replace the complete terrain pipeline without matched visual and device evidence. See [review response and checkpoint evidence](review-2026-10-19/DIORAMA_TOUR.md).

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
