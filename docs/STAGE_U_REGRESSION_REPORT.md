# TrekViewer Stage U — Comprehensive Engineering Regression Report

**Date**: September 2026  
**Target Hardware**: Meta Quest 3 Passthrough Mixed Reality (WebXR)  
**Baseline Commit**: `2757b2e7ccdcc9220db440f1434cb94717fc1900`  
**Stage U Merge HEAD**: Commit `c5e0c8c` (PRs #26, #27, #28, #29, #30)  
**CI / Test Status**: 44 Test Files, 204 Unit Tests (100% Green), TypeScript Typecheck Clean, Vite Production Build Clean  

---

## 1. Executive Summary

TrekViewer Stage U directly resolves rendering, geometry, tracking, and imagery defects observed on physical Meta Quest 3 hardware in stereo passthrough Mixed Reality. Rather than relying on hypothetical cleanups or fragile rewrites, Stage U was executed across six focused sub-stages with strict preservation of the room-space diorama anchoring invariant ($y = 0.82\text{m}, z = -0.80\text{m}$), zero headset-locking, and zero diorama recentering during user head turns.

### Key Architectural Invariants Enforced:
1. **Diorama Room-Space Anchoring**: The tabletop diorama remains rigidly world-locked at standard table height in room coordinates ($y=0.82\text{m}$, $z=-0.80\text{m}$). Head rotation and translation never move or recenter the diorama.
2. **Authoritative Direction & Forward Convention**: Standardized mathematical forward convention where $0\text{ rad} = -Z$ (North $= -Z$, East $= +X$, South $= +Z$, West $= -X$). Hiker heading arrow and 1:1 first-person room walk align strictly with real-world cardinal headings.
3. **Unified Rendered Terrain Surface**: Eliminates vertical gap and half-burial defects between trail ribbons, LOD imagery patches, and elevation meshes by sampling the exact barycentric coordinates of rendered base mesh triangles via `sampleRenderedSurfaceY()`.
4. **Canonical Waypoint Projection & Interaction**: Snaps waypoints within a 75m threshold directly to visual route stations (`projectGeoPointToVisualRoute`), guaranteeing zero horizontal offset for route-coincident waypoints (e.g. Camp 3 at $0.000\text{m}$ delta). Markers maintain ~2.5 cm world diameter across all diorama scales with intuitive fingertip touch ($\le 3.5\text{cm}$) and laser selection ($5.0\text{cm}$ hit radius).
5. **Coherent Imagery LOD**: Dynamic patch subdivision ($4 \times 4$ for $z \ge 18$, $6 \times 6$ for $z \ge 16$, $8 \times 8$ for $z < 16$), 500ms promotion dwell time, nested contiguous $3 \times 3$ center and outer perimeter rings, and atomic parent/child replacement eliminating checkerboard gaps and GPU thrashing.
6. **Provider Transparency & Truthful Sources**: Explicit awaited initialization (`TextureProvider.initializeFromEnvironment()`), removal of asynchronous races, elimination of per-tile cross-provider fallback, honest cache keys (`cesium-bing:z:x:y`), and transparent UI reporting of active providers and fallback statuses.

---

## 2. Corrected Physical & Route Measurements

Documentation previously contained conflicting or legacy figures regarding physical dimensions, route distances, and interaction envelopes. Stage U establishes the following verified authoritative measurements:

| Metric | Correct Measurement | Corrected Legacy Value | Source / Implementation |
| :--- | :--- | :--- | :--- |
| **Mount Rainier Emmons Route Length** | **24.3 km** (round trip) | *12.8 km* or *13.4 km* (one-way) | `GPXParser`, `public/routes/MountRainierViaEmmons.gpx` |
| **Mount Rainier Elevation Gain** | **3,097 m** | *2,740 m* | `GPXParser` elevation sum |
| **Tabletop Maximum Dimension** | **1.0 m** max width (target **0.85 m**) | *0.9 m* or *1.2 m* | `SceneManager.ts` (`targetTableSize = 0.85`) |
| **Hand Gesture Reach Envelope** | **18 cm** around diorama/pedestal | *12 cm* or *25 cm* | `XRManager.ts` (`distWorld <= 0.18`) |
| **Waypoint World Marker Diameter** | **~2.5 cm** world diameter | *2.2 cm* or unscaled | `DioramaBase.ts` (`DESIRED_MARKER_DIAMETER_WORLD = 0.025`) |
| **Waypoint Touch Radius** | **~3.5 cm** fingertip touch radius | *2.0 cm* or laser-only | `XRManager.ts` (`TOUCH_RADIUS = 0.035`) |
| **Waypoint Laser Hit Radius** | **5.0 cm** world radius (10 cm diam) | *24 m* (unscaled world error) | `DioramaBase.ts` (`DESIRED_LASER_HIT_RADIUS_WORLD = 0.05`) |
| **LOD Patch Mesh Subdivisions** | Dynamic **4x4 to 8x8** by zoom | *Static 8x8* | `ImageryLODManager.ts` (`getPatchSubdivisionSegments`) |

---

## 3. Sub-Stage Verification Breakdown

### Stage U1: Direction Fidelity & Authoritative Heading Model (PR #26, Commit `a9bd721`)
- **Forward Convention**: Established canonical coordinate convention where heading $0 = -Z$ (North), $\pi/2 = +X$ (East), $\pi = +Z$ (South), and $3\pi/2 = -X$ (West).
- **Three.js Yaw Rotation**: Correctly maps world azimuth $\theta$ to Three.js rotation angle $\text{rotY} = -\theta$.
- **Hiker Arrow Indicator**: Renders as a 3D forward-pointing arrow tangent to the route centerline, accurately reflecting the hiker's instantaneous direction of travel.
- **1:1 First-Person Room Walk**: Aligns room-space forward vector with the trail bearing at the user's progress point. Walking forward in physical room space moves forward along the trail.
- **Distance-Indexed Visual Stations**: Trail stations indexed by cumulative travel distance rather than raw GPS vertex indices for consistent flyover speeds and station interpolation.

### Stage U2: Unified Rendered Terrain Surface (PR #27, Commit `12d0de2`)
- **Barycentric Surface Sampling**: Implemented `sampleRenderedSurfaceY(x, z)` directly on the base terrain mesh, calculating the exact elevation of the triangle plane containing $(x, z)$.
- **Dual-Edge Ribbon Sampling**: Trail ribbons sample both left and right edge vertices directly from `sampleRenderedSurfaceY()`, eliminating half-buried ribbon edges on steep lateral slopes.
- **Aspect-Aware Base Terrain**: Replaced square-forced terrain generation with an aspect-aware bounding dimension that matches the real-world route ratio without distortion.
- **Patch Surface Conformance**: Imagery LOD patches conform exactly to the base elevation surface, eliminating z-fighting and seam gaps.

### Stage U3: Canonical Waypoint Projection & Interaction (PR #28, Commit `7bc02fe`)
- **Visual Route Snapping**: `projectGeoPointToVisualRoute()` projects waypoints onto the rendered trail centerline if within a 75m threshold, eliminating horizontal delta for on-route camps (e.g. Camp 3 horizontal delta $= 0.000\text{m}$).
- **World-Scale Compensation**: Waypoint diamond markers scale dynamically with diorama scale to maintain a consistent ~2.5 cm world diameter.
- **Fingertip Touch & Pinch**: Direct fingertip touch at $\le 3.5\text{cm}$ or pinch gesture within hover range triggers waypoint selection and camera jump.
- **Readable Angular Labels**: Waypoint billboard labels maintain fixed angular visual size (~10° FOV) with active selection highlighting and hover halos.

### Stage U4: Coherent Imagery LOD Lifecycle (PR #29, Commit `93e29f0`)
- **Requested / Ready / Visible State Separation**: Clear distinction between tiles requested from the network, tiles decoded in GPU memory, and patches mounted in the scene graph.
- **Dynamic Subdivision**: High zoom patches ($z \ge 18$) use $4 \times 4$ segments, mid zoom ($z \ge 16$) use $6 \times 6$, and lower zoom use $8 \times 8$, reducing vertex overhead by over 50% in dense areas.
- **Nested Ring Refinement**: Center $3 \times 3$ area refines to $Z_{high}$, outer perimeter ring refines to $Z_{mid}$, or coherently shrinks to $2 \times 2$ / lowers to $Z_{mid}$ if tiles are missing, completely eliminating arbitrary checkerboard holes.
- **Atomic Parent/Child Replacement**: Parent patch remains visible until all 4 children are ready. Crossfade transitions render with `depthWrite: false` during fade, flipping to `true` when opaque.
- **Promotion Dwell Time**: 500ms dwell filter prevents LOD oscillation during rapid camera movement unless scale changes by $>15\%$ or position shifts by $>10\text{cm}$.
- **Coverage Diagnostics**: Telemetry and `#buildBadge` track `visibleByZoom`, `desiredZoom`, `readyHighResCount`, and in-flight requests.

### Stage U5: Provider Diagnostics & Truthful Sources (PR #30, Commit `c5e0c8c`)
- **Explicit Awaited Initialization**: Eliminated spontaneous unawaited `static {}` initialization in `TextureProvider`. Introduced `initializeFromEnvironment()` and `waitForInitialization()`, awaited on DOM load and before route generation.
- **Truthful Cache Keys**: Removed silent Esri fallback URL from `CesiumBingImageryProvider.getTileUrls()`. Cache keys `cesium-bing:z:x:y` never contain Esri pixels.
- **Provider State API**: `TextureProvider.getProviderInitState()` exposes `requestedProvider`, `activeProvider`, `initialized`, `fallbackReason`, `displayName`, `maxZoom`, and `attribution`.
- **UI Source Transparency**: Desktop and Spatial HUD display honest imagery attribution (e.g. `Bing Aerial via Cesium • up to Z19` or `Esri World Imagery • up to Z19 (fallback: Cesium unavailable)`).
- **Failure Instrumentation**: `TileImageCache` tracks `failureCount` surfaced in telemetry and on-screen diagnostics.
- **Sample Configuration**: Added `.env.example` documenting `VITE_SATELLITE_PROVIDER` and `VITE_CESIUM_ION_TOKEN`.

---

## 4. Test Suite & Quality Verification Matrix

All 44 automated test suites in `test/` pass with zero failures:

```
 Test Files  44 passed (44)
      Tests  204 passed (204)
   Start at  15:06:56
   Duration  6.27s
```

### Verified Test Suites:
1. `test/stage_u1_direction.test.ts`: Canonical forward convention ($0 = -Z$), hiker arrow heading, 1:1 room alignment, distance-indexed visual stations.
2. `test/stage_u2_terrain.test.ts`: Unified rendered surface sampling, dual-edge ribbon conform, aspect-aware terrain mesh.
3. `test/stage_u3_waypoint.test.ts`: Canonical waypoint projection, Camp 3 coincidence ($0.000\text{m}$ delta), ~2.5 cm world marker geometry, fingertip touch/pinch interaction.
4. `test/stage_u4_lod.test.ts`: Coherent imagery LOD, dynamic subdivision ($4 \times 4$ to $8 \times 8$), nested ring refinement, atomic parent/child swap, depthWrite safety, promotion dwell time.
5. `test/stage_u5_provider.test.ts`: Delayed metadata initialization gate, provider failure global fallback without mixed layers, truthful cache keys, UI attribution.
6. `test/hand_gestures.test.ts`: Bare hand pinch, 6DOF manipulation, tabletop height invariance, 18 cm touch proximity envelope.
7. `test/route_transaction.test.ts`: Atomic route swapping, error rollback, disposal safety.
8. `test/stage_s3_polish.test.ts`: Diorama world-lock invariance across all view modes and camera movements.
9. `test/terrain_cache_robustness.test.ts`: TileImageCache limits, Quest vs. Desktop memory budgets, anisotropic filtering bounds.
10. `test/scale_and_heading.test.ts`: Scale adaptation, ribbon widths, topo tile URLs.

---

## 5. Deployment & Release Invariants
- **Zero-Server Static PWA**: TrekViewer builds into a standalone static client bundle (`dist/`) suitable for instant deployment on HTTPS static hosts (Vercel, Cloudflare Pages, GitHub Pages, Surge) and direct installation into the Meta Quest App Library.
- **Power Efficiency**: WebXR session automatically requests Meta Quest 3 72Hz power-efficient refresh rate to minimize thermal throttling and extend battery life during alpine route exploration.
