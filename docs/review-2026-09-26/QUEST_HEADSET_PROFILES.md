# Quest 3 headset profile comparison

Measured on Meta Quest 3 in Quest Browser with the same `c315e40-2026-09-27T05:12:09.407Z` build, tabletop view and Aerial imagery. Four opt-in JSON sessions were downloaded from the headset on 2026-09-26 (Pacific time). **High runs 1 and 2 and Balanced run 2 used Olympus and Bailey Range June 2026; Balanced run 1 used Mount Rainier via Emmons.** The Rainier run is useful for understanding range but must not be treated as a controlled High/Balanced comparison. The raw session files are kept outside the repository because they include device and route metadata.

These reports record the `satellite` style but did not record the active provider. The token in the localhost production build currently receives Cesium HTTP 403 for the localhost referrer and HTTP 200 for the hosted site's referrer, so Esri fallback is likely for these USB-forwarded sessions. Their measured performance must not be assumed to represent Cesium Bing imagery. Later reports explicitly record the active provider.

The table uses one-second windows beginning at least five seconds after `xr-session-start`. A *stable* window has 100% selected imagery coverage and no tile requests in flight. Values are medians across stable windows, so they describe typical one-second periods rather than the entire run. The runs were not controlled for pose, movement, thermal state, or background work.

| Metric, stable XR windows | High run 1 | High run 2 | Balanced run 1 | Balanced run 2 |
| --- | ---: | ---: | ---: | ---: |
| Route | Olympus/Bailey | Olympus/Bailey | Rainier/Emmons | Olympus/Bailey |
| XR session length | 95.2 s | 42.2 s | 58.5 s | 57.4 s |
| Stable windows sampled | 70 | 25 | 40 | 35 |
| Browser callback cadence | 52.7/s | 34.8/s | 61.6/s | 49.1/s |
| Callback interval p95 within a window | 43.3 ms | 121.8 ms | 29.6 ms | 82.5 ms |
| JavaScript plus renderer submission p95 | 32.2 ms | 36.9 ms | 9.3 ms | 30.5 ms |
| Imagery update mean per callback | 3.19 ms | 6.50 ms | 0.52 ms | 2.77 ms |
| Render submission mean per callback | 4.51 ms | 3.31 ms | 2.59 ms | 4.17 ms |
| Draw calls | 214 | 168 | 114 | 182 |
| Triangles | 560,632 | 550,248 | 162,592 | 463,108 |
| Selected imagery patches | 48 | 48 | 28 | 28 |
| Retained local terrain chunks | 3 | 3 | 3 | 4 |

The fast Balanced run used a different route. On the matched Olympus/Bailey route, Balanced's median JavaScript submission p95 was 30.5 ms versus 32.2 and 36.9 ms for High, while median callback cadence was 49.1/s versus 52.7/s and 34.8/s. This small, variable improvement does **not** establish that Balanced solves the slowdowns. Balanced rendered about 16–17% fewer triangles than High on Olympus/Bailey, despite allowing 28 rather than 48 selected imagery patches. The chunk count is a count of retained chunks, not visible chunks. A coverage value of 100% means complete coverage of the **selected** footprint, not identical geographic area or resolution between presets. The headset user reported that the detail loss in Balanced is noticeable.

Several sessions remained slow after network loading finished, so tile downloads alone do not explain the issue. `ImageryLODManager.evaluateLOD` raycasts against the rendered terrain when the inspection pose changes; High evaluates more often and uses more terrain geometry. The first four sessions could not isolate that cost. Build `989c573` added opt-in timings for terrain raycasting, tile selection, and reconciliation; none of the measurements in the table include those timings.

A fifth, 85-second Olympus/Bailey High XR session on build `989c573` confirmed the CPU attribution. Across the recorded session, raycasting averaged 4.64 ms per callback out of 4.90 ms for the entire imagery update (about 95%). In the 58 stable windows at least five seconds after XR entry, median per-callback raycasting was 4.84 ms; the worst individual raycast took 48.9 ms. Tile selection and reconciliation averaged 0.02 ms and 0.16 ms per callback. Median stable-window JavaScript submission p95 was 36.65 ms and callback cadence was 42.0/s. This is still browser CPU timing, not headset GPU time.

Build `47a52a3` tried a bounding-volume hierarchy for those same rendered-triangle hits while preserving the High terrain and imagery budgets. A 74-second Olympus/Bailey High headset session showed lower **stable-window median** raycast cost (0.36 ms per callback), CPU submission p95 (7.6 ms), and higher callback cadence (61.0/s). It also showed recurring raycast spikes around 100–123 ms when the visible tabletop terrain changed, including long stalls well after startup. This version is therefore unsuitable despite the typical-window improvement.

The next change replaces the hierarchy with traversal of the terrain's regular grid cells. It checks the same rendered triangles and honors the base mesh's compacted index range, without rebuilding a tree after local DEM promotion. Exact-hit regression tests compare results with Three.js's raycaster across transformed terrain, visible refinement, changed indices and heights, multiple ray angles, and material sides. A new on-headset High session is required to verify both the typical cost and the worst-case stalls.

These JSONs measure browser callbacks and main-thread work through WebGL submission. They do **not** provide compositor-delivered FPS, GPU frame time, reprojection/stale-frame count, battery temperature, or thermal throttling. Quest Browser did not expose an XR target refresh rate to the recorder, so missed callbacks cannot be counted reliably. OVR Metrics Tool or Meta's WebXR performance tooling is needed before claiming that either preset meets a device frame-rate target over a longer session.

Keep High as the fidelity default and Balanced as an explicit performance option. Profile the terrain raycast, patch reconciliation, and rendering costs within High; then remove redundant work without shrinking its imagery footprint or terrain shape. Repeat a controlled sequence with comparable movement, a longer duration, and device GPU/FPS/thermal metrics before declaring a sustained performance target met.
