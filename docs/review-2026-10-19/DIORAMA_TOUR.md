# Diorama tour checkpoint and architecture review response

The user approved prioritizing the tabletop diorama and flyover on October 19, 2026. New 1:1 development and its native acceptance are deferred. The existing mode remains available. This builds on the prior chat's source fidelity, bounded original-byte caching, terrain worker recovery and verified application-entry work; those remain regression requirements.

## Review findings carried forward

- Terrain/imagery coordination, large orchestration/input classes and duplicated UI logic are legitimate maintenance concerns. The dual DOM/regex GPX parser also merits consolidation with representative namespace/attribute-order fixtures.
- The reported missing-LERC failure was not reproduced at `edeb169`: typechecking, 609 tests (5 skipped) and the production build passed. The dependency is declared and locked, and its WASM asset is emitted. This is a local-checkout result, not a fresh offline installation guarantee. Existing LERC browser-externalization and large-bundle warnings remain.
- Surface clipping is real, but the current implementation visits intersecting grid cells, reuses interior vertices and provides serialized worker preparation. It does not clip every terrain triangle for every tile. Patch capacity is not measured per-eye draw count, frame delivery or thermal behavior.
- A unified terrain tree or batching prototype must preserve exact UVs, refinement continuity, independent source resolutions, coarse fallback coverage and bounded residency. Choose the next performance change from a tabletop device baseline. Meta's [WebXR performance workflow](https://developers.meta.com/vr/documentation/web/webxr-perf-workflow/) was checked during review; it distinguishes CPU submission costs from GPU vertex/fragment work.
- Offline route packs remain a useful option for curated routes. Load time and memory depend on actual bytes, decompression, geometry and GPU uploads; no sub-500 ms guarantee or complete removal of network recovery is justified.

## Resulting behavior

The default diorama player now offers a 90-second tour at 1x, moving at constant route-distance progress. The tour avoids recorded camps, stationary pauses and multi-day timestamp gaps. Slower/faster presets are 0.5x, 1x, 2x and 3x. Track timing remains selectable with the existing 1x, 5x, 20x and 60x multipliers. Switching timing basis preserves geographic progress and resets speed to 1x. Spatial ten-second tour steps are independent of playback speed; first-person meter steps remain intact.

An optional desktop Follow route button moves a raised inspection camera smoothly toward the hiker, using the rendered marker's world position (including model transforms and exaggeration). Dragging, zooming, Fit terrain, route replacement, view-mode changes or XR entry stops follow. Stopping follow leaves the current view ready for manual inspection. This is an oblique inspection follow, not a terrain-clearance flight planner.

XR tours animate the hiker while preserving the tabletop transform and tracked camera. No automatic root movement or viewer steering is added. DOM and spatial controls share playback labels and speed policy through `PlaybackPresentation`; this is the first small presenter extraction, not a claim that the full UI duplication has been resolved.

## Validation and remaining limits

- Focused regressions cover multi-day tour timing, pause/replay/endpoints, scrubbing, mode switching, track playback, existing first-person speed limits, unchanged XR/model transforms, and frame-rate-independent camera smoothing.
- The reproducible [browser check](diorama-tour-browser.mjs) exercises actual DOM controls, spatial hit actions, manual camera takeover, Fit terrain, route/view transitions and responsive layout. Its three-point GPX uses synthetic fallback terrain with external sources deliberately unavailable; this isolates controls and does not establish live source fidelity or native performance.
- `npm run verify`: typechecking, 615 passing tests (5 skipped) and production build passed. After the mobile profiling layout adjustment, typechecking/build and 29 relevant tour, inspection and lifecycle tests passed again. Existing LERC browser-externalization and bundle-size warnings remain.
- Desktop 1440×1000 and mobile 390×844 checks passed without page exceptions or horizontal overflow. The mobile profiling panel clears the actual player-bar height, including after responsive wrapping. [Browser results](diorama-tour/browser.json), [desktop follow view](diorama-tour/1440-follow.png), [mobile follow view](diorama-tour/390-follow.png). These are fixture controls/layout evidence from a modified build, not native or imagery-fidelity acceptance.
- Publication follows the repository's clean-build checkpoint workflow. Native tabletop clarity, sustained 72 Hz frame delivery, thermal behavior, hand/controller comfort and lifecycle acceptance remain open. First-person native acceptance is explicitly deferred.
