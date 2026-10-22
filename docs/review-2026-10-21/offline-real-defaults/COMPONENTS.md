# Real default-route source and lossless component audit

Eight planned sources per route, validated with the production browser worker/Canvas code. 24,081,881 bytes retained in the ignored local source cache. This is a bounded sample, not a complete route pack or a full-model native-resolution claim.

| Route | Validated source total | DEM originals | Gzip DEM components | DEM reduction | Unchanged PNGs |
|---|---:|---:|---:|---:|---:|
| rainier-emmons | 11.82 MB | 7.57 MB | 6.23 MB | 17.7% | 4.25 MB |
| enchantments-dragontail | 12.26 MB | 7.34 MB | 6.09 MB | 17.0% | 4.93 MB |

All selected imagery pixels are opaque. Both complete overview DEM rasters are valid, and all local DEM samples supporting their actual rendered footprints are valid. Local guard samples outside those footprints are not implied valid. Selected sources are the overview DEM, first/middle/last local DEM and Z16/17/18/19 imagery from the actual current full-model plans.

The zero-tolerance LERC samples are effectively raw Float32 payloads. Node gzip level 6 reduces component-file sizes without changing source bytes: bounded decompression reproduces each original SHA-256 exactly. PNGs are kept unchanged. HTTP wire compression was not measured; this is not a claimed reduction versus current network transfer. The reduction is only 17–18% for these DEM components and says nothing about compressing the much larger full imagery inventory. This tests preparation components only; the current browser pack store still retains original LERC/PNG bodies and does not import gzip components. No full-pack size or headset speed improvement follows from these samples.

| Route overview DEM | Valid samples | Source elevation range |
|---|---:|---:|
| rainier-emmons | 658,432 | 1139.7–4392.2 m |
| enchantments-dragontail | 761,856 | 338.3–2693.4 m |

Every decoded DEM reports Float32 and zero LERC error tolerance. Source height ranges demonstrate relief in these requested rasters; they do not establish source-native survey spacing, fine mesh coverage, geographic accuracy against an independent survey or accepted headset appearance.

Reproduce locally (network only in the first command; cached accepted bodies are reused):

```powershell
$env:TREK_OFFLINE_PROBE_COMMIT=(git rev-parse HEAD)
node --experimental-transform-types scripts/probe-offline-defaults.mjs
node scripts/summarize-offline-default-probe.mjs
```

The probe requests at most sixteen selected resources, one acquisition/validation lane, 35 seconds per approved public-source attempt and 32 MiB per DEM / 8 MiB per image. It never reads private provider configuration, publishes a ready pack or changes the installed application. The committed component report records source URLs, required windows, actual sizes, original/round-trip hashes and local timings. Complete source/native-resolution coverage, stable geographic indexing, portable streaming archives, full-route acquisition and installed/native acceptance remain unfinished.
