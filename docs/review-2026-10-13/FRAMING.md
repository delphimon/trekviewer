# Terrain framing and inspection continuation

Implemented October 14, 2026, after the [close-up detail work](DETAIL.md).

## View behavior

Desktop framing now fits the eight corners of the terrain's world bounding box into the space between the header, timeline and settings panel. This accounts for perspective depth, camera field of view, camera zoom and viewport aspect ratio. It includes the terrain skirt and visible detailed chunks, so the whole terrain fits at an elevated viewing angle. Invalid bounds or an unusable viewport leave the camera unchanged.

**Fit terrain** appears beside **Level horizon** in desktop and mobile Settings. It reframes the camera without changing model position, scale, tilt, route progress or playback state. Pending OrbitControls inertia is finished before the fit, preventing a previously started gesture from moving the newly fitted view. Mobile fitting closes Settings and returns keyboard focus to its toggle.

Automatically fitted views adapt when the viewport changes. Once the user wheels, pinches or drags the desktop orbit controls, resizing preserves their camera position and orbit target. The projection still adapts to the new aspect ratio; use **Fit terrain** to show the whole model again. Returning from walking to tabletop fits the terrain. The control is disabled before a track is available, during graphics interruption and in walking mode. The camera operation also guards immersive sessions and suspended graphics.

The existing horizon lock, horizon reset, close zoom, adaptive clipping and direction chevrons remain available. Fitting retains a freely tilted model; **Level horizon** remains the separate action for removing its pitch and roll.

## Production-browser evidence

The [browser results](framing/browser.json) record projected bounds, clipping depths, camera and model poses, progress and GL errors. The production build runs in headless Edge using ANGLE D3D11 on an NVIDIA RTX 4060.

| Check | Result |
| --- | --- |
| 1233 × 821 desktop fit | All eight terrain-box corners inside the available x=360–1217, y=122–689 region |
| Automatic resize to 1400 × 900 | Terrain remains between the panels |
| Real wheel zoom followed by resize | Camera and orbit target preserved within `1e-12`; automatic fitting disabled |
| Real orbit drag followed by mobile resize | Camera, target and model pose preserved within `1e-12` |
| Keyboard activation of Fit terrain | All corners fit; model tilt, position, scale and progress 0.37 preserved |
| 390 × 844 mobile fit | All corners inside x=16–374, y=256–586; no horizontal page overflow |
| Mobile Settings | Closes after fitting; toggle reports collapsed and receives focus |
| Walking/tabletop transition | Fit disabled while walking and enabled on return; tabletop fits again |
| Clipping / GL / browser errors | Terrain corners within near/far range; zero GL errors, page errors or console warnings/errors |

The [desktop fit](framing/desktop-fit.png), [desktop controls](framing/desktop-controls.png), [mobile Settings](framing/mobile-settings.png) and [mobile fit](framing/mobile-fit.png) capture the verified layouts. The [browser harness](framing/browser-framing.mjs) runs from the repository root with `node docs/review-2026-10-13/framing/browser-framing.mjs`; its Edge and Playwright paths match this Windows environment.

Framing uses a bounding box, so empty space can remain around irregular terrain. Markers and spatial panels are excluded from terrain framing. Streaming continues during the browser checks; small bound changes after an automatic resize can occur as detailed terrain publishes. This is a usability and composition improvement, not a measured GPU or FPS speedup.

## Verification and performance limits

| Check | Result |
| --- | --- |
| Source and test TypeScript checks | Passed |
| Full Vitest suite | [482 passed, 5 POSIX packaging fixtures skipped on Windows](framing/tests.log); 92 files passed / 1 skipped |
| Strengthened framing regression | [19 inspection tests passed](framing/inspection-tests.log) |
| Production build | Passed; main JS 908.27 kB / 237.74 kB gzip; worker 210.77 kB |
| Production Edge checks | Passed |
| Git whitespace check | Passed; existing line-ending notices only |
| Meta VR device listing | Empty |

Regression cases project every box corner for wide, long and tall terrain, portrait and landscape viewports, off-center models and optical camera zoom. They check unusable input, integration with terrain skirts, preservation of model pose/progress, and camera guards for walking, XR and suspended graphics.

Fitting runs on route/view transitions, explicit requests and resizing an automatically fitted view. It does not add work to the animation loop. This pass keeps the existing geometry and imagery budgets and introduces no additional render objects or draw calls. The [earlier detail report](DETAIL.md) contains the measured close-up imagery and raycast improvements.

The Meta VR plugin documentation search identified the [official WebXR performance workflow](https://developers.meta.com/vr/documentation/web/webxr-perf-workflow) and [performance best practices](https://developers.meta.com/vr/documentation/web/webxr-perf-bp). No Quest was connected. Sustained headset frame delivery, GPU duration, thermal behavior and immersive comfort still require hardware validation. The existing main-bundle size warning remains.
