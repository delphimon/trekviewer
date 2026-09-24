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

### Controller Ownership & Bare Hand Outline Suppression (Stage T1)
- When physical **Touch Plus Controllers** are held or active, hand tracking outlines are automatically suppressed to eliminate visual jitter and visual clutter.
- When controllers are put down, **Bare Hand Outlines** smoothly activate for optical finger tracking.

### Bare Hands (Natural Optical Tracking)
- **Two-Handed Pinch & Stretch**: Pinch thumb and index on both hands and pull apart to **zoom in / scale up**.
- **Two-Handed Pinch & Squeeze**: Pinch both hands and move closer together to **zoom out / scale down**.
- **Two-Handed Steering Wheel**: Pinch both hands and rotate around vertical axis to **rotate the mountain**.
- **Two-Handed Dual Pan**: Pinch both hands and move through room space to **translate the diorama in 3D**.
- **One-Handed Pinch & Drag**: Pinch with one hand to **reposition the mountain** anywhere in your room.
- **One-Handed Wrist Twist**: Pinch and twist your wrist to **adjust terrain heading**.
- **Direct Fingertip Poke**: Touch buttons and scrubber on the floating 3D Spatial HUD directly with your index finger.

### Touch Plus Controllers
- **Left Thumbstick**: Pan diorama across room (Tabletop) / Walk trail forward and backward (1:1 mode).
- **Right Thumbstick**: Rotate and zoom terrain.
- **Grip Button**: Grab and move terrain or HUD handle in room space.
- **A / X Button**: Toggle between Tabletop Mixed Reality and 1:1 First-Person Trail immersion.
- **B / Y Button**: Play / pause GPS speed-scaled flyover.
- **Trigger**: Laser pointer selection for waypoints, HUD buttons, and route scrubbing.

---

## 🧭 Route Fidelity, Telemetry & Trail Colors (Stage T2 & T3)

- **Solid High-Contrast Route Default**: Trails render by default in high-contrast cyan (`#38bdf8`) for crystal-clear readability against alpine terrain, snowfields, and rock.
- **2D Spatial X/Z Smoothing**: Trackpoints undergo moving-window spatial smoothing to eliminate GPS jitter and jagged zigzag lines without modifying raw GPX analytics.
- **GPS Spike Suppression**: Unrealistic GPS jump anomalies (> 60 km/h) are automatically filtered out.
- **Dense Terrain Reprojection**: Trail geometry is densely resampled every 4 meters and draped precisely over high-resolution elevation data with dynamic lift, preventing trail clipping inside mountain ridges.
- **Spatially Smoothed Grade & Pace**: Telemetry values are smoothed over distance windows and categorized into 5 broad color bands with 60-meter run-length filtering to eliminate high-frequency visual speckling:
  - **Grade Bands**: Gentle (0–6%), Moderate (6–15%), Steep (15–25%), Very Steep (25–40%), Extreme (40%+).
  - **Pace Bands**: Slow (< 1.1 mph), Moderate (1.1–2.2 mph), Standard (2.2–3.3 mph), Brisk (3.3–4.5 mph), Fast (4.5+ mph).

---

## 📍 Waypoint Marker Redesign & Landmark UX (Stage T4)

- **Compact Visual Markers & Scale Compensation**: Replaced oversized legacy markers with sleek diamond beacons (`~2.2 cm` apparent world size across all diorama scales from 0.1x to 10x).
- **Invisible Laser Hit Targets**: A 24-meter radius invisible hit sphere surrounds each marker, enabling effortless Quest 3 laser pointing without requiring millimeter precision on the visual pin.
- **Billboard Text Cards**: Waypoint labels default to hidden to prevent cluttering the diorama. Labels automatically appear on hover (0.8s exit timeout) or selection (4.0s display timeout). Labels maintain a fixed readable angular size (~10° FOV) from near and far.
- **Spatial HUD Row 3 Navigation**:
  - `◀ Prev Landmark`: Jump progress to previous landmark along route.
  - `📍 Current Landmark`: Displays nearest landmark with elevation and distance.
  - `Next Landmark ▶`: Advance progress to next landmark along route.
  - **Profile Halo**: Active/nearest landmark is highlighted with an amber glowing ring on the HUD elevation chart.
- **Desktop Landmark Controls**:
  - **"Jump to Landmark ▾"** dropdown in the landmarks panel.
  - **Elevation Profile Click Jump**: Clicking on or near a landmark marker on the elevation profile immediately jumps progress to that waypoint.

---

## 🛰️ Imagery Quality & Satellite Providers (Stage T5)

- **Active XR Camera Tracking**: The per-frame animation loop passes the active WebXR camera (`renderer.xr.getCamera()`) to `ImageryLODManager`, correctly tracking true 6DOF head movement in room coordinates rather than stationary desktop camera offsets.
- **Provider Max Resolution (Zoom 19)**: In 1:1 first-person trail mode, inner detail zones reach provider maximum resolution (zoom 19, sub-meter per pixel on Esri World Imagery and Bing Aerial).
- **Crisp Texture Filtering**: Tile patches use trilinear mipmapping (`LinearMipmapLinearFilter`) and maximum hardware anisotropy (up to 16x) for razor-sharp textures even at oblique viewing angles.
- **Configurable Satellite Provider**:
  ```bash
  # In .env or build environment:
  VITE_SATELLITE_PROVIDER=auto       # 'auto' (default), 'esri', or 'cesium-bing'
  VITE_CESIUM_ION_TOKEN=your_token   # Optional: Cesium Ion token for Microsoft Bing Aerial
  ```
  - **`esri`**: Global high-resolution Esri World Imagery (default, no token required).
  - **`cesium-bing`**: Microsoft Bing Maps Aerial via Cesium Ion. Gracefully falls back to Esri World Imagery if token is missing or network fails.
  - **`auto`**: Uses Bing Aerial if a valid Cesium token is configured, otherwise Esri World Imagery.

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
