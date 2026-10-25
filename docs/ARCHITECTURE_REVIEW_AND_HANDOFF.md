# TrekViewer 3D — First-Principles Architecture Review, Implementation Record & Agent Handoff Guide

**Updated:** October 25, 2026 (`America/Los_Angeles`)

This document records the comprehensive first-principles code and architecture review of **TrekViewer 3D**, the 11-phase engineering implementation completed across the codebase, and the operational runbook for any developer or autonomous agent continuing work, verifying builds, or deploying the application.

---

## 1. Executive Summary of Completed Architectural Improvements (Phases 1–11)

All findings from the first-principles architecture review have been implemented and verified across 143 Vitest suites (853 tests) and TypeScript/Vite production builds:

### Phase 1 & Phase 7: Terrain Streaming, DEM Memory Lifecycle & Seam Blending
- **Fixed 256–512 MB DEM Raster Retention Leak ([`LocalTerrainChunk.ts`](../src/terrain/LocalTerrainChunk.ts))**: Added `summarizeElevationGrid(grid)` so `LocalTerrainChunk` strips multi-megabyte `Float32Array` (`data`) and `Uint8Array` (`tileValidity`) arrays from `this.currentGrid` immediately after sampling vertex heights while retaining all scalar metadata (`minElevation`, `maxElevation`, `width`, `height`, `isRealDEM`, `source`, `quality`).
- **Fixed `TiledTerrainStreamer.activeVisibleChunk` LRU Selection Bug ([`TiledTerrainStreamer.ts`](../src/terrain/TiledTerrainStreamer.ts))**: Updated `activeVisibleChunk` to return the focused tile (`this.focusTileId`) or the most recently prioritized visible chunk at the tail of `this.chunks` rather than the oldest eviction candidate at the head of the `Map`.
- **Dynamic Outer-Edge Blending & Parent Normals ([`LocalTerrainChunk.ts`](../src/terrain/LocalTerrainChunk.ts), [`TiledTerrainStreamer.ts`](../src/terrain/TiledTerrainStreamer.ts))**: Added `outerEdges: TerrainChunkEdgeFlags` support and `setOuterEdges(edges)` with retained `rawLocalHeights` so adjacent high-resolution DEM tiles only blend to the coarse parent mesh along outer perimeter boundaries, added `computeOuterEdgesForTile(id)` and `syncNeighborOuterEdges()` on `TiledTerrainStreamer`, and recompute parent edge normals after `updateElevationGrid`, `setVerticalExaggeration`, and `setOuterEdges`.

### Phase 2 & Phase 7: Imagery LOD, GPU Array-Texture Memory & Shader Fixes
- **Restored Terrain Shadow Receiving & Removed 4 cm Vertex Shift ([`TerrainImageryMaterial.ts`](../src/terrain/TerrainImageryMaterial.ts))**: Removed `.replaceAll('&& receiveShadow', '&& receiveShadow && !terrainTilePresent')` so directional sunlight shadows remain visible on high-res imagery tiles, and removed the unconditional `transformed.y += 0.04` vertex displacement.
- **Eliminated Unused `THREE.BatchedMesh` Allocations in Direct-Surface Mode ([`ImageryBatchRenderer.ts`](../src/terrain/ImageryBatchRenderer.ts))**: Skipped `new THREE.BatchedMesh(...)` creation when `this.directSurface === true` (saving ~33 MB of GPU vertex/index buffers per page) and enabled cross-zoom tile packing on shared `directSurface` texture-array pages.
- **Worker Clipping Bypass & Raycaster Pooling ([`ImageryLODManager.ts`](../src/terrain/ImageryLODManager.ts), [`TerrainRaycast.ts`](../src/terrain/TerrainRaycast.ts))**:
  - When `this.terrainImagery` is active (`?terrainImagery=1`, default), `ImageryLODManager.drainQueue` bypasses worker triangle-clipping (`prepareStreamedPatch`) and builds a lightweight 4-corner terrain-sampled bounding box geometry (`buildLightweightBoundsGeometry`).
  - Pooled `THREE.Raycaster` instances across `getTerrainViewRays` (`detailRayPool` and `firstPersonRayPool`) and cached inverse world matrices per `THREE.Mesh` in a `WeakMap` inside `TerrainRaycast.ts`.
  - Removed unreachable `quest-high` dead code in `evaluateFirstPersonLOD`.

### Phase 3 & Phase 10: Offline Storage Performance, JPEG Validation & Corridor Planning
- **Eliminated Per-Tile SHA-256 Re-Hashing on Read ([`OfflineStore.ts`](../src/offline/OfflineStore.ts))**: Removed `await hashOfflineBlob(asset.blob)` from the hot `OfflineStore.read(url)` path while preserving cryptographic SHA-256 verification during download, resume, and archive import, alongside URL allowlist, byte-length, and digest-format checks on read.
- **Batched Offline Progress Notifications & JPEG Header Validation ([`OfflineDownloads.ts`](../src/offline/OfflineDownloads.ts))**: Coalesced `OfflineStore.save` event notifications during bulk pack preparation (every 16 resources or 250 ms) and added JPEG SOI (`0xFFD8FF`) validation alongside PNG (`0x89504E47`) in `validateOfflineResource`.
- **Corridor-Buffered v3 Offline Route Planning & UI Selector ([`OfflinePlan.ts`](../src/offline/OfflinePlan.ts), [`OfflineDownloadsPanel.ts`](../src/offline/OfflineDownloadsPanel.ts), [`OfflineStore.ts`](../src/offline/OfflineStore.ts))**: Added `OfflinePlanOptions` (`mode: 'full-v2' | 'corridor-v3'`, `corridorMeters`, `maxImageryZoom: 18 | 19`) to `planOfflineRoute`, exposed a `[data-offline-mode]` Coverage selector (`Full terrain (through Z19)` vs `Trail corridor (through Z18)`) in `OfflineDownloadsPanel`, and added automatic `v2` vs `v3` plan resolution from `index.manifest.planId` when importing `.tar` route archives.

### Phase 4 & Phase 8: Playback Physics, Geodesy, GPX Sanitization & 3D Visualization
- **Fixed Stationary-Point Freeze in 1:1 First-Person Mode ([`FlyoverController.ts`](../src/visualization/FlyoverController.ts))**: Prevented `this.progress = Math.min(this.progress, maxProgress)` from resetting `this.playbackTime` backward when consecutive GPS points have zero horizontal distance (`dd = 0`), and replaced per-frame `new THREE.Vector3()` allocations with reusable scratch vectors.
- **Multi-Span GPU Buffer Uploads & Bounding Box Shrink ([`SurfaceVertexIndex.ts`](../src/visualization/SurfaceVertexIndex.ts))**: Recomputed `boundingBox.min.y` and `max.y` when all vertices change (fixing stale enlarged culling bounds when lowering vertical exaggeration) and upgraded `markChangedSpan` to emit up to 4 disjoint `updateRanges` when changed vertices are separated by `> 64` vertices (e.g., loop routes touching start and finish).
- **Mid-Route Summit Beacon & Lazy First-Person Normals ([`TrailMesh.ts`](../src/visualization/TrailMesh.ts))**: Added a dedicated `SUMMIT` pin at the true peak elevation when the route finish is not the summit, and deferred `firstPersonGeo` normal recomputation during `'diorama'` surface streaming until the user switches to `'first-person'` mode.
- **Off-Route Connector Lines, Exact Waypoint Matching & Scale Bar Label ([`DioramaBase.ts`](../src/visualization/DioramaBase.ts))**: Updated `WaypointConnectorLine` vertical endpoints during `setVerticalExaggeration` and `reprojectWaypoints`, prioritized exact case-insensitive waypoint name matches over substring matches in `selectWaypointByName`, and attached scale metadata (`scaleMeters`, `label`) and a 3D label sprite to `ScaleBar`.
- **GPX Sanitization & Extremum Hysteresis ([`GPXXMLReader.ts`](../src/gpx/GPXXMLReader.ts), [`GPXParser.ts`](../src/gpx/GPXParser.ts), [`GPXValidator.ts`](../src/gpx/GPXValidator.ts), [`ElevationStats.ts`](../src/gpx/ElevationStats.ts))**: Prevented `<wpt><name>` from overwriting `<trk><name>`, guarded `<wpt><ele>` against `NaN`, clamped non-monotonic timestamps, replaced isolated corrupted startup coordinates (`index 0` > 50 km jump), and added `trackExtrema?: boolean` to `calculateElevationStats`.

### Phase 5 & Phase 9: UI Security, Spatial HUD Mipmaps/Reuse & Session State
- **DOM Security & Listener Cleanup ([`DesktopOverlay.ts`](../src/ui/DesktopOverlay.ts), [`style.css`](../src/style.css))**: Replaced `innerHTML` interpolation of GPX warnings with `textContent` and safe DOM nodes, cleaned up `window` `dragover`/`drop` listeners in `dispose()`, added structured `state` and `progress` parameters to `showStatus`, and scoped `user-select: none` to interactive controls.
- **Spatial HUD Mipmaps, Route Reuse & Chart Landmark Clicks ([`SpatialHUD.ts`](../src/ui/SpatialHUD.ts), [`main.ts`](../src/main.ts))**: Enabled trilinear mipmaps (`THREE.LinearMipmapLinearFilter`, `generateMipmaps = true`) on the VR `SpatialHUD` texture, reused a single `SpatialHUD` instance across route switches via `setTrack()`, unified chart hover/click/drag Y-bounds (`190..395`), and added click hit-testing for landmark pins on the VR elevation chart.
- **Centralized `horizonLocked` Session State ([`TrekSession.ts`](../src/core/TrekSession.ts))**: Added `horizonLocked: boolean` and `setHorizonLocked(locked)` to `TrekSession`.

### Phase 6: Portable Verification Scripts & Test Hygiene
- **Cross-Platform Playwright Launcher ([`scripts/playwright-launch.mjs`](../scripts/playwright-launch.mjs))**: Replaced hardcoded Windows `C:/Users/andre/...` and `msedge.exe` paths across all 11 browser verification scripts in `scripts/` with a shared cross-platform launcher supporting macOS, Linux, and Windows (`PLAYWRIGHT_EXECUTABLE_PATH`, `PLAYWRIGHT_CHANNEL`, or bundled Chromium).
- **Real `DesktopOverlay` Unit Testing ([`test/desktop_status_banner.test.ts`](../test/desktop_status_banner.test.ts))**: Removed `test/scratch_calc.ts` and rewrote `test/desktop_status_banner.test.ts` to test the real `DesktopOverlay` class.

---

## 2. How to Build, Test, Verify, and Use TrekViewer

### Local Development & Verification Commands
```bash
# 1. Install dependencies cleanly
npm ci

# 2. Start local HTTPS development server (default https://localhost:5173)
npm run dev

# 3. Run full verification gate (TypeScript typechecks + Vitest suite + production Vite build)
npm run verify

# Individual steps in `npm run verify`:
npm run typecheck   # Runs `tsc --noEmit && tsc -p tsconfig.test.json --noEmit`
npm test            # Runs `vitest run --maxWorkers=2` (143 test files, 853 tests)
npm run build       # Writes build-info.json, runs tsc, and builds dist/
```

### Browser Verification Scripts
All browser verification scripts in `scripts/` use [`scripts/playwright-launch.mjs`](../scripts/playwright-launch.mjs) and work out-of-the-box on macOS, Linux, and Windows:
```bash
# Override browser executable or channel if desired (optional):
export PLAYWRIGHT_CHANNEL=chrome
# or: export PLAYWRIGHT_EXECUTABLE_PATH="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"

# Run browser verification checks against a local preview server (`npm run preview`):
node scripts/verify-diorama-tour.mjs
node scripts/verify-landmark-navigation.mjs
```

### URL Query Flags for Diagnostics & Controlled Comparisons
- `?debug=1`: Displays the real-time diagnostic overlay and `#buildBadge` (frame pacing, CPU submission p95, active imagery/DEM provider, LOD patch counts by zoom, cache stats) and exposes `window.__trekViewerApp`.
- `?profile=1`: Enables the bounded 1-second Quest/desktop performance profiler and **Download JSON** report button.
- `?terrainImagery=0`: Disables direct terrain shader imagery draping and falls back to overlay patch meshes for A/B comparison.
- `?imageryBatch=1`: Enables experimental `THREE.BatchedMesh` clipped-patch batching.
- `?markerBatch=0`: Disables `WaypointInstanceRenderer` instanced waypoint markers.
- `?terrainTiles=0`: Uses legacy single-chunk `LocalTerrainStreamer` instead of `TiledTerrainStreamer`.
- `?terrainGrid=60|75|120`: Overrides base terrain mesh cell spacing in meters.

### Deployment to Production (`trekviewer.surge.sh`)
```bash
# 1. Ensure git working tree is clean and committed so dist/build-info.json records a clean SHA
git status

# 2. Run full verification and production build
npm run verify

# 3. Push commit to GitHub origin
git push origin main

# 4. Deploy dist/ to Surge static hosting (https://trekviewer.surge.sh)
npm run deploy:surge
```

---

## 3. Where Another Agent Should Pick Up Next

1. **Codebase & Automated Gates**: 100% of the code, architecture, memory, security, and test recommendations from the October 25, 2026 review are complete and verified in [`test/architecture_review_fixes.test.ts`](../test/architecture_review_fixes.test.ts).
2. **Remaining Hardware-Only Acceptance Items (Tracked in [`docs/COMPLETION_PLAN.md`](./COMPLETION_PLAN.md))**:
   - **Connected Meta Quest 3 Headset Acceptance**: Native 72 Hz frame delivery, time-to-sharp visual acceptance in passthrough MR and VR, and 15-minute thermal stability runs require a physical Meta Quest 3 connected via USB/WebXR with an active browser session.
   - **Signed Sideloadable APK Verification**: `npm run package:apk` is implemented and tested at the script level, but building a production-signed APK with user keystores and verifying installed offline launch on a physical Quest headset remains an on-device task.
