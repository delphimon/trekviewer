# Review implementation — October 13, 2026

Implemented against reviewed commit `2f438031b650db15885935134595ca09884d6197`. Source changes are in the working tree. The original [review](REVIEW.md) and its evidence remain available.

## Changes

| Area | Result |
| --- | --- |
| Terrain fidelity | High targets a 60 m base grid and roughly 10 m stable refinements. Quest High retains at most 12 tiles / 96,000 refinement vertices; desktop High 24 / 160,000. Balanced uses 9 / 40,000 at about 25 m. Existing base-grid vertex caps remain. |
| Elevation fidelity | USGS regional elevation is enabled within the packaged Enchantments footprint for both base and local terrain, with AWS fallback. Local valleys remain below the coarse base elevation. Adjacent tile edges share heights and normals. |
| Streaming performance | One reusable worker handles GPX finalization, Terrarium decoding, local mesh sampling/normals, and imagery clipping. At most one prepared refinement publishes per frame, with imagery swapped in the same transaction. Coarse cells cover areas until detailed surfaces are ready. |
| Workload bounds | Imports reject unsupported date-line crossings and extents beyond 100 km. Limits also cover 100,000 track points, 1,000 explicit waypoints, 400 km route distance, and 200 derived landmarks. DEM requests enforce the route's 25-tile budget even at minimum zoom; a shared 64-tile/pixel decode guard precedes allocations. Decoded local grids use a 64 MiB LRU budget. |
| Main-thread work | Date formatting occurs at calendar boundaries rather than per point. The full 1024×1024 procedural topo texture yields between row batches. Hidden HUDs defer rasterization. Static X/Z buckets localize trail reprojection; first-person normals update only affected faces and neighbors. Unchanged exaggeration and UV mappings skip rebuilds. |
| Rendering | Asynchronous shader preparation warms incoming terrain while the previous route stays mounted. Initial warmup prepares the visible sky rather than hidden XR meshes. Sky draws after opaque foreground geometry. XR retains its existing foveation, anisotropy, guarded 72 Hz request, and disabled shadow pass. |
| Comfortable movement | Default walking is 1.4 m/s, with 2 m/s brisk movement. Turning defaults to a latched 30° snap. First-person entry pauses playback; playback stays within walking pace, and transport steps become 1 m. Settings offers stepped movement, optional smooth turning, a motion vignette, and a larger panel preference, persisted locally. |
| Viewer alignment | First-person entry/recenter captures current floor-projected viewer position and heading. Subsequent physical movement remains independent. Snap turns can pivot around current feet; reference-space resets pause/cancel interaction and recapture on a valid pose. Terrain promotion updates grounding before that frame renders. |
| Exclusive input | Direct hand targets resolve before far rays. Terrain ownership gates HUD/waypoint dispatch. Pokes re-arm after withdrawal, hidden panels, and tracking loss. Chart dragging belongs to the pointer that pressed the chart. Physical-controller pose visibility is respected, with release required after reacquisition. Finger tracking loss cancels hand capture. |
| Spatial UI | Panel scale targets about 2.7° button height at the settled dock distance, with a 1.55× minimum scale for spacing. Scaled hand grabs retain their initial offset and capture. Walking mode displays walking pace rather than accelerated speed buttons. Desktop and spatial playback/view states synchronize. |
| Responsive UI | Navigation wraps; the timeline has its own row. Mobile Settings restores access to styles, quality, landmarks, and comfort. Import is keyboard-operable, the range has an accessible label, status is live, and Escape closes settings. Camera framing accounts for actual control rectangles and viewport aspect. |
| Lifecycle | Concurrent XR entry is guarded; failed/disposed entry cleans up requested sessions. Disposal stops animation, cancels route work, removes reference/resize listeners, and terminates the terrain worker. |
| Verification/dependencies | Timing-sensitive imagery fixtures wait for scheduler completion and compare actual geographic tile coordinates. POSIX packaging fixtures explicitly skip Windows. Test concurrency is pinned to two workers. `source-map-js` advances from 1.2.1 to 1.2.2; the dependency audit reports no vulnerabilities. |

No framework migration or publication was required. Three.js remains the rendering framework. The Meta VR plugin's verification, WebXR, and immersive design guidance informed the changes; official [WebXR performance guidance](https://developers.meta.com/vr/documentation/web/webxr-perf-bp/), [locomotion preferences](https://developers.meta.com/vr/design/locomotion-user-preferences/), and [hands UI guidance](https://developers.meta.com/vr/design/hands-ui-best-practices/) were checked during this work.

## Validation

| Check | Result |
| --- | --- |
| Source and test TypeScript checks | Passed |
| Final Vitest suite | 420 passed; 5 POSIX packaging fixtures skipped on Windows; 85 files passed / 1 skipped |
| Production build | Passed; main JS 891.12 kB / 232.26 kB gzip; worker 212.51 kB |
| Dependency audit | Zero reported vulnerabilities |
| Production browser | Rainier and Enchantments render; worker runs; no page errors or console warnings/errors |
| Responsive controls | Checked at 320, 390, 768, and 1024 pixels |
| Connected Meta hardware | None reported by the plugin device listing |

The exact [test log](implementation/tests.log), [browser checks](implementation/browser.json), [profile](implementation/profile.json), [CPU samples](implementation/load.cpuprofile), and [audit](implementation/audit.json) are saved with [desktop](implementation/desktop.png), [mobile](implementation/mobile.png), [mobile settings](implementation/mobile-settings.png), and [Enchantments](implementation/enchantments.png) screenshots. The final pre-render grounding change also has a regression test demonstrating that a promoted surface reaches the viewer's feet in the same frame.

The production browser checks use Edge with an ANGLE D3D11 / NVIDIA RTX 4060 hardware backend. Rainier and Enchantments render, the module worker runs, route changes complete, walking entry pauses playback, and layouts at 320, 390, 768, and 1024 pixels keep essential controls in bounds with a usable timeline. No browser page errors or console warnings/errors were observed.

The final worker-promotion measurement retains about 9.96×9.94 m local cells and reaches the desktop limit of 24 detailed tiles. Promotion-phase maximum was 5.9 ms, versus 26.3 ms before imagery preparation moved to the worker. CPU submission p95 during the first three streaming windows was 4.1–5.4 ms; settled windows were about 1.2–1.4 ms. Maximum recorded CPU submission was 8.7 ms. These figures describe this desktop run, not Quest GPU time or compositor FPS.

Cold-start long tasks varied substantially across successive builds/runs (including 388 ms and 1,360 ms maxima). The original saved baseline's longest task was 1,151 ms. Shader compilation and first-use uploads remain a startup limit; this evidence does **not** establish a repeatable cold-start speedup. The worker/finer-grid run also renders more geometry than the original, so it is not a matched-fidelity benchmark.

## Desktop inspection continuation

The later zoom/horizon work and its separate measurements are recorded in [INSPECTION.md](INSPECTION.md). It fixes tabletop clipping, expands desktop zoom, adds persistent horizon locking and a level reset, bounds close-up waypoint size, and prepares terrain retirement imagery in the worker. The original implementation measurements above remain a historical record of that earlier build.

## Remaining validation and limits

The latest [imagery patch construction continuation](PATCHES.md), implemented October 14, reduces interior vertex allocation and lookup work while preserving exact terrain overlays. Its 506-test local suite, maximum-detail production-browser comparison and isolated CPU measurements are the current validation record.

The earlier [terrain picking continuation](PICKING.md), implemented October 14, reuses traversal storage while preserving owned hit points and exact surface selection. Its 498-test local suite, production-browser comparison and isolated CPU measurements record that implementation pass.

The earlier [startup and layout continuation](STARTUP.md), implemented October 14, gates pending immersive entry checks and keeps automatic terrain fits aligned with changing header/timeline bounds. Its 496-test local suite and production-browser readiness/layout checks record that implementation pass.

The earlier [terrain streaming continuation](STREAMING.md), implemented October 14, recovers wanted detail after temporary failures and reduces idle preparation and focus work. Its 493-test local suite, production-browser outage recovery and isolated CPU measurements record that implementation pass.

The earlier [local trail lookup continuation](LOOKUP.md), implemented October 14, reduces spatial lookup and index-construction work while preserving ordered vertex selections and trail geometry. Its 486-test suite, matched production rendering and isolated CPU measurements record that implementation pass.

The earlier [terrain framing continuation](FRAMING.md), implemented October 14, fits terrain between the controls, adds an explicit Fit terrain action and preserves manual camera inspection during resizing. Its 482-test suite and production desktop/mobile browser checks record that implementation pass.

The earlier [close-up detail continuation](DETAIL.md), implemented October 14, uses actual desktop inspection distances, responds to small close-up zoom steps, and stops terrain ray traversal after the nearest valid cell hit. Its 475-test suite, same-view imagery comparison and isolated raycast measurements record that implementation pass.

The earlier [imagery streaming continuation](IMAGERY.md), implemented October 14, shares style compositions, releases canceled imagery, preserves committed terrain through route replacement, and enforces overview tile budgets. Its 470-test suite and production-browser lifecycle checks record that implementation pass.

The earlier [terrain coverage update](COVERAGE.md) replaces per-cell footprint scans with a reusable coverage mask, preserves identical triangles, and bounds index uploads. Its 455-test suite and isolated algorithm measurements record that implementation pass.

The earlier [graphics recovery and control-state work](RECOVERY.md) handles native context loss/restoration, stale GPU cleanup, cancellable shader readiness and desktop accessibility states. Its 452-test suite and browser interruption checks record that implementation pass.

The [trail rendering and immersive availability continuation](CONTINUATION.md) adds correct dynamic trail bounds, partial GPU uploads, initial walking normals, and explicit per-mode XR availability. Its 446-test suite and separate browser evidence record that earlier implementation pass.

The Meta device listing was checked again after continuation and returned no connected headsets. Quest GPU timings, thermal behavior, sustained frame delivery, tracking transitions, subjective comfort, seated use, and spatial text readability still require hardware. The new High defaults are implemented and bounded, but are not presented as a headset performance certification.

Base meshes, regional grids, live chunk references, image caches, GPU buffers, and temporary worker staging add memory beyond the 64 MiB decoded-grid cache. The renderer still combines terrain meshes with imagery overlays; a shared GPU texture atlas/compressed tile pipeline could further reduce draw and texture overhead, but requires a separate implementation and device validation. The main JS bundle retains a size warning. Unsupported date-line routes are rejected rather than wrapped. Android packaging remains a POSIX workflow and was not executed on Windows.

For comparisons, use `terrainGrid=60|75|120`, `regionalDem=0`, `regionalBase=0`, or `terrainTiles=0` one at a time, keeping the viewpoint and other settings fixed. `terrainTiles=0` selects the existing single-refinement streamer. The README documents current defaults and profiling instructions.
