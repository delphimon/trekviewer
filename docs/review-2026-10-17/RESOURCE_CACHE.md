# Persistent source caching for personal/internal use

The user clarified October 17 that TrekViewer is for personal/internal use, with no public product release planned. Free API-key imagery, DEM and lidar-derived data are eligible: select for verified native detail, coverage, latency and zero-cost terms rather than rejecting a service because it requires a key. Private credentials must stay out of committed code and hosted bundles. Existing static test deployment does not make an embedded private credential private.

## Implemented

Reviewed USGS imagery/topo/names, 3DEP elevation, AWS Terrarium and EOxCloudless responses now have an IndexedDB source cache. It stores original encoded bytes; neither imagery nor floating-point elevation is recompressed, resized or quantized for storage. Shared 1024-pixel imagery exports remain shared, and the existing exact 256-pixel crop path supplies textures. Elevation is cached only after successful LERC decoding and full coverage validation. Raw-byte caching does not change source-native accuracy or mesh resolution.

- Disk: **256 MiB / 4,096 resources**, seven-day expiry from download, least-recent-use eviction in an atomic metadata/body transaction.
- Pending writes: at most **32 sources / 32 MiB**; batched after 250 ms and never awaited by normal tile publication. There is no background prefetch or route-wide download.
- Reads: database-open timeout 500 ms, read transaction timeout 150 ms. Missing, denied, blocked or slow storage falls through to normal loading. Writes have a two-second deadline; quota/write failures pause saving while existing entries remain reusable.
- Transfers: enforce eight MiB for encoded image responses and 32 MiB for elevation while streaming, including responses without Content-Length. These exceed normal 256/1024-pixel source sizes; they do not reduce requested source detail.
- Recovery: corrupt image bytes are removed and refetched; corrupt persisted LERC is removed, refetched and validated before publication. Aborted user requests remain aborted. Generation checks prevent pre-clear writes from restoring stale data; disabling during a transaction does not delete prior cached entries.
- Settings: **Cache on this device**, committed storage usage and **Clear saved terrain & imagery**. Pausing persists on the device. Clear removes this resource database's bodies/metadata, not saved profile reports, GPX files or account state.
- Opt-in profile windows: cache hits, misses, writes and write-failure state. Source reporting continues to identify the requested successful service even when image decoding uses a temporary object URL. Object URLs are revoked after decoding.

The allowlist matches exact reviewed HTTPS hosts/service paths and excludes credential-bearing URLs and optional commercial services. Optional keyed services need their own terms/key-handling integration before this cache admits them. GeoPlatform remains a configured network alternative, with its existing browser-access limitations; it is not added to the persistent allowlist in this checkpoint. Ordinary browser HTTP caching still applies to other eligible resources.

Cached alternatives preserve the existing preferred-source order. An unavailable uncached preferred service can still need probing before a stored alternative is tried. The cache is not a full offline application or a complete downloaded region, and browser storage can be reclaimed. Disk capacity does not increase decoded/GPU memory budgets or certify headset frame delivery.

## Verified zero-cost API candidates

Primary documents were checked October 17, 2026. These are candidates, not newly enabled providers or proof of finer coverage at a specific route.

| Candidate | Verified access and relevant limits | Integration consequence |
| --- | --- | --- |
| [LINZ Basemaps](https://www.linz.govt.nz/guidance/data-service/linz-basemaps-guide/linz-basemaps-documentation) | Standard and developer API access have no charge; standard keys renew after 90 days. [Attribution is mandatory](https://www.linz.govt.nz/products-services/data/licensing-and-using-data/attributing-linz-basemaps-data). | Strong regional imagery candidate for NZ imports, with an eligible key, coverage and contributor attribution. Needs actual keyed browser validation before enabling. |
| [MapTiler Cloud Free](https://www.maptiler.com/cloud/pricing/) | No card needed; currently 100,000 API requests/month, personal/noncommercial terms and required branding. [Free access suspends at quota; paid plans charge extra](https://docs.maptiler.com/guides/account/sessions-vs-requests/). [Terms permit temporary individual-device caching and restrict bulk downloads/proxying](https://www.maptiler.com/terms/cloud/). | Evaluate exact satellite coverage and 3D/branding conditions against the internal use, with the Free plan retained. Do not treat a paid account's included allowance as a zero-cost guarantee. |
| [OpenTopography](https://opentopography.org/developers) | Non-academic free global DEM access currently allows 50 calls/day; keys cannot be public/shared. Its USGS 1 m raster API is restricted to academic users. | Private/local data preparation or a private backend, with applicable dataset terms and eligibility. A global 30 m DEM is not a fidelity upgrade over existing local 3DEP lidar-derived coverage. |

For bundled US routes, public 3DEP already accesses lidar-derived terrain without an account. Free registration alone does not establish better data. Regional source integration, route-wide provenance and native acceptance remain open in the completion plan.

## Validation

`npm run verify` passed types, **596 Windows tests with five POSIX-only skips**, and production build. Focused checks cover source/credential admission, exact binary data, declared/chunked response limits, unavailable/denied storage, persisted LERC reuse and corrupt-LERC recovery.

The [production browser harness](resource-cache-browser.mjs) uses actual Edge WebGL and IndexedDB with **HTTP cache disabled**. Preferred/GeoPlatform imagery is deliberately aborted to make the public alternative reproducible. Its [recorded result](resource-cache/browser.json) verifies:

- 27 source files / approximately 17 MiB committed in the recorded cold run; 18 persistent hits and zero new writes in the sampled warm phase. Counts vary with the asynchronous streaming work that settles before each snapshot.
- The selected fine export causes zero repeat HTTP requests after reload. Full 256×256 RGBA hashes match before/after reload and after corrupt-image recovery.
- The base USGS elevation Float32 hash matches after reload, and previously stored elevation URLs cause no repeat HTTP requests in the checked interval.
- Corrupt image data causes exactly one refetch of that export, restoring identical decoded pixels.
- Actual database transactions enforce expiry, oldest-first eviction and byte budget. Eviction uses synthetic metadata pressure, not a claimed physical quota-exhaustion test or a 320 MiB fixture allocation.
- Clear rejects stale-generation writes, the Settings opt-out survives reload, saved resources clear successfully, and JavaScript/WebGL errors are zero.
- Saved profile windows contain cache counters, and clearing resources preserves the completed profile across reload. The final focused recorder/cache/elevation run passed all 21 tests.

Browser reload evidence is not native Quest acceptance or a GPU/FPS measurement. Headset testing remains deferred by the user; the latest published client must be prepared again when testing resumes.
