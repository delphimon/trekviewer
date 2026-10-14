# TrekViewer review — October 13, 2026

Reviewed commit: `2f438031b650db15885935134595ca09884d6197`.

The project has a strong foundation for a terrain exploration app: transactional route loading, an authoritative session state, real elevation provenance, bounded imagery profiles, coherent parent/child replacement, exact rendered-surface sampling, and substantial regression coverage. The most urgent gaps are first-person comfort, exclusive input dispatch, and a hard upper bound on imported-route workloads. Performance work should preserve the imagery stability already achieved and target main-thread construction and surface promotion before reducing fidelity.

This review adds documentation and evidence only. Application source and committed dependency files are unchanged.

## Scope and verification

Reviewed the WebXR lifecycle and input, scene configuration, GPX parsing and coordinates, route assembly, terrain/imagery streaming and caches, playback, spatial/desktop UI, deployment packaging, CI, tests, and existing headset reports. Used the Meta VR plugin's `hz-quest-verify-first`, `hz-iwsdk-webxr`, and `hz-immersive-designer` skills. The app uses Three.js directly; IWSDK is an optional way to consolidate interactions, not a prerequisite for a sound WebXR app.

Meta documentation was checked on October 13, 2026. The plugin's documentation search returned mostly unrelated results for performance/comfort queries, so official Meta pages were also retrieved through web search. Current documentation takes precedence over numerical guidance in the installed skills.

| Check | Result |
| --- | --- |
| Source and test TypeScript checks | Passed |
| Production build, locked Vite 8.3.0 / Three.js 0.186.0 | Passed; JS 861.02 kB minified, 223.53 kB gzip; bundle-size warning |
| Final locked Vitest 5.0.1 run, 2 workers, packaging excluded | 388 passed, 2 failed; 80 files passed, 1 failed |
| Unix packaging fixtures | Five fixtures cannot run here: Windows symlink permissions and `/bin/bash` assumptions |
| Targeted review reproductions | Seven passed, each asserting the observed defective behavior |
| Production browser load | Rainier rendered with Esri imagery; no page errors |
| Desktop hardware backend | Edge, ANGLE D3D11, NVIDIA RTX 4060; confirmed hardware rather than SwiftShader |
| Responsive inspection | 1440×1000 and 390×844; narrow layout fails |
| npm audit | One high-severity development dependency advisory, described below |
| Connected Meta hardware | `metavr_device(action="list")` returned no devices |

The first dependency installation resolved newer compatible releases. It was replaced with `npm ci --ignore-scripts` against the committed lockfile before the final checks and saved browser evidence. Initial default-parallel test runs also exposed temporary-file/sandbox errors and timer-dependent imagery assertions. The final run used a workspace temporary directory and two workers to isolate those effects.

These measurements do not establish Quest GPU frame time, compositor-delivered FPS, battery life, thermal behavior, tracking quality, or subjective comfort. Existing headset reports are useful historical evidence, not fresh measurements of this commit.

## Findings

P1 means address before broader headset release. P2 means a concrete correctness, usability, or performance issue to address next. P3 means maintenance or further optimization.

### 1. [P1] First-person locomotion has extreme speed and no comfort configuration

Sources: [GestureMath.ts](E:/Development/delphimon/trekviewer/src/xr/GestureMath.ts:412), [XRManager.ts](E:/Development/delphimon/trekviewer/src/core/XRManager.ts:550), [FlyoverController.ts](E:/Development/delphimon/trekviewer/src/visualization/FlyoverController.ts:186).

Normal thumbstick movement advances 18 m/s; holding the trigger increases it to 75 m/s. First-person turning uses the same continuous 2.1 rad/s (~120°/s) rate as tabletop rotation. The flyover also moves the surrounding world continuously, with playback multipliers up to 60×. There is no snap-turn setting, motion vignette, comfortable movement mode, or separate cap on first-person playback. Entering first person while an accelerated tabletop flyover is playing preserves that playback.

The alpine environment adds rapid elevation changes and close terrain, which increase optic flow and visual/vestibular mismatch. This is a comfort risk supported by the implemented behavior; the proportion of affected users is unmeasured.

**Recommendation:** Separate tabletop time scrubbing from immersive locomotion. Default first-person movement to a walking pace, provide snap turning and landmark teleport/stepped movement, pause on view-mode entry, and make fast continuous movement an explicit preference. Add a movement vignette and predictable transition feedback. Current [Meta locomotion preferences](https://developers.meta.com/vr/design/locomotion-user-preferences/) recommend comfortable defaults and user-selectable movement/turn styles; [locomotion best practices](https://developers.meta.com/vr/design/locomotion-best-practices/) discuss optic flow and acceleration controls.

### 2. [P1] The DEM tile limit is not a hard limit

Sources: [ElevationTiles.ts](E:/Development/delphimon/trekviewer/src/terrain/ElevationTiles.ts:104), [GPXParser.ts](E:/Development/delphimon/trekviewer/src/gpx/GPXParser.ts:173), [Coordinates.ts](E:/Development/delphimon/trekviewer/src/gpx/Coordinates.ts:68).

The zoom-reduction loop stops at zoom 10 even if the footprint still exceeds `MAX_DEM_TILES = 25`. Geographic bounds use ordinary longitude minima/maxima. A tiny valid track from `(46, 179.999)` to `(46.001, -179.999)` consequently covers almost the entire longitude range. The reproduction recorded **1,024 tiles at z10**, with a requested composite canvas of **262,144×256** pixels. The reproduction intercepted decoding before allocation or network access.

That footprint exceeds normal canvas limits and implies roughly 256 MiB for each full RGBA or float elevation buffer, before image/cache overhead. Other very large imported extents can exceed the intended budget too. The GPX file-size limit does not bound geographic extent, tile count, or generated stations.

**Recommendation:** Enforce tile, pixel, byte, point, and station limits before allocation/download. Normalize or split date-line-crossing longitudes consistently across bounds, projection, and imagery. Reject unsupported extents with a useful error if wrapping is not yet supported. Add adversarial small-file fixtures, including long routes and date-line crossings.

### 3. [P2] One hand pinch can dispatch the same HUD action twice

Sources: [XRManager.ts](E:/Development/delphimon/trekviewer/src/core/XRManager.ts:527), [XRManager direct touch](E:/Development/delphimon/trekviewer/src/core/XRManager.ts:907).

The controller loop handles the hand's ray pinch first. `processHandGrabs()` subsequently invokes the direct HUD path for that same hand. If its fingertip is near the panel and its ray also intersects it, both call `onPointerClick`. The reproduction counted two dispatches for one pinch. Toggle actions such as Play or view mode can toggle twice and appear to do nothing; other controls can apply twice.

**Recommendation:** Resolve near/far target priority once per hand and dispatch one action per confirmed gesture edge. Direct contact should consume the corresponding ray selection. Test real toggle outcomes with both paths active, rather than testing each path independently.

### 4. [P2] Captured terrain gestures can still activate HUD or waypoint actions

Source: [XRManager.ts](E:/Development/delphimon/trekviewer/src/core/XRManager.ts:907).

`processHandGrabs()` calls the direct HUD and waypoint interaction methods before checking the hand's existing `activeInteraction`. A hand already manipulating the diorama can therefore touch/click the panel or a waypoint while still returning an active terrain grab. The reproduction confirmed a HUD click and continued terrain manipulation in the same update. The ray path suppresses HUD interaction for a terrain owner, but the direct path does not apply the same rule.

**Recommendation:** Make ownership gate every dispatch path. Keep capture until release, tracking loss, or cancellation; hover calculations should not fire actions or change the owner. Include dragging a mountain through the HUD, passing a waypoint during a grab, and moving both hands near different controls.

### 5. [P2] Direct pokes can remain latched after the finger leaves

Source: [XRManager.ts](E:/Development/delphimon/trekviewer/src/core/XRManager.ts:1062).

`isClickingHUD` is reset only while the fingertip remains within the card bounds and near its plane. A fast withdrawal can move directly outside that volume without visiting the internal release condition. Returning directly to the poke plane then leaves the flag true and prevents a second click. Tracking-loss branches also omit this latch reset. The reproduction poked, withdrew by 20 cm, and returned; only the first poke dispatched.

**Recommendation:** Re-arm on leaving the contact volume, invalid tracking, hidden/removed HUD, and session/mode changes. Add spatial hysteresis so the release band is forgiving and independent of frame rate.

### 6. [P2] A held trigger can start chart scrubbing without a chart press

Sources: [SpatialHUD.ts](E:/Development/delphimon/trekviewer/src/ui/SpatialHUD.ts:662), [XRManager.ts](E:/Development/delphimon/trekviewer/src/core/XRManager.ts:1363).

`onPointerDrag()` updates route progress whenever the pointer is in the chart's y band; it does not check `isDraggingScrubber`. The caller invokes it for any held trigger over the panel. Pressing a different control or empty space and moving over the chart can therefore jump progress. In first person this also moves the world unexpectedly. The reproduction dispatched `onScrub` with no preceding chart capture.

**Recommendation:** Require a chart-originated pointer-down and a captured pointer identity. Keep dragging only for that pointer until release/cancellation. Avoid sharing a global drag flag across two controllers/hands.

### 7. [P2] Untracked controllers are made visible and processed using stale poses

Source: [XRManager.ts](E:/Development/delphimon/trekviewer/src/core/XRManager.ts:535).

The physical-controller path sets both ray and grip groups visible whenever an input source remains connected. Three.js hides those spaces when their current XR pose is unavailable. Overriding that state revives stale transforms and continues ray/grab input. The reproduction began with both spaces hidden and confirmed they became visible and were dispatched. `isPhysicalControllerActive()` also equates connection with tracking, which can suppress the corresponding hand while a controller is untracked.

**Recommendation:** Distinguish connected, tracked, and actively engaged states. Preserve the renderer's pose validity, suspend pose-based interactions while tracking is unavailable, and clear captured gestures/button edges before reacquisition. Verify controller occlusion, setting a controller down, and switching modalities on a headset.

### 8. [P2] First-person entry ignores the user's current room position

Source: [FlyoverController.ts](E:/Development/delphimon/trekviewer/src/visualization/FlyoverController.ts:210).

The first-person world offset always places the route point at XR reference-space `(0,0,0)`. If a user physically moves away from that origin while inspecting the tabletop and then enters first person, the point is placed beside the user rather than beneath their current feet. The reproduction used a headset at x=2 m, z=3 m and confirmed the route still landed at x=0, z=0. Initial heading similarly aligns to reference-space forward rather than capturing the viewer's current horizontal heading.

**Recommendation:** Capture a floor-projected viewer position and horizontal heading at first-person entry/recenter. Apply route progression relative to that fixed navigation anchor, while preserving subsequent physical head movement. Test entry after walking/turning, seated entry, and reference-space reset events.

### 9. [P2] Route construction blocks the main thread for visible intervals

Sources: [GPXParser.ts](E:/Development/delphimon/trekviewer/src/gpx/GPXParser.ts:737), [TerrainGenerator.ts](E:/Development/delphimon/trekviewer/src/terrain/TerrainGenerator.ts:325), [LocalTerrainChunk.ts](E:/Development/delphimon/trekviewer/src/terrain/LocalTerrainChunk.ts:127), [LoadedTrek.ts](E:/Development/delphimon/trekviewer/src/core/LoadedTrek.ts:115).

Two production desktop startup captures recorded multiple long tasks, including maximum durations of **1,223 ms** and **1,151 ms**. The saved CPU sampling profile attributed about **466 ms of sampled self time to `deriveLandmarks`**, which formats a date for each timestamped point, and about **283 ms to `renderDynamicLayer`**. Sampled self time is accumulated across the capture, not the duration of one call. Other samples include DEM decoding and elevation sampling. Hardware rendering was verified; these are not SwiftShader figures.

The base vertex loop yields in batches, but GPX finalization, procedural topo generation, trail construction, and local chunk construction/promotion contain synchronous work. A Promise continuation does not move that work off the UI thread. Surface promotion also synchronously reprojects trail geometry and recomputes normals. Loading another route while XR remains active exposes these operations during immersion.

**Recommendation:** Move parsing/metrics, DEM decoding, and geometry arrays into workers with generation-aware cancellation. Budget main-thread publication/uploads separately; spatially index ribbon vertices for bounded surface changes. Avoid repeatedly formatting calendar dates for the same day. Skip/throttle HUD rasterization while its group is hidden and consolidate forced redraws during route commit. Measure these changes at matched fidelity. [Meta WebXR performance guidance](https://developers.meta.com/vr/documentation/web/webxr-perf-bp/) recommends staggering work and profiling actual bottlenecks.

### 10. [P2] Narrow viewports lose essential controls

Sources: [style.css](E:/Development/delphimon/trekviewer/src/style.css:64), [player layout](E:/Development/delphimon/trekviewer/src/style.css:438), [DesktopOverlay.ts](E:/Development/delphimon/trekviewer/src/ui/DesktopOverlay.ts:361).

At 390×844, Enter VR was positioned at x≈866 px and Passthrough at x≈948 px. The chart and range input both had **zero width**. The document hides overflow, so the off-screen controls cannot simply be scrolled into view. The narrow breakpoint hides the whole stats/style/quality panel without adding an alternative. This affects phones and resized browser panels; a headset browser can also be used in a constrained 2D window before XR entry.

**Recommendation:** Wrap or stack the top controls, constrain the route selector, move secondary controls into an accessible drawer, and give the timeline its own row and minimum usable width. Reframe the diorama when the available inspection area changes. Verify portrait widths, tablet widths, browser zoom, and narrow headset windows. See [mobile screenshot](mobile.png) and measured rectangles in [browser.json](browser.json).

### 11. [P2] Spatial control targets and spacing are too small at the first-person dock distance

Sources: [SpatialHUD.ts](E:/Development/delphimon/trekviewer/src/ui/SpatialHUD.ts:164), [control layout](E:/Development/delphimon/trekviewer/src/ui/SpatialHUD.ts:340), [main.ts](E:/Development/delphimon/trekviewer/src/main.ts:524).

The panel is 0.8×0.53 m mapped to 1024×680 pixels. Most button hit regions are 58 px high, approximately **45 mm**. At the default side dock's approximately 1.49 m center distance, that is about **1.7°** of visual angle. Neighboring speed/step targets are separated by roughly 10 px, only **7.8 mm** horizontally. Common 16 px fonts correspond to a nominal 12.5 mm font box, approximately 0.48° at that distance; actual glyph heights are smaller. The HUD can be dragged farther away without angular scaling or a text-size option.

Current [Meta hands UI guidance](https://developers.meta.com/vr/design/hands-ui-best-practices/) recommends roughly 2.5–3° angular colliders and 12 mm spacing, plus angular sizing for movable distant panels. These current values differ from some fixed physical-size numbers in the installed skill.

**Recommendation:** Increase angular targets and spacing, reduce simultaneously visible secondary controls, add hit slop without overlapping neighbors, and provide text/panel scale preferences. Keep quick actions in a simple reachable layout for seated and one-handed use. Validate reading and selection on hardware rather than judging the 1024 px canvas on desktop.

### 12. [P2] Elevation charts and HUD detail mix distance progress with point index

Sources: [GPXParser.ts](E:/Development/delphimon/trekviewer/src/gpx/GPXParser.ts:806), [DesktopOverlay.ts](E:/Development/delphimon/trekviewer/src/ui/DesktopOverlay.ts:218), [SpatialHUD profile](E:/Development/delphimon/trekviewer/src/ui/SpatialHUD.ts:813), [SpatialHUD tooltip](E:/Development/delphimon/trekviewer/src/ui/SpatialHUD.ts:1052).

For tracks with no more points than the requested profile sample count, `sampleElevationProfile()` returns the original unevenly spaced points. Both chart renderers place those samples evenly by index, while scrubbers and landmark markers use distance fractions. A three-point route with distances 0, 10, and 1,000 m consequently plots its 10 m point at 50% of the chart. The spatial tooltip separately chooses `floor(progress * (points.length - 1))` for grade, pace, and nearby-landmark lookup, so dense/sparse recording can make its details refer to another part of the route even on long tracks.

**Recommendation:** Plot `sample.distance / totalDistance`, or always produce uniform-distance samples. Feed the HUD the authoritative distance-interpolated telemetry already available from `RouteGeometry`/`TrekSession`, including smoothed grade/pace. Add short uneven-sample tracks and strongly varying sampling density to UI regression coverage. This finding is established by the shared data/plot code; it was not exercised on a headset.

### 13. [P2] The verification gate is currently red and some LOD tests depend on timers and obsolete assumptions

Sources: [stage_s1_first_person_lod.test.ts](E:/Development/delphimon/trekviewer/test/stage_s1_first_person_lod.test.ts:86), [imagery_lod.test.ts](E:/Development/delphimon/trekviewer/test/imagery_lod.test.ts:200), [quest_packaging.test.ts](E:/Development/delphimon/trekviewer/test/quest_packaging.test.ts:11).

The final locked run consistently failed the center-patch assertion and the no-new-patches assertion in Stage S1. An isolated run also failed its z18 prefetch assertion. The stationary-convergence assertion failed in a highly parallel run but passed in isolation and the final two-worker run.

Several checks assume a z18 layout even though current first-person selection targets z19; the center assertion matches a numeric substring in a mesh name rather than geographic coverage. Fixed 150/50 ms sleeps can leave a queue still draining and mistake late initial completions for renewed selection. Packaging fixtures unconditionally create a Unix-style symlink, invoke `/bin/bash`, and construct a colon-separated PATH.

**Recommendation:** Update tests to assert current coverage/selection invariants, explicitly pin profiles, and await controlled network completion. Distinguish steady-state churn from initial queue drain. Make the packaging suite an explicit Linux job or provide portable fixtures. Do not treat these failures alone as proof of a product LOD regression, and do not weaken assertions just to turn CI green.

## Additional best-practice work

- **Terrain renderer:** Continue the existing [migration plan](../TERRAIN_RENDERER_MIGRATION.md). Stable first-person imagery selection is valuable, but a single visible high-resolution terrain chunk still leaves distant faces on the coarse base mesh. A unified spatial tile should own geometry and imagery mapping, replacing duplicated conforming imagery meshes where measured draw-call cost justifies it. Preserve atomic parent coverage and the rendered-surface sampler during migration.
- **Memory budgets:** `TileImageCache` measures decoded image references, not total process/GPU memory. Track DEM float grids, base/composite canvases, GPU mip chains, duplicated patch geometry, and off-scene route construction peaks. The global DEM cache and per-trek station cache are bounded by entries rather than bytes. Apply byte budgets and shared ownership across these stores.
- **Foveation:** Three.js 0.186.0 already initializes foveation to 1.0 and applies it on XR session setup. Missing explicit application calls do not mean foveation is disabled. Expose/query the effective value and compare central/peripheral terrain and HUD readability before tuning. [Meta FFR guidance](https://developers.meta.com/vr/documentation/web/webxr-ffr/) describes the quality tradeoff.
- **Refresh rate:** The supported-rate-guarded 72 Hz request is a defensible power/quality choice, not intrinsically a bug. Sustained GPU/compositor evidence is needed to justify it. Offer higher rates only when measurements demonstrate adequate headroom. At 72 Hz each delivered frame has about 13.9 ms; callback frequency is not proof of delivered frame rate.
- **Rendering:** Retain XR shadow suppression and instanced hand visuals. Profile patch batching/atlases, opaque depth ordering, sky ordering, and PBR cost before changing materials. Compress curated static textures where practical; streaming provider JPEG/PNG tiles require a different pipeline from build-time KTX2 assets.
- **Desktop accessibility:** Add an accessible name for the scrubber, keyboard-accessible GPX import, status/live regions, and programmatic selected states. Remove forced `user-scalable=no`. Preserve keyboard focus when replacing route-specific controls. Canvas visuals need textual equivalents for key telemetry.
- **XR capability and recovery:** Advertise support before entry, label AR-to-VR fallback clearly, prevent concurrent entry requests, and end a session if renderer attachment fails. Add current-generation guards around asynchronous startup/disposal and explicitly end a live XR session during teardown. Handle reference-space resets and WebGL context recovery as app lifecycle events.
- **Usability:** Present a short in-headset introduction for pinch/drag, point/select, and mode changes. Provide reachable route and quality controls within XR, or a clear flow to return to the browser. Keep loading/error information actionable and avoid relying on implementation-stage labels in product copy.
- **Architecture:** Consolidate input targeting/capture/dispatch before expanding custom gesture logic. Split orchestration from profiling/UI construction in `main.ts`; divide the large imagery manager along scheduler, selection, residency, and rendering responsibilities. Retain the existing transaction/generation boundaries and regression invariants during these changes.
- **Deployment:** The README correctly states that the APK wrapper is network-dependent and offline support is absent. Do not promise offline usability without a service worker, source-permitted tile retention, and explicit downloaded-region handling. Signed APK/Digital Asset Links and real headset launch remain separate validation tasks. Prefer verified `metavr` device/install workflows in documentation.
- **Dependency advisory [P3]:** `npm audit` reports `source-map-js <1.2.2` with [GHSA-68fv-2mgg-jv7q](https://github.com/advisories/GHSA-68fv-2mgg-jv7q), an indexed-source-map event-loop denial of service. It is a development dependency in this lockfile, not evidence that the shipped Three.js app is exposed. Update the transitive lockfile resolution after checking toolchain compatibility; assess untrusted source-map inputs in development/CI. [Audit evidence](audit.json).

## Suggested implementation order

1. Fix the hard route/DEM bounds and add comfortable first-person movement/turn defaults.
2. Implement one interaction capture/dispatch owner per hand/controller, including tracking validity, cancellation, poke re-arming, and chart-only drag capture. Use the saved reproductions as starting fixtures, reversing their assertions to expect corrected behavior.
3. Correct distance-based chart/tooltip sampling, repair narrow layout, and resize the spatial controls using angular measurements.
4. Restore reliable CI by replacing timing sleeps and outdated LOD assumptions, and separating Unix packaging checks.
5. Move measured main-thread construction into cancellable workers and publish within a frame/upload budget. Add total memory counters before further increasing terrain fidelity.
6. Advance the terrain-tile migration under a feature flag with matched visual, CPU, GPU, and memory evidence.

## Headset acceptance work still required

Use the Meta VR plugin's read-only device discovery first, then Quest Browser inspection and appropriate performance tools once hardware is connected. The app is browser-delivered; measurements must target the active browser/XR experience rather than treating it as a Unity title.

Test Rainier and Enchantments in tabletop and first person, both High and Balanced, with fixed viewpoints, repeatable head sweeps, walking/turning before mode entry, both controller and hand input, controller occlusion, seated use, route replacement, provider failure/recovery, and repeated session entry/exit. Capture rendered screenshots alongside browser callback/CPU diagnostics and device-delivered FPS, GPU time, stale/reprojected frames, memory, and thermal behavior. Include sustained runs and report the actual supported refresh rate. Use RenderDoc when a frame-level rendering question remains; use Perfetto for scheduling/long-stall diagnosis. [Meta's performance workflow](https://developers.meta.com/vr/documentation/web/webxr-perf-workflow/) explicitly separates measurement, bottleneck diagnosis, and validated changes.

## Saved evidence

- [Desktop screenshot](desktop.png) and [narrow screenshot](mobile.png).
- [Browser rectangles, long tasks, and CPU sampling summary](browser.json).
- [Load CPU profile](load.cpuprofile), importable in Chromium DevTools Performance.
- [Targeted reproduction source](reproductions.test.ts.txt) and [results](reproductions.log).
- [Final locked test run](tests.log) and [npm audit](audit.json).

The saved reproduction assertions confirm existing defects; they are not passing acceptance tests for a corrected implementation. To run them, copy the source to `test/review_oct13_reproductions.test.ts` and use `node node_modules/vitest/vitest.mjs run test/review_oct13_reproductions.test.ts`. Remove that temporary test after inspection or turn it into regression coverage when implementing fixes.
