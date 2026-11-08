# Review fix plan (started 2026-11-08)

Source: full code/UI/architecture review of 2026-11-08 (terrain, offline, XR, UI), checked
against current Meta Quest WebXR guidance (Mixed Reality Support in Browser, Hands UI best
practices, Locomotion comfort, WebXR framerate/FFR, WebXR PWAs).

**How to continue:** work top to bottom. Mark `[x]` when done and verified by
`npm run typecheck && npm test`. Add a one-line note under an item if it deviates from the
plan. Out of scope by owner decision: the Cesium ion token in the hosted bundle stays
(personal, unshared deployment).

Legend: `[ ]` todo · `[x]` done · `[~]` partially done (see note) · `[-]` dropped (see note)

## Phase A — Correctness bugs

- [x] A1 Imagery provider: single awaited init from saved setting (stored → env → auto);
      request sequencing so a late Bing init cannot win; dropdown reflects the provider
      actually active; remove legal claims ("Free Personal") from labels. (`main.ts:306`,
      `TextureProvider.ts:125-231`, `DesktopOverlay.ts`)
      Note: default remains public `auto`; Esri/Bing are explicit choices.
- [x] A2 Provider switch clears only that provider's imagery (not DEM tiles / in-flight DEM),
      and invalidates every texture style, not just the current one.
- [x] A3 Coverage: one CONUS/Swiss coverage definition used by fetch and attribution;
      CONUS check excludes Canada/Mexico; attribution matches what is fetched.
- [x] A4 Tile timeout negative-cache match (`'timeout'` vs `'Timeout loading tile'`);
      status must not say "Aerial view active." after composite failure.
- [x] A5 Terrain chunk seams: call `syncNeighborOuterEdges()` when chunk set changes.
- [x] A6 XR session end in 1:1 mode restores the desktop camera/root; saved tabletop transform
      cleared on route commit and session start/end; recenter viewer after route switch in XR 1:1.
- [x] A7 HUD poke hit-test uses SpatialHUD's real geometry (0.8 × 0.6 m), not duplicated
      constants; press requires a hover frame and front-face approach; pinches that started
      off the HUD never click; Exit is hold-to-confirm; `onPointerLeave` fires.
      Note: Exit uses tap-again-within-3 s (works for laser and poke) instead of a timed hold.
- [x] A8 Hand disconnect releases HUD scrub with cached handedness; controller/grip
      `updateMatrixWorld()` at start of XR update (one-frame lag).
- [x] A9 Waypoint touch never jumps progress without a deliberate pinch/poke; smaller hover radius.
      Note: hover 8→4 cm; poke = index tip only within 2.5 cm while not pinching.
- [x] A10 One-hand pinch translates only (wrist "twist" measured heading, not roll; rotation
      stays on two-hand steering). Note: controller grip still rotates (stable pose).
- [x] A11 Tour playback: duration independent of frame rate (no 0.1 s clamp for progress).

## Phase B — Offline

- [x] B1 Render-path decode failures never invalidate pinned packs (only temporary cache);
      timeouts/worker errors are not corruption.
- [x] B2 Plan id includes the inventory hash → stale packs show "Needs update", not "Ready".
      Deviation: the id is unchanged (would orphan the existing 5.5/10.4 GB packs). Instead the
      panel counts the current plan's sources missing from a ready pack (`OfflineStore.missingCount`)
      and shows "Needs update"; Download fetches only the gap; publish deletes leftover assets
      instead of aborting on a count mismatch. Resume also no longer re-hashes saved assets (H4).
- [x] B3 "Remove pack" asks for confirmation with size.
- [x] B4 Request persistent storage at first offline interaction; clear warning when denied.
- [x] B5 Service worker: "Reload to update" (SKIP_WAITING + controllerchange reload), disabled in XR;
      entry-recovery `trekRetry` requests bypass the SW cache.
- [x] B6 Geographic cache key includes non-bbox request parameters (no cross-format matches).
- [x] B7 Default coverage = trail corridor through Z18 (smaller packs); full Z19 stays optional.
      Note: Node pack tooling (`scripts/build-offline-route-pack.mjs`) still builds full-v2 only.
- [x] B8 Offline panel copy in plain language; Play pausing downloads is announced.

## Phase C — XR interaction & comfort (Meta guidance)

- [x] C1 Audio feedback for HUD presses, grabs and selections (hands have no haptics).
- [x] C2 A/X view-mode switch: hold-to-confirm with progress + fade through black.
- [x] C3 MR: request `plane-detection` + `anchors` (optional); place the diorama on the
      detected table plane when available; anchor it so recentering does not move it.
      Note: `src/xr/TablePlacement.ts`; searches 4 s after entry; does not call
      `initiateRoomCapture()` automatically. Needs headset validation.
- [x] C4 HUD: smaller default (≈0.6 m wide), docked at ≥1 m for ray use; summoned relative to head.
      Deviation: ~0.9 m wide at 1.05 m (buttons must stay ≥2.7° per Meta); 0.6 m needs a HUD
      layout redesign (see Deferred: quad layer / compact transport strip).
- [x] C5 1:1 locomotion: larger step (25 m), smoothed ground height.
- [x] C6 Tabletop thumbstick pan head-relative; dominant-axis lock on right stick.
- [x] C7 Follow during XR playback no longer slides the table toward the user.
      Note: Play no longer auto-enables follow in XR; the HUD Follow toggle still slides the table.
- [x] C8 PWA: launch straight into immersive mode when running as an installed PWA.

## Phase D — Desktop / mobile UI

- [x] D1 Split the single side panel: route card (stats + landmarks), Settings drawer,
      Offline section, controls help; horizon lock moves into Settings.
- [x] D2 Mobile: credit bar no longer covers the scrubber; status banner no longer overlaps the
      route selector; compact header.
- [x] D3 Minimum 12 px text; friendlier GPX error messages.
- [x] D4 Follow framing keeps the trail ahead visible.

## Phase E — Cleanup & architecture

- [~] E1 Delete legacy `LocalTerrainStreamer` path (`?terrainTiles=0`).
      Done: the URL flag is gone (tiled streamer always). Kept: `LocalTerrainStreamer` is also the
      fallback when no base mesh grid exists and is covered by 7 test files; delete with those.
- [~] E2 Delete BatchedMesh imagery path (`?imageryBatch=1`) and rename the default flag.
      Done: URL flag removed (batching always off). Kept: BatchedMesh branches inside
      `ImageryBatchRenderer` (interleaved with the shipped direct-surface path; remove with its tests).
- [~] E3 Delete single-region Enchantments DEM experiment (`regionalDem`, `regionalBase`,
      `public/dem`) and `terrainSourceBounds=compact`.
      Done: `terrainSourceBounds` flag removed. Kept: the regional DEM is still ON by default for
      the Enchantments default route; removing it changes terrain and needs a visual check.
- [ ] E4 Remove dead helpers in ImageryLODManager / TextureProvider / ElevationTiles.
      Not started (low value vs. risk without headset checks); candidates listed in the 2026-11-08 review.
- [x] E5 Extract profiler + debug telemetry out of `main.ts`.
      `src/core/ProfileSession.ts`, `src/core/DebugTelemetry.ts` (badge now uses textContent).
- [x] E6 Lazy-load offline + profiler code (main bundle size).
      Deviation: offline+profiler code is ~3% of the bundle; instead three.js is a separate vendor
      chunk (app chunk 1086 KB → 508 KB) with SRI on its modulepreload link.
- [x] E7 Remove committed evidence (`docs/review-*`, one-off probe/summary scripts); history keeps them.
      Fixtures used by tests moved to `test/fixtures/legacy/`.
- [x] E8 README rewritten for users; handoff doc corrected.
- [x] E9 Tests for: provider init/state, HUD hit-test geometry, offline invalidation policy.
      `test/review_fixes_2026_11.test.ts`. Known flaky under parallel load (pre-existing):
      `route_transaction` atomic swap, `terrain_raycast` boundaries — pass in isolation.

## Verification log

- 2026-11-08: `npm run verify` green (144 files / 871 tests, typecheck, build). Browser
  (production build, desktop + 375 px mobile): tabs, credits under the chart, provider dropdown
  matches the active provider and a saved Esri choice survives reload, mobile header/settings
  sheet. Not verified: anything on a Quest headset (table placement, anchors, HUD poke,
  hold-to-switch fade, audio cues, PWA auto-enter, offline pack update flow on device).

## Deferred (large, needs headset validation) — record decisions here

- Split `ImageryLODManager` / `XRManager` into smaller modules; replace static singletons
  with injected services; make `TrekSession` the single source of truth for view mode/progress.
- Offline packs transcoded to WebP/KTX2 and distributed as hosted prebuilt files.
- HUD as WebXR quad layer with static/dynamic texture split.
- Terrain-shader imagery: patches beyond texture-array capacity (352 tiles) or mid-fade render as
  flat 4-corner quads (ImageryLODManager `buildLightweightBoundsGeometry`); cap `maxPatches` to
  batch capacity or never draw those meshes.
- Memory/perf items from the terrain review (CPU copy of array pages, double uploads,
  main-thread decode, per-frame `syncRenderer` churn, IndexedDB `getAll` every 250 ms).
- Node pack tooling for corridor (v3) packs; per-asset `validated` flag already implied by
  trusting committed assets on resume.
- Optional: call `initiateRoomCapture()` (once) when no planes are found in passthrough.
