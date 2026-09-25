# TrekViewer Stage W — Quality-First Persistent LOD Report

## Executive Summary

**Target Platform**: Meta Quest 3 (primarily WebXR passthrough mixed reality `immersive-ar`), Desktop Chrome / Firefox / Safari fallback  
**Reviewed Base SHA**: `5bf764a6abcfa0a61671d77e55d562cca168fef1`  
**Current HEAD**: Stage W complete (all sub-stages W1–W7 merged)  
**Deployment**: Production static bundle deployed at [https://trekviewer.surge.sh](https://trekviewer.surge.sh)  
**Automated Verification**: **57 / 57 test suites passed** (265 tests total, 0 failures, 100% green typecheck and production build)

Stage W directly addresses the primary visual limitation identified on Meta Quest 3: overly conservative patch budgets and aggressive eviction timers caused the renderer to fall back to coarse imagery and base terrain geometry too frequently. Stage W intentionally biases Quest 3 toward **higher visual fidelity**, a **larger high-resolution working set**, **earlier forward prefetching**, and **memory-pressure-driven warm retention** while strictly preserving all Stage U/V invariants (coherent quadtree atomic promotion, world-locked tabletop MR, rendered-surface conformance, and zero headset-locked HUDs).

---

## 1. Core Invariants Preserved

Across all changes in Stage W, the following architectural invariants are strictly preserved:

1. **Tabletop Diorama World-Lock Invariance**:
   - In Tabletop Mixed Reality mode, `dioramaRoot` is rigidly world-anchored in physical room space at $(0.00, 0.82, -0.80)\,\text{m}$ (standard tabletop height and comfortable reach distance). Head movements never translate, rotate, or scale the mountain.
2. **Zero Headset-Locked Elements**:
   - Zero HUD, panel, or overlay is attached to the camera (`camera.add(...)` is strictly forbidden). All interface elements reside on the world-anchored Spatial HUD or desktop fallback overlay.
3. **Atomic Quadtree Promotion (Coherent Tile Replacement)**:
   - High-resolution tiles are grouped strictly into atomic 2x2 parent quadtrees ($4$ child patches). A parent is never promoted or made visible until all 4 children are decoded and ready in GPU memory. Partial-parent holes ($1/4$, $2/4$, $3/4$) are strictly prevented.
4. **Authoritative Rendered Surface Conformance**:
   - Trail ribbon left and right vertices, hiker avatar, and waypoint pedestals strictly hug the authoritative `sampleRenderedSurfaceY` elevation, accounting for local high-resolution DEM chunks and vertical exaggeration.
5. **Static Client-Only Architecture**:
   - Pure client-side static TypeScript/Vite application. No custom server or backend services.

---

## 2. Stage W Sub-Stage Breakdown & Implementation

### Sub-Stage W1: Centralized Quality Profiles & Scaled Decoded Image Cache (PR #39)
- **Centralized Quality Profiles (`src/terrain/QualityProfile.ts`)**:
  - Replaced ad-hoc parameters with explicit device profiles: `quest-high` (default Quest 3), `quest-low` (fallback), `desktop-high` (desktop default), and `desktop-low`.
  - Scaled Quest patch budgets: Tabletop expanded from 24 $\to$ **48 patches**; 1:1 first-person expanded from 24 $\to$ **64 patches** (Desktop: 80 tabletop / 96 first-person).
  - Scaled concurrency: 6 concurrent tile requests on Quest (8 on Desktop).
- **Scaled Decoded Tile Image Cache (`src/terrain/TileImageCache.ts`)**:
  - Expanded in-memory decoded image cache to **240 entries / 64MB** on Quest 3 (scalable to 320 entries / 80MB) and **360 entries / 96MB** on Desktop.
  - Implemented LRU eviction with byte accounting, preventing GC churn and re-fetch stutter when looking back and forth along a trail.

### Sub-Stage W2: Asymmetric Zoom Hysteresis, Dwell Timing & Priority Scheduler (PR #40)
- **Asymmetric Zoom Hysteresis**:
  - Promotion bias $+0.40$ (e.g. promoting to z19 when calculated desired zoom is $\ge 18.60$).
  - Demotion threshold $-0.85$ (demoting only when camera recedes beyond $17.15$). This broad hysteresis gap eliminates LOD thrashing during subtle head motion.
- **Asymmetric Temporal Dwell Timing**:
  - Fast promotion dwell: **200ms** continuous high-res demand before triggering promotion.
  - Conservative demotion dwell: **3000ms** continuous low-res demand before allowing demotion to coarse tiles.
- **Tier 0 Sibling Completion Scheduling**:
  - Priority scheduler assigns Tier 0 priority to tile requests that complete a $3/4$ child group, unblocking atomic promotion ahead of distant speculative tiles.
  - Selective request cancellation preserves in-flight requests that belong to pending child groups.

### Sub-Stage W3: Tabletop 2x2 Parent Quadtree Expansion & Pointer/Gaze Extension (PR #41)
- **2x2 Parent Tabletop Refinement**:
  - Upgraded tabletop central refinement from a single parent (4 z19 children) to a $2\times 2$ parent block (16 z19 children + surrounding z18 perimeter ring = 28–32 patches $\le 48$).
- **Dynamic Pointer / Laser Interaction Extension**:
  - Gaze and laser pointer ray (`XRManager.getActivePointerRay()`) project onto the diorama surface.
  - Tabletop refinement dynamically extends up to 6 parent tiles (24 z19 children + perimeter = 38 patches) along the user's pointed ray. Desktop extends up to 12 parent tiles (48 children).

### Sub-Stage W4: 1:1 Quality Corridor, Extended Forward Prefetch & Latitude-Aware Sizing (PR #42)
- **Extended Forward Prefetch & Retention Corridor**:
  - Forward prefetch corridor extended to **500–750m ahead** along the trail route; retention behind extended to **200–400m behind**.
- **Latitude-Aware Web Mercator Tile Sizing**:
  - Replaced equatorial metric assumptions with `metersPerPixelAtZoom(lat, zoom) * 256` to determine exact ground footprints across high latitudes (e.g. Mount Rainier at $46.85^\circ\text{N}$, Tromsø at $69^\circ\text{N}$).
- **Contiguous Corridor Generation & Lateral Wings**:
  - Formed unbroken contiguous corridors with lateral wing parent tiles on the Quest 64-patch budget.
  - Reduced hiker movement re-evaluation threshold to **15m** (down from 50m).

### Sub-Stage W5: Three-Tier Retention & Distance/Importance-Based Warm Eviction (PR #43)
- **Multi-Factor Importance Scoring (`calculatePatchImportanceScore`)**:
  - Tier 1 Active status bonus ($+10,000$ pts) and pending-children protection ($+5,000$ pts).
  - Tier 2 Recency decay over `warmRetentionMs` window ($+0\dots 2,000$ pts).
  - Spatial proximity & route corridor envelope bonus ($+3,000$ pts for tiles within prefetch/retain distance, $+0\dots 2,000$ pts distance-based).
  - Tabletop mode focus proximity ($+0\dots 3,000$ pts based on distance to diorama center).
- **Memory-Pressure-Driven Eviction (`prunePatches`)**:
  - Retains warm non-active resident patches in GPU memory until total patch count exceeds `maxPatches`.
  - Memory pressure, rather than arbitrary timers, drives eviction. Lowest importance score tiles are evicted first.

### Sub-Stage W6: Local High-Resolution Terrain (1000–1500m) & Seamless Multi-Chunk Streaming (PR #44)
- **Expanded Local Terrain Footprint**:
  - Expanded `LocalTerrainChunk` radius from 750m to **1250m** (`QualityProfile.localTerrainRadiusM` for Quest), supporting 1000–1500m high-resolution DEM meshes.
  - Added 3D spatial offsetting via `referenceCenterLat/Lon` to position fine-grained DEM meshes anywhere along the route in local diorama coordinates.
- **C1 Hermite Smoothstep Boundary Blending**:
  - Implemented smooth edge blending across the outer 15% margin to base terrain elevation:
    $$\alpha = \mathrm{smoothstep}(0.85, 1.0, r / R)$$
    $$h = (1 - \alpha) \cdot h_{\mathrm{local}} + \alpha \cdot h_{\mathrm{base}}$$
  - At $r = R$, chunk edge vertex heights match the base terrain mesh identically, completely eliminating vertical cliffs and geometry seams.
- **Rolling Multi-Chunk Streaming (`LocalTerrainStreamer`)**:
  - Automatically manages 2–3 active rolling high-resolution DEM chunks along the active route (ahead station, current hiker station, behind station).
  - Seamlessly updates `TerrainResult`, prioritizing the closest chunk for authoritative surface queries.

### Sub-Stage W7: Runtime Diagnostics, Multi-Tier Visual Outlines & Deployment
- **Runtime Telemetry & HUD Indicators**:
  - Telemetry logs and compact on-screen HUD badge display:
    - High-res coverage percentage (`coveragePercent`)
    - z19 unbroken route distance ahead (`z19AheadDistanceMeters`)
    - Tile image cache hit rate (`cacheHitRate`)
    - Warm resident patches count (`residentWarmCount`)
    - Total evictions count (`evictionsTotal`)
- **Multi-Tier Visual Debug Outlines (`?debug=1`)**:
  - Distinct color coding for visual verification:
    - **z19 High-Res Patches**: Vibrant Emerald Green (`0x22c55e`)
    - **z18 Perimeter Ring**: Warm Amber / Yellow (`0xfbbf24`)
    - **z17 / Base Imagery**: Sky Cyan / Indigo (`0x38bdf8`)
    - **Local High-Res Terrain Extents**: Rose / Vibrant Magenta (`0xf43f5e`)
- **Production Build & Deployment**:
  - Validated 100% green test suite (57 test files, 265 unit tests).
  - Deployed to Surge: `https://trekviewer.surge.sh`.

---

## 3. Automated Test Verification Summary

The test suite was executed and passed with 100% compliance:

```
Test Files  57 passed (57)
     Tests  265 passed (265)
  Duration  ~6.2s
```

### Stage W Dedicated Test Suites:
1. `test/stage_w1_quality_profile.test.ts`: Centralized profiles, patch budgets, cache entry/byte limits.
2. `test/stage_w2_asymmetric_dwell.test.ts`: Asymmetric hysteresis, 200ms promotion / 3000ms demotion dwell, Tier 0 child-completion priority.
3. `test/stage_w3_tabletop_expansion.test.ts`: 2x2 parent quadtree promotion (16 z19 children), laser pointer gaze extension.
4. `test/stage_w4_firstperson_corridor.test.ts`: 500-750m forward prefetch, latitude-aware tile sizing, 15m hiker movement evaluation threshold.
5. `test/stage_w5_warm_retention.test.ts`: Multi-factor importance scoring, warm retention under budget, memory-pressure eviction ordering.
6. `test/stage_w6_terrain_expansion.test.ts`: 1250m/1500m radius expansion, reference offset 3D positioning, C1 smooth boundary blending, multi-chunk streaming along route.
7. `test/stage_w7_diagnostics_outlines.test.ts`: Coverage %, z19 distance ahead, cache hit rate telemetry, distinct color-coded outlines.

---

## 4. Manual Meta Quest 3 Verification Checklist

When validating on Meta Quest 3 via Quest Browser at `https://trekviewer.surge.sh?debug=1`:

1. **Tabletop Mixed Reality Mode**:
   - Verify the diorama is world-locked at standard tabletop height $(0, 0.82, -0.80)\,\text{m}$.
   - Inspect debug outlines: central focus should show a $2\times 2$ parent block in green (`z19`), enclosed in an amber perimeter ring (`z18`).
   - Point controller laser at different regions of the mountain: observe high-resolution green tiles smoothly extending along the pointer ray.
2. **1:1 First-Person Mode**:
   - Switch to 1:1 First-Person view on Mount Rainier.
   - Verify green (`z19`) tiles extend at least 500m ahead along the trail ribbon, with amber (`z18`) perimeter tiles extending into the distance.
   - Walk or scrub forward 50m: notice immediate smooth playback with zero stutter, as forward tiles were already prefetched into GPU memory.
   - Turn head $180^\circ$ to look back: observe the trail behind remains crisp in high resolution (warm retention corridor) rather than popping into blurriness.
3. **Local High-Resolution Terrain**:
   - Observe local terrain mesh boundary in magenta (`0xf43f5e`).
   - Check the boundary between local terrain and base diorama: verify zero vertical cliffs, zero geometry tears, and zero z-fighting.
4. **Telemetry Badge**:
   - Inspect build badge in upper-left corner: verify `Cov: 100%`, `Ahead: >500m`, `Warm: >0`, and `hit: >80%` during trail navigation.
