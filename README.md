# TrekViewer 3D ⛰️🥽

Meta Quest 3 Alpine GPX Trek Visualizer in WebXR (Stereo Passthrough Mixed Reality & Full 1:1 Immersion).

---

## 🚀 Headset Installation & Standalone Deployment (Zero-Server Setup)

You do **not** need to keep your laptop or local development server running to use TrekViewer on your Meta Quest 3. You can either deploy it to free static web hosting (recommended) and install it directly to your Quest App Library, or package it into a standalone `.apk`.

### Method 1: Hosted WebXR

Open your deployed HTTPS URL in Meta Quest Browser and select the app's VR or MR entry button. Browser installation affordances vary by headset/browser version; opening a hosted URL is the basic supported path.

Completed implementation checkpoints must be checked in and published, as requested October 14, 2026. Run `npm run verify` and the relevant browser checks, commit the checkpoint's source, tests and review evidence, push to `origin`, and wait for GitHub CI to pass. Rebuild from the clean commit before publishing `dist/` to [trekviewer.surge.sh](https://trekviewer.surge.sh), so `build-info.json` identifies the committed revision. Verify the hosted build metadata and a production browser load before reporting the checkpoint as published. Keep credentials and temporary validation files out of commits.

### Method 2: Sideloadable Meta Quest APK

The wrapper loads the hosted website. It is **not an offline bundle**: startup, routes, elevation, and imagery need network access. There is currently no service-worker shell cache or offline region-download feature.

Follow [Meta's PWA packaging guide](https://developers.meta.com/horizon/documentation/web/pwa-packaging/) to prepare Bubblewrap, signing, and Digital Asset Links:

1. Run `npm run verify`, then deploy `dist/` to your chosen HTTPS origin.
2. Install `@meta-quest/bubblewrap-cli` and initialize against that origin:
   ```bash
   QUEST_MANIFEST_URL=https://your-host/manifest.webmanifest npm run package:apk -- --init
   ```
3. Review the interactive app-mode and signing configuration. Publish the generated association at `/.well-known/assetlinks.json` on the hosted origin. Keep signing keys/passwords out of Git.
4. Build and install:
   ```bash
   npm run package:apk
   adb install -r quest-package/app-release-signed.apk
   ```

`QUEST_ANDROID_DIR` selects another generated-project directory. The script fails for missing prerequisites, failed builds, or missing/stale output. It neither deploys the site nor installs the APK automatically. A real signed build and headset launch remain unverified; see [current validation](docs/review-2026-09-26/IMPLEMENTATION.md).

---

## 🖐️ Controls & Mixed Reality Interactions

TrekViewer seamlessly supports both **Bare Hands** and **Touch Plus Controllers** simultaneously with zero mode switching and clean input ownership.

### Diorama Tabletop Positioning & Invariance
- **Natural Room-Space Anchoring**: The tabletop diorama anchors rigidly at natural table height (**82 cm above the floor, 80 cm in front of the user**) in room space.
- **World-Locked Invariance**: Head rotation and physical walking through room space never move or recenter the diorama.
- **Diorama Sizing**: Scaled to fit comfortably on any standard table (**1.0 m maximum width**, nominal **0.85 m** target table diameter).
- **Proximity Envelope**: Intuitive **18 cm reach envelope** around the 3D model and pedestal gates gestures and displays proximity feedback.

### Bare Hands (Natural Optical Tracking)
- **Two-Handed Pinch & Stretch**: Pinch thumb and index on both hands and pull apart to **zoom in / scale up**.
- **Two-Handed Pinch & Squeeze**: Pinch both hands and move closer together to **zoom out / scale down**.
- **Two-Handed Steering Wheel**: Pinch both hands and rotate around vertical axis to **rotate the mountain**.
- **Two-Handed Dual Pan**: Pinch both hands and move through room space to **translate the diorama in 3D**.
- **One-Handed Pinch & Drag**: Pinch with one hand within the 18 cm envelope to **reposition the mountain** anywhere in your room.
- **One-Handed Wrist Twist**: Pinch and twist your wrist to **adjust terrain heading**.
- **Direct Fingertip Touch**: Touch waypoint markers directly with your fingertip (within **~3.5 cm touch radius**) or poke floating Spatial HUD buttons.
- **Controller Ownership**: When Touch Plus Controllers are held, hand tracking outlines are automatically suppressed to eliminate visual jitter.

### Touch Plus Controllers
- **Left Thumbstick**: Pan diorama across room (Tabletop) / Walk trail forward and backward (1:1 mode).
- **Right Thumbstick**: Rotate and zoom terrain.
- **Grip Button**: Grab and move terrain or HUD handle in room space.
- **A / X Button**: Toggle between Tabletop Mixed Reality and 1:1 First-Person Trail immersion.
- **B / Y Button**: Play / pause GPS speed-scaled flyover.
- **Trigger**: Laser pointer selection for waypoints (with generous **5.0 cm world hit radius** / 10 cm diameter), HUD buttons, and route scrubbing.

---

## 🧭 Route Fidelity, Telemetry & Direction Model (Stages T & U)

- **Default Iconic Trek**: **Mount Rainier via Emmons Glacier** (**24.3 km** round trip distance, **3,097 m** total elevation gain, summit elevation 4,392 m / 14,411 ft).
- **Authoritative Forward Convention**: Canonical mathematical forward convention where $0\text{ rad} = -Z$ (North), $\pi/2 = +X$ (East), $\pi = +Z$ (South), and $3\pi/2 = -X$ (West).
- **Hiker Heading Arrow**: 3D forward-pointing indicator oriented along the exact route tangent vector at the user's current progress point.
- **1:1 Room-Space Alignment**: Headset forward vector in first-person mode aligns 1:1 with real-world trail azimuth. Walking forward in your room moves forward along the mountain trail.
- **Unified Rendered Terrain Surface**: Trail ribbon vertices sample both left and right edges directly from the rendered terrain mesh triangle barycentric coordinates (`sampleRenderedSurfaceY`), preventing half-buried ribbon edges on steep slopes.
- **Solid High-Contrast Route Default**: Trails render in high-contrast cyan (`#38bdf8`) with dense 4-meter resampling and dynamic lift.
- **Travel Direction Chevrons**: Repeating white chevrons with dark outlines follow GPX travel order on the path in tabletop and 1:1 views. They scale with the view, retain all trail color modes, and render within the existing ribbon draw call.
- **Spatially Smoothed Grade & Pace**: Telemetry values are smoothed over distance windows and categorized into 5 broad color bands with 60-meter run-length filtering.

---

## 📍 Waypoint Marker Redesign & Landmark UX (Stages T4 & U3)

- **Exact Visual Route Coincidence**: Canonical projection (`projectGeoPointToVisualRoute`) snaps waypoints within 75m directly onto the rendered trail centerline, guaranteeing zero horizontal gap for on-route camps (e.g. Camp 3 at **0.000 m** horizontal delta).
- **World-Scale Compensated Markers**: Sleek diamond beacons scale dynamically to maintain a consistent **~2.5 cm world diameter** across all diorama scales.
- **Multi-Modal Interaction**: Select waypoints via direct index fingertip touch (**~3.5 cm touch radius**), bare-hand pinch hover, or controller laser pointing (**5.0 cm world hit radius**).
- **Billboard Text Cards**: Waypoint labels maintain a fixed readable angular size (~10° FOV) with active selection highlighting and hover halos.
- **Spatial HUD Landmark Navigation**:
  - `◀ Prev Landmark`: Jump progress to previous landmark along route.
  - `📍 Current Landmark`: Displays nearest landmark with elevation and distance.
  - `Next Landmark ▶`: Advance progress to next landmark along route.
  - **Profile Halo**: Active/nearest landmark is highlighted with an amber glowing ring on the HUD elevation chart.
- **Desktop Landmark Controls**:
  - **"Jump to Landmark ▾"** dropdown in the landmarks panel.
  - **Elevation Profile Click Jump**: Clicking on or near a landmark marker on the elevation profile immediately jumps progress to that waypoint.

---

## 🛰️ Imagery Quality, Coherent LOD & Source Transparency (Stages T5, U4, U5)

- **Coherent LOD & Dynamic Subdivision**:
  - High-detail patches ($z \ge 18$) use **4x4 segments**, mid zoom ($z \ge 16$) use **6x6**, and base zoom use **8x8**, optimizing vertex throughput on Quest 3.
  - Nested refinement rings: contiguous $3 \times 3$ center at $Z_{high}$ and outer perimeter at $Z_{mid}$, eliminating checkerboard holes.
  - Atomic parent/child replacement: parent tiles remain visible until all 4 child tiles are ready; depthWrite-safe opacity crossfading prevents visual pop.
  - 500ms promotion dwell time prevents rapid LOD thrashing during fast head turns.
- **Explicit Awaited Initialization**: Eliminates asynchronous startup races by awaiting provider environment configuration before route loading begins.
- **Truthful Sources & Cache Isolation**: Cesium Bing provider requests only Bing URLs; per-tile fallback to Esri is eliminated, ensuring cache keys (`cesium-bing:z:x:y`) never contain mixed Esri imagery.
- **UI Source Transparency**: Desktop and Spatial HUD clearly report active imagery provider and fallback status (e.g. `Bing Aerial via Cesium • up to Z19` or `Esri World Imagery • up to Z19 (fallback: Cesium unavailable)`).
- **Diagnostics (`?debug=1`)**: Telemetry and on-screen `#buildBadge` monitor requested provider, active provider, initialized state, fallback reason, LOD visible counts by zoom, and tile cache failure counts.
- **Configurable Satellite Provider**:
  ```bash
  # In .env or build environment:
  VITE_SATELLITE_PROVIDER=auto       # 'auto' (default), 'esri', or 'cesium-bing'
  VITE_CESIUM_ION_TOKEN=your_token   # Optional: Cesium Ion public access token for Microsoft Bing Aerial
  ```
  - **`esri`**: Global high-resolution Esri World Imagery (default, no token required).
  - **`cesium-bing`**: Microsoft Bing Maps Aerial via Cesium Ion. Falls back to Esri World Imagery globally if token is missing or network fails.
  - **`auto`**: Uses Bing Aerial if a valid Cesium token is configured, otherwise Esri World Imagery.

#### Cesium Ion Token Scoping & Security Guidelines
Because TrekViewer is a 100% client-side WebXR static PWA, any token provided via `VITE_CESIUM_ION_TOKEN` is compiled into the client-side JavaScript bundle and transmitted directly to Cesium Ion from the client browser.
- **Never use secret or administrator tokens**: Generate a dedicated, scoped client token in your [Cesium Ion Tokens Dashboard](https://ion.cesium.com/tokens).
- **Scope by URL Domain / Origin**: In the Cesium Ion token settings, configure the allowed URLs for where you serve the app. The USB-forwarded Quest workflow uses `http://localhost:4173/`; a token allowed only for `https://trekviewer.surge.sh/` receives HTTP 403 on localhost and TrekViewer correctly uses Esri. Cesium requires a matching `Referer` for URL-restricted tokens. Prefer a separate public, asset-read-only token for local development instead of broadening the hosted token to all localhost sites.
- **Restrict Asset Permissions**: Restrict the token's asset permissions strictly to **Asset 2 (Bing Maps Aerial)** and disallow write, asset creation, or geocoding privileges.
- **Zero-Token Fallback**: If `VITE_CESIUM_ION_TOKEN` is omitted, TrekViewer automatically uses Esri World Imagery with zero degradation, zero error dialogs, and full quadtree LOD streaming.

For detailed hardware acceptance verification, manual testing procedures, and engineering results across all Stage V improvements, see:
- [Stage V Meta Quest 3 Hardware Acceptance & Interaction Precision Report](docs/STAGE_V_QUEST_ACCEPTANCE.md)
- [Stage U Comprehensive Engineering Regression Report](docs/STAGE_U_REGRESSION_REPORT.md)

---

## 🛠 Local Development & Testing

```bash
# Clean install dependencies
npm ci

# Run local development server with HTTPS
npm run dev

# Run TypeScript typechecker
npm run typecheck

# Run automated Vitest test suite
npm test

# Build production static bundle into dist/
npm run build
```

---

## 🌐 Network, Offline & PWA Behavior

- **Client-Side Architecture**: TrekViewer runs 100% clientside inside your browser or WebXR runtime. There is no custom backend server.
- **Hosted WebXR & APK wrapper**: Use Quest Browser directly or package the hosted site with Bubblewrap. Both currently require network access.
- **Network Tile Access**: While the app shell and bundled GPX routes are served locally, real-world DEM elevation grids and high-resolution satellite/topographic imagery tiles are streamed dynamically over Wi-Fi from public providers (AWS Terrarium, Esri World Imagery, USGS Topo). An active internet connection is required to fetch new terrain and map textures.

---

## 🔒 Privacy

- **Local GPX Processing**: Uploaded GPX files, timestamps, and track metadata are processed in your browser and its local worker; the application does not upload the GPX file.
- **External Map Requests**: Loading imagery and elevation sends geographic tile coordinates to the configured map/DEM providers. Provider requests may use credentials when a configured provider requires them.

### First-person navigation and HUD placement

Entering first-person establishes the route heading once. Right-stick turning remains under your control during playback and while paused; bends in the route no longer force headset yaw. The HUD is placed beside you on entry and stays where you dock or drag it. Click the **right thumbstick** to hide it or summon it again; the **left thumbstick** focuses the hiker. Docking and switching view modes also restore the HUD.

Trail entry pauses playback and anchors the route at your current floor-projected headset position and heading. Walking defaults to 1.4 m/s (2 m/s while holding the trigger), with 30° snap turns. Settings offers 1 m steps, optional smooth turning, a motion vignette, and larger panel text; these preferences are saved locally. Immersive playback stays at walking pace, and HUD step buttons move 1 m. Accelerated time playback remains available in tabletop mode. Panel targets scale with dock distance, and mobile Settings exposes style, quality, landmarks, and comfort controls.

### Desktop inspection and horizon

Desktop wheel/pinch zoom follows the pointer and supports much closer inspection. Near and far clipping adapt to the tabletop view, preserving nearby terrain and depth precision; walking and XR use their metre-scale clipping range. Desktop waypoint markers shrink during close inspection so they keep the terrain visible.

**Lock horizon level** is enabled by default and saved locally. It keeps the model upright during hand manipulation while allowing yaw, movement and scaling. Desktop orbiting keeps the camera upright while allowing views from above and from the sides. **Level horizon** removes model pitch and roll without resetting pan, zoom or route progress. Both controls appear in the desktop/mobile settings and the spatial HUD.

**Fit terrain** frames the whole terrain between the desktop controls, preserving model pose and trail progress. Automatic views adapt to resizing; manually zoomed or orbited views retain their camera position and target. Mobile fitting closes Settings. See the [terrain framing validation](docs/review-2026-10-13/FRAMING.md) for its checks and desktop/mobile captures.

### Performance validation

VR and passthrough availability are checked separately. Entry controls start disabled while checking and wait for a ready trek and graphics. Unavailable modes have disabled controls with an explanation. Passthrough never silently switches to VR; choose **Enter VR** explicitly when that mode is available. Connecting or changing an XR device refreshes the availability check. Automatic terrain fits follow header/timeline layout changes; manual camera views are preserved. See the [startup and layout validation](docs/review-2026-10-13/STARTUP.md).

Terrain picking reuses traversal storage while keeping returned hit points independent. The [latest performance validation](docs/review-2026-10-13/PICKING.md) records unchanged surface selection and rendering, isolated CPU measurements, and the remaining headset validation limits.

Trail refinements maintain conservative rendering bounds and upload changed position/normal spans, preserving trail visibility as terrain detail and exaggeration change. See the [rendering and XR availability continuation](docs/review-2026-10-13/CONTINUATION.md) for its validation and upload measurements.

Graphics interruptions pause playback and preserve the current trek and desktop inspection position. Rendering resumes after resources are prepared; use **Retry graphics** if recovery preparation fails, then press Play when ready to continue. Desktop controls expose selected states to assistive technology. See the [graphics recovery validation](docs/review-2026-10-13/RECOVERY.md) for native interruption checks and hardware limits.

Terrain refinements reuse a coarse-cell coverage mask and upload the drawn index prefix, preserving the same terrain triangles and visual detail while reducing update work. See the [terrain coverage measurements](docs/review-2026-10-13/COVERAGE.md) for its tests, browser checks and CPU benchmark.

Map styles share pending and completed imagery compositions, and terrain disposal releases owned canvases and GPU textures. The visible route retains its imagery while a replacement loads. Overview composition is capped at 120 tiles, including wide polar terrain bounds. See the [imagery streaming validation](docs/review-2026-10-13/IMAGERY.md) for its tests and browser lifecycle evidence.

Close desktop inspection uses the actual viewed distance to select source imagery and responds to small zoom steps within the existing tile budgets. Terrain raycasts stop after the nearest valid cell hit. See the [close-up detail validation](docs/review-2026-10-13/DETAIL.md) for its tests, before/after images and isolated CPU measurements.

Local trail updates look up nearby numeric spatial buckets, with a bounded scan for broad footprints. Vertex selection and sampling order stay the same. See the [trail lookup validation](docs/review-2026-10-13/LOOKUP.md) for the latest tests, matched rendering and isolated CPU measurements.

Wanted detail terrain recovers automatically after temporary download failures, with retries from one to five minutes and visible base coverage while waiting. Settled streaming avoids repeated preparation scans and reuses unchanged geographic focus. See the [terrain streaming recovery validation](docs/review-2026-10-13/STREAMING.md) for the latest tests, real cooldown checks and isolated idle CPU measurements.

Append `?debug=1` to display callback pacing, CPU submission p95, tile coverage, draw calls, and cache diagnostics. The panel reports the actual XR refresh rate when available; desktop rate is shown as unknown. Callback estimates are not GPU/compositor measurements. Debug geometry and logging also add overhead, so compare against a normal headset session.

For repeatable headset runs, append `?profile=1` to the hosted URL. The production build records bounded one-second CPU, callback, rendering, cache, and quality samples locally. Entering XR starts the recorder; exiting stops it. Press **Download JSON** on the page to save the report. Pair it with Meta's device GPU/FPS/thermal metrics. See the [Quest 3 profiling procedure](docs/QUEST_PROFILE.md) for exact steps and measurement limits.

High quality now targets a 60 m base grid and approximately 10 m terrain refinements. Stable terrain tiles retain parent coverage until detailed geometry and its imagery are prepared, then publish together. Quest High is bounded to 12 refinement tiles / 96,000 refinement vertices; desktop High uses up to 24 / 160,000. Balanced uses up to 9 / 40,000 at about 25 m spacing. Base meshes retain the existing 125,000-vertex Quest and 200,000-vertex desktop limits. Changing quality affects streaming immediately; reload the route to rebuild the base grid.

The Enchantments' packaged regional DEM is enabled for local and base terrain where available. It contains 26 z15 Terrarium PNGs derived from the USGS 3DEP 1-metre WA Eastern Cascades 2019 source. Uncovered positions and failed packaged requests fall back to AWS; packaged edges blend to AWS over 24 pixels. The 1 m source is resampled into z15 tiles; the renderer does not imply 1 m mesh spacing. The profile records source counts, DEM zoom, and actual mesh cell sizes.

For controlled comparisons, `terrainGrid=60`, `75`, or `120` selects the base spacing without changing imagery selection. `regionalDem=0` and `regionalBase=0` disable the respective regional sources, and `terrainTiles=0` restores the legacy single-refinement streamer. Keep other flags and the viewpoint fixed when comparing. High's new defaults have browser and regression coverage; their Quest GPU, thermal, and subjective comfort costs still require a connected headset. Decoded local DEM caching is bounded to 64 MiB; base/regional grids, live terrain, and worker staging are additional memory.

To regenerate the pack, install `rasterio`, `numpy`, and `Pillow` in a Python environment and run `python3 scripts/build-regional-dem.py`. The source COG URL, tile footprint, coordinate conversion, and resampling method are recorded in `src/terrain/data/enchantments-3dep-2019.json`. The build-time geospatial packages are not needed on the headset.

Save `dist/build-info.json` with each device test: it includes the source SHA, modified-tree marker, and timestamped build ID. See the [October implementation and validation record](docs/review-2026-10-13/IMPLEMENTATION.md) for verified results and pending hardware checks.
