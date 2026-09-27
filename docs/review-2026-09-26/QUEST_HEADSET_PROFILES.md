# Quest 3 headset profile comparison

Measured on Meta Quest 3 in Quest Browser with the same `c315e40-2026-09-27T05:12:09.407Z` build, tabletop view and Aerial imagery. Four opt-in JSON sessions were downloaded from the headset on 2026-09-26 (Pacific time). **High runs 1 and 2 and Balanced run 2 used Olympus and Bailey Range June 2026; Balanced run 1 used Mount Rainier via Emmons.** The Rainier run is useful for understanding range but must not be treated as a controlled High/Balanced comparison. The raw session files are kept outside the repository because they include device and route metadata.

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

Several sessions remained slow after network loading finished, so tile downloads alone do not explain the issue. `ImageryLODManager.evaluateLOD` raycasts against the rendered terrain when the inspection pose changes; High evaluates more often and uses more terrain geometry. That is a plausible contributor to the imagery phase difference, **not yet a measured root cause**. The render path and extra geometry also cost time. Build `989c573` adds opt-in timings for terrain raycasting, tile selection, and reconciliation; it was built and served locally after these four sessions, so none of the measurements in this table include those timings.

These JSONs measure browser callbacks and main-thread work through WebGL submission. They do **not** provide compositor-delivered FPS, GPU frame time, reprojection/stale-frame count, battery temperature, or thermal throttling. Quest Browser did not expose an XR target refresh rate to the recorder, so missed callbacks cannot be counted reliably. OVR Metrics Tool or Meta's WebXR performance tooling is needed before claiming that either preset meets a device frame-rate target over a longer session.

Keep High as the fidelity default and Balanced as an explicit performance option. Profile the terrain raycast, patch reconciliation, and rendering costs within High; then remove redundant work without shrinking its imagery footprint or terrain shape. Repeat a controlled sequence with comparable movement, a longer duration, and device GPU/FPS/thermal metrics before declaring a sustained performance target met.
