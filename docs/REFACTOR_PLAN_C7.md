# C7 refactor plan: injected services and quadtree terrain

Owner asked for a plan on 2026-11-15 (item C7 in `REVIEW_FIX_PLAN_2026_11_12.md`). This
document is the plan only; nothing here has been started. The two parts are independent.
Part A should go first because it makes Part B testable.

## Part A — Replace static singletons with injected instances

### Where things stand (2026-11-15)

| Singleton | Defined in | Static calls in `src/` | Files using it | Test files touching it |
|---|---|---|---|---|
| `TextureProvider` | `src/terrain/TextureProvider.ts` (606 lines) | 48 | 8 | 25 |
| `TileImageCache` | `src/terrain/TileImageCache.ts` (590) | 19 | 4 | 27 |
| `ElevationTileService` | `src/terrain/ElevationTiles.ts` (597) | 17 | 5 | 13 |
| `QualityProfileManager` | `src/terrain/QualityProfile.ts` (143) | 14 | 6 | 5 |

Users: `main.ts`, `RouteLoader`, `LoadedTrek`, `SceneManager`, `TerrainGenerator`,
`ImageryLODManager`, `TiledTerrainStreamer`, `LocalTerrainChunk`, `CompositeImagery`,
`TerrainImageryMaterial`, `TerrainWorker`.

The cost today: every test that touches imagery or elevation has to reset module state,
and two routes (or a worker and the page) cannot have different provider or profile
settings. Most of the 70 affected test files reset state through private statics.

### Approach

One `TerrainServices` object, built once in `TrekViewerApp` and passed down:

```ts
interface TerrainServices {
  textures: TextureProvider;      // provider choice, attribution, UV lookup
  tiles: TileImageCache;          // image fetch, retry, budget
  elevation: ElevationTileService;
  quality: QualityProfileManager; // active profile + listeners
}
```

Each class becomes an ordinary instance class. Keep a deprecated static facade that
forwards to a default instance until the last caller moves, so every step is a small,
behaviour-preserving commit.

### Steps (one commit each, tests green after each)

1. `QualityProfileManager` (smallest, 14 calls): instance class + default instance +
   static facade. Pass it to `LoadedTrek`, `ImageryLODManager`, `TiledTerrainStreamer`.
2. `ElevationTileService`: instance; `TerrainGenerator.prepareElevation` and
   `RouteLoader` take it. The worker builds its own instance (no shared state crosses
   the worker boundary today, so nothing changes there).
3. `TileImageCache`: instance owned by `TextureProvider`'s instance, not global.
4. `TextureProvider`: instance; `waitForInitialization` becomes an instance promise the
   app awaits once.
5. Move tests from private-static resets to fresh instances. No assertion changes.
6. Delete the static facades.

Estimate: 6 commits, each under the 300-line rule except step 5 (tests only).

### Risks

- Init order: `TextureProvider.waitForInitialization` is awaited in three load paths; the
  instance must exist before the first route load. Build it in the app constructor.
- Hidden coupling through static caches (e.g. `TileImageCache.applyProfile` from quality
  changes) must become explicit listener wiring in step 1/3.

## Part B — One quadtree terrain surface instead of whole-route mesh + 5 m chunks

This is slice 2–4 of `docs/TERRAIN_RENDERER_MIGRATION.md`; that document's goals, render
boundary and acceptance gate still apply. This part adds an order of work that fits the
current code after C1 (`TiledTerrainStreamer` is the only streamer).

### Target

- One quadtree over the terrain footprint (`TerrainFootprint.ts`). The root is today's
  coarse base grid; each node is a fixed-size grid patch (e.g. 33 × 33 vertices).
- Node selection by screen-space error: `geometricError(node) * viewportScale / distance`
  against a pixel threshold, evaluated for both XR eyes plus a head-turn guard band, with
  hysteresis (split above τ, merge below 0.7 τ).
- Geomorphing in the vertex shader (blend toward the parent's height over the last part of
  each node's range) so splits and merges do not pop.
- Crack-free edges: either restrict neighbour level difference to 1 and stitch, or use
  short skirts (the current chunks already use a skirt-like edge ring).
- Imagery stays on the terrain shader (`TerrainImageryMaterial` texture arrays); a node
  samples whichever imagery level is resident for its area. This needs the C3 shader fade.
- Height sampling for trail, waypoints and ray hits comes from the selected node set
  (`sampleRenderedSurfaceY`), as today.

### Steps

1. **Pure quadtree selection** (`src/terrain/TerrainQuadtree.ts`): node bounds, error
   metric, split/merge with hysteresis, neighbour level limit. Unit tests only.
2. **Node mesh builder** in the terrain worker, reusing `LocalTerrainChunk` normals/edge
   code; returns transferable buffers.
3. **Behind `?quadtree=1`**: render the selected nodes in place of the base mesh and
   chunks, parent kept visible until children are ready, per-frame upload budget.
4. **Geomorph** uniform + vertex shader change; verify no popping in a recorded flythrough.
5. **Surface sampler and ray hits** from the node set; trail/waypoint reprojection on
   node changes (existing `onSurfaceChange` path).
6. **Headset gate** (Enchantments fixed viewpoint, per the migration doc): FPS, GPU time,
   memory, visual quality vs today. Only then make it the default.
7. **Remove** the whole-route mesh path, `TiledTerrainStreamer`, and (with C3) the
   overlay-patch renderer.

### Risks

- Quest GPU budget: more, smaller draws. Batch nodes per level or use one multi-draw if
  draw calls exceed the current budget.
- DEM source resolution caps useful depth; stop splitting where the DEM has no more
  detail (node error from DEM pixel size).
- Offline packs plan DEM tiles from today's tile layout (`planTerrainTiles`); the
  quadtree must request the same sources or the pack plan version must change (bump to v4
  and treat older packs as Needs update).

## Order relative to other open items

1. Part A steps 1–6.
2. C3 shader fade (prerequisite noted on C3).
3. Part B steps 1–6 behind a flag; C3 removal folds into Part B step 7.
