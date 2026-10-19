# TrekViewer completion plan

Updated October 18, 2026 (America/Los_Angeles), following the [current-state review](review-2026-10-16/STATE_REVIEW.md) of application revision `086ece3`. Checkpoint 1 is implemented with regression/browser evidence in [XR quality](review-2026-10-17/XR_QUALITY.md); native checkpoints remain open. This is the authoritative remaining-work plan; dated checkpoint reports describe historical results rather than current completion status.

## Outcome and constraints

Deliver a consistently sharp, stable and usable Quest VR/MR terrain viewer, with the best verified source data available under the user's no-paid-license personal-use constraint and sustained performance at the requested runtime target. Keep desktop inspection, horizon controls and direction chevrons working.

**Source policy clarification, October 17:** this is the user's personal/internal application, with no public product release planned. Free API-key imagery, DEM and lidar-derived sources are allowed when the applicable personal/internal plan costs nothing. An API key is not itself a reason to reject a finer or faster source. Verify hard limits, eligibility, attribution and caching rights; avoid plans that can incur usage charges. Keep private keys out of hosted bundles/repositories, using device-local configuration, a private backend or local data preparation as appropriate. Existing test-site publication remains a checkpoint workflow, distinct from a public product release.

- High is the fidelity mode. Keep broad surrounding terrain, full-detail 1:1 inspection, source-native detail, accurate geometry/UVs and readable spatial controls as explicit requirements.
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
- [x] Eviction preference for visible warm imagery over hidden obsolete work; eligible-only scoring and eviction counters.
- [x] Comfortable locomotion defaults, exclusive input ownership, workload limits, responsive controls and desktop graphics recovery.
- [x] Opt-in completed-report persistence and build provenance.

These checkmarks mean implemented and tested in their documented environments. They do not mark the immersive experience accepted.

## Remaining checkpoints, in execution order

### 1. Make High's actual XR rendering quality explicit

- [x] Implement an explicit foveation policy: High requests 0; Balanced uses a documented separate policy. Apply correctly at session creation and quality changes without overriding runtime head tracking.
- [x] Record requested and runtime-supported/applied foveation, actual eye/layer dimensions and refresh target. Mark unsupported values as unknown; do not infer success from a setter alone.
- [x] Add focused lifecycle/quality-policy regressions and verify full-resolution source/mesh settings remain unchanged.
- [x] Prepare a reproducible native comparison for the current policy and the corrected High policy. Disabling foveation may increase GPU work; record that cost without compensating through hidden quality reductions. The capture helper and protocol are prepared; native execution is still checkpoint 2.

**Done when:** the policy is explicit and tested, the published build is traceable, and actual supported runtime state can be captured. Subjective sharpness/performance acceptance belongs to checkpoints 2 and 5.

### 2. Capture a usable current-build native baseline

**October 17 status:** the exact `7d61b22` client was loaded and the Olympus/Bailey 1:1 position prepared. The user deferred headset testing. The host capture was stopped; no native run or acceptance is claimed. Reconfirm/reload the current published client and reattach capture when testing resumes, especially after another publication. Continue independent source/provenance work meanwhile.

- [ ] Preconfigure the exact published build, route, progress, High/Aerial state and recorder before requesting headset participation. Preserve the `483e4d5` historical evidence; label it as a different run.
- [ ] Use one prepared session covering stationary 1:1, slow up/down/side turns and returns to prior views, tabletop inspection, and VR/MR transitions. Keep comparable portions separate in the report.
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

- [ ] Check controller and hand ownership, tracking loss/reacquisition, physical movement/recenter, seated use, walking/stepped movement/snap turning, horizon lock/reset and spatial text/target usability.
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
