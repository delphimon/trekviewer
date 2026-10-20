# Preserve the DEM's actual geographic footprint

The current USGS elevation request allowed the service to change its geographic footprint while the app continued sampling heights against the original footprint. The correction explicitly requests `adjustAspectRatio=false`. It applies to both the base model and local elevation exports, without changing the selected source, raster dimensions, lossless F32/LERC precision, geometry budgets or geographic coverage.

The [ArcGIS export documentation](https://developers.arcgis.com/rest/services-reference/enterprise/export-image/) explains that the default adjusts the bounding box to match the image aspect ratio. The app already expands the requested bounds by half a sample to place the outer geographic coordinates on sample centres. A second, implicit service adjustment invalidated that mapping for rectangular rasters.

## Reproduced with the live service

The [recorded requests and returned extents](dem-registration/registration.json) use the same padded Olympus/Bailey footprint as the failed native baseline. Both responses are 1024×675. Converting the returned pixel-edge extents to sample centres gives:

| Request | Maximum outer-sample position error at this latitude |
| --- | --- |
| Previous default | **8.517 m**, on the north/south sides |
| Explicit footprint preservation | **0 m** within the returned numeric precision |

This is a stretch around the raster centre, not an 8.5 m translation of the whole model. It measures registration against the requested coordinates, not elevation accuracy against a survey. The corrected binary export also passed full coverage and finite-height checks: **1024×675**, **2,764,870 bytes**, zero LERC error tolerance, approximately **114.19–2406.26 m**. Its encoded bytes remain local in ignored review storage.

Reproduce with `node --experimental-transform-types scripts/audit-dem-registration.mjs`. The audit makes two metadata exports and one binary export, each with a 20-second deadline. It writes no credentials or room/head/controller data.

The additional URL parameter gives corrected bytes their own persistent-cache key. Existing bytes remain stored; they are not silently reused under the corrected mapping or removed by a bulk cache clear. Regression checks cover the recorded non-square service response and separation of old/new cache keys, alongside the existing full-precision decode and sampler checks. The earlier small Rainier binary fixture retains its original capture metadata.

## Production and regression checks

`npm run verify` passes source/test types, **654 Windows tests with five platform-specific skips**, and the production build. The desktop/mobile tour driver passes controls, playback, camera clearance, GPX recovery and layout checks with no page exceptions.

The [live DEM browser driver](dem-registration-browser.mjs) uses the production app, real USGS elevation and a single-route manifest fixture. A desktop Edge test user agent selects the saved Quest run's geometry budget; it is not a native rendering test. It confirms a real 1024×675 Olympus DEM, the unchanged 434×286-cell base mesh, valid graphics state and persisted whole-model byte reuse on reload. Imagery and broad tiled refinement are disabled for this focused check; the legacy local elevation path can still issue separate requests. Publication and exact hosted-client verification are recorded after the app checkpoint.

## Imagery comparison and remaining work

A separate [browser probe](imagery-comparison-browser.mjs) requests identical Z19 Olympus crops from current imagery services and the earlier Esri path. The [point result](dem-registration/imagery-comparison.json) records Esri returning a 256×256 tile in about **319 ms**; the two USGS fine exports exceeded this probe's **12-second** deadline, and GeoPlatform's browser fetch failed. This does not establish service availability across the route, a sustained timing comparison, or that a 256-pixel image contains finer native photography. The probe's deadline is shorter than the app's existing 35-second public-source timeout. No provider order, fine-detail fallback or timeout policy is changed here.

The user confirmed an existing Cesium ion account with Bing access. No ion token is configured in this workspace or process, and its local location has been requested without asking for a token in chat. Account-specific availability, current endpoint metadata and imagery/attribution behavior still need verification before selecting that path. Esri access in the point probe does not establish an eligible account/plan. [Cesium's current guide](https://cesium.com/learn/ion/content-usage-and-attribution-guide/) still only guarantees Bing availability at least through September 2026; the October account must be checked directly.

This correction does **not** establish recovery from the user's flat-looking terrain or poor sharpness report. Whole-model base cells remain about 94 m and base source sampling about 44 m; fine local DEM sampling does not describe the entire model. Native performance/quality, eligible Bing versus public imagery, earlier Terrarium versus current elevation, whole-model ridge fidelity and batching/HUD work remain open under [checkpoint 0f](../COMPLETION_PLAN.md).
