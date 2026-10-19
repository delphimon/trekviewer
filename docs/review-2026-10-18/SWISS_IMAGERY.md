# Swiss aerial imagery and revision-aware caching

This checkpoint advances completion-plan source coverage for imported routes. Swiss imports can now use current SWISSIMAGE aerial detail instead of only the approximately 10 m global mosaic. No API key or account is required. Other no-charge keyed services remain eligible under the user's personal/internal-use policy; they are not newly enabled by this change.

## Verified source and fidelity limits

Official [SWISSIMAGE product documentation](https://www.swisstopo.admin.ch/en/orthoimage-swissimage-10) describes native 10 cm imagery in plains/main valleys and 25 cm Alpine imagery. The current [EPSG:3857 capabilities](https://wmts.geo.admin.ch/EPSG/3857/1.0.0/WMTSCapabilities.xml) advertise `ch.swisstopo.swissimage-product`, PNG and JPEG, current time, and matrix set `3857_20`. We use the product's masked PNG endpoint, not the separate background layer that includes coarser neighboring-country satellite imagery. The URL follows the official [XYZ service documentation](https://docs.geo.admin.ch/visualize-data/xyz.html).

The service/terms were checked October 18, 2026. [Swisstopo's OGD terms](https://www.swisstopo.admin.ch/en/terms-of-use-free-geodata-and-geoservices) permit free use with source attribution and allow excessive-service restrictions. Visible attribution includes ©swisstopo and the product's required Planet acknowledgement for satellite imagery used in large lakes. The current mosaic contains different acquisition dates; the cache revision is not a flight date. [Live point checks](swiss-imagery/tiles.json) and [revision response](swiss-imagery/cache-update.json) preserve the service evidence without storing credentials or private headset data.

Detail uses exact 256×256 Z16–Z19 PNGs, with existing sRGB, mipmapping, anisotropy and geographic draping. Z19 ground sampling around the tested latitude is about 0.21 m: source-native 10 cm detail is not fully resolved, and a 25 cm photograph does not become a native 0.21 m survey. The current Z19/working-set constraints are explicit remaining fidelity limits. This change does not add Swiss DEM/lidar: the imported test route still reports **Mapzen Terrarium fallback**. Detailed photographs can therefore be draped over coarser geometry; no terrain accuracy improvement is claimed.

## Coverage and performance

The capabilities envelope is an eligibility rectangle, not a country polygon or guaranteed survey coverage. Every original alpha pixel must be 255 before publication. Even a one-pixel masked border rejects the fine tile; opaque white snow remains valid. The result is remembered in a WeakMap for that image so validation is not repeated by the publication path. Validation canvases are released immediately.

The complete route overview stays on global EOxCloudless at Z15 or below. A separate optional overview ceiling prevents narrow Swiss imports from building an incomplete Z16 base composite. Fine source failures retain that base/previous published coverage, follow existing bounded retry/negative-cache behavior, and never publish an enlarged overview under a fine key. Real sampled Germany/France tiles returned transparent PNGs and were rejected; sampled Grindelwald/Zermatt tiles returned complete 256×256 PNGs. Partial-border behavior is also covered by an exact one-pixel unit test.

No new frame-loop network calls, geographic reprojection, quality-profile changes, memory-budget increases or peripheral resolution reductions are introduced. Native GPU/frame pacing remains unmeasured. Border regions inside the broad service envelope can request unavailable detail; whole-tile mask rejection favors complete coverage, and full cross-border precision remains limited by the retained overview.

## Cache freshness

Swiss PNGs join the reviewed 256 MiB/4,096-resource device cache. Encoded bytes are preserved and masks checked before storage. Before disk reuse, a shared once-per-page request checks the official [cache-update endpoint](https://docs.geo.admin.ch/visualize-data/wmts.html#cache-update), with a 1.5-second deadline. Stored Swiss keys include the verified mosaic revision, separate from the unchanged network URL. When a revision changes, old entries cannot satisfy new reads; they age out or are evicted inside the existing budget. There is no request-time CDN cache-busting parameter.

If the metadata request fails or is malformed, Swiss disk reuse/saving is skipped for that page and real network imagery continues. Existing decoded-image caching and normal HTTP behavior still apply. All Swiss cache calls share that check, rather than issuing one per tile. Credentials/historical snapshots/unreviewed endpoints remain excluded. The existing pause/clear settings apply.

## Validation

- `npm run verify`: types, **607 Windows tests plus five POSIX-only skips**, production build. [Log](swiss-imagery/verify.log). Six focused tests cover endpoint/overview policy, envelope versus coverage, exact alpha validation and ownership, provenance/cache admission, one shared revision request and malformed revision handling. Existing US/global policy tests continue to pass.
- The [browser harness](swiss-imagery-browser.mjs) imports a synthetic GPX near Grindelwald using real AWS elevation and real SWISSIMAGE PNGs, with HTTP caching disabled. It requires at least 16 published Z19 Swiss patches and checks actual profile provenance, exact pixel hashes across reload, no repeat HTTP request for the sampled saved tile, simulated revision invalidation, metadata-failure network continuation and missing-coverage rejection. [Result](swiss-imagery/browser.json).
- The rendered [trail inspection](swiss-imagery/trail.png) illustrates the imported route and source credits. It is a desktop capture using fallback elevation, not subjective native headset acceptance or proof of full 10 cm delivery.

Native clarity, performance, comfort and lifecycle gates remain open while user testing is deferred. Regional DEM/lidar and further free-key providers remain follow-up work.
