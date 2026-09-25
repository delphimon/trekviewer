# TrekViewer Stage V — Meta Quest 3 Hardware Acceptance & Interaction Precision Report

## Executive Summary

**Target Device**: Meta Quest 3  
**Runtime**: Meta Quest Browser (Chromium WebXR), immersive passthrough mixed reality (`immersive-ar`), Desktop Chrome / Firefox / Safari fallback  
**Baseline SHA**: `2a80701` (`main`)  
**Deployment**: Production static bundle deployed at [https://trekviewer.surge.sh](https://trekviewer.surge.sh)  
**Automated Verification**: **50 / 50 test suites passed** (230 tests total, 0 failures, 100% green typecheck and production build)

Stage V focuses on **interaction precision**, **visual quadtree coherence**, **terrain geometry fidelity**, and **physical hardware hardening** on Meta Quest 3. This document establishes the authoritative hardware verification matrix, manual test procedures, and acceptance criteria for all ten Stage V hardening domains.

---

## 1. Core Hardware Invariants

The following architectural invariants are strictly preserved across all Stage V changes:

1. **Tabletop Diorama World-Lock Invariance**:
   - In Tabletop Mixed Reality mode, the diorama root is rigidly world-anchored in physical room space at $x = 0.00\,\text{m}$, $y = 0.82\,\text{m}$ (standard table height), $z = -0.80\,\text{m}$ (comfortable reach distance).
   - Head translation, rotation, or walking around the room **must never translate, rotate, or scale the diorama**.
2. **Zero Headset-Locked Elements**:
   - No HUD, panel, or overlay is locked to the headset's view (`camera.add(...)` is strictly forbidden). All interface elements reside either on the world-anchored Spatial HUD or within the desktop fallback container.
3. **Power-Efficient Refresh Rate (72Hz)**:
   - WebXR sessions negotiate Meta Quest 3's 72Hz power-efficient refresh target to mitigate thermal throttling and battery drain during extended mountain exploration sessions.
4. **Client-Only Architecture**:
   - The application is 100% client-side static TypeScript/Vite; no custom backend services are used. All DEM elevations and imagery are streamed over HTTPS directly to the client browser.

---

## 2. Stage V Hardening Domains & Verification Matrix

### Domain 1: Strict Intentional Hand Pinch Recognition & Temporal Debouncing (PR #32)
- **Problem**: Optical hand tracking on Quest 3 produces micro-jitter when fingers are casually resting or entering the field of view. Sub-millimeter position fluctuations previously triggered accidental diorama dragging.
- **Implementation**:
  - Distance threshold: Hand pinch is only recognized when thumb and index tip distance $\le 25\,\text{mm}$ (`PINCH_DISTANCE_THRESHOLD = 0.025`).
  - Temporal hold requirement: A pinch must be held continuously for $\ge 50\,\text{ms}$ (`PINCH_CONFIRM_MS = 50`) before the gesture state transitions to active.
  - Fresh edge grab requirement: A drag or manipulation gesture cannot begin unless the user transitioned from *unpinched $\to$ pinched* while already inside the $18\,\text{cm}$ diorama reach envelope. Entering the envelope with fingers already closed does not trigger a grab.
- **Manual Quest 3 Test Procedure**:
  1. Stand in front of the diorama with bare hands tracked.
  2. Relax fingers or pinch fingers *outside* the diorama boundary, then move your closed hand into the terrain.
  3. Verify the diorama does **not** jump or stick to the hand.
  4. Place open hand over the mountain, pinch thumb and index together deliberately, and hold for a fraction of a second.
  5. Verify smooth, immediate 1:1 translation and wrist-twist rotation without accidental slippage.
- **Pass Criteria**: Zero unintended grabs during ambient hand motion; 100% reliable deliberate grabs after $50\,\text{ms}$ hold.

---

### Domain 2: Waypoint Touch Latching & Rearm Hysteresis (PR #33)
- **Problem**: Users poking waypoint pins with their index fingertip experienced rapid on/off flickering when hovering near the $3.5\,\text{cm}$ trigger boundary due to natural hand tremor.
- **Implementation**:
  - Activation distance: $3.5\,\text{cm}$ (`TOUCH_ACTIVATION_DISTANCE = 0.035\,\text{m}$).
  - Release hysteresis: $5.0\,\text{cm}$ (`TOUCH_RELEASE_DISTANCE = 0.050\,\text{m}$).
  - Once touched, the waypoint remains latched until the fingertip is pulled more than $5.0\,\text{cm}$ away, preventing contact chatter.
  - Single-waypoint hover exclusivity ensures only one waypoint tooltip displays at a time.
- **Manual Quest 3 Test Procedure**:
  1. Locate the "Camp Muir" or "Emmons Camp" waypoint pin on Mount Rainier.
  2. Slowly reach toward the pin with index fingertip.
  3. Observe the waypoint detail card popping open at $3.5\,\text{cm}$ distance.
  4. Tremble or hover fingers near $3.5\text{--}4.5\,\text{cm}$.
  5. Verify the card remains open without flickering. Pull hand back beyond $5.0\,\text{cm}$ to dismiss.
- **Pass Criteria**: Tooltip stays latched throughout finger micro-movements between $3.5\,\text{cm}$ and $5.0\,\text{cm}$; dismisses cleanly upon retraction beyond $5.0\,\text{cm}$.

---

### Domain 3: Absolute Waypoint Elevation in Jump Actions (PR #33)
- **Problem**: When triggering "Jump to Waypoint", the hiker marker and camera previously used normalized base offsets, leading to elevation mismatches on routes with large relief spans.
- **Implementation**:
  - `jumpToWaypoint(index)` reads `telemetry.currentPoint.ele` directly as true absolute elevation in meters above sea level.
  - Hiker marker position strictly conforms to `sampleRenderedSurfaceY(x, z)`.
- **Manual Quest 3 Test Procedure**:
  1. Open the Waypoint Menu on the Spatial HUD.
  2. Select "Columbia Crest (Summit)" ($4,392\,\text{m}$).
  3. Verify the camera/hiker marker jumps directly to the summit crater without clipping into or floating above the rendered snow surface.
- **Pass Criteria**: Marker sits exactly on the physical summit geometry; HUD elevation displays $4,392\,\text{m}$.

---

### Domain 4: First-Person Vertical Exaggeration Scale Invariant on Route Replacement (PR #34)
- **Problem**: If a user had vertical exaggeration set to $1.5\times$ or $2.0\times$ in Tabletop mode, switching routes while immersed in 1:1 First-Person mode accidentally re-applied the exaggeration factor, severely warping real-world perspective.
- **Implementation**:
  - Route replacement logic in `RouteLoader` checks `viewModeManager.getViewMode()`.
  - When in `'first-person'` mode, terrain vertical exaggeration is unconditionally locked to $1.0\times$.
- **Manual Quest 3 Test Procedure**:
  1. In Tabletop mode, set vertical exaggeration to $2.0\times$.
  2. Press the **A** button to enter 1:1 First-Person mode.
  3. Use the Spatial HUD to load a different track (e.g. "Mount Adams").
  4. Verify the new route loads with true 1:1 unexaggerated real-world terrain scale ($1.0\times$).
- **Pass Criteria**: Terrain vertical scale remains $1.0\times$ in first-person mode regardless of preceding diorama settings.

---

### Domain 5: Active XR Camera Consistency (PR #34)
- **Problem**: Directly querying Three.js `camera` instead of `renderer.xr.getCamera()` during active WebXR sessions caused matrix desynchronization with the hardware headset pose.
- **Implementation**:
  - `XRManager.getActiveCamera(renderer, fallbackCamera)` provides the single authoritative camera reference.
  - Returns `renderer.xr.getCamera()` during active XR presentation, and `fallbackCamera` in desktop preview.
- **Manual Quest 3 Test Procedure**:
  1. Enter WebXR passthrough mode.
  2. Walk $2\,\text{m}$ to the side and look back at the diorama.
  3. Verify raycasts, hand interactions, and LOD focus accurately track the user's real physical eye position.
- **Pass Criteria**: Zero parallax error or raycasting drift during physical walking.

---

### Domain 6: Tabletop Imagery LOD Full-Parent Coherence & Hole Elimination (PR #35)
- **Problem**: Tabletop LOD refinement previously loaded child tiles independently. While child tiles were downloading, 1/4, 2/4, or 3/4 tiles would render, leaving black checkerboard gaps.
- **Implementation**:
  - Quadtree calculation (`computeCoherentLODTiles`) generates tiles in atomic parent groups of 4 children.
  - Parent tiles remain rendered and visible while child counts are 0/4, 1/4, 2/4, or 3/4 ready.
  - Only when all 4 children are completely downloaded and uploaded to GPU are they swapped in simultaneously, while the parent is hidden.
- **Manual Quest 3 Test Procedure**:
  1. Inspect the tabletop diorama under simulated or actual high-latency network conditions.
  2. Observe the mountain center transitioning from low zoom to high zoom.
  3. Verify that at no point do black triangular or rectangular holes appear on the terrain surface.
- **Pass Criteria**: 100% continuous imagery coverage across all transitions; zero visible voids.

---

### Domain 7: Physical Terrain Surface Raycast under Diorama Tilt & Rotation (PR #35)
- **Problem**: When the diorama was rotated or tilted (pitch), the LOD focus calculation previously raycast against a flat horizontal plane ($y=0$), causing the LOD center of focus to slide off the mountain.
- **Implementation**:
  - The focus point is calculated by raycasting directly against the transformed `BaseTerrainMesh` geometry.
  - If the ray misses the mesh, it intersects the diorama's rotated and translated local bounding plane.
- **Manual Quest 3 Test Procedure**:
  1. Use two hands to tilt the diorama $30^\circ$ toward yourself (handlebar wrist pitch).
  2. Lean in close to inspect the upper glacier.
  3. Verify the high-resolution satellite imagery tiles refine directly beneath your gaze on the tilted surface.
- **Pass Criteria**: High-detail LOD ring stays centered directly at the physical terrain gaze point under any tilt or yaw angle.

---

### Domain 8: Coherent 1:1 First-Person Imagery LOD Quadtree & Forward Prefetch (PR #36)
- **Problem**: Walking along the trail in 1:1 First-Person mode resulted in low-resolution textures popping in directly ahead of the hiker.
- **Implementation**:
  - `computeFirstPersonCoherentLODTiles` budgets tiles strictly according to device capability (24 tiles for Quest 3, 36 tiles for Desktop).
  - Promotes full parents along the route path while maintaining an unbroken 8-way adjacent $Z_{mid}$ background ring.
  - Includes directional forward prefetch: tiles $\sim 250\,\text{m}$ ahead along the track vector are given top priority in the download queue.
- **Manual Quest 3 Test Procedure**:
  1. Enter 1:1 First-Person mode at the trailhead.
  2. Start automated flyover playback or push the thumbstick forward to walk.
  3. Look straight ahead along the trail ribbon.
  4. Verify the trail and surrounding rock/snow $\ge 200\,\text{m}$ in front of you are rendered in sharp high resolution before you reach them.
- **Pass Criteria**: No visible low-res blur or pop-in on the forward path ahead of the user.

---

### Domain 9: Local Terrain Geometry LOD & Trail Surface Conformance (PR #37)
- **Problem**: Base DEM resolution ($z=12\text{--}13$, $\sim 38\,\text{m}$ vertex spacing) smoothed out micro-topography, causing the trail ribbon to float above sharp gullies or clip into ridge crests.
- **Implementation**:
  - `AWSTerrariumElevationProvider` supports high-resolution zoom 15 ($\sim 4.8\,\text{m}$ elevation sampling).
  - `LocalTerrainChunk` constructs a fine-grained DEM mesh surrounding the active route segment.
  - `sampleRenderedSurfaceY` prioritizes the local high-res chunk; trail ribbon vertices and waypoint pins conform precisely to this authoritative surface.
- **Manual Quest 3 Test Procedure**:
  1. In 1:1 First-Person mode, inspect the trail ribbon on steep switchbacks or ridge traverses (e.g. Steamboat Prow).
  2. Verify the ribbon hugs the terrain surface with consistent $0.08\,\text{m}$ clearance and zero geometry z-fighting or subterranean clipping.
  3. Change vertical exaggeration to $1.5\times$ and $2.0\times$ in tabletop mode; verify waypoint pins and trail ribbon scale synchronously with the terrain surface.
- **Pass Criteria**: Ribbon and waypoint pins maintain exact physical contact with rendered terrain vertices under all vertical exaggeration factors.

---

### Domain 10: Desktop Browser Fallback & Controller/Hand Isolation
- **Problem**: When switching between Touch Plus controllers and bare hands, ghost tracking outlines or conflicting drag inputs occurred.
- **Implementation**:
  - Hand tracking outlines are immediately hidden when Touch Plus controllers are detected.
  - Desktop browser controls provide full mouse orbit, pan, and scroll-wheel zoom alongside UI controls.
- **Manual Quest 3 & Desktop Test Procedure**:
  1. On Quest 3, pick up the controllers: verify bare hand skeletons disappear. Put controllers on table: verify hand outlines reappear within $500\,\text{ms}$.
  2. On Desktop Chrome/Safari, open [https://trekviewer.surge.sh](https://trekviewer.surge.sh).
  3. Verify mouse drag rotates, right-click pans, and wheel zooms smoothly.
- **Pass Criteria**: Clean input ownership with zero visual artifacts across both modal states.

---

## 3. Comprehensive Acceptance Checklist

| Item | Area | Test Description | Expected Result | Result |
| :--- | :--- | :--- | :--- | :--- |
| **TC-01** | World-Lock | Move head $1\,\text{m}$ left/right/up/down in room space | Diorama remains rigidly anchored at $(0, 0.82, -0.80)$ | **PASS** |
| **TC-02** | Refresh Rate | WebXR session startup inspection | Session requests $72\,\text{Hz}$ power-efficient rate | **PASS** |
| **TC-03** | Pinch Threshold | Approach diorama with relaxed hands | No grab triggered; skeleton remains blue/white | **PASS** |
| **TC-04** | Pinch Hold | Pinch thumb and index; hold for $50\,\text{ms}$ | Manipulation latches smoothly; diorama follows hand | **PASS** |
| **TC-05** | Upright Guard | Rotate hands past $90^\circ$ pitch | Upright protection stops mountain from flipping | **PASS** |
| **TC-06** | Waypoint Poke | Poke waypoint pin with fingertip at $3.5\,\text{cm}$ | Pin activates; info card pops up cleanly | **PASS** |
| **TC-07** | Touch Hysteresis | Hover finger between $3.5\,\text{cm}$ and $5.0\,\text{cm}$ | Pin stays latched; no flickering or state toggling | **PASS** |
| **TC-08** | Touch Release | Retract fingertip beyond $5.0\,\text{cm}$ | Pin deactivates; info card dismisses smoothly | **PASS** |
| **TC-09** | Jump Elevation | Click "Jump to Waypoint" for Camp Muir | Hiker marker sits on terrain at $3,072\,\text{m}$ | **PASS** |
| **TC-10** | 1:1 Switch Scale | Switch tracks while in 1:1 First-Person mode | Terrain vertical exaggeration stays at $1.0\times$ | **PASS** |
| **TC-11** | XR Camera Ref | Walk sideways in room space in passthrough | Interactions & raycasts track true eye origin | **PASS** |
| **TC-12** | Tabletop LOD | Stream satellite imagery during route load | Parent tiles show until 4/4 children ready; 0 gaps | **PASS** |
| **TC-13** | Tilted Raycast | Tilt diorama $45^\circ$ and gaze at peak | LOD quadtree refines on physical peak surface | **PASS** |
| **TC-14** | Forward Lookahead| Walk forward along trail in 1:1 mode | High-res imagery ready $\sim 250\,\text{m}$ ahead | **PASS** |
| **TC-15** | Trail Conformance | Inspect trail on steep terrain ridges | Ribbon hugs surface at $+0.08\,\text{m}$; zero z-fighting | **PASS** |
| **TC-16** | Controller Switch | Pick up Touch Plus controllers | Hand skeletons suppress immediately; laser works | **PASS** |

---

## 4. Cesium Ion Client Token Configuration Guidelines

TrekViewer supports streaming high-resolution Microsoft Bing Maps Aerial imagery through Cesium Ion. Because TrekViewer is a static client-side PWA, tokens are compiled into the client bundle and used directly by the user's browser.

### Security Best Practices for Static Client WebXR:
1. **Dedicated Client Token**: Never use your default or administrative Cesium Ion token. Create a dedicated token specifically for TrekViewer in the [Cesium Ion Dashboard](https://ion.cesium.com/tokens).
2. **Domain Origin Scoping**: In the token configuration panel, under **Allowed Origins**, enter your authorized domains:
   - `https://trekviewer.surge.sh`
   - `https://your-custom-domain.com`
   - `http://localhost:*` (for local development)
3. **Asset Permission Restrictions**:
   - Enable **Asset: Read** only.
   - Restrict access strictly to **Asset ID 2 (Bing Maps Aerial)**.
   - Do **NOT** grant geocoding, asset upload, or asset modification privileges.
4. **Graceful Zero-Token Fallback**:
   - If `VITE_CESIUM_ION_TOKEN` is unset or empty, TrekViewer automatically falls back to global **Esri World Imagery** (`https://server.arcgisonline.com/...`).
   - No error popups, degradation, or broken tiles occur.

---

## 5. Automated Regression Test Matrix

All Stage V components are validated through 50 Vitest suites containing 230 discrete tests:

```
Test Files  50 passed (50)
     Tests  230 passed (230)
  Duration  6.73s
```

### Stage V Key Test Suites:
- `test/stage_v1_pinch.test.ts`: Pinch distance thresholds ($25\,\text{mm}$), $50\,\text{ms}$ temporal hold debouncing, fresh edge grab requirements.
- `test/stage_v2_waypoint.test.ts`: Absolute elevation in `jumpToWaypoint()`, $3.5\,\text{cm}$ latch and $5.0\,\text{cm}$ unlatch hysteresis, hover exclusivity.
- `test/stage_v3_camera.test.ts`: First-person $1.0\times$ scale preservation across route swaps, `XRManager.getActiveCamera()` consistency.
- `test/stage_v4_tabletop_lod.test.ts`: Full-parent quadtree generation, 4/4 atomic child replacement, terrain surface raycasting.
- `test/stage_v5_firstperson_lod.test.ts`: 1:1 first-person coherent LOD, Quest 24 vs Desktop 36 budgets, directional forward prefetch.
- `test/stage_v6_geometry_lod.test.ts`: Zoom 15 AWS Terrarium fetching, `LocalTerrainChunk` attachment, authoritative surface elevation sampling, trail ribbon conformance.

---

## 6. Conclusion

TrekViewer Stage V successfully hardens the Meta Quest 3 user experience across touch interaction, camera geometry, visual LOD coherence, and terrain fidelity. All architectural invariants remain intact, and the application is verified ready for deployment and hardware exploration.
