# State review against the requested outcome

Reviewed October 16, 2026 (America/Los_Angeles). Application revision: **`086ece3479e3603855e99be9432a2d18206d0fde`**. This is a review/planning checkpoint; it changes no application behavior. [Completion plan](../COMPLETION_PLAN.md).

The desktop usability work is implemented and browser-tested. The high-detail source/streaming path has improved substantially. **The overall immersive quality/performance objective is not complete:** the latest physical-headset MR recording predates the worker and eviction changes, was well below the 72 Hz target, and still showed frequent fine-tile removal. A further rendering-quality mismatch is identified below.

## Requirements and evidence

| User requirement | Current assessment | Evidence / remaining gap |
| --- | --- | --- |
| Direction chevrons | Implemented; retain existing behavior | Existing ribbon chevrons; the user's correction removed the need to add another system. |
| Close desktop zoom and cut-off terrain | Implemented, desktop-tested | `InspectionView.ts` uses a 0.00001 m orbit floor and adaptive clipping. [Inspection checks](../review-2026-10-13/INSPECTION.md) and latest published browser smoke passed. |
| Persistent level-horizon lock and one-action reset | Implemented, regression/browser-tested | Lock constrains model tilt; reset preserves heading/translation/scale/progress. Desktop/mobile and spatial control wiring exist. End-to-end headset manipulation remains part of acceptance. |
| High-quality terrain above/below the immediate view and in 1:1 | Partly validated | High uses broad overscanned stereo samples and approximately 5 m refinement cells. Native trail samples were all Z19 in 78/87 windows, with at least one Z19 hit in 87/87. This is sampling, not proof of full-frame uniform quality. Fixed foveation needs correction/verification. |
| Stable sharp imagery during VR/MR head movement | Improved implementation; not accepted as complete | Published residents no longer disappear solely because selection changes. Worker preparation and warm eviction policy are implemented/tested. Native eviction remained substantial on the older recorded build; their combined current-build effect is unmeasured. |
| Best available sources without a paid personal-use license | Public-source policy implemented; geographic quality ceiling remains | Auto uses USGS/USDA imagery, best-available USGS elevation where eligible, EOX global imagery and terrain fallbacks. No implicit commercial fallback. Global imagery is capped at Z15; this is not proof of best available regional free data everywhere. [Source audit](../review-2026-10-13/SOURCES.md). |
| High fidelity with sustained Quest performance | Open, highest priority | Latest native MR: 29.9/32.0 Hz median callback rates for trail/tabletop against a 72 Hz target; CPU submission and GPU/compositor measurements must be distinguished. |
| Meta VR best practices and usability | Implemented foundations; native acceptance incomplete | Comfortable movement/snap turning, ownership, tracking release, bounded imports, lifecycle cleanup, graphics recovery and accessible responsive controls have regression/browser evidence. Comfort, readability, physical alignment and lifecycle still need consolidated headset checks. |
| Commit and publish every checkpoint | Followed | `086ece3` was confirmed live with a clean build stamp. [CI](https://github.com/delphimon/trekviewer/actions/runs/39011270078) passed all 586 tests, types and build. This planning checkpoint will be committed/published separately. |

## Prioritized findings

### P1 — High quality inherits a maximum fixed-foveation request

The installed, locked Three.js `WebXRManager.js` initializes `foveation = 1.0` at line 47 and applies it on session setup. Its setter documents 0 as full resolution and 1 as maximum peripheral reduction. TrekViewer constructs the renderer in `src/core/SceneManager.ts` but has no `setFoveation`, `fixedFoveation` or equivalent override in `src/`.

Thus, the app inherits a maximum-foveation request even in High. Sharp source tiles and a detailed DEM do not compensate for reduced eye-buffer sampling. This conflicts with the user's request to avoid conspicuous peripheral quality reductions. The actual runtime/layer value was not captured in existing reports; this review does **not** prove it caused the reported tile popping or every blurry region.

**Required next change:** make High's full-resolution rendering intent explicit, with a requested foveation value of 0, and record the supported/applied layer state. Give Balanced a separate intentional policy. Measure the GPU cost instead of silently reducing High quality elsewhere. Meta's [FFR documentation](https://developers.meta.com/horizon/documentation/web/webxr-ffr/), verified for this review, describes peripheral resolution reduction and possible visible artifacts.

### P1 — Current-build native performance and continuity remain unverified

The latest [completed native MR run](MR_COMPLETED.md) used `483e4d5`. It preceded `ef1a09b` (exit deferral), `6c1b71e` (streamed worker preparation), and `086ece3` (eviction priorities). Its 164.7 seconds included both trail and tabletop modes, a route-position change and a visibility pause; it cannot serve as a controlled before/after comparison.

Trail/tabletop median callback rates were 29.9/32.0 Hz; peak draw calls were 872/1,068, with up to 3.40/7.64 million stereo triangles. There were 178 Long Tasks. No WebGL context loss and no hidden-while-resident fine observations were seen, but 2,130 trail fine-eviction observations and 3,502 patch creations/disposals between first/last trail windows show unresolved turnover on that build.

**Required next step:** one prepared current-build acceptance/profiling session, with stable route/view conditions, complete build provenance, durable retrieval, actual foveation/eye-buffer data, CPU stacks and available native GPU/compositor metrics. Another isolated desktop microbenchmark cannot close this gap.

### P1 — The renderer still has a high per-tile submission cost

`ImageryLODManager.createAndMountPatch()` creates a separate mesh, texture and standard material per patch. Current worker preparation removes clipping from the main animation thread, but does not reduce the number of submitted objects or their texture uploads. Native data justifies investigation; it does not by itself establish whether the current build is CPU-, vertex- or fragment-bound.

**Required optimization path:** use the device profile to choose the limiting work, then evaluate shared-source texture/mesh batching, publication/upload scheduling, or equivalent reductions in repeated work. Preserve geographic UVs, mip behavior, normals, depth priority, atomic coverage and stereo bounds. Do not preselect lower source resolution, stronger foveation or a smaller high-detail footprint as the performance fix. Follow Meta's [CPU/GPU profiling workflow](https://developers.meta.com/horizon/documentation/web/webxr-perf-workflow/).

### P2 — Quality/source claims need geographic and resolution boundaries

The source policy is substantially better aligned with the request than the earlier commercial default. However, requested export sampling, native survey detail, rendered mesh spacing and eye-buffer resolution are different quantities. For example, the saved Rainier identify response selected an approximately 3 m source class despite approximately 1 m export sampling; the mesh remains approximately 5 m. Outside CONUS, the default imagery path is approximately 10 m EOX imagery capped at Z15.

**Required next step:** maintain a source/coverage/terms matrix for the bundled routes and representative imports. Verify better free regional options before adding them, and expose actual fallback/provenance clearly. Do not label the global fallback or an upsampled export as universally highest-quality data. This review does not redo the earlier legal/source audit or certify third-party availability.

### P2 — Immersive lifecycle and user experience lack final acceptance

Desktop graphics recovery and profile restart behavior are tested. The native run confirmed the app's committed profile-save status and allowed a host copy, but its later independent database read timed out. Exit deferral has modeled ordering tests, not a subsequent native exit result. Hand/controller transitions, reference-space reset, seated use, horizon manipulation and spatial text/target usability need current-build headset checks.

**Required next step:** combine these checks with performance acceptance in one prepared session. Confirm report recovery after a real Quest Browser restart. Attribute failures to timestamped application/diagnostic sources rather than inferring that an unavailable debugger means no user run occurred.

## Review conclusion

The project has a green engineering baseline and meaningful, quality-preserving improvements. It has **not** achieved a verified smooth, consistently sharp Quest experience. The next work should close the explicit foveation gap, capture the current native bottleneck, and reduce rendering/streaming cost based on that evidence. Historical checkpoint reports remain useful evidence; [the completion plan](../COMPLETION_PLAN.md) is now the authoritative list of remaining work.
