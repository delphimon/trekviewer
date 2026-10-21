# Reuse exact latitude projection during terrain sampling

DEM sampling calculated the same inverse hyperbolic/Mercator latitude twice per vertex. Regular terrain rows also repeat the same latitude for every column. The sampler now retains only the most recent exact latitude and its dimensionless projection, independently of grid identity, bounds, source values and validity. `Object.is` preserves signed-zero/NaN input distinctions. Different latitudes recalculate normally; changing grids, raster bounds, decoded data or validity masks always resamples those current inputs. No DEM data, coordinates or image pixels are rounded or approximated, and resource/selection limits remain unchanged.

## Controlled measurement

The [alternating Node benchmark](elevation-projection/benchmark.json) compares with committed `83721f9`. It checks **187,308 exact sample matches** across regular rows, scattered points, USGS-style export bounds, XYZ tiles, missing tiles, NaN/Infinity samples, negative/extreme latitudes and out-of-range positions. A complete 23,409-vertex chunk built through each sampler has identical full build data, including positions, normals, UVs, indices, heights, bounds and fallback diagnostics.

Across three alternating 50-chunk passes, the median complete construction time falls from **712.9 ms to 589.9 ms**: approximately **14.26 to 11.80 ms per chunk (17.3% less)**. Regular-row sampling takes a median 64.57 to 36.80 ms per 468,180 samples. Scattered sampling takes 61.07 to 67.41 ms (about 10% more, or 6.34 ms per 468,180 samples). This is a deliberate optimization for the repeated rows dominating streamed grid construction; it is not a universal sampler speedup. The cache holds two scalars, with no retained DEM or historical coordinate collection.

Reproduce on Node 24 with `node --experimental-transform-types scripts/benchmark-elevation-projection.mjs`. These are isolated desktop CPU measurements, excluding message transport, GPU uploads, frames and native headset performance.

## Validation

`npm run verify` passes both typechecks, **712 Windows tests with five platform skips**, and the production build. The new regression alternates same-latitude samples across grids with different bounds, edits data and validity, changes latitude, returns to the original latitude and checks NoData. Existing registration, fallback, source and terrain tests remain passing.

The [local full tour](elevation-projection/local-tour.json) passes actual-image/marker gates without page/GL errors. Fine hiker ground appears in 350/367 samples (95.4%); 1,234 chunk jobs include 497 repeats. Neither loading nor churn is solved. Main-thread construction remains 0.1 ms median / 0.2 ms p95 after the preceding buffer-adoption checkpoint. Local/overview mesh spacing remains approximately 4.96/94 m and requested local DEM export spacing approximately 1.0001 m. Modified build: `83721f9-modified-2026-10-21T01:58:16.980Z`, entry `index-BSh1uPxU.js`.

[Desktop/mobile controls](elevation-projection/controls-local.json) and [geographic/stereo/fade/recovery checks](elevation-projection/controlled-local.json) pass. The latter restores a bitwise-identical image after actual context loss. Clean hosted release evidence is recorded after completion below.

## Remaining work

This reduces terrain CPU construction cost while preserving numeric results. Repeated builds/decoded grids, source latency, broad overview detail, GPU work and native 72 Hz/visual acceptance remain open. The user deferred headset testing; desktop measurements do not certify the headset experience.
