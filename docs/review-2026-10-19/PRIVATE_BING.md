# Private Bing Aerial comparison

The user supplied a local provider configuration after confirming an existing Cesium ion account. A redacted [account probe](private-bing/account.json) confirms HTTP 200 for the configured Bing imagery endpoint. The existing Bing adapter also initialized successfully and retrieved the matching Olympus Z19 tile. This confirms current account access, rather than inferring October availability from Cesium's September guarantee.

## Launch without a published token

The production bundle replaced the previous `globalThis.process.env` compatibility fallback with an empty object. Supplying that object in the browser therefore did not select Bing. `TextureProvider` now supports an explicit launch object in browser memory, `globalThis.__TREK_VIEWER_PROVIDERS__`, with `provider: 'cesium-bing'` and a valid `ionToken`. The private launcher supplies it before application startup and removes it once initialization completes. No configuration file, token or credential is added to the hosted assets, browser storage or profile diagnostics.

A token without the explicit provider selection does not change the public default. Invalid/oversized tokens use the existing public fallback and generic failure reason. Existing awaited initialization, provider-specific tile cache keys and timeout behavior remain in place. A regular page refresh, without the private bootstrap, returns to public imagery. This is a session configuration for a controlled comparison, not a new account-management UI.

The [production browser test](private-bing-browser.mjs) reads the user-selected file only in its local Node process. Set `TREK_LOCAL_PROVIDERS_PATH` to that file and run `node docs/review-2026-10-19/private-bing-browser.mjs`. It scans emitted HTML/JS/JSON for the actual credential without printing it; verifies live Cesium and Bing metadata, a 256×256 Olympus tile through the production loader, removal of the bootstrap, and return to public defaults after refresh. Output contains only whitelisted fields. [Local production result](private-bing/browser.json). The observed tile timing is a desktop source test, not native frame performance or subjective sharpness acceptance.

Five regressions cover explicit private selection, diagnostics exclusion, initialization after bootstrap removal, no implicit selection from a token alone, and invalid token fallbacks. `npm run verify` passes **659 Windows tests with five platform-specific skips**, source/test types and the production build. Hosted checks and headset preparation follow the clean app publication.

## Comparison scope

The prepared comparison uses **Aerial**, Olympus/Bailey progress 0.3555875547854273, High, 1× exaggeration, paused tour/1×. The [DEM footprint correction](DEM_REGISTRATION.md) remains active. No Google 3D Tiles or Cesium terrain replacement is enabled by this launch support.

The existing Hybrid implementation combines aerial imagery with an Esri reference overlay. That style needs correction before broader Bing rollout: [Cesium's current guide](https://cesium.com/learn/ion/content-usage-and-attribution-guide/) disallows combining its Bing assets with non-Bing imagery/maps and requires attribution and a prominent Cesium logo for non-Cesium renderers. Dynamic credits/logo presentation and all-style behavior remain integration work. The source and launch tests here do not close those gates or certify a complete Bing integration. Use Aerial for the controlled comparison.

The last completed native performance run remains the failed `9cc6afa` baseline. A new matched native run is still required before accepting visual quality, frame delivery or time-to-sharp. Public defaults remain unchanged for other clients.
