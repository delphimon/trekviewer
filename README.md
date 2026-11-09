# TrekViewer 3D

View GPX hiking and mountaineering routes as 3D terrain models: a tabletop model in
passthrough mixed reality or VR on Meta Quest 3, a life-size "walk the trail" mode, and a
desktop/mobile browser view. Everything runs in the browser; there is no backend.

Bundled routes: Mount Rainier (Emmons), Baker, Adams, Hood, Glacier Peak, the Olympus/Bailey
traverse, the Enchantments & Dragontail, and Putrid Pete's/Web/Defiance. Import your own `.gpx`
with **Import GPX** (up to 25 MB; the file never leaves your device).

## Using it

**Desktop / phone**
- Drag to orbit, scroll or pinch to zoom. **Fit terrain** (View tab) shows the whole model.
- **Tour** plays the route in about 90 seconds; **Track timing** replays the recorded pace.
  **Follow route** keeps the camera on the hiker.
- The side panel has four tabs: **Route** (stats, landmarks), **View** (map style, imagery
  source, trail colors, exaggeration, horizon, quality, VR comfort), **Offline** (offline
  maps, cache) and **Help** (controls, data sources, version).

**Quest 3** — open the hosted URL in Meta Quest Browser and choose **Passthrough (MR)** or
**Enter VR**. In passthrough the model is placed on your table automatically when Space
Setup knows about one (the table is detected through WebXR plane detection and the model is
anchored so recentering does not move it).

| Input | Action |
|---|---|
| One-hand pinch on the model | Move it |
| Two-hand pinch | Pull apart/together to zoom; turn like a steering wheel to rotate |
| Pinch a marker / tap it with your index finger | Jump to that landmark |
| Panel | Point and pinch, or tap with your index finger; pinch the bar above it to move it |
| Grip | Grab and move or turn the model |
| Left stick | Move the model (tabletop) / walk the trail (life-size) |
| Right stick | Turn; up/down zooms the tabletop; click to hide/show the panel |
| Hold A / X | Switch between tabletop and life-size trail (fades through black) |
| B / Y | Play / pause |
| Trigger | Point and select |

Exit on the panel needs a second tap. Comfort options (walking vs 25 m steps, snap vs smooth
turning, motion vignette, larger panel) are in the View tab and saved on the device. Playing
in XR does not move the table; use the panel's **Follow** button if you want the model to
track the hiker.

## Offline maps

In the **Offline** tab choose routes and a detail level, then **Check size** and **Download**.
"Sharp along the trail" (default) keeps full terrain shape with sharp imagery near the route
and is much smaller than "Sharp everywhere" (the earlier full packs were 5.5 GB for Rainier
and 10.4 GB for the Enchantments). Keep the tab open while downloading; playing or entering
VR/MR pauses it and **Download** resumes. Packs that a newer app version expects more data
for show **Needs update** and keep working (missing pieces load online). Prepared
`.trekpack.tar` files can be imported under **Import or export a pack file**; see
[docs/OFFLINE_ROUTE_PACKS.md](docs/OFFLINE_ROUTE_PACKS.md).

When a new version is deployed, the Offline tab shows **Reload to update**.

## Imagery and elevation sources

The default **Public sources** setting uses USGS NAIP / GeoPlatform NAIP imagery in the
continental US, SWISSIMAGE in Switzerland and EOX Sentinel-2 cloudless (CC BY-NC-SA,
non-commercial) elsewhere; elevation comes from USGS 3DEP where available and AWS Terrarium
tiles otherwise. Esri World Imagery and Bing (through your own Cesium ion token, entered in
the View tab or via `VITE_CESIUM_ION_TOKEN`) are optional. Credits for what is shown appear
below the elevation chart. See [public/data-sources.html](public/data-sources.html).

## Development

```bash
npm ci
npm run dev        # https://localhost:5173 (self-signed certificate)
npm run verify     # typecheck + tests + production build
npm run preview    # serve the production build
```

- `src/main.ts` wires everything; `src/core` (session state, XR input, scene, profiling),
  `src/terrain` (DEM, imagery LOD, providers, caches), `src/visualization` (trail, markers,
  playback), `src/ui` (desktop overlay, spatial HUD), `src/offline` (packs, service worker
  shell), `src/xr` (gestures, comfort, table placement, audio feedback).
- URL flags: `?debug=1` (diagnostics badge + console telemetry), `?profile=1` (local
  performance recorder with JSON download; see [docs/QUEST_PROFILE.md](docs/QUEST_PROFILE.md)),
  `?terrainImagery=0` (overlay imagery patches instead of terrain-shader imagery),
  `?bestDem=0`, `?regionalDem=0`, `?regionalBase=0`, `?terrainGrid=60|75|120`.
- Deploy: `npm run deploy:surge` (runs `verify` first). `npm run package:apk` wraps the
  hosted site as a Quest PWA with Bubblewrap (see Meta's PWA packaging guide).
- Open work and the latest review are tracked in
  [docs/REVIEW_FIX_PLAN.md](docs/REVIEW_FIX_PLAN.md). Hardware acceptance on a Quest 3
  (frame timing, thermals, table placement, hand interaction) is still pending.
