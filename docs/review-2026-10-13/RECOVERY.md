# Graphics recovery and desktop control states

Implemented October 13, 2026, continuing the [rendering and availability work](CONTINUATION.md).

## Graphics interruptions

The app now coordinates its playback, route preparation and rendering with graphics context loss/restoration. WebGL resources from the old context become invalid on restoration; see [Mozilla's context-restoration documentation](https://developer.mozilla.org/en-US/docs/Web/API/HTMLCanvasElement/webglcontextrestored_event). The installed Three.js renderer already initializes new graphics caches, but application playback and existing cleanup handlers also needed coordination.

On context loss, the app stops its animation callback, pauses playback, releases input capture and ends an active immersive session. It releases GPU cleanup handlers while the context is still lost, retaining CPU geometry, texture pixels and the current trek. This covers scene resources, inactive walking/tabletop ribbons, cached map styles, instances, shadows and routes undergoing shader preparation. It does not use the full route-disposal helper, which also removes scene objects and clears canvases.

Route shader preparation waits for graphics readiness with the route's abort signal. A restoration revision change causes warmup to repeat before committing the route. Cancelled or disposed routes remove their waiters instead of accumulating suspended work. Startup and recovery failures are handled, with a persistent **Retry graphics** control when preparation fails.

After the browser restores graphics, the app prepares the sky/current trek shaders and draws the restored desktop scene before making the canvas visible. The animation clock resets, while playback remains paused until the user explicitly resumes. The graphics notice is immediately readable and temporarily takes priority over ordinary status messages; Play, scrubbing and immersive entry are disabled during recovery. The invalid canvas stays hidden, avoiding the bright cleared buffer observed in the forced-loss test.

An early browser run exposed stale-context buffer/VAO deletion warnings after quality changes. Releasing GPU resources during the lost-context phase corrected this. Stronger checks then covered cached walking/map resources and disposal of the prior route after restoration. Normal terrain cancellation is propagated as cancellation rather than logged as a fetch failure.

## Control states

Desktop map style, trail color, exaggeration, quality and playback-speed buttons now expose `aria-pressed` alongside their visible selected state. Play and walking/tabletop toggles also expose their state. The shared state setters run for initial values, keyboard/pointer actions and session updates. The browser check uses Enter on focused controls and verifies that focus remains on the selected control and exactly one option in each group is selected.

## Verification

| Check | Result |
| --- | --- |
| Source and test TypeScript checks | Passed |
| Vitest | [452 passed, 5 POSIX packaging fixtures skipped on Windows](recovery/tests.log); 89 files passed / 1 skipped |
| Production build | Passed; main JS 906.15 kB / 236.32 kB gzip; worker 212.63 kB |
| Native context loss/restoration | Two cycles using `WEBGL_lose_context`, including an injected preparation failure and successful retry |
| Preserved state | Current route, nonzero progress, camera position, orbit target, model position/quaternion/scale; playback remains paused |
| Subsequent interaction | Keyboard selection, quality/style changes, mobile settings and route replacement pass |
| Browser errors | No page errors or console warnings/errors; post-restoration WebGL error code is zero |
| Meta device listing | Empty |

The [browser result](recovery/browser.json) and [harness](recovery/browser-recovery.mjs) accompany screenshots of [paused graphics](recovery/graphics-paused.png), [restored terrain](recovery/graphics-restored.png), [retry](recovery/graphics-retry.png), [selected controls](recovery/selected-controls.png), and [mobile controls](recovery/mobile-selected-controls.png). The harness uses local Windows Edge and Playwright paths and runs from the repository root. It verifies real graphics interruptions on the desktop; the preparation failure itself is deliberately injected.

GPU resources still need shader preparation and texture/buffer uploads after restoration, so recovery can include first-use CPU/GPU work. This is a reliability improvement, not a sustained frame-rate or thermal benchmark. Active XR loss/re-entry and headset driver recovery still require connected hardware. The existing bundle-size warning and earlier hardware validation limits remain.
