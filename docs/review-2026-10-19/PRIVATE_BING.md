# Private Bing Aerial comparison

The user supplied a local provider configuration after confirming an existing Cesium ion account. A redacted [account probe](private-bing/account.json) confirms HTTP 200 for the configured Bing imagery endpoint. The existing Bing adapter also initialized successfully and retrieved the matching Olympus Z19 tile. This confirms current account access, rather than inferring October availability from Cesium's September guarantee.

## Launch without a published token

The production bundle replaced the previous `globalThis.process.env` compatibility fallback with an empty object. Supplying that object in the browser therefore did not select Bing. `TextureProvider` now supports an explicit launch object in browser memory, `globalThis.__TREK_VIEWER_PROVIDERS__`, with `provider: 'cesium-bing'` and a valid `ionToken`. The private launcher supplies it before application startup and removes it once initialization completes. No configuration file, token or credential is added to the hosted assets, browser storage or profile diagnostics.

A token without the explicit provider selection does not change the public default. Invalid/oversized tokens use the existing public fallback and generic failure reason. Existing awaited initialization, provider-specific tile cache keys and timeout behavior remain in place. A regular page refresh, without the private bootstrap, returns to public imagery. This is a session configuration for a controlled comparison, not a new account-management UI.

The [production browser test](private-bing-browser.mjs) reads the user-selected file only in its local Node process. Set `TREK_LOCAL_PROVIDERS_PATH` to that file and run `node docs/review-2026-10-19/private-bing-browser.mjs`. It scans emitted HTML/JS/JSON for the actual credential without printing it; verifies live Cesium and Bing metadata, a 256×256 Olympus tile through the production loader, removal of the bootstrap, and return to public defaults after refresh. Output contains only whitelisted fields. [Local production result](private-bing/browser.json). The observed tile timing is a desktop source test, not native frame performance or subjective sharpness acceptance.

Five regressions cover explicit private selection, diagnostics exclusion, initialization after bootstrap removal, no implicit selection from a token alone, and invalid token fallbacks. `npm run verify` passes **659 Windows tests with five platform-specific skips**, source/test types and the production build.

App commit **`2099bf6`** passed [CI](https://github.com/delphimon/trekviewer/actions/runs/39380654021), was rebuilt cleanly, and was published to the existing test site. Both the [private-source check](private-bing/hosted-2099bf6.json) and [desktop/mobile regressions](private-bing/hosted-tour-2099bf6.json) passed on exact entry `index-t14YXxJA.js`, build `2099bf6-2026-10-20T06:29:25.327Z`. The hosted private-source check verifies successful metadata, original-size tile decoding, bootstrap removal, default restoration on refresh and no page exceptions. This later evidence-only commit retains that verified app on the site.

## Comparison scope

The prepared comparison uses **Aerial**, Olympus/Bailey progress 0.3555875547854273, High, 1× exaggeration, paused tour/1×. The [DEM footprint correction](DEM_REGISTRATION.md) remains active. No Google 3D Tiles or Cesium terrain replacement is enabled by this launch support.

The existing Hybrid implementation combines aerial imagery with an Esri reference overlay. That style needs correction before broader Bing rollout: [Cesium's current guide](https://cesium.com/learn/ion/content-usage-and-attribution-guide/) disallows combining its Bing assets with non-Bing imagery/maps and requires attribution and a prominent Cesium logo for non-Cesium renderers. Dynamic credits/logo presentation and all-style behavior remain integration work. The source and launch tests here do not close those gates or certify a complete Bing integration. Use Aerial for the controlled comparison.

The connected Quest browser was verified on that exact published entry with `cesium-bing` active, then prepared at the position/settings above. Preparation finished outside XR. The private bootstrap was removed after initialization; refreshing the tab requires another private launch to select Bing again. Bounded host report capture was attached, without CPU sampling, before requesting the user's MR check. Preparation/attachment are not a completed native run.

The subsequent [completed Bing native run](NATIVE_BING.md) also failed acceptance. The user reports about the same, less detailed DEM, slow loading and missing hiker follow. It contains only 19.115 seconds of playing and does not certify a full tour. Public defaults remain unchanged for other clients; new follow/acquisition changes still require native acceptance.
