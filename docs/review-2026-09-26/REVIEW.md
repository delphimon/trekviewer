# TrekViewer project review — 26 September 2026

Reviewed commit: `835906a` (`main`). Target: Meta Quest 3, Quest Browser WebXR. Scope: application orchestration, XR inputs and navigation, GPX ingestion, terrain and imagery streaming, resource ownership, tests, build, deployment, and hardware acceptance documentation.

The project builds and its existing tests pass, but three high-priority defects affect imported-file security, frame stability, and terrain correctness. Six additional defects affect interaction, initialization, or distribution. This records the original pre-fix review. Repairs and current verification are tracked in [IMPLEMENTATION.md](IMPLEMENTATION.md); the reproductions below describe the original baseline.

## Verification and limits

- `npm run verify`: source/test typechecks passed; **65 test files / 330 tests passed**; production build passed. Build warned about an approximately 820 kB JavaScript chunk (212 kB gzip).
- `npm audit --omit=dev`: no reported production dependency vulnerabilities. This does not cover application-level vulnerabilities or the development dependency tree.
- Seven focused defect reproductions passed, meaning they confirmed the faulty behavior described below. They are archived in `reproductions.test.ts.txt`, outside normal test discovery. To rerun, copy it to `test/review_findings.test.ts`, run `npx vitest run test/review_findings.test.ts --reporter=verbose --silent=false`, then remove that temporary copy. Imports assume that location. Convert the assertions to expected correct behavior when fixing the issues; these are diagnostic proofs, not acceptance tests.
- Opened the locally served production build in the desktop in-app browser. Confirmed Rainier loading, terrain rendering, desktop first-person switching, and the harmless GPX script-execution proof described below. The configured imagery provider fell back to Esri with an explicit UI notice.
- No physical Quest was connected or tested. Stereo rendering, hand/controller reliability, sustained 72 Hz, thermals, battery, and APK installation remain unverified. A desktop rendering check cannot establish these outcomes.
- The development HTTPS certificate was not trusted by the browser; the review used a separate loopback HTTP server for the built static files. No certificate warning was bypassed.

## Findings

### 1. P1 — Imported waypoint names execute JavaScript

Location: `src/ui/DesktopOverlay.ts:884`; input source: `src/gpx/GPXParser.ts:63`.

`updateLandmarks()` inserts `lm.name` into `innerHTML`. The browser GPX parser correctly decodes waypoint text, but that text is then interpreted as HTML. A GPX received from another person can therefore execute script in the app's origin as soon as its landmark chips render. This defeats the intended local-data boundary and permits UI manipulation or interception of subsequent imports.

**Verified:** imported `import-fixture.gpx` through the actual production UI. Its waypoint contains an image error handler that only replaces itself with the words `REVIEW: IMPORTED HTML EXECUTED`. That label appeared in the live page without clicking the waypoint. No external destination or data extraction is in the fixture. See `import-proof.png`. The archived unit reproduction also confirms the unescaped HTML sink.

**Fix:** construct the icon and span as DOM nodes and assign the waypoint name using `textContent`. Add a browser regression test for CDATA and escaped XML markup that must display literally and never create an image or event handler.

### 2. P1 — One pending tabletop DEM load can trigger dozens of synchronous mesh rebuilds

Location: `src/terrain/LocalTerrainStreamer.ts:437–446` and `:462`.

`updateTabletopFocus()` is called every animation frame. Its distance guard requires an already-visible tabletop chunk, so it does not suppress repeated calls during initial loading. Fetch deduplication shares the network promise, but every call attaches another promotion callback. When the grid arrives, all callbacks build, validate, attach, reproject, and replace a mesh on the main thread. Quest-high uses a 128×128 segment grid per candidate.

**Verified:** 72 updates with the same focus and one unresolved promise produced **72 mesh attachments/promotions** when that promise resolved. The reproduction uses smaller geometry for speed; the production configuration does more work per callback. This proves a burst of redundant work, not a measured Quest frame duration.

**Fix:** track the pending focus request and its generation separately from the visible chunk. Share one build/promotion operation per desired focus, cancel or ignore obsolete generations, and assert one promotion across many waiting frames.

### 3. P1 — Refined terrain can put the trail and camera below the terrain that is actually drawn

Location: `src/terrain/TerrainGenerator.ts:612–615`; attachment: `:520–536`.

Local detail meshes are added on top of the still-rendered opaque base mesh. The authoritative sampler always prefers the local mesh even where its elevation is lower than the coarse surface. Ordinary depth testing still shows the coarse surface above it; a small polygon offset does not remove metres of overlapping terrain. The trail, waypoints, imagery patches, and first-person camera can therefore follow a surface hidden below the visible mountain.

**Verified:** using the real generator and local chunk classes with controlled DEM samples, the sampler returned **130 m**, while a downward ray through the rendered meshes hit the base surface at **230 m** first. A first-person eye placed on the sampled ground would be below the opaque base. Real coarse/fine DEM differences need not be this large for the defect to matter.

**Fix:** make coarse and refined terrain ownership exclusive within the promoted footprint, with a compatible boundary transition. Use the same surface for rendering and dependent sampling. Test both positive and negative refinement deltas, including raycast-visible surface agreement.

### 4. P2 — Moving the model or controller pointer alone does not refresh detail focus

Location: `src/terrain/ImageryLODManager.ts:1236–1244`.

The tabletop early-return condition checks only camera movement, camera direction, and scale. Model translation is calculated after this return; model rotation and changes to the active pointer ray are not part of the gate. With a steady head, dragging/rotating the model or pointing at a different location leaves imagery detail and tabletop DEM focus at the previous place until a different trigger moves far enough.

**Verified:** after the initial evaluation, moving the root 1 m, rotating it 1 radian, and supplying a different pointer ray caused no second evaluation after the interval elapsed.

**Fix:** include world position, orientation, active-pointer changes, and relevant surface revisions in invalidation before returning. Test each independently with a stationary camera.

### 5. P2 — Changing map style can leave detail imagery absent until the viewer moves

Location: `src/terrain/ImageryLODManager.ts:1129–1144`.

`setTextureStyle()` clears patches, the queue, and desired tiles without resetting evaluation state or marking it dirty. The next updates can return because camera/progress thresholds have not changed. The base composite changes style, but high-resolution patches are not requested until sufficient head, camera, or route movement occurs. This is especially visible during paused first-person inspection.

**Verified:** an initial evaluation followed by a style change and an eligible update at the same pose left **zero desired detail tiles** and no additional evaluation.

**Fix:** invalidate the next LOD evaluation on style changes, as the view-mode setter already does. Cover stationary first-person and tabletop cases.

### 6. P2 — An unavailable imagery metadata service can block all application UI

Location: `src/terrain/providers/ImageryProvider.ts:41–47`; startup dependency: `src/main.ts:924–926`.

Both provider-metadata fetches lack an application timeout or abort signal. The DOM-ready callback awaits provider initialization before constructing the app, so a stalled Cesium or Bing metadata connection leaves a blank application, with no status UI, import control, or bounded fallback. Catching rejected requests does not bound requests that remain pending.

**Verified:** a pending fetch kept initialization unresolved after 60 seconds of simulated time. In the actual desktop session the request failed and Esri fallback worked; the defect concerns slow or stalled connections.

**Fix:** construct a usable loading/error shell immediately, bound metadata requests, and fall back explicitly after the deadline. Keep provider choice resolved before tile requests, without blocking all UI construction.

### 7. P2 — First-person updates erase controller turning before rendering

Location: `src/visualization/FlyoverController.ts:176–178`; input: `src/core/XRManager.ts:575–579`; ordering: `src/main.ts:757–775`.

The right stick adjusts the root yaw, but the subsequent first-person flyover update sets that yaw to the route heading every frame, including while paused. The same frame therefore discards the user's rotation before rendering. Route bends also rotate the whole environment automatically as progress changes.

**Verified:** setting a first-person root yaw to 1 radian, then calling the paused update on a northbound route, resets it to 0. The production animation ordering establishes that controller updates are subject to this overwrite.

**Fix:** model user heading separately from route position/alignment; compose it into the navigation transform. Define whether route-following yaw is an explicit option and validate turning comfort on Quest.

### 8. P2 — First-person HUD cannot be docked or moved out of the view

Location: `src/main.ts:779–787`.

Every first-person frame copies the camera orientation and places the entire HUD 1.2 m ahead. That overrides the existing drag/dock controls and makes the panel follow head rotation continuously. It also contradicts the repository's stated zero-headset-locked-elements invariant. The desktop first-person browser check showed the large panel covering the central trail view; the frame loop establishes the headset-following behavior in XR.

**Fix:** place the HUD once on mode entry or an explicit summon action, preserve user positioning, and provide a hide/show action. If a following HUD is desired, make it an explicit mode rather than overriding docking every frame. Verify head turns do not move a docked panel.

### 9. P2 — The documented standalone APK/offline path is not implemented reliably

Location: `scripts/package-quest-apk.sh:23–29`; `public/manifest.webmanifest:5`; `README.md:50–58`.

The script invokes `ovr-platform-util create-pwa-package` with a local manifest and claims to produce a signed, offline APK. This does not match Meta's current documented PWA packaging workflow. There is no generated Android project, signing configuration, hosted-origin association, or bundling of the built JavaScript/routes into a local Android runtime. There is also no service worker or explicit offline shell cache in the source. When the utility is absent, the script merely prints instructions and exits successfully without an APK.

**Evidence:** Meta's [Package a PWA for Meta Quest](https://developers.meta.com/horizon/documentation/web/pwa-packaging/) documentation, updated 22 July 2026, uses `@meta-quest/bubblewrap-cli`, an HTTPS-hosted manifest, signing, and Digital Asset Links. The older `ovr-platform-util` example documented by [Google's Web.dev source](https://github.com/GoogleChrome/web.dev/blob/main/src/site/content/en/blog/pwas-on-oculus-2/index.md) uses `create-pwa`, not the command in this script. The actual CLI was not installed or run, and no APK was produced during this review.

**Fix:** implement and validate a supported package workflow, require the output artifact before reporting success, and describe network requirements accurately. Treat reliable offline startup and offline terrain availability as separate capabilities with explicit caching/download behavior and device tests.

## Architecture and verification assessment

Useful foundations already exist: a small production dependency surface, separation of route/session/XR concerns, generation-based route cancellation, explicit resource teardown, shared DEM normalization, and detailed tests for gesture math and route geometry. The failures above arise primarily where separately tested systems interact over time or with the browser renderer.

The test suite relies heavily on mocked canvas/DOM/rendering. It can verify mathematical sampling and state flags while missing an opaque mesh above the chosen sample, repeated promise callbacks across animation frames, or actual browser interpretation of imported text. Retain the pure tests, then add focused browser and runtime integration checks for these boundaries.

`docs/STAGE_V_QUEST_ACCEPTANCE.md` records hardware cases as PASS against an older baseline. That document is not current-build device evidence. `docs/STAGE_X3_1_STABILIZATION_REPORT.md` also says tabletop local geometry is hidden, while current Stage X7 code actively creates it. These reports should be clearly dated snapshots, with hardware results tied to a tested commit, headset OS/browser versions, run date, and actual observations. The README's Rainier distance/gain also differ from the current UI: this review observed 27.5 km and +3,200 m, whereas the README advertises 24.3 km and +3,097 m. This mismatch alone does not establish which route values are intended.

No current physical-device performance conclusion is warranted from the profile budgets alone. After fixing the defects, run a sustained Quest session covering initial load under slow networking, repeated mode/style changes, model dragging with a stationary head, controller/hand transitions, first-person turns and sharp route bends, import/replacement failures, and exit/re-entry. Capture frame timing and memory before/after the session, and preserve screenshots or recordings of terrain coverage and trail contact.

## Recommended repair order

1. Escape imported names and add the real-browser security regression.
2. Deduplicate pending tabletop promotions and establish exclusive terrain ownership.
3. Fix LOD invalidation for model/pointer/style changes and separate navigation/HUD state from per-frame pose updates.
4. Bound startup networking and correct packaging/offline behavior.
5. Run the complete automated checks and a new, explicitly recorded Quest 3 acceptance session on the resulting commit.
