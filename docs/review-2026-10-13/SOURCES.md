# Public source quality checkpoint

Source review: October 14, 2026 (browser evidence also includes October 15 UTC). This checkpoint replaces the default commercial imagery path with public sources, adds live best-available USGS elevation, and retains the broader High-detail coverage from the previous checkpoint.

## Source selection and limits

| Data | Default selection | Resolution and use |
| --- | --- | --- |
| US elevation | [USGS 3DEP best available](https://elevation.nationalmap.gov/arcgis/rest/services/3DEPElevation/ImageServer), raw floating-point heights, lossless LERC | Public domain. Approximately 1 m output sampling for local terrain, bounded to 1024 samples per side. Native survey resolution varies. Overview sampling is coarser to cover the entire route. |
| Contiguous-US aerial imagery | [USGS NAIP Plus / HRO](https://imagery.nationalmap.gov/arcgis/rest/services/USGSNAIPPlus/ImageServer), then GeoPlatform NAIP and [USGS NAIP](https://imagery.nationalmap.gov/arcgis/rest/services/USGSNAIPImagery/ImageServer) | The preferred service describes public-domain sources from 6 inches to 1 m. Fine detail uses natural-colour PNG exports through Z19, rather than an enlarged cached overview. Source date and resolution vary by location. |
| Global imagery | EOxCloudless Sentinel-2 2025 mosaic | Approximately 10 m native detail, capped at Z15. Free for personal/noncommercial use under [EOX's CC BY-NC-SA 4.0 terms](https://cloudless.eox.at/documentation/license), with attribution and ShareAlike conditions. |
| Terrain fallback | Packaged regional USGS data / [Mapzen Terrain Tiles](https://registry.opendata.aws/terrain-tiles/) | Available terrain stays visible when the preferred source is unavailable. Local fallback chunks retry the preferred source with bounded backoff. Regional source credits are linked in the app. |
| Topo and Hybrid names | USGS The National Map / GNIS | Public-domain US maps and names. No implicit Esri or OpenTopoMap fallback. |

`auto` uses the public policy even if a Cesium token happens to be configured. Esri and Cesium/Bing require explicit configuration and retain their separate terms. Default requests require no paid account, key, or requester-pays AWS access. The app includes a responsive [source and license page](../../public/data-sources.html), full EOX attribution where applicable, and LERC/Three.js software notices.

These services cannot guarantee the finest public dataset at every coordinate. High-resolution local surveys may exceed general services. Eligibility uses coarse geographic bounds, and valid coverage is checked from the responses; border, coastal, Alaska, island and other areas may have lower-resolution imagery or retain existing coverage. No claim is made that every imported route has native 1 m elevation or sub-metre imagery.

### Native survey versus sample spacing

The live [Rainier identify response](sources/elevation-selection.json), using the same `Best` mosaic rule as the app, selects survey `ned19_n47x00_w122x00_wa_lewis_2009` (catalog item 8856), with approximately 3.44 m Web Mercator pixel spacing: roughly the 3 m / 1/9 arc-second source class. Lower-resolution 10 m and 30 m surveys were present but not selected. The service's native pixel-size selection precedes attribute ordering; see [ArcGIS mosaic configuration](https://doc.arcgis.com/en/imagery/workflows/best-practices/initial-configuration.htm) and the [identify API](https://developers.arcgis.com/rest/services-reference/enterprise/identify-image-service/).

The app samples this surface at approximately 1 m locally and retains approximately 5 m High mesh cells. These are different measurements. Resampling preserves the best available input for the mesh; it cannot manufacture native 1 m landforms. The full Rainier overview in this run sampled at 14.54 m because of the raster dimension cap.

## Performance and failure handling

- Sixteen neighbouring fine imagery tiles share one 1024 × 1024 public-service export. Each receives its exact 256 × 256 region, preserving ground pixel density while reducing export requests.
- Shared decoded exports retain at most four entries (16 MiB), counted within the existing profile image-cache byte budget. Eviction releases cache ownership without mutating images still in use.
- Native elevation is decoded in the terrain worker using Apache-licensed LERC/WASM. Header dimensions, bands, response size, masks and finite height ranges are checked before publication. Partial coverage never replaces complete terrain.
- Failed shared imagery exports and native terrain footprints use bounded cooldown records. Existing terrain remains visible during retries; a successful terrain upgrade swaps matching imagery and geometry together.
- Outside the US imagery region, selection respects EOX's Z15 cap rather than requesting fictitious higher-detail tiles. High-detail field coverage and desktop/Quest mesh budgets remain unchanged.

## Validation and evidence

Local `npm run verify` passed source and test TypeScript checks, **530 tests**, with five POSIX-only tests skipped on Windows, plus the production build. The corresponding Linux suite includes those five tests. See [verification log](sources/verify.log).

The build reports the existing large-main-chunk advisory and LERC's Node-only `module` branch externalization advisory. Actual browser worker decoding of native USGS LERC succeeded. Main bundle: 930.79 kB (244.71 kB gzip); terrain worker: 232.96 kB; LERC WASM: 117.02 kB (32.09 kB gzip).

### Live first-person field checks

[Harness](sources/browser-sources.mjs), [raw browser result](sources/browser.json), [walking screenshot](sources/walking.png), [turned screenshot](sources/turned.png).

Actual Edge WebGL on NVIDIA RTX 4060 / ANGLE D3D11. A Quest user-agent selected Quest High budgets; this was **not** a headset or native XR performance test. Rainier at route progress 0.4, then a 25° turn:

| Measurement | Walking | After turn |
| --- | --- | --- |
| Terrain hits across a 5 × 5 screen-ray grid | 25 / 25 | 23 / 25 (two rays hit sky) |
| Hit points covered by Z19 imagery and native USGS local grids | 25 / 25 | 23 / 23 |
| Native terrain chunks retained | 48 | 50 (including warm retention) |
| Local vertices | 451,632 | 470,450 |
| Largest sampled High mesh cell | 4.98 m | 4.98 m |
| Local height output sampling | 1.001 m | 1.001 m |
| Time until all sampled terrain hits had this detail | 110.5 s | 40.2 s |
| WebGL error | 0 | 0 |

These are cold/live network refinement timings, not FPS or frame-time improvements. The public dynamic services can be slow. The snapshots had additional guard-region work outstanding and do not establish that every background request had completed. Two preferred imagery exports failed upstream CORS checks and recovered through the public NAIP alternative; all sampled visible terrain reached fine imagery. There were no JavaScript exceptions. Captured console messages retain the two network failures (four messages), rather than concealing them. No default commercial imagery requests were observed.

The first-person screenshots include snow at this route position; a fine requested zoom does not imply texture detail where the source is uniform. [Overview](sources/overview.png) shows the actual public imagery over snow, rock and forest.

### Controls, attribution and global imagery

[Focused controls harness](sources/browser-controls.mjs), [result](sources/controls.json), [mobile screenshot](sources/mobile.png).

A separate fresh browser check confirms mobile Fit terrain centres the model in the view, avoids horizontal overflow at 390 × 844, and keeps credits within the viewport. The original first-person harness held a camera-turn override into its final mobile step; that test-only override is now restored before leaving first-person mode. The separate controls result and screenshot are the mobile-fit evidence.

The in-app source link serves successfully. An actual EOX Z15 tile over the Swiss Alps loaded with CORS-readable canvas pixels, 256 × 256 dimensions and non-uniform image data. Controls/global checks had no JavaScript, console or WebGL errors.

No Quest device was connected. On-headset frame timing, thermals, memory pressure, source clarity and HUD readability still require device validation. Desktop screenshots and selected Quest budgets do not certify headset performance.

## Reproduction and release

The browser scripts expect a built `dist`, the local Edge installation and the Codex Playwright dependency path recorded in each script. They create their own Vite preview process and close it in `finally`. Generated intermediate output lives in ignored `.review-cache`; only the named evidence above is archived here.

Release uses the repository's checkpoint workflow: commit and push, require green GitHub CI, rebuild the clean commit, publish to Surge, then compare hosted build metadata and script with local output and run the hosted controls smoke check. Build metadata records the exact commit and clean-tree status.
