# Trail rendering and immersive availability continuation

Implemented October 13, 2026, after the [desktop inspection work](INSPECTION.md).

## Rendering correctness and performance

Terrain refinement and vertical exaggeration previously changed trail positions without updating their cached bounding box/sphere. A camera looking at a raised section could therefore cull the trail using its old elevation range. The trail now maintains conservative elevation bounds during every position update. A regression positions a camera above the old bounds and verifies that the raised section stays in its frustum after reprojection.

Localized position and normal changes mark one merged GPU update span, retaining all pending changes until rendering. Full exaggeration updates cover the complete position buffer. The spans intentionally include unchanged vertices between edits to bound GPU upload calls. Position and walking normal buffers use dynamic usage, and the unlit tabletop ribbon avoids allocating the normal adjacency graph. Walking-mode normals are also computed from the sloped geometry at initial construction.

Bounds expand after an elevation change rather than rescanning the entire route to shrink them. This preserves correctness with bounded update work; lower exaggeration can leave a conservative culling volume until the geometry is rebuilt.

The final production-browser capture observed two tabletop trail position uploads of **7,824 and 11,808 bytes**, versus **82,632 bytes** for the entire position buffer. Those uploads are approximately 86–91% smaller than complete-buffer uploads. This describes trail position data in the saved run, not all geometry/texture transfers or measured GPU duration. [Raw upload evidence](continuation/trail-uploads.json) records actual WebGL `bufferSubData` calls without GPU readback.

## VR/MR availability and entry

The app checks virtual reality and passthrough support separately before entry. Unsupported buttons are disabled with a visible explanation; uncertain checks remain retryable. Route readiness and mode availability compose so a completed load does not re-enable an unsupported mode. Device changes trigger another check, stale responses are ignored, and disposal removes the listener.

Selecting passthrough no longer silently opens virtual reality when `immersive-ar` is unsupported. The app explains that the user can choose **Enter VR** explicitly. Capability checks never request an immersive session. Navigation now lets the route selector shrink while preserving essential buttons and displaying the availability explanation without horizontal overflow.

Meta plugin documentation searches for current WebXR rendering and mixed-reality guidance were run for this continuation. Support is determined from the runtime rather than assuming it from a headset model or user-agent string. See [Meta WebXR performance guidance](https://developers.meta.com/vr/documentation/web/webxr-perf-bp) and [Browser mixed-reality documentation](https://developers.meta.com/vr/documentation/web/webxr-mixed-reality).

## Verification

| Check | Result |
| --- | --- |
| Source and test TypeScript checks | Passed |
| Vitest | [446 passed, 5 POSIX packaging fixtures skipped on Windows](continuation/tests.log); 87 files passed / 1 skipped |
| Production build | Passed; main JS 900.30 kB / 234.80 kB gzip; existing bundle-size warning remains |
| Production browser | Zoom, clipping, horizon/reset/persistence, partial uploads and unsupported-mode messaging passed; no page errors or console warnings/errors |
| Layout | No horizontal overflow at 1233 px desktop and 390 px mobile |
| Meta device listing | Empty |

The [browser results](continuation/browser.json), [desktop](continuation/desktop.png), [mobile settings](continuation/mobile-settings.png), [close-up](continuation/settled-close.png), and [spatial HUD](continuation/spatial-hud.png) show the final build. [The harness](continuation/browser-continuation.mjs) runs from the repository root using the local Windows Edge and Playwright paths.

The short [close-up profile](continuation/close-profile.json) uses Edge with an ANGLE D3D11 / NVIDIA RTX 4060 backend. It reaches the existing 24 detailed-tile limit at approximately 10 m spacing. Maximum terrain update is 4.7 ms and maximum CPU submission is 8.1 ms in that run. These desktop observations do not establish sustained Quest GPU time, compositor FPS, thermal behavior or subjective comfort. Physical device connection and mode entry remain pending hardware validation.
