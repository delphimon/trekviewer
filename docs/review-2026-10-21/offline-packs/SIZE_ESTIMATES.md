# Offline sizes for all eight bundled routes

Calculated 2026-10-21T20:48:44.374Z. **Planning estimates only; no route pack or installed offline app has been built.** Decimal GB (1 GB = 1,000,000,000 bytes).

These estimates preserve the current public imagery provider’s lossless PNG layout, sharing each 1024-square source image among sixteen child crops. “Full” covers the complete surrounding model (1.5 times track bounds, at least 1.5 km per axis). “Corridor” retains full-model Z13–16 overview and selects fine images/terrain tiles intersecting a buffer 1 km to each side of the actual track, without joining separate GPX segments. Whole boundary tiles are retained. This is a pack scope comparison; live High settings and coverage are unchanged.

The bounded probe retained **24 validated public-source images (37.8 MB)**. Every pixel is opaque and sampled colours are nonblank. Per route, fine imagery is budgeted at 75% of the smallest observed bytes/pixel through 150% of the largest, plus raw RGBA overview capacity. This deliberately broad planning range is not a confidence interval, a complete coverage check or a measured archive download. The small probe does not establish native source resolution.

Pack budgets below add the uncompressed one-metre requested Float32 elevation inventory and GPX, leaving elevation compression savings unclaimed. Exact source/imagery coverage and rights still need validation before baking. Optional prepared geometry is separate.

| All eight routes | Full model | 1 km corridor + complete overview |
|---|---:|---:|
| Imagery through Z17 + elevation | 13.94–19.44 GB | 6.43–7.95 GB |
| Imagery through Z18 + elevation | 24.48–50.91 GB | 8.73–15.34 GB |
| Imagery through Z19 + elevation | 65.73–173.89 GB | 16.97–41.77 GB |

Z19 is the current maximum imagery request level. Z17/Z18 are explicit smaller pack options, not established equivalents in visual quality. A finer request can resample a coarser survey. A future source-native archive/pyramid bake could avoid storing redundant resampled pixels, but its size and visual parity must be measured.

| Route | Full-model pack through Z19 | Corridor pack through Z19 |
|---|---:|---:|
| Mount Rainier via Emmons Glacier | 3.50–12.07 GB | 1.14–3.41 GB |
| Mount Baker (July 2026) | 1.10–4.89 GB | 0.70–2.91 GB |
| Mount Adams (July 2026) | 0.40–2.61 GB | 0.34–2.09 GB |
| Mount Hood (June 2026) | 0.59–1.37 GB | 0.51–1.18 GB |
| Glacier Peak Traverse (July 2026) | 7.19–26.70 GB | 1.96–5.83 GB |
| Olympus & Bailey Range Traverse (2026) | 45.08–105.20 GB | 9.06–18.21 GB |
| Enchantments & Dragontail Peak | 6.77–18.25 GB | 2.40–5.95 GB |
| Putrid Pete's Peak, Web Mtn & Mt Defiance | 1.10–2.79 GB | 0.87–2.17 GB |

| Route | Model km (width × depth) | Raw elevation GB, full / corridor | Optional prepared geometry GB, full / corridor |
|---|---:|---:|---:|
| Mount Rainier via Emmons Glacier | 13.5 × 8.5 | 0.48 / 0.15 | 0.23 / 0.07 |
| Mount Baker (July 2026) | 3.2 × 11.9 | 0.16 / 0.10 | 0.08 / 0.05 |
| Mount Adams (July 2026) | 1.7 × 11.1 | 0.08 / 0.07 | 0.04 / 0.03 |
| Mount Hood (June 2026) | 1.6 × 7.1 | 0.05 / 0.05 | 0.02 / 0.02 |
| Glacier Peak Traverse (July 2026) | 20.4 × 13.8 | 1.17 / 0.27 | 0.55 / 0.13 |
| Olympus & Bailey Range Traverse (2026) | 40.9 × 26.9 | 4.53 / 0.86 | 2.17 / 0.41 |
| Enchantments & Dragontail Peak | 15.5 × 11.2 | 0.72 / 0.26 | 0.34 / 0.12 |
| Putrid Pete's Peak, Web Mtn & Mt Defiance | 5.2 × 4.6 | 0.10 / 0.08 | 0.05 / 0.04 |

All-route raw elevation: **7.29 GB full / 1.84 GB corridor**. Optional prepared geometry: **3.47 GB full / 0.88 GB corridor**.

Terrain counts use current High Quest base-grid policy, approximately 5 m refinement meshes, exact tile footprints, four-metre source guards and endpoint-inclusive one-metre sampling. They describe a proposed offline baking inventory, not the production request format. Raw elevation preserves Float32 samples; one-metre export spacing does not certify one-metre native DEM coverage. Prepared geometry counts current position/normal/UV/height/index arrays for the Quest variant, not a full-resolution source archive. Desktop variants and finer future meshes are excluded.

Budgets exclude optional label/topographic layers, source masks, small base-grid/manifest/index data, filesystem overhead, temporary staging/update copies and APK overhead. Reserve free space separately once the streaming installer is designed. Lossless compression may reduce elevation/geometry; PNG is already compressed. Do not assume a ZIP dramatically reduces imagery. The existing complete built website is approximately 7.8 MB before HTTP compression, including all bundled GPX files. Large map data should remain independently versioned and removable.

These packs would avoid network tile acquisition while playing downloaded coverage. They still require bounded local reads, decoding and GPU residency. Prebuilding geometry may remove known rebuild work; it does not certify native frame rate. The first implementation should validate a bounded source-native sample, offline storage and network-disabled startup/tour before provisioning all routes.

Machine-readable counts, public sample URLs, SHA-256 hashes, alpha checks and per-component estimates: [estimates.json](estimates.json). Reproduce from the repository with:

```powershell
$env:TREK_PACK_SAMPLE='1'
node --experimental-transform-types scripts/estimate-offline-route-packs.mjs
node scripts/summarize-offline-route-packs.mjs
```

The first command limits probing to three selected images per route, uses at most two concurrent requests and reuses URL-hashed local files. Failed requests may try permitted public fallback sources. No private provider credentials are read and no pack-scale acquisition occurs.
