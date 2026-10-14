# Desktop zoom, terrain clipping and horizon controls

Implemented on October 13, 2026, continuing the performance and usability work. The existing trail direction arrows were retained, as requested in the user's correction.

## Changes

- Desktop inspection supports close zoom beyond the former 0.2 m OrbitControls floor, with pointer-focused wheel/pinch zoom and no fixed maximum distance. A small positive minimum keeps the orbit calculation well defined.
- Tabletop near clipping adapts to inspection distance, between 0.0000001 and 0.001 m. The far plane covers the model and camera distance rather than using the walking view's 80 km range. The sky projects at background depth independently of that range. Walking and XR restore 0.1–80,000 m clipping.
- **Lock horizon level** defaults on and persists locally. It keeps the model upright while permitting translation, yaw and scaling. Gesture rotation is constrained before applying the contact pivot, preserving the held point/midpoint. Desktop OrbitControls retains an upright camera with freely adjustable viewing elevation.
- **Level horizon** clears model pitch/roll, preserves yaw, pan, scale, camera position/target and route progress, and levels any saved tabletop transform. It works with the lock off and appears in desktop/mobile settings and the spatial HUD. Headset tracking continues to use the runtime's camera pose.
- Desktop markers target a maximum 22 px apparent diameter (28.6 px during hover/selection), and active labels target a maximum 240 px width. Physical marker size remains unchanged in XR. This prevents nearby markers from hiding close-up terrain.
- Terrain retirement retains the old detailed surface until replacement parent imagery is prepared in the worker, then swaps both in one frame. New imagery arriving during preparation causes a retry instead of a synchronous rebuild. Existing tile/vertex budgets and the single preparation job remain bounded.
- Debug imagery outlines now use a 64-segment terrain-following perimeter instead of extracting sharp edges from every triangle. These outlines indicate approximate tile bounds and do not represent every internal mesh crease.

## Reproduction and evidence

The local production-browser harness positions the camera 0.06 m from the summit and renders the same terrain with the old and new clipping plane. The old plane puts the target beyond the near clip boundary (projected z = -2.347); the adaptive 0.0003 m near plane keeps it visible (z = 0.990). [Old clipping](inspection/close-old-clipping.png) and [fixed clipping](inspection/close-fixed-clipping.png) show the resulting cut-off and restored foreground.

OrbitControls accepts a 0.01 m inspection distance, and an actual wheel event zooms further to about 0.009025 m. The browser also checks reset invariants, lock propagation to XR input and the spatial HUD, mobile Settings access, and preference persistence after reload. [Browser results](inspection/browser.json), [desktop](inspection/desktop.png), [mobile Settings](inspection/mobile-settings.png), [spatial HUD](inspection/spatial-hud.png), and [streamed close-up](inspection/settled-close.png) record those checks.

The harness runs Edge on an ANGLE D3D11 / NVIDIA RTX 4060 backend. A separate [eight-second close-up profile](inspection/close-profile.json) records CPU submission and streaming after the wheel event. It excludes debug geometry. These measurements are desktop JavaScript/render submission, not Quest GPU timings or compositor FPS.

The final run reaches 24 local terrain tiles at approximately 9.96 × 9.94 m spacing. Terrain-update phase maximum is 4.4 ms, maximum CPU submission is 7.3 ms, and settled one-second CPU submission p95 values are approximately 0.9–1.1 ms. These are observations from this short run, not a sustained device certification. The [browser harness](inspection/browser-inspection.mjs) can be run from the repository root with Node; it uses the local Windows Edge and bundled Playwright paths and writes its working evidence under `.review-cache/inspection`.

## Validation

The source/test TypeScript checks, production build, regression suite and browser checks are recorded with the saved evidence. Regression cases cover near/far clipping, large models, reset invariants, persistent preferences, locked gesture anchors, unlocked tilt, desktop marker sizing, spatial button routing, retirement coverage, late imagery and bounded debug outlines.

| Check | Final result |
| --- | --- |
| Source and test TypeScript checks | Passed |
| Vitest | [437 passed; 5 POSIX packaging fixtures skipped on Windows](inspection/tests.log); 86 files passed / 1 skipped |
| Production build | Passed; main JS 897.60 kB / 233.97 kB gzip; worker 212.51 kB |
| Production browser | Zoom, clipping, reset, persistence and mobile access passed; no page errors or console warnings/errors |
| Headset device listing | Empty |

The Meta plugin documentation verification and device listing were run again. No headset was connected, so Quest GPU, thermal, tracking and subjective readability/comfort checks remain pending. The production bundle still has the existing size warning. Deeper inspection exposes the finite resolution of source imagery and the bounded approximately 10 m terrain mesh; it does not add source detail that is unavailable.
