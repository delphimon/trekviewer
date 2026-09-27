# Review repairs and visual fidelity — 26 September 2026

Implemented against the reviewed `835906a` baseline. The original findings and diagnostic reproductions remain in [REVIEW.md](REVIEW.md). This file records the repaired working tree; it does not claim headset acceptance.

## Changes

| Review finding | Implemented behavior | Evidence |
| --- | --- | --- |
| 1. Imported waypoint HTML | Names are assigned to a span with `textContent`. | Regression test and actual browser import: literal markup, one SPAN, zero IMG nodes; [browser proof](import-fixed.png). |
| 2. Repeated delayed focus promotions | One pending focus generation; movement, mode/profile changes, and disposal invalidate stale work. DEM requests receive a lifetime abort signal. | 72 pending frames produce one attachment and one surface revision; stale mode/disposal/focus tests. |
| 3. Competing terrain surfaces | Refined footprints align to whole coarse cells. Covered coarse triangles leave the draw range. Refined boundary heights use the rendered coarse surface. | Downward raycasts match the authoritative sampler for both lower and higher refinements, before/after exaggeration; seam samples agree; detachment restores the original index count. |
| 4. Stationary camera with moving model/pointer | World position, quaternion, pointer origin/direction, and surface changes invalidate LOD. | Independent rotation/pointer regressions and unchanged-pose early-return check. |
| 5. Stationary style change | Style/profile changes mark LOD dirty; stale request callbacks cannot remove a newer request. | Stationary style-change regression plus existing LOD lifecycle tests. |
| 6. Startup hang | UI and animation start immediately. Metadata has a five-second total deadline and abort, with the existing fallback provider. Explicit route/import selection wins over delayed startup. | Never-settling fetch test, delayed-startup/import test, browser fallback observation. |
| 7. First-person turning overwritten | Route direction initializes yaw once. Controller turns update persistent navigation yaw; bends do not force yaw. | Paused turning and changed-route-direction tests. |
| 8. HUD placement overwritten | Mode entry/dock/summon place it once; normal frames preserve positioning. Right-thumbstick click hides/summons; hidden panels reject pointer/hand input. Spatial HUD is shown in XR, with desktop controls used outside XR. | Headset-motion/drag-position, hide/summon, and hidden-hand-poke tests. Physical reach and stereo readability remain unverified. |
| 9. Unsupported APK claims | Hosted-manifest Bubblewrap init/build workflow. Missing prerequisites, failed commands, and missing/unchanged output fail. README explains network dependence and signing/origin setup. | Five stub-CLI tests. No real Android build, signing, origin association, or installation performed. |

## Visual quality and performance choices

- Imagery is clipped from the actual visible terrain triangles instead of resampling an independent grid. Heights, ridges, and smooth source normals remain consistent at patch boundaries. Geographic UVs use Web Mercator coordinates.
- Interior imagery vertices are shared. A patch covering a complete 128 × 128 refinement uses **16,641 vertices / 32,768 triangles**, instead of 98,304 duplicated vertices. Cropping visits only source grid cells intersecting the tile; boundary clipping adds a small amount of geometry. Existing texture-resolution, mipmap, anisotropy, tile-concurrency, and cache limits are retained.
- This trades some mesh construction work for exact surface fidelity. Hardware frame-time impact still needs measurement; no Quest FPS improvement is claimed from desktop tests.
- Coarse coverage reuses a single dynamic index buffer, avoiding repeated GPU buffer allocation on promotions. Surface notifications cover the union of retired and promoted footprints, so dependent objects are updated where needed.
- Refined chunks use integer subdivisions of coarse cells and a boundary blend to the rendered coarse surface. Fine elevation detail remains intact in the interior, including valleys below the original coarse mesh.
- Desktop framing now targets the model from above and accounts for surrounding controls. Headset table scale and placement are unchanged.

## Verification

`npm run verify` passed: source and test TypeScript checks, **68 test files / 351 tests**, and the production build. This adds 21 regressions to the baseline's 330 tests. Vite still warns about the main bundle size: **830.02 kB / 214.73 kB gzip**. The changes add no dependencies.

Browser smoke checks used the production bundle on loopback HTTP, without bypassing any certificate warning. Verified immediate startup UI, Rainier loading, fallback imagery attribution, rendered terrain, desktop first-person entry/return, and the import security fix. The final smoke run reported no browser console errors. Browser rendering is supporting evidence only; it does not validate WebXR stereo or Quest performance. Screenshots: [tabletop](terrain-fixed.png), [desktop first-person](first-person-fixed.png), and [safe imported markup](import-fixed.png).

The APK script tests use a fake CLI and placeholder output in temporary directories. They validate script control flow, including stale artifacts, and are explicitly **not** evidence that a signed APK exists. The workflow follows [Meta's current packaging documentation](https://developers.meta.com/horizon/documentation/web/pwa-packaging/).

## Remaining Quest 3 acceptance

Use a specific source commit/build and record headset OS, Quest Browser version, date, selected quality profile, and network conditions. The following are pending on physical hardware:

1. Sustained 72 Hz frame pacing and CPU/GPU timing over a 15-minute session, including thermal behavior and memory after repeated route/mode/style changes.
2. Close tabletop inspection of refined valleys, coarse/refined seams, trail contact, imagery edges, and 1×/3× exaggeration. Compare High and Balanced without assuming their budgets prove performance.
3. Stationary-head model rotation/translation and pointer-only inspection; verify fine imagery follows the selected region.
4. First-person turning while paused and moving, sharp route bends, and head turns beside a docked or dragged HUD. Check hide/summon and controller-to-hand transitions.
5. Slow/unavailable metadata, imagery and elevation services; import during startup; exit/re-enter XR; verify no stale route or mesh promotion.
6. Initialize/sign the wrapper using the chosen deployed HTTPS origin, verify Digital Asset Links, produce a real APK, sideload, and cold launch. Offline startup and offline terrain availability are not implemented capabilities.

Earlier Stage V and Stage X3.1 reports are historical snapshots and now link here rather than implying current-build acceptance.

## Continuation: streaming lifecycle and measurement

A further pass reproduced and repaired three cache/scheduling failures that can degrade visual quality over time:

- Cancelling an obsolete imagery request now releases its scheduler slot immediately. Late completions remain guarded so they cannot decrement or delete a replacement request. A one-slot regression repeatedly changes focus and verifies new work starts without waiting for stale requests.
- Cache eviction and clearing release references without assigning an empty `src` to decoded images borrowed by live textures. The cache byte counter measures cache-held images, not total renderer/decoded memory; image storage can remain alive while a texture or compositor owns it.
- Cache clearing advances a generation. Successes/failures from older requests cannot refill the cleared cache, alter current priority counts, or delete a newer request for the same tile. Both success and rejection paths are tested.

Rapid browser style switching also exposed a stale loading banner. Completing the current style now reports that view as active; an older style's late completion cannot overwrite the current status. This does not claim that every high-resolution tile is loaded.

### Measurement support

Open the built app with `?debug=1`. Its local debug panel and once-per-second console telemetry include a bounded history of up to 720 callback intervals, average callback frequency, p95/max interval, CPU submission p95, and estimated missed callbacks when the actual XR refresh rate is available. Histories reset across view/profile/refresh changes and visibility interruptions. Real long stalls remain in the measurements. Frame recording allocates no per-frame arrays; sorting happens only when producing a snapshot. Per-frame pose console logging was removed.

These are JavaScript callback and render-submission measurements, **not GPU timings or compositor frame-delivery proof**. The debug panel, outlines, and console add overhead; compare with a normal build session and capture device profiler evidence before making performance claims. Telemetry stays in the browser console and is not uploaded by the app.

The build now emits `dist/build-info.json` and matching embedded metadata, including a timestamped build ID and whether the working tree was modified. Record this file with headset results; the Git SHA alone cannot identify uncommitted repairs.

### Previous continuation checkpoint

- `npm run verify`: **70 files / 360 tests passed**, both TypeScript checks passed, production build passed.
- Main bundle: **833.92 kB / 215.58 kB gzip**; the existing bundle-size warning remains. No dependencies added.
- Build tested: `835906a-modified-2026-09-26T23:50:08.153Z`.
- `adb devices -l` succeeded with an empty device list. ADB is available; no Quest was available for this session. Bubblewrap is not installed in PATH, so no real signed APK was built.
- The physical-device acceptance items above remain pending. The new diagnostics support that work but do not replace it.

Final production-browser check: rapid Topo → Aerial switching reported “Aerial view active.”, the stale loading banner dismissed, and the diagnostic panel showed callback/CPU measurements with an unknown desktop target rather than inventing a headset refresh rate. No browser console errors were captured. See [diagnostic screenshot](diagnostics-fixed.png). Desktop timings in that screenshot are not Quest performance evidence.

## Continuation: complete imagery coverage and stationary recovery

The prior browser run settled at 8/12 visible high-resolution tiles (67% coverage) despite zero image failures. Candidate generation excludes tiles outside the terrain bounds and selects only the coarse perimeter around the finer footprint, but visibility waited for all four geographic siblings regardless of selection. Unrequested siblings could never complete those groups.

Refinement now reveals all **selected siblings together**. Interior high-resolution groups still require four ready tiles; edge and perimeter groups require their entire selected subset. This preserves atomic transitions without fetching out-of-bounds imagery or increasing texture resolution, patch budgets, or concurrency. The existing full four-child transition and eviction rollback regressions still pass.

Warm children from an old selection no longer hide a newly selected coarse parent. Groups with no desired children also stop protecting stale parents from eviction, including during mode changes that reduce the patch budget.

Failed desired image requests now retry without requiring head, pointer, or route movement. Retries use exponential backoff from one second to a maximum interval of 60 seconds and respect any longer remaining negative-cache cooldown. The frame loop checks a deadline before scanning failures. Retries share the existing bounded scheduler; movement cannot bypass the cooldown or lose a queued retry. Style, mode, focus changes, and disposal cancel irrelevant retries. Persistent failures continue retrying while selected, at the bounded interval.

### Latest verification

- `npm run verify`: **71 test files / 370 tests passed**, both TypeScript checks passed, production build passed. Ten additional regressions cover real candidate footprints, selected-group transitions, coarse restoration, stationary recovery, cancellation, and a queued retry surviving reconciliation.
- Main bundle: **835.42 kB / 216.00 kB gzip**. The existing size warning remains; no dependencies added.
- Browser-tested build: `835906a-modified-2026-09-27T00:06:28.685Z` (26 September in local Pacific time).
- Production browser: Rainier tabletop reached **12/12 Z14 tiles / 100% selected detail coverage**. First-person reached **68/68 Z19 tiles / 100%**, with 28 Z18 perimeter patches; the 96-patch desktop budget remained in effect. Balanced tabletop reached 15/15 Z13 tiles. Returning to High and repeating entry/return restored complete tabletop coverage. These counts describe the selected footprint, not whole-route maximum-resolution coverage.
- An attempted rapid batched sequence hit an automation input timeout after entering first-person. The subsequent page read showed complete 68/68 imagery and responsive controls; an explicit return succeeded. This was a smoke check, not a completed stress test.
- No captured browser console errors. Screenshot: [complete tabletop imagery](coverage-fixed.png).
- `adb devices -l` still reports no connected headset. Quest stereo appearance, device GPU timing, sustained frame pacing, thermal behavior, and real APK installation remain unverified.

## Continuation: desktop visual presentation

The desktop mountain was small in the available inspection area, and its skirt read as a solid black slab. Desktop terrain framing now uses more of the spare viewport while retaining the existing route bounding fit and sidebar offset. This changes only the desktop camera; the Quest tabletop placement and scale are unchanged. Moving closer can select more imagery tiles on desktop, still within the existing quality profile budgets.

The diorama skirt now has outward-facing normals, front-face rendering, and a subtle rock gradient from rim to base. It no longer receives self-shadow from the terrain. The new geometry test checks normal and triangle winding on every side and verifies the gradient. Front-face rendering avoids shading the inside of the solid model.

Production-browser inspection covered the Rainier default route, the long Olympus and Bailey traverse, and the compact Enchantments route. Each terrain model fit beside the controls without clipping. Olympus completed 80/80 selected Z13 tiles and Enchantments completed 30/30 selected Z14 tiles. These are desktop visual and selected-tile checks; they do not measure Quest frame pacing or GPU cost. [Updated Rainier presentation](visual-fidelity-rainier.png).

`npm run verify` passed after this change: both TypeScript checks, **72 test files / 371 tests**, and a production build. The main bundle is **835.57 kB / 216.07 kB gzip** and retains the existing size warning. Rainier reached 20/20 selected Z14 tiles with no captured browser console errors. ADB still saw no attached Quest; physical-device acceptance remains open.
