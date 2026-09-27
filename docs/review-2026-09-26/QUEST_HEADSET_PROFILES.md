# Quest 3 headset profile comparison

Measured on Meta Quest 3 in Quest Browser with the same `c315e40-2026-09-27T05:12:09.407Z` build, Rainier tabletop view and Aerial imagery. Three opt-in JSON sessions were downloaded from the headset on 2026-09-26 (Pacific time). The raw session files are kept outside the repository because they include device and route metadata.

The table uses one-second windows beginning at least five seconds after `xr-session-start`. A *stable* window has 100% selected imagery coverage and no tile requests in flight. Values are medians across stable windows, so they describe typical one-second periods rather than the entire run. The second High run was shorter and much slower than the first; the runs were not controlled for pose, movement, thermal state, or background work.

| Metric, stable XR windows | High run 1 | High run 2 | Balanced run |
| --- | ---: | ---: | ---: |
| XR session length | 95.2 s | 42.2 s | 58.5 s |
| Stable windows sampled | 70 | 25 | 40 |
| Browser callback cadence | 52.7/s | 34.8/s | 61.6/s |
| Callback interval p95 within a window | 43.3 ms | 121.8 ms | 29.6 ms |
| JavaScript plus renderer submission p95 | 32.2 ms | 36.9 ms | 9.3 ms |
| Imagery update mean per callback | 3.19 ms | 6.50 ms | 0.52 ms |
| Render submission mean per callback | 4.51 ms | 3.31 ms | 2.59 ms |
| Draw calls | 214 | 168 | 114 |
| Triangles | 560,632 | 550,248 | 162,592 |
| Selected imagery patches | 48 | 48 | 28 |

The Balanced session substantially reduced JavaScript submission cost while maintaining complete coverage of its **selected** imagery footprint in the stable windows. It rendered roughly 70% fewer triangles than High. Some of the gain is an explicit fidelity tradeoff: Balanced permits fewer and less detailed terrain/imagery patches. A coverage value of 100% does not mean identical geographic area or resolution between presets. The headset user reported that the detail loss in Balanced is noticeable, so its better timing does not make it an acceptable replacement for High by itself.

The High sessions remained slow after network loading finished, so tile downloads alone do not explain the issue. `ImageryLODManager.evaluateLOD` also raycasts against the rendered terrain when the inspection pose changes; High evaluates more often and uses more terrain geometry. That is a plausible contributor to the imagery phase difference, **not yet a measured root cause**. The render path and extra geometry also cost time. A targeted on-headset phase trace would be needed to assign those costs confidently.

These JSONs measure browser callbacks and main-thread work through WebGL submission. They do **not** provide compositor-delivered FPS, GPU frame time, reprojection/stale-frame count, battery temperature, or thermal throttling. Quest Browser did not expose an XR target refresh rate to the recorder, so missed callbacks cannot be counted reliably. OVR Metrics Tool or Meta's WebXR performance tooling is needed before claiming that either preset meets a device frame-rate target over a longer session.

Keep High as the fidelity default and Balanced as an explicit performance option. Profile the terrain raycast, patch reconciliation, and rendering costs within High; then remove redundant work without shrinking its imagery footprint or terrain shape. Repeat a controlled sequence with comparable movement, a longer duration, and device GPU/FPS/thermal metrics before declaring a sustained performance target met.
