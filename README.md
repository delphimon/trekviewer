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

## 🖐️ Controls & Hand Tracking Guide

TrekViewer seamlessly supports both **Bare Hands** and **Touch Plus Controllers** simultaneously with zero mode switching.

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
- **Grip Button**: Grab and move terrain or HUD handle.
- **A / X Button**: Toggle between Tabletop Mixed Reality and 1:1 First-Person Trail immersion.
- **B / Y Button**: Play / pause GPS speed-scaled flyover.
- **Trigger**: Laser pointer selection.

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
