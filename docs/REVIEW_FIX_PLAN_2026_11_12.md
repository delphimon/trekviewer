# Review fix plan — 2026-11-12

Source: full code, architecture, UI and functionality review of commit `21f21cf` (main).
This plan continues [REVIEW_FIX_PLAN.md](./REVIEW_FIX_PLAN.md) (phases A–F). It is written so
an agent with no memory of the review can do the work item by item.

At the time of the review: `npm run typecheck`, `npm test` (145 files / 879 tests) and
`npm run build` all pass. Nothing in this plan has been started.

---

## 0. Prompt for the agent doing this work

Copy this into a new session opened in the repository root:

```text
You are continuing a reviewed fix plan for TrekViewer 3D (Three.js + TypeScript + Vite,
no backend). Read docs/REVIEW_FIX_PLAN_2026_11_12.md completely before changing anything,
including section 1 (rules). Then work through the items in the order given in section 2,
one item at a time.

For every item:
1. Read the files named in the item. Line numbers were correct at commit 21f21cf and may
   have moved; find the code by the quoted snippet or symbol name, not by line number.
2. If the item is marked "(verify first)", prove the problem exists (a failing test or a
   clear reading of the code) before you change anything. If it does not exist, mark the
   item [-] with a one-line note and move on.
3. Make the smallest change that satisfies "Done when". Do not refactor nearby code.
4. Add or update the test the item asks for.
5. Run: npm run typecheck && npm test. Both must pass before you continue.
6. For items marked "Browser check", also run npm run build, start the "trekviewer-dist"
   preview (http://localhost:4174) and look at the result. Take a screenshot.
7. Tick the checkbox in the plan file, add a one-line note if you deviated, and commit
   that single item with a message starting with its ID (for example "B3: separate hand
   poke and ray pointer ids").

Work on a branch named review-fixes-2026-11-12. Never push, deploy, or edit .env files.
Never print or copy any token value. Stop and ask the owner when an item says OWNER, when
two attempts at an item have failed, or when a change would need more than about 300
changed lines outside tests. Finish a whole phase before starting the next one, and write
a short summary in the "Progress log" at the end of the plan after each phase.
```

---

## 1. Rules (read before starting)

**Commands**

```bash
npm ci
npm run typecheck
npm test
npm run build
```

- Run one test file with `npx vitest run test/<file>.test.ts`.
- `npm run dev` serves `https://localhost:5173` with a self-signed certificate, which the
  in-app browser pane refuses. For browser checks build first, then use the
  `trekviewer-dist` entry in `.claude/launch.json` (`http://localhost:4174`).
- `?debug=1` shows a diagnostics badge and exposes `window.__trekViewerApp`.

**Working rules**

- Branch: `review-fixes-2026-11-12`. One commit per item. Never push or deploy.
- Never run `npm run deploy:surge`, `deploy:gh-pages` or `package:apk`.
- Do not read, print or edit `.env.production.local`. Do not print token values.
- New tests go in `test/` and are named after the unit, not the plan
  (`offline_downloads_update.test.ts`, not `review_2026_11_12.test.ts`).
- New tests must call public methods. Do not add new `(x as any).privateField` access.
- Do not delete or weaken an existing test to make a change pass. If an existing test
  encodes the old (wrong) behaviour, change it and say so in the commit message.
- No new runtime dependencies. Dev dependencies named in this plan are allowed
  (`fake-indexeddb`, `@playwright/test`, `eslint`, `typescript-eslint`).
- Keep per-frame code free of allocations (`new`, array literals, `.map`, `.filter`,
  closures) in anything called from `TrekViewerApp.animate`.

**Status marks** (same as the earlier plan)

`[ ]` todo · `[x]` done · `[~]` partly done, see note · `[-]` dropped, see note

**What cannot be verified here**

Nothing can be tested on a Quest headset from this environment. Items tagged **HEADSET**
must still be implemented and unit-tested, then marked `[~] needs headset check` with the
exact thing the owner should look at.

**OWNER items** need a decision or an action only the owner can take. Do not guess; list
them in the progress log and continue with the next item.

**Confidence labels**

- *Confirmed*: seen in the running app or read directly in source during the review.
- *Reported (verify first)*: found by a sub-review and not independently re-read.

---

## 2. Order of work

1. Phase B — correctness bugs
2. Phase S — security and secrets
3. Phase V — visual quality
4. Phase U — desktop and mobile UI
5. Phase W — desktop walk mode
6. Phase O — offline robustness
7. Phase P — performance and memory
8. Phase X — XR interaction (HEADSET)
9. Phase N — new functionality
10. Phase C — cleanup and architecture
11. Phase T — tests and tooling

Phase T item T1 (`fake-indexeddb`) is needed by B2; do T1 first when you reach B2.

---

## Phase B — Correctness bugs

- [x] **B1 Imagery tiles overflow the texture array and draw flat quads** — *Confirmed
  (budgets and layer count); overflow behaviour reported.*
  - Where: `src/terrain/ImageryBatchRenderer.ts` (`IMAGERY_BATCH_LIMITS.layers: 32`,
    `maxPages`, `eligible()`), `src/terrain/QualityProfile.ts` (`tabletopPatches: 448`,
    `firstPersonPatches: 512`, desktop 640/768), `src/terrain/ImageryLODManager.ts`
    (`maxPatches`, `buildLightweightBoundsGeometry`, the `!patch.isFading` upload gate).
  - Problem: capacity is `layers × maxPages` tiles (about 352). Budgets are larger. A tile
    with no slot, or one still fading or queued, is drawn as a 4-corner proxy quad with a
    flat normal, which cuts through ridges.
  - Do:
    1. Export `imageryArrayCapacity(): number` from `ImageryBatchRenderer.ts` returning
       `layers × maxPages` for the active renderer.
    2. In `ImageryLODManager`, when terrain-shader imagery is on, clamp the number of
       selected tiles to `capacity − 32`.
    3. In `eligible()` (or the slot assignment next to it), give slots to visible tiles
       before hidden warm tiles; evict hidden entries first when full.
    4. In terrain-shader mode never set a proxy patch mesh visible. Until a tile is
       uploaded, the coarser parent tile or the route composite stays on screen.
  - Test: new `test/imagery_array_capacity.test.ts`. With a quest-high profile and more
    desired tiles than capacity, assert selected count ≤ capacity and that no patch mesh
    has `visible === true` in terrain-shader mode.
  - Done when: test passes; Browser check with `?debug=1` in walk mode for 60 s shows no
    flat sheets.
  - Note: patch meshes keep `visible` as the logical flag (coverage and upload use it);
    they are kept off-screen with `layers.mask = 0`, so the test checks drawable meshes.

- [x] **B2 Updating a "Needs update" pack takes the whole pack offline** — *Confirmed.*
  - Where: `src/offline/OfflineDownloads.ts` near
    `state: 'downloading', total: plan.resources.length`;
    `src/offline/OfflineStore.ts` `read()` (`r.state === 'ready'`).
  - Problem: a ready pack is rewritten to `downloading` before the first fetch, and
    `read()` only serves `ready` packs. A failed update leaves the pack unusable.
  - Do: add an optional `updating?: boolean` to `OfflinePackState`. When
    `previous?.state === 'ready'`, keep `state: 'ready'` and set `updating: true` for the
    whole gap download. On success `publish` clears it. On failure or pause, write back
    `state: 'ready', updating: false` with the error in `message`. Update
    `OfflineDownloadsPanel.ts` to show progress when `updating` is true.
  - Test (needs T1): `test/offline_downloads_update.test.ts`. Seed a ready pack, make the
    first fetch reject, assert `OfflineStore.read(url)` still returns the stored blob and
    the state is `ready`.
  - Done when: test passes and README line "keep working" is true.

- [x] **B3 Hand-ray scrubbing on the HUD chart stops after one frame** — *Confirmed.*
  - Where: `src/core/XRManager.ts`: the poke path ends with
    `this.spatialHUD.onPointerRelease(pointerId);` and the ray path builds
    ``const pointerId = isHand ? `hand_${...}` ``; `src/ui/SpatialHUD.ts`
    `onPointerRelease`.
  - Do: use different ids: `handpoke_<handedness>` in the poke path and
    `handray_<handedness>` in the ray path. Check every other use of the old id
    (disconnect handling from fix A8 caches handedness) and update both.
  - Test: extend `test/hand_gestures.test.ts` or add `test/hud_pointer_ownership.test.ts`:
    start a scrub with the ray id, call the poke path's release with the poke id, assert
    a following `onPointerDrag` with the ray id still moves progress.

- [~] **B4 The model is sunk into the detected table** — *Confirmed.* **HEADSET**
  - Where: `src/xr/TablePlacement.ts`
    `root.position.set(table.position.x, table.position.y + 0.01, table.position.z)`;
    plinth dimensions in `src/visualization/DioramaBase.ts` (`baseY: number = -80`) and
    its caller in `src/core/RouteLoader.ts`.
  - Do: export the plinth's lowest local Y from `DioramaBase` (read the real thickness
    in code; the review measured bottom at about −105). Set
    `y = table.y + 0.01 + plinthBottomDepth × root.scale.y`. Pass the depth into
    `TablePlacement.update` rather than importing scene objects.
  - Test: unit test with scale 0.0005 and depth 105 asserting the plinth bottom world Y
    equals `table.y + 0.01` within 1 mm.
  - Note: needs headset check — in passthrough with a Space Setup table, the plinth's
    bottom face should sit on the table top (no slab hidden below the surface).

- [x] **B5 Chunk seam re-blend runs on already-blended heights** — *Confirmed.*
  - Where: `src/terrain/LocalTerrainChunk.ts`
    `this.rawLocalHeights = prepared ? new Float32Array(prepared.heights) : ...` and the
    prepared payload `heights: this.unscaledHeights`; `src/workers/TerrainWorker.ts`.
  - Do: have the worker path return the unblended heights as a second transferable
    `rawHeights`, and use it for `rawLocalHeights`. Keep the current behaviour as the
    fallback when `rawHeights` is absent. After `setOuterEdges`, compute edge-vertex
    normals from the height field (central differences using neighbour samples) instead
    of `computeVertexNormals` so inner edges have two-sided normals.
  - Test: build two adjacent chunks from one synthetic sloped grid through the prepared
    path, call `setOuterEdges` with the shared edge marked inner, assert the shared-edge
    heights equal the raw grid heights (not the 60 m parent) within 1 cm.

- [x] **B6 Trail ribbon is buried on convex ridges** — *Confirmed (shader); effect
  reported.*
  - Where: `src/visualization/TrailChevronMaterial.ts`
    `vec3 trailMid = 0.5 * (position + trailPartner);`; edge sampling in
    `src/visualization/TrailMesh.ts`; attribute upkeep in
    `src/visualization/SurfaceVertexIndex.ts` (it already maintains `trailPartner`).
  - Do: add a float attribute `trailCenterY` holding the terrain-sampled height of the
    centre line at each vertex (plus the same lift the edges get). Maintain it wherever
    `trailPartner` is maintained (surface streaming, vertical exaggeration). In the
    shader use `trailMid.y = max(trailMid.y, trailCenterY);`.
  - Test: for a synthetic ridge (centre 10 m above both edges) assert the attribute is
    within 0.1 m of the centre height and that it rescales with exaggeration.

- [x] **B7 Tile timeouts are negative-cached for 60 s instead of 15 s** — *Confirmed.*
  - Where: `src/terrain/TileImageCache.ts`: `const timer = setTimeout(abort, timeoutMs);`
    and `/timed? ?out|timeout/i.test(errMsg) ? 15000 : 60000`.
  - Do: keep a local `let timedOut = false`; the timer sets it and aborts. In the catch,
    if `timedOut` and the caller's `signal` is not aborted, throw
    `new Error('Timeout loading tile')`. A caller abort must stay an `AbortError`.
  - Test: fake timers, a fetch that never resolves; assert the negative-cache retry delay
    is 15000.

- [x] **B8 Laser cannot press most of the HUD Dock button** — *Reported (verify first).*
  - Where: `src/core/XRManager.ts` (search `uv.y > 0.92`), `src/ui/SpatialHUD.ts` Dock
    button rectangle (x 650–765, y 25–79) and the `hud-drag` area.
  - Do: remove the UV fallback drag zone and use only the `hud-drag` hit area reported by
    `SpatialHUD`. Make sure that area does not overlap any button.
  - Test: hit-test the centre and the top edge of the Dock rectangle; both must resolve
    to the Dock action, not a drag.

- [x] **B9 Trigger grabs the model from anywhere** — *Reported (verify first).*
  - Where: `src/core/XRManager.ts` (search `t < 12`).
  - Do: after intersecting the horizontal plane, transform the hit into `dioramaRoot`
    local space and reject it when it lies outside the plinth footprint plus 5 cm.
  - Test: ray hitting the plane 5 m from the model does not start a drag; a ray hitting
    inside the footprint does.

- [~] **B10 Poke has no release hysteresis** — *Reported (verify first).* **HEADSET**
  - Where: `src/core/XRManager.ts` `POKE_DEPTH = 0.012`.
  - Do: press at 12 mm, release at 20 mm, and ignore a new press on the same control for
    150 ms after a release.
  - Test: feed fingertip depths 11, 13, 11, 13 mm over 4 frames; exactly one press fires.
  - Note: needs headset check — poke a HUD button slowly and hold the fingertip at the
    surface; it should fire once, and a quick double poke (under 150 ms) should fire once.
    The 150 ms guard is per hand (any HUD control), not per control.

- [x] **B11 Hold-A/X dim can stick** — *Reported (verify first).*
  - Where: `src/core/XRManager.ts` (controller disconnect / tracking-lost paths,
    `prevButtons.fill(false)`, `resetInteractionState`), `src/main.ts`
    `viewHoldProgress`.
  - Do: call `onViewModeHoldProgress(null)` in every path that clears button state and in
    `resetInteractionState`. Also ignore a second face button while one hold is running.
  - Test: start a hold, simulate disconnect, assert the callback received `null`.

- [x] **B12 Terrarium DEM is offset by half a pixel** — *Reported (verify first).*
  - Where: `src/terrain/ElevationTiles.ts` (search
    `gx = (xGlobal - grid.tileXMin) * 256`).
  - Verify: build a synthetic 2-tile grid where pixel `(i, j)` stores `i`. Sample at the
    geographic centre of pixel 10. Correct result is 10; if you get 10.5 the bug exists.
  - Do: subtract 0.5 from `gx` and `gy` on the tile path only (not the USGS raster path)
    and clamp to the grid. Update `test/dem_registration`-style fixtures if they encoded
    the offset, and say so in the commit.

- [x] **B13 "Reload to update" breaks other open tabs** — *Reported (verify first).*
  - Where: `scripts/offline-worker.js` (`skipWaiting`, cache deletion in `activate`),
    `src/offline/OfflineShell.ts` (`controllerchange`, `reloading`, `canReload`).
  - Do: on `controllerchange`, reload any tab that is not presenting XR and has no
    download running (`OfflineDownloads.busy()`); if it cannot reload now, show the
    existing "Reload to update" prompt. Show that prompt outside the Offline tab too (use
    the status banner).
  - Test: extend `test/offline_shell.test.ts` for a second client receiving
    `controllerchange` with `reloading === false`.

- [~] **B14 Small confirmed leftovers**
  - `src/ui/SpatialHUD.ts` footer text (search `1-Hand Pinch to Drag & Turn` and
    `[A/X] 1:1 Mode`): change to "1-hand pinch: move · 2 hands: zoom / turn" and
    "Hold A/X: switch view".
  - `src/ui/DesktopOverlay.ts` `showStatus`: stop detecting "done" from substrings
    (`'ready'`, `'active'`, `'complete'`, `'Loaded:'`). Make every caller pass `state`
    explicitly; default with no state is `loading` only when a spinner is wanted. Update
    `test/desktop_status_banner.test.ts`.
  - `src/core/RouteLoader.ts` (search `abort`): treat only `error.name === 'AbortError'`
    as a cancel, not any message containing "abort".
  - `src/offline/OfflineStore.ts`: reject transaction promises in `onabort` (where
    `tx.error` is set) so `QuotaExceededError` reaches the "storage is full" message; add
    a `db.onclose` handler that clears the cached connection. *(verify first)*
  - `src/main.ts` `sessionstart`: place the diorama relative to the first viewer pose (as
    `pendingHUDDock` does for the panel) instead of
    `position.set(0, 0.82, -0.80)`. **HEADSET**
  - Note: all five done. Needs headset check — enter MR facing away from the room's
    origin with no Space Setup table; the model should appear 80 cm ahead of where you look.
    The OfflineStore `onabort`/`onclose` change was verified by reading the IndexedDB
    event order; it has no IndexedDB test yet because `fake-indexeddb` (T1) is not installed.
    `test/xr_availability.test.ts` now expects the explicit `'error'` state argument.

---

## Phase S — Security and secrets

- [ ] **S1 OWNER: revoke the token that is in git history.** A Cesium-style token was
  committed in `src/terrain/TextureProvider.ts` at commit `33a0f92` and later removed.
  The agent must not print it. Add this to the progress log as an owner action: revoke it
  in the Cesium ion dashboard, and restrict the current token by allowed URL.
- [x] **S2 Delete the `deploy:gh-pages` script** from `package.json`. It publishes the
  built bundle (which contains the current token) to a repository branch and skips
  typecheck and tests.
- [x] **S3 Send the ion token as a header** — *Reported (verify first).*
  `src/terrain/providers/ImageryProvider.ts` (search `access_token=`): use an
  `Authorization: Bearer` header for the ion endpoint request if the API accepts it.
  Keep the query form only for the tile URLs that require it.
- [x] **S4 Add a Content-Security-Policy meta tag** to `index.html`.
  - Build the host list from the allowlist in `src/offline/OfflineSourceIdentity.ts` and
    the provider files in `src/terrain/providers/`. Do not invent hosts.
  - Start from: `default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; worker-src
    'self' blob:; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data: <hosts>;
    connect-src 'self' <hosts>`.
  - `scripts/entry-integrity.ts` injects inline script; if it does, either hash it in the
    CSP or move it to a file. Do not add `'unsafe-inline'` to `script-src`.
  - Browser check: load Rainier and the Enchantments, switch Aerial / Hybrid / Topo, and
    confirm the console shows no CSP violations. If any provider breaks, fix the list.

---

## Phase V — Visual quality

Every item here needs a Browser check with a before and after screenshot of the default
Rainier route.

- [x] **V1 Terrain is cropped too tightly around the route** — *Confirmed.*
  - Where: `src/terrain/TerrainGenerator.ts` `const margin = 0.25;` and the two
    `Math.max(bounds.*Meters * (1 + margin * 2), 1500)` lines.
  - Problem: on Rainier the summit sits at the edge of the block.
  - Do: compute each dimension as the largest of (a) route extent × 1.5, (b) route
    extent + 2 × 2000 m, (c) the extent needed so the route's highest point is at least
    2500 m from every edge. Keep the block centred on the route bounds. Cap each
    dimension at the value where the base DEM still fits the existing tile budget (find
    the "25-tile budget" logic in `ElevationTiles.ts`); if the cap is hit, keep the cap.
  - Side effect to check: `src/offline/OfflinePlan.ts` derives pack contents from the
    terrain footprint. Run `test/offline_plan.test.ts`. Existing downloaded packs will
    show "Needs update" after this change, so **B2 must be done first**. Note this in the
    progress log for the owner.
  - Also soften the edge: fade the outer 3% of the terrain into the skirt colour in the
    terrain shader, or darken the skirt to match the plinth.
  - Done when: the Rainier summit is clearly inside the block with terrain visible on all
    sides.
  - Note: one rule (`src/terrain/TerrainFootprint.ts`) now drives terrain, plinth, XR grab
    footprint and offline plans, which each had their own copy of the old margin. Sizes are
    rounded up to 250 m; the high point is recorded in `GeoBounds.highPoint`. The edge is
    softened by darkening the skirt. First Rainier load in the preview took about 30–40 s
    (was about 18 s) because the DEM and imagery cover a larger area.

- [x] **V2 Snow is blown out and imagery colours are shifted** — *Confirmed.*
  - Where: `src/core/SceneManager.ts` `toneMapping = THREE.ACESFilmicToneMapping`,
    `toneMappingExposure = 1.15`, hemisphere light 1.2, sun 2.4.
  - Do: switch to `THREE.NeutralToneMapping` with exposure 1.0. Then lower the lights so
    a sun-facing white surface is not above 1.0 before tone mapping: start with sun 2.0
    and hemisphere 1.0 and adjust by eye.
  - Done when: in a screenshot of the Emmons Glacier, crevasses and texture are visible
    in the snow (not flat white) and forest is not darker than before.

- [x] **V3 Trail is invisible on snow** — *Confirmed.*
  - Where: `src/visualization/TrailChevronMaterial.ts`, `src/visualization/TrailMesh.ts`.
  - Do: in the fragment shader darken the outer 20% of the ribbon width to `#0b1220`
    (a casing) using the existing across-width coordinate. Set `toneMapped = false` on
    the trail material so legend colours match the legend. Apply to every colour mode.
  - Done when: the trail is clearly readable across the glacier and across forest.
  - Note: at overview distance the ribbon is only about 3 px wide, so a 20% casing was
    sub-pixel; the casing is the outer 20% or about one pixel, whichever is wider. The
    trail was confirmed 5 m above the terrain along its whole length (not buried).

- [x] **V4 Markers have no names** — *Confirmed.*
  - Where: `src/visualization/DioramaBase.ts`, `src/visualization/TrailMesh.ts`,
    `src/visualization/WaypointInstanceRenderer.ts`.
  - Do: always show a text label for start, summit/high point, finish and day-boundary
    landmarks. Reuse the existing label sprite code. Each frame-interval (not every
    frame; reuse the existing waypoint update throttle) project label rectangles to the
    screen, sort by priority (summit, start, finish, day boundary, other) and hide a
    label that overlaps a higher-priority one. Other waypoints keep hover-only labels.
  - Done when: four labelled pins are readable on the default view and none overlap.
  - Note: there was no existing waypoint update throttle; placement runs every 0.2 s.
    Always-on labels are half the hover size. On Rainier, Finish shares Start's location
    (merged), and Day 2 Start is hidden at the default zoom because it would cover the
    High Point label; it appears when zoomed in. So the default view shows two to three.

- [x] **V5 Follow camera is almost top-down** — *Confirmed.*
  - Where: `src/visualization/DioramaCameraFollow.ts`.
  - Do: follow from behind the direction of travel at about 35° above the horizon,
    smoothing the heading over about 2 s so switchbacks do not swing the camera. Keep the
    existing terrain-clearance logic (`test/diorama_follow_clearance.test.ts`).
  - Done when: during the tour the skyline is visible and the camera never goes below
    the terrain. Update follow tests that assert the old pitch.

- [x] **V6 Plinth renders flat black** — *Reported (verify first).*
  `src/visualization/DioramaBase.ts` (search `metalness: 0.8`): use
  `metalness: 0, roughness: 0.85` and a dark slate colour.

- [x] **V7 Anisotropy is set to the device maximum** — *Reported (verify first).*
  `src/core/SceneManager.ts` `TextureProvider.setMaxAnisotropy(...)`: clamp to 4 for
  quest profiles and 8 for desktop.

- [~] **V8 Scale bar is useless once zoomed** — *Reported (verify first).*
  `src/visualization/DioramaBase.ts` `ScaleBar`: pick the bar length from the current
  model scale so it stays between 8% and 25% of the plinth width, choosing from
  1-2-5 × 10ⁿ metres, and update its label.
  - Note: the bar is now the largest 1-2-5 × 10ⁿ length within 8–25% of the plinth width
    (2 km on Rainier). The ratio to the plinth cannot change with model scale (both scale
    together), so zooming still leaves the bar in the plinth corner. OWNER: say whether a
    screen-relative scale bar (sized to the visible ground) is wanted instead.

---

## Phase U — Desktop and mobile UI

All items: Browser check at 1440×900 and at the `mobile` preset (375×812).
Files: `src/ui/DesktopOverlay.ts`, `src/style.css`.

- [x] **U1 Elevation chart is tiny and blurry.**
  - The canvas is fixed at `width="800" height="70"` and is about 250 px wide at 1440.
  - Do: size the canvas backing store to `clientWidth × devicePixelRatio` on resize (use
    the existing `ResizeObserver` pattern in `main.ts`), redraw the static layer, and
    scale drawing by DPR. Restructure `.player-bar` so the chart and scrubber take a full
    row (minimum height 96 px desktop, 72 px mobile) and the buttons sit in a row above.
  - Add: Y-axis min/max labels, X-axis distance ticks, and on pointer move a tooltip with
    distance, elevation and grade at the cursor (grade from neighbouring samples in
    `cachedElevationSamples`).
- [x] **U2 Header wastes space when XR is unavailable.** When `setXRSupport(false, false)`
  hide both XR buttons and the status line, and show one small text button
  "Open on a Quest headset" that opens the Help tab. Remove the subtitle
  "Meta Quest 3 Alpine Visualizer" below 900 px width.
- [x] **U3 Mobile layout.** Target: at 375×812 the 3D canvas has at least 55% of the
  viewport height when panels are closed.
  - Header: one row (logo, route select, a single "⋯" menu holding Import GPX and
    Settings).
  - Player bar: play button, scrubber and chart only; speed, timing mode, follow and view
    toggle move into a collapsible second row.
  - Settings: a full-height sheet (top of viewport to bottom) with its own close button,
    not a box squeezed between header and player bar.
- [x] **U4 Units setting.** Add a `units: 'imperial' | 'metric'` preference stored under
  `trekviewer.units` (default from `navigator.language`: `en-US` → imperial, otherwise
  metric). Create `src/utils/Units.ts` with `formatDistance`, `formatElevation`,
  `formatSpeed` and use it everywhere numbers are shown: `DesktopOverlay` (stats,
  subtitle, scrubber, legend, landmarks, load status in `main.ts`) and `SpatialHUD`.
  Add the selector to the View tab. Unit-test the formatters.
- [x] **U5 Keyboard shortcuts.** Space: play/pause. Left/Right: scrub ±1% (Shift ±5%).
  `F`: fit terrain. `1`/`2`/`3`: Aerial/Hybrid/Topo. Ignore keys when focus is in an
  `input`, `select` or `textarea`. List them in the Help tab. Remove the listener in
  `dispose()`.
- [x] **U6 Offline tab explains itself.** Only two routes are listed because
  `vite.config.ts` hashes only `rainier-emmons` and `enchantments-dragontail`. Add one
  sentence under the list: "Offline maps are available for these routes. Other routes
  use the temporary cache as you explore." Do not change which routes are offered.
- [x] **U7 Replace emoji used as icons** in buttons with text labels or inline SVG, so
  buttons render the same on every platform. Keep labels short.
- [x] **U8 Default speed parse.** `DesktopOverlay.ts`
  `parseFloat(btn.getAttribute('data-speed') || '20')`: the fallback should be `'1'`.

---

## Phase W — Desktop walk mode

*Confirmed in the running app:* at 1.8 m eye height the ground is a dark smear even with
all Z19 tiles loaded, dragging does nothing, there are no keyboard controls, and playback
is locked to walking pace on an 18-hour route.

- [x] **W1 Chase camera on desktop.** In `src/visualization/FlyoverController.ts`, when
  not presenting XR and view mode is `first-person`, place the camera behind the hiker
  along the direction of travel, 60 m back and 25 m above the ground, looking at a point
  40 m ahead of the hiker. Keep it above the terrain using the elevation sampler
  (minimum 8 m clearance). XR behaviour must not change.
  Rename the desktop button from "Walk Trail (1:1)" to "Fly the trail"; XR labels stay.
- [x] **W2 Mouse look.** While in this mode on desktop, dragging rotates the view around
  the hiker (yaw free, pitch 5°–80°), the wheel changes the follow distance 15–400 m, and
  releasing for 3 s eases back to the default chase position.
- [x] **W3 Speed control.** Show the speed selector in this mode on desktop with
  1×, 10×, 30×, 100× of walking pace (extend `playbackPresentation` in
  `src/visualization/PlaybackPresentation.ts`). XR life-size stays at walking pace.
- Tests: camera stays above terrain along a synthetic ridge; speeds map correctly;
  XR path unchanged (existing `stage_s1_first_person_lod` and `flyover_speed` tests pass).
- Browser check: enter the mode at the start of Rainier, play at 30× for 20 s,
  screenshot; drag to look around, screenshot.
- Note: W1 browser check done (elevated chase view at the Rainier start). The 30× / 20 s
  run and the drag screenshot could not be taken: the in-app browser pane was hidden, so
  the page received no animation frames. In the page, the selector showed 1×/10×/30×/100×,
  play started, and one real 1 s update at 30× advanced 42 m (1.4 m/s × 30). Movement and
  mouse look are covered by `test/desktop_chase_camera.test.ts`. Repeat the visual run.

---

## Phase O — Offline robustness

- [x] **O1 Retry in the browser download path** — *Reported (verify first).*
  `src/offline/OfflineDownloads.ts` (the loop that tries each alias once then
  `throw lastError`), `src/offline/OfflineDownloadsPanel.ts` (queue `break`).
  Do: up to 4 attempts per resource with delays 1 s, 4 s, 15 s (honour the abort
  signal). A resource that still fails is put on a "revisit" list and the download
  continues; after the main pass, retry the list once. Pause only if more than 20
  resources are still failing or a quota error occurs. Test with `fake-indexeddb` and a
  fetch mock that fails twice then succeeds.
- [x] **O2 Corridor packs overclaim terrain** — *Reported (verify first).*
  `src/offline/OfflinePlan.ts` (corridor mode drops fine DEM outside the corridor), copy
  in `src/offline/OfflineStore.ts` ("with full terrain shape") and `README.md`.
  Do: fix the copy to "detailed terrain along the trail, overview terrain elsewhere".
  Do not change what is downloaded.
- [x] **O3 Pack-file resume re-reads everything** — *Reported (verify first).*
  `src/offline/OfflineArchive.ts`, `src/offline/OfflineDownloads.ts`: when a stored
  asset's `sha256` and `bytes` equal the archive manifest record, skip `source.load`,
  decode and re-hash.
- [x] **O4 Service worker update check.** `src/offline/OfflineShell.ts`: call
  `registration.update()` when the page becomes visible, at most once an hour. `canReload`
  must be false while `OfflineDownloads.busy()`.
- [ ] **O5 OWNER decision: store imagery as WebP/JPEG instead of PNG32.** Packs are
  5–10 GB mainly because of lossless PNG. Transcoding on download would cut size
  several-fold but changes pack format and hashes. Do not start this; record it in the
  progress log with the size numbers from `scripts/estimate-offline-route-packs.mjs` if
  that script runs without network.
- [ ] **O6 OWNER decision: tie pack validity to the inventory, not the GPX bytes**
  (`OfflineStore.compatible`). Record only.

---

## Phase P — Performance and memory

Measure before and after each item with `?debug=1` (badge shows callbacks/s, CPU p95,
draw calls, textures) on the default route: tabletop idle, tour playing, walk mode.
Write the numbers in the commit message.

- [x] **P1 `syncRenderer` allocates every frame** — *Reported (verify first).*
  `src/terrain/ImageryLODManager.ts` `syncRenderer` (called from `main.ts` every frame):
  add a revision counter that increments when batch entries or terrain surfaces change;
  return early when the revision and renderer are unchanged.
- [x] **P2 HUD texture re-upload at about 12 Hz** — *Reported (verify first).*
  `src/ui/SpatialHUD.ts` `updateState` → `drawHUD()`: skip the redraw unless a displayed
  label string changed, a toggle changed, or the chart cursor moved ≥ 2 canvas pixels.
  Extend `test/hud_ui_performance.test.ts`: 90 s of tour progress updates must cause
  fewer than 200 uploads.
- [x] **P3 XR per-frame traversals and allocations** — *Reported (verify first).*
  `src/core/XRManager.ts`:
  - cache `dioramaRoot.getObjectByName('Waypoints')` and the `hitMeshes` list; refresh
    them in `setDioramaContext` / on route commit, not per frame;
  - replace per-frame `setFromPoints([new Vector3, new Vector3])` on ray lines with a
    unit-length line scaled by `rayLine.scale.z`;
  - replace `new THREE.Ray(...)` with a scratch ray.
  `src/xr/GestureMath.ts`: remove the per-frame `wristPairs` array and clones.
- [ ] **P4 First-person imagery zoom ignores distance** — *Reported (verify first).*
  `src/terrain/ImageryLODManager.ts` (search
  `innerZoom = Math.min(this.providerMaxZoom, 19)`),
  `src/terrain/BroadDetailSelection.ts`.
  Do: per view-ray hit, choose zoom from distance: maximum zoom within 300 m, one level
  lower for each doubling of distance, never below the base composite zoom. Keep the
  existing hysteresis. Test: hits at 100 m, 600 m, 2400 m, 9600 m select zooms
  19, 18, 16, 14 (when the provider maximum is 19).
  This reduces tile count, which also helps B1.
- [ ] **P5 Diagnostic work runs when not profiling** — *Reported (verify first).*
  `ImageryLODManager.ts`: the 12 extra rays used only for diagnostics and the unused
  `corridorPoints` build in the broad path run only when `?debug=1` or `?profile=1`.
- [ ] **P6 Imagery memory** — *Reported estimate, about 430 MB on Quest High.*
  - `src/terrain/ImageryBatchRenderer.ts`: free the CPU mirror of array pages after
    upload if nothing reads it afterwards (check context-loss recovery in
    `GraphicsRecovery`; if recovery needs the data, re-request tiles instead).
  - `src/terrain/QualityProfile.ts`: lower `tileCacheBytes` for quest profiles from
    192 MB to 64 MB.
  - Report `tileCacheMB`, textures and JS heap before and after.
- [ ] **P7 Whole-array mipmap regeneration per tile** — *Reported (verify first).*
  three.js regenerates mips for all 32 layers after each layer update. Advanced; attempt
  only after P1–P6. Approach: build the mip chain for the one tile on a canvas, and
  upload each level with `texSubImage3D` through `renderer.getContext()`, with
  `generateMipmaps = false` on the array texture. If this needs more than about 300
  lines or breaks context recovery, mark `[~]` and stop.
- [ ] **P8 IndexedDB read path** — *Reported (verify first).*
  `src/terrain/PersistentResourceCache.ts`: reads use a `readonly` transaction; batch
  the last-access timestamp writes into the existing flush; replace `metadata.getAll()`
  on every flush with a running total.
- [ ] **P9 Depth precision.** `SceneManager.ts` camera `near 0.1 / far 80000`. In
  first-person/chase mode set near to 1 m and far to 3 × terrain extent
  (`updateInspectionClipping` already handles tabletop). Browser check for z-fighting on
  distant ridges.

---

## Phase X — XR interaction (all HEADSET)

Implement and unit-test; mark each `[~] needs headset check`.

- [ ] **X1 Comfortable defaults.** `src/xr/ComfortPreferences.ts` `DEFAULT_COMFORT`:
  `movement: 'step'`. Existing saved preferences must be respected. Add a 150 ms fade
  through black around each 25 m step using `SceneManager.setFade`.
- [ ] **X2 HUD legibility, interim.** `src/ui/SpatialHUD.ts`: canvas 2048×1536 with all
  layout coordinates scaled ×2 (use a single scale constant, do not hand-edit numbers),
  minimum text size equal to 18 px at the old scale, texture anisotropy 4, and tilt the
  panel so its normal points at the eye (pitch, not only yaw) in `dockHUD` in `main.ts`.
  P2 must be done first because the texture is four times larger.
- [ ] **X3 Near-field transport strip.** Add a small strip on the plinth's near edge with
  Play/Pause, previous/next landmark and a short scrub bar, sized for index-finger poke
  (targets ≥ 3 cm). It reuses `SpatialHUD` callbacks. The far panel stays as it is.
  OWNER: confirm before starting; this is new UI.
- [ ] **X4 Marker scale.** Hiker marker and start/finish pins must keep a constant
  angular size like waypoints do (they currently grow with zoom); in life-size mode
  waypoint markers become signpost height (about 1.5 m).
- [ ] **X5 Zoom about the plinth, stay on the table.** When two-hand scaling, keep the
  plinth bottom at the table height (use B4's offset). Clamp maximum scale so the plinth
  is never wider than 2.5 m.
- [ ] **X6 Vignette centred on view direction.** `SceneManager.ts` vignette shader uses
  `length(screenUV-0.5)` per eye; compute it from the view-space direction so both eyes
  agree.
- [ ] **X7 Pause on blur.** Pause playback and locomotion when the XR session's
  `visibilityState` is not `visible`.
- [ ] **X8 Framebuffer scale.** `SceneManager.ts` `setFramebufferScaleFactor(1)`: use 1.2
  for the quest-high profile. Must be set before the session starts.
- [ ] **X9 Unused cues.** Play the existing `release` audio cue on grab release; call
  `setAngularSize` after a hand bar-drag as the controller path does.

---

## Phase N — New functionality

Do these only after phases B–U. Each needs a Browser check and a unit test for its maths.

- [ ] **N1 Click a point on the trail.** Desktop: clicking the trail (raycast against the
  trail mesh, then `routeGeometry.projectGeoPointToVisualRoute` or its local-space
  equivalent) sets progress there and shows distance, elevation, grade and elapsed time
  in a small popover. XR: the same on pinch/trigger select of the trail.
- [ ] **N2 Slope-angle shading.** A fourth visual style "Slope" that tints terrain by
  slope angle from the surface normal in `src/terrain/TerrainImageryMaterial.ts`:
  transparent below 27°, yellow 27–30°, orange 30–35°, red 35–45°, purple above 45°,
  blended at 50% over the imagery. Add a legend. Normals must be in model space and
  must account for vertical exaggeration (divide the vertical component back out).
- [ ] **N3 Day splits.** `src/gpx/RouteLandmarks.ts` already produces `day_boundary`
  landmarks. Show per-day distance, gain, loss and time in the Route tab, and shade
  alternate days in the elevation chart.
- [ ] **N4 Remaining distance and time** next to the progress readout (desktop and HUD).
- [ ] **N5 Sun position.** OWNER: confirm. A time-of-day slider that moves the
  directional light using solar position for the route's latitude/longitude and the
  track's date. Shadows stay off in XR.

---

## Phase C — Cleanup and architecture

Run the full test suite after each deletion. Delete the tests that only cover deleted
code, and list them in the commit message.

- [ ] **C1 Delete `LocalTerrainStreamer`** — *Reported (verify first).* Prove it is
  unreachable: `src/core/LoadedTrek.ts` picks it only when `baseMeshGrid` is missing, and
  `src/terrain/TerrainGenerator.ts` should always set `baseMeshGrid`. If any code path
  returns a result without `baseMeshGrid`, stop and mark `[-]`.
- [ ] **C2 Delete the BatchedMesh imagery branches** in
  `src/terrain/ImageryBatchRenderer.ts` and the `experimentalImageryBatching` option
  (always `false` in `main.ts`).
- [ ] **C3 Remove the overlay-patch renderer** once B1 is done and a shader fade exists:
  `?terrainImagery=0`, `SurfacePatchGeometry`, `SurfacePromotion`, the `prepareSurface*`
  handshake, `staleDirectPatches`, `reprojectPatches`. OWNER: confirm before starting;
  it is the last A/B fallback.
- [ ] **C4 Split `src/terrain/ImageryLODManager.ts`** (3,092 lines) by moving code
  without changing behaviour, one module per commit:
  1. `ImagerySelection.ts`: the pure selection functions.
  2. `ImageryRequestScheduler.ts`: queue, concurrency, retry, backoff.
  3. `ImageryViewSampling.ts`: view rays and zoom hysteresis.
  4. `ImageryDiagnostics.ts`: counters and `getDiagnostics`.
  The class keeps its public API. No test should need to change except imports.
- [ ] **C5 Remove unused code** found by `npx tsc --noEmit --noUnusedLocals
  --noUnusedParameters` (27 errors at review time), then set both options to `true` in
  `tsconfig.json`.
- [ ] **C6 Remove debug leftovers in `main.ts`**: the `__trekViewerInstances` counter and
  the unconditional build `console.log` (keep it under `?debug=1`).
- [ ] **C7 OWNER decision, record only:** replace the static singletons
  (`TextureProvider`, `TileImageCache`, `ElevationTileService`,
  `QualityProfileManager`) with injected instances, and replace the whole-route mesh plus
  5 m chunks with one quadtree using per-node screen-space error and morphing. Both are
  large; do not start.

---

## Phase T — Tests and tooling

- [x] **T1 Add `fake-indexeddb`** (dev dependency) and
  `test/offline_store_lifecycle.test.ts` covering `OfflineDownloads.prepare/start` and
  `OfflineStore.publish/remove/save/read` through public methods: fresh download,
  resume after pause, publish, remove. Needed by B2 and O1.
- [ ] **T2 One browser smoke test in CI.** Add `@playwright/test`, a test that serves
  `dist`, loads the page, waits for the status "Loaded:" (or its replacement from B14),
  and asserts no console errors other than network failures to external hosts. Mock
  external hosts with route interception returning a 1×1 PNG so CI needs no network.
  Add the step to `.github/workflows/ci.yml` after the build.
- [ ] **T3 Repair or delete `scripts/*.mjs` browser checks.** Several use removed URL
  flags (`imageryBatch`, `terrainTiles`, `terrainSourceBounds`) and Playwright was not a
  dependency. Delete scripts referenced by nothing (check `package.json`, docs and other
  scripts with `grep -rn "<script name>" .`); fix the rest.
- [ ] **T4 ESLint** with `typescript-eslint` recommended rules, `npm run lint`, and a CI
  step. Fix errors; do not disable rules wholesale. Per-line disables need a reason.
- [ ] **T5 `package.json` hygiene:** add `"private": true`, a `description`, an `engines`
  field matching CI, remove `"main": "index.js"`. Read the version in `vite.config.ts`
  from `package.json` instead of the hard-coded `1.0.0`. Make CI and local Node versions
  agree (CI uses 22; `@types/node` is 26).
- [ ] **T6 Rename history-named tests** (`stage_*`, `review_*`,
  `architecture_review_fixes`) to the unit they cover, splitting files that cover several
  units. Pure moves; no assertion changes. Do this last to avoid merge pain.
- [ ] **T7 Docs.** Update `README.md` for every user-visible change in this plan.
  `docs/OFFLINE_ROUTE_PACKS.md` says browser export and geographic indexing "remain
  open" (both exist). `docs/ARCHITECTURE_REVIEW_AND_HANDOFF.md` documents removed URL
  flags. Point `README.md` "Open work" at this file.

---

## OWNER decisions and actions (summary)

| ID | What is needed |
|---|---|
| S1 | Revoke the old token from git history; restrict the current token by URL |
| V1 | Accept that existing offline packs will show "Needs update" after the terrain margin change |
| O5 | Whether to transcode offline imagery to WebP/JPEG |
| O6 | Whether pack validity should follow the inventory instead of GPX bytes |
| X3 | Go-ahead for the near-field transport strip |
| C3 | Go-ahead to remove the overlay-patch fallback |
| N5 | Go-ahead for sun position |
| C7 | Whether to plan the singleton removal and quadtree terrain |
| All X items, B4, B10 | Headset check |

---

## Progress log

Add one entry per finished phase: date, items done, items dropped and why, measurements,
and anything the owner must check.

- 2026-11-12: plan written. Nothing started.
- 2026-11-13, Phase B done (branch `review-fixes-2026-11-12`). B1–B3, B5–B9, B11–B13 done;
  B4, B10, B14 done in code and marked `[~]` for a headset check. T1 (`fake-indexeddb`)
  done early for B2. Verify-first items B8, B9, B10, B11, B12, B13 and the B14 storage
  item were all confirmed by test or reading; none dropped. Existing tests changed because
  they encoded old behaviour: `review_improvements` (poke id, 150 ms re-press),
  `terrain_cache_robustness` (DEM pixel centres), `desktop_status_banner` and
  `xr_availability` (explicit status state). B1 browser check: 60 s in walk mode with
  `?debug=1`, coverage 100 %, no flat sheets. Suite: 157 files / 909 tests.
  Owner headset checks: B4 plinth sits on a detected table; B10 slow poke fires once;
  B14 model appears 80 cm ahead of where you look on MR entry without a table.
- 2026-11-13, Phase S done except S1 (owner). S2 removed `deploy:gh-pages`. S3 verified the
  ion request carried the token in the URL; it now sends `Authorization: Bearer`, and a
  live browser request confirmed ion's CORS accepts the header (401 for a dummy token).
  S4 added the CSP; the build stamps the inline script's sha256, and the browser check
  (Rainier, Enchantments, Aerial/Hybrid/Topo) showed no violations. The S4 check also found
  a B14 regression (spinner stayed on "Aerial view active."), fixed in its own commit.
  Note for browser checks: the offline service worker keeps serving the previous build in
  the preview until it is unregistered. **OWNER action S1:** revoke the Cesium token that
  was committed in `src/terrain/TextureProvider.ts` at `33a0f92` in the Cesium ion
  dashboard, and restrict the current token to the app's allowed URLs.
- 2026-11-13, Phase V done. V1–V7 done with before/after browser checks on default
  Rainier; V8 partly done (see its note). V1 consolidates four copies of the terrain margin
  into `terrainFootprint()`; first load in the preview now takes about 30–40 s instead of
  about 18 s. **OWNER:** existing offline packs will show "Needs update" after V1 (B2 keeps
  them usable). V3 casing has a one-pixel minimum because the overview ribbon is ~3 px wide.
  V4 added a 0.2 s label placement throttle (none existed). V8 needs an owner decision.
- 2026-11-13, Phase U done (U1–U8), each checked at 1440×900 and 375×812. U1 chart is
  DPR-sharp with axes and a hover readout; U3 gives the 3D view 70% of a 375×812 screen
  (53% with More open); U4 adds an imperial/metric setting (`trekviewer.units`). Tests
  changed: `stage_t4_waypoint_ux` unaffected after a fix; `product_polish` legend now shows
  the real fast-band threshold (3.7+ mph, was a mislabelled 4.0+); `review_regressions`
  reads the chip label after the new marker dot. Waypoint label textures on the model
  (DioramaBase) pick up the unit setting on the next route load, not live.
- 2026-11-13, Phase W done in code (W1–W3) with unit tests; W1 browser-checked. The W2/W3
  visual run is outstanding (pane hidden, see the Phase W note). Speed resets to 1× on any
  view-mode change so tour/track multipliers never carry into the trail view.
- 2026-11-13, Phase O done for O1–O4 (all verify-first items confirmed). O1 retries each
  source 4× and revisits failures; O2 fixes the corridor wording; O3 skips re-reading saved
  sources on pack-file resume; O4 checks for app updates hourly when shown and blocks
  reloads during downloads. **OWNER O5** (transcode imagery to WebP/JPEG): the inventory
  script runs offline but gives tile counts only — 71,730 full-model and 27,091 corridor
  imagery tiles across the 8 routes (7.3 GB of decoded Float32 elevation); byte sizes need
  its network probe (`TREK_PACK_SAMPLE=1`), not run. README cites 5.5 GB (Rainier) and
  10.4 GB (Enchantments) for full packs. Note the script still uses the pre-V1 margin.
  **OWNER O6** (pack validity from inventory instead of GPX bytes): recorded, not started.

