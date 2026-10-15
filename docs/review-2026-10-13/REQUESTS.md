# Shared imagery export scheduling

This checkpoint fixes a loading bottleneck introduced when neighbouring fine tiles began sharing a public imagery export. Previously, all six LOD loading slots could wait on different crops of the same 1024 × 1024 image. The image cache correctly deduplicated the export, but other visible regions waited in the queue while only one export was downloading.

Providers can now identify tiles sharing an export. The LOD scheduler admits one pending consumer per group and fills available slots with the next distinct groups in the existing priority order. After an export completes, its remaining crops consume the cached image. Completion and failure wake the queue directly. Cancelled groups release their slots immediately, and stale completions cannot release slots belonging to newer work.

Aerial admits at most four distinct groups, matching the four-source image cache. Hybrid admits at most two geographic groups because each can retain both aerial and label images. Both remain below the existing six-request LOD limit. Providers without shared exports keep their previous ordered scheduling. Group identity is computed when requests enter the queue, rather than reconstructing geographic bounds for every skipped duplicate.

## Fidelity and bounds

- Tile coordinates, imagery URLs, PNG crops, provider resolution limits, chosen terrain, broad High coverage, and terrain/imagery publication rules are unchanged.
- Each fine tile still receives its exact 256 × 256 region from the 1024 × 1024 export. No output is downsampled to improve the timing.
- The shared-source cache still holds at most four exports / 16 MiB, within the same overall decoded-image byte budget. Resident terrain and GPU patch budgets are unchanged.
- Public-service outages, CORS failures and fallback latency remain possible. This changes scheduling, not service availability.

## Controlled scheduling measurement

[Reproduction script](requests/benchmark-requests.mjs), [results](requests/benchmark.json).

The production LOD scheduler receives 192 selected tiles sharing twelve exports. Each export has a fixed simulated 100 ms latency. Both policies use shared-request deduplication and a four-source LRU. The previous policy is reproduced by withholding the new optional provider scheduling hint; the source grouping, network model and selected tiles remain identical.

| Measurement | Previous tile-slot policy | Distinct-export policy |
| --- | --- | --- |
| Simulated refinement completion | 1,200 ms | 300 ms |
| Export requests | 12 | 12 |
| Maximum concurrent exports | 1 | 4 |
| Maximum concurrent tile consumers | 6 | 4 |
| Peak retained source bytes | 16 MiB | 16 MiB |
| Tiles mounted | 192 | 192, identical keys |

This establishes the scheduling improvement under fixed latency. It is not an application FPS, GPU timing, CPU benchmark, or guaranteed fourfold real-world speedup.

## Regression and browser checks

`npm run verify` passes source/test TypeScript checks, **537 tests** with five POSIX-only Windows skips, and the production build. Linux CI also runs those five tests. [Verification log](requests/verify.log).

Seven new regression cases cover export identity across zooms/regions, distinct-source admission, completion without another view update, ordinary-provider ordering, Hybrid source capacity, cancelled/stale work and failed-source retries. Existing cache, atomic promotion, coverage and source-quality tests remain in the suite. Build advisories about the main chunk size and the Node-only LERC branch remain; actual browser worker decoding succeeds.

The [live-source browser harness](sources/browser-sources.mjs) runs real Edge WebGL on RTX 4060 / ANGLE D3D11. Its Quest user-agent selects Quest High budgets only. It checks the same Rainier progress-0.4 view and 25° turn as the source checkpoint, 25 screen rays per view, fine imagery, native USGS local grids, approximately 5 m mesh cells, vertex limits, WebGL status, and unique pending export groups. Sky rays are excluded from terrain-hit counts. Mobile fitting restores the test camera override before leaving first-person mode.

Live results, including service timing and any network messages, are archived in `requests/aerial` and `requests/hybrid`. Snapshot success means all sampled visible terrain hits had detail; additional guard-region downloads can remain queued. The earlier source checkpoint's [110.5 s / 40.2 s observations](SOURCES.md) are useful context, not a controlled network comparison.

| Final live run | Aerial | Hybrid |
| --- | --- | --- |
| Walking: all 25 terrain hits have Z19 imagery and USGS local grids | 5.1 s | 15.2 s |
| Turned: all 23 terrain hits have the same detail (two sky rays excluded) | 20.2 s | 15.2 s |
| Pending grouped requests at snapshots | 4 distinct groups | 2 distinct groups |
| Retained native chunks, walking / turned | 37 / 48 | 49 / 51 |
| Local vertices, walking / turned | 348,133 / 451,632 | 461,041 / 479,859 |
| JavaScript exceptions / WebGL errors | 0 / 0 | 0 / 0 |

[Aerial result](requests/aerial/browser.json), [Hybrid result](requests/hybrid/browser.json), [aerial mobile fit](requests/aerial/mobile.png), [Hybrid mobile fit](requests/hybrid/mobile.png). Each snapshot stayed below the 800,000-vertex Quest High resident limit, and sampled mesh cells stayed at approximately 5 m. No default commercial-provider requests were observed. Hybrid made 22 public GNIS label requests.

The final Aerial run had two preferred-export CORS failures, which recovered through the public NAIP fallback; all four corresponding console messages are retained in the result. Hybrid had no console warnings/errors. These live timings use separate fresh browser contexts, but upstream service/CDN cache state is uncontrolled and may be warm. An [earlier Aerial pass](requests/aerial-initial.json) during this checkpoint took 25.2 s / 15.1 s with no network messages; these observations show variability and should not be presented as a guaranteed latency bound.

No Quest was connected through Meta's device tools. Following the [Meta WebXR profiling workflow](https://developers.meta.com/vr/documentation/web/webxr-perf-workflow), actual headset CPU/GPU timing, thermal behaviour and subjective clarity remain device checks; these desktop measurements do not certify them.

## Reproduction

After `npm run build`, run the controlled script with Node's TypeScript transformation support:

```powershell
node --experimental-transform-types docs/review-2026-10-13/requests/benchmark-requests.mjs
```

The browser harness records its local Playwright and Edge paths and starts/closes its own preview server. For aerial, set `TREK_SOURCES_OUT=.review-cache/requests/aerial` and `TREK_SOURCE_STYLE=satellite`; for Hybrid use `.review-cache/requests/hybrid` and `hybrid`. Then run `node docs/review-2026-10-13/sources/browser-sources.mjs`. These runs need network access to the public providers and must run sequentially because they share the preview port.
