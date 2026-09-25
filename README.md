# TrekViewer 3D ⛰️🥽

Meta Quest 3 Alpine GPX Trek Visualizer in WebXR (Stereo Passthrough Mixed Reality & Full 1:1 Immersion).

---

## 🚀 Headset Installation & Standalone Deployment (Zero-Server Setup)

You do **not** need to keep your laptop or local development server running to use TrekViewer on your Meta Quest 3. You can either deploy it to free static web hosting (recommended) and install it directly to your Quest App Library, or package it into a standalone `.apk`.

### Method 1: Free Static Web Hosting + Quest App Library (Recommended)

WebXR apps on Meta Quest can be deployed to any free static web hosting provider with HTTPS.

#### Option A: Surge.sh (Free, Instant, 1-Command)
```bash
npm run deploy:surge
```
- Enter your desired domain (e.g. `trekviewer-alpine.surge.sh`).
- Surge automatically provisions free SSL/HTTPS.

#### Option B: GitHub Pages (Free, Permanent)
1. Push your repository to GitHub.
2. Run:
```bash
npm run deploy:gh-pages
```
Or enable GitHub Pages in your repo settings (`Settings -> Pages -> Deploy from branch: gh-pages`).

#### Option C: Vercel / Cloudflare Pages
- Run `npx vercel` or connect your Git repo to Cloudflare Pages (Build command: `npm run build`, Output directory: `dist`).

---

### 📲 Installing Directly onto Meta Quest 3 (No PC / Cables Needed)

1. Put on your Meta Quest 3 and open the **Meta Quest Browser**.
2. Navigate to your hosted URL (e.g. `https://trekviewer-alpine.surge.sh` or your GitHub Pages URL).
3. In the Quest Browser address bar, tap the **`...` (Options)** menu on the right.
4. Select **"Install App"** (or **"Add to Home"**).
5. **Done!**
   - **TrekViewer 3D** is now installed directly in your Meta Quest **App Library**.
   - Launching it from your library opens it as a dedicated, borderless full-screen application.
   - **Automatic Updates**: Any time you deploy a new version to Surge or GitHub Pages, your headset automatically receives the update on next launch without re-installing!

---

### Method 2: Standalone Meta Quest `.apk`

If you prefer an offline sideloadable Android package file (`.apk`):

1. Run the packaging script:
```bash
npm run package:apk
```
This uses Meta's official `ovr-platform-util` CLI tool (`create-pwa-package`) to generate a signed `trekviewer.apk`.

2. Install the APK to your Quest:
- **Via ADB**:
  ```bash
  adb install -r trekviewer.apk
  ```
- **Via SideQuest**: Drag and drop `trekviewer.apk` onto the SideQuest window.
- **Via Meta Quest Developer Hub (MQDH)**: Drag into App Manager.

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
- **Scope by URL Domain / Origin**: In the Cesium Ion token settings, configure the allowed origins (e.g. `https://trekviewer.surge.sh`, `https://your-custom-domain.com`, `http://localhost:*`).
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
- **PWA & APK Installation**: Installing TrekViewer as a PWA or sideloading via APK installs the web application shell to your Meta Quest App Library for dedicated, full-screen WebXR launching.
- **Network Tile Access**: While the app shell and bundled GPX routes are served locally, real-world DEM elevation grids and high-resolution satellite/topographic imagery tiles are streamed dynamically over Wi-Fi from public providers (AWS Terrarium, Esri World Imagery, USGS Topo). An active internet connection is required to fetch new terrain and map textures.

---

## 🔒 Privacy

- **Your Data Remains Private**: Uploaded GPX files and personal track data stay strictly in your local browser/device memory and are never uploaded or transmitted to any third-party server.
- **Tile Requests**: Outgoing network traffic consists exclusively of anonymous HTTP GET requests to public map and DEM tile servers.
