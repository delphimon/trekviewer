# Terrain renderer migration

## Goal and evidence

The 1:1 Quest view should keep visible terrain sharp as the user turns their head, without replacing hundreds of imagery patches or exposing obviously faceted ridgelines. The tabletop view must continue to load arbitrary GPX routes and preserve its current controls.

The stable imagery footprint in build `6b046c5` removed the measured head-turn churn on Enchantments: no incomplete selected-coverage windows, in-flight imagery requests, or new patches after startup in the 90-second run. The same screenshots still show broad soft faces and faceted peaks. The current first-person renderer uses a single visible local DEM chunk inside a full-route base mesh, whose Quest grid targets about 120 m cells. The outer stable imagery footprint is z16. See [the headset profile comparison](review-2026-09-26/QUEST_HEADSET_PROFILES.md).

Build `f2d8393` adds a bounded `?terrainGrid=60` experiment. A matched headset run must establish how much of the visible defect is base-mesh undersampling, how much is imagery resolution or DEM source quality, and what additional geometry costs on the headset. It is not the destination architecture.

The optional `?regionalDem=1` experiment packages 26 USGS 3DEP z15 elevation tiles near Colchuck Lake and Asgard Pass. It changes only local DEM source selection and keeps the current mesh layout, so a matched run isolates the source contribution. Missing/partial source tiles fall back to AWS, and packaged boundary pixels are feathered to AWS to avoid height steps. It does not solve the coarse distant base mesh; a tiled terrain surface is still the migration target.

The separate `?regionalBase=1` flag applies that same regional source to full-route base-mesh vertices where covered, leaving the local chunk on AWS unless `regionalDem=1` is also set. This isolates source detail from mesh density. It adds a bounded 30-tile regional decode during route preparation, with 26 packaged USGS tiles and AWS fallback for the four uncovered positions. Browser validation confirms the Enchantments route renders with regional base z15 and local AWS z15; Quest GPU, memory, and visual benefit remain unmeasured. It is still a source-selection step toward the tiled surface, not a replacement for it.

## Target rendering boundary

Retain GPX parsing, route geometry, hand/controller input, HUD, scene lifecycle, and WebXR delivery. Replace `TerrainGenerator`'s whole-route mesh, `LocalTerrainStreamer`'s single visible refinement, and `ImageryLODManager`'s surface-copying patch geometry behind one terrain-surface interface. A rendered spatial tile owns its height mesh, material mapping, bounds, and quality metadata. DEM and imagery may have different source zooms; they do not need a one-to-one source tile match.

The renderer should:

1. Keep a coarse parent surface available everywhere in the trek extent, then select finer child geometry by projected terrain error and imagery by projected texel size. Evaluate both XR eye frusta plus a head-turn guard band. Do not promote or demote solely because a center gaze ray moved.
2. Preserve parent coverage until replacement children are complete. Snap shared boundaries, stitch differing mesh resolutions or use bounded skirts, and keep the route and waypoints on the same rendered-surface sampler.
3. Bound work separately: source downloads, decoded DEM/imagery in RAM, GPU-resident geometry/textures, draw calls, and per-frame uploads. Build/decoding work should run outside the frame callback where practical; promotion should have a small upload budget and hysteresis.
4. Keep source attribution and provider identity with every tile. Disk retention must respect each source's license and cache headers. In particular, [Cesium Bing is not an unrestricted offline-region source](https://cesium.com/legal/third-party-terms/). [USGS 3DEP DEM](https://data.usgs.gov/datacatalog/data/USGS%3A77ae0551-c61e-4979-aedd-d797abdcde0e) may support curated region packs after coverage and provenance checks.
5. Apply different LOD policies to tabletop and 1:1 view while sharing the same tile store and renderer. The tabletop can prioritize the inspected region; first person needs broad stable surrounding coverage and higher geometry quality on visible ridges.

## Migration slices

1. **Measure the geometry ceiling.** Compare the same Enchantments viewpoint on `?profile=1` and `?profile=1&terrainGrid=60`. Record screenshots, base/local ray counts, actual cell spacing and DEM zoom, callback/CPU data, and headset GPU/FPS/thermal data. Keep the existing stable imagery footprint in both runs.
2. **Build one tiled Enchantments surface behind a flag.** Use a bounded area around the lake and Asgard Pass. Verify DEM coverage/resolution; construct a coarse parent and independently promotable child height meshes with seamless boundaries. Keep the current renderer as fallback.
3. **Move imagery onto rendered terrain tiles.** Share atlas/array storage or batches where measured draw calls justify it; remove duplicated surface-copying patch meshes. Maintain independent imagery and geometry LOD and atomic parent/child fallback.
4. **Generalize to arbitrary GPX routes.** Add source selection, a bounded tile scheduler, disk cache for permitted content, and separate tabletop/first-person policies. Migrate trail projection and ray hits to the tiled surface before removing the legacy mesh path.

The offline layout primitive in `TerrainTileLayout.ts` begins slice 2. It partitions a 360-degree neighborhood into non-overlapping whole-parent-cell tiles with deterministic IDs, shared boundary coordinates, integer child subdivisions, and separate tile/vertex limits. It does not yet create or display child meshes. The next renderer slice must keep the parent visible while building each tile, validate sampled heights, blend its outer boundary to the parent, and promote it within a per-frame upload budget. The missing headset comparison from slice 1 remains a gate before making a finer default.

## Acceptance gate

At the fixed Enchantments viewpoint, compare the same head sweep and screenshot directions before and after each slice. Require no missing surface, no severe ridge facets where source DEM supports more detail, and no high-resolution collapse on head rotation. Report visible imagery and geometry quality, patch/tile churn, draw calls, peak memory, and headset-delivered FPS/GPU frame time over a sustained run. Browser callback rate alone is not a frame-rate claim. Advance the tiled renderer only if the visual gain survives that device budget.
