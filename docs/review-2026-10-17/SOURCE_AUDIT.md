# Source provenance checkpoint

This checkpoint advances completion-plan item 4 while the user defers native testing. It does not close source coverage or the native acceptance gates.

## Point catalog evidence

The [recorded audit](source-audit/audit.json) samples the highest recorded GPX point of every bundled route. `scripts/audit-route-sources.mjs` records coordinates, request URLs, retrieval times, catalog attributes and explicit catalog contribution weights. Elevation uses the application's Best mosaic rule; imagery uses NaturalColor. Requests use approximately 1 m ground sampling, which is distinct from native source resolution.

Reproduce from the repository root with Node 20+:

```powershell
node scripts/audit-route-sources.mjs
node scripts/audit-route-sources.mjs --fallback-imagery
```

The default output is ignored `.review-cache/route-source-audit/audit.json`; override with `TREK_SOURCE_AUDIT_OUT`. `--refresh-imagery` refreshes the already selected imagery service without discarding preferred failures. Two route workers, sequential elevation/imagery per route, 20-second request timeouts and 30 catalog items bound the service work. This is an offline audit, not an extra request in the rendering loop.

All eight preferred NAIP Plus identify requests timed out. USGS NAIP alternative identifies succeeded. Seven point contributors explicitly report 1 METER imagery from 2017; Hood reports 0.3 METER imagery from 2022. The [in-app source page](../../../public/data-sources.html) lists the point matrix. An identify timeout is not proof that every export endpoint is down, and the alternative catalog is not proof of the current rendered dataset.

Elevation contribution names include 1/9 arc-second surveys at Rainier, Hood and Olympus; Baker, Adams, Glacier Peak, Defiance and Enchantments report LowPS 1. LowPS values remain unconverted service-coordinate metadata. They are not relabeled as verified native ground metres. Catalog dates do not establish the accuracy or acquisition date of an entire route. [ArcGIS identify documentation](https://developers.arcgis.com/rest/services-reference/enterprise/identify-image-service/) describes the returned catalog contribution weights.

## Actual published image services

The tile loader records the successful service after coverage validation. A WeakMap associates fixed service identifiers with borrowed image/canvas objects; it retains no images, request URLs, coordinates or provider tokens. Cache hits preserve the same provenance. Crop images retain their actual supplier. Hybrid composites inherit aerial provenance even when reference labels fail. Service cooldown can reorder requests, but alternative status is compared with the original configured first URL.

LOD diagnostics and opt-in profile windows include `imageryVisibleBySource`, `imageryVisibleFineBySource` (Z17+), and `imageryVisibleAlternativeSources`. Counts describe patches whose mesh publication flag is visible, including warm published coverage outside the frustum. They are not pixel areas, per-eye visibility, base overview composition, catalog dataset IDs, native resolutions or failure explanations. Missing metadata is `unknown`; unclassified services are `other`. The summary CLI prints peak counts and alternative-source window counts. Existing reports remain readable.

No new network requests, changed quality budgets, lower resolution, different source priority or imagery replacement policy are introduced. Collection uses the existing diagnostic patch traversal and constant-time WeakMap lookups. Regional and global source limitations are now explained on the user-facing source page.

## Regional source gap

The current app still selects EOxCloudless imagery outside CONUS and Mapzen terrain outside eligible US regions. Switzerland, Nepal and New Zealand are representative policy cases, not completed imported-route browser/device acceptance runs. The approximately 10 m global imagery is not fine aerial coverage.

Verified primary documentation establishes a better free Swiss imagery option: [SWISSIMAGE](https://www.swisstopo.admin.ch/en/orthoimage-swissimage-10) has native 10 cm plains/main valleys and 25 cm Alpine imagery. [Swisstopo OGD terms](https://www.swisstopo.admin.ch/en/terms-of-use-free-geodata-and-geoservices) permit free use with attribution and allow restrictions for excessive service use. It is **not integrated**; coverage, reprojection, browser access, NoData boundaries, cache/failure guards and elevation integration still need implementation/validation. No claim of universally finest free data is justified.

## Validation and remaining gates

Four focused regressions cover exact service classification, URL/credential exclusion, real crop/cache/cooldown behavior, actual Hybrid compositing with missing labels, and hidden versus published counts. Recorder coverage verifies exported fields. `npm run verify` passed types, **591 Windows tests with five POSIX-only skips**, and the production build; Linux CI runs all 596 tests. [Validation log](source-audit/verify.log). The [browser harness](source-provenance-browser.mjs) deliberately aborts the preferred service, requires at least 64 real Z19 alternative patches with matching service diagnostics and saved profile fields, and checks the mobile source matrix. This is desktop WebGL evidence, not native MR. Native clarity, 72 Hz application delivery, GPU/compositor/thermal timing, exit/re-entry and restart recovery remain pending the user's later test.

The [local result](source-audit/browser.json) reported 84 published Z19 USGS NAIP patches and two saved profile windows with matching source/alternative counts, zero JavaScript exceptions and zero WebGL errors. Expected injected timeouts and the existing GeoPlatform CORS failures are retained in its warnings; working USGS alternative exports supplied the imagery. Older native report summarization also passed without requiring the new fields.
