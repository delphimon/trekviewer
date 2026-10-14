# Startup controls and available-view layout continuation

Implemented October 14, 2026, after the [terrain streaming work](STREAMING.md).

## Startup readiness

VR and MR entry controls previously appeared enabled before capability checks completed. Their initial markup and overlay state now start disabled. The support status shows **Checking headset availability…** and exposes `aria-busy` while either asynchronous check is pending. Every capability refresh enters this state, including device changes.

Completing support checks still composes separate VR/MR results with trek readiness and graphics recovery. Supported modes become available when the trek is ready; unsupported modes remain disabled. A rejected capability check retains the existing unknown/retryable behavior after completion, with an explanation. Disposed applications do not start additional checks, and obsolete results remain ignored. No immersive session is automatically requested.

Disabled-control tooltips distinguish an active support check, an unavailable mode, a loading trek and graphics recovery. The route and terrain can continue loading while support checks are pending.

## Automatic terrain fitting

Asynchronous support messages can change header height after terrain loads. The previous fit listened only for window resizing, so its available-screen bounds could become stale. The application now observes the header and timeline's border boxes, matching the visible bounds used by the terrain-fit calculation. Padding changes are included; the first browser pass caught the difference between content-box and border-box observation.

Layout changes reframe only an automatically fitted desktop tabletop view. Manual wheel/orbit inspection, walking and immersive views retain their existing camera behavior. Fit terrain re-enables automatic fitting. The observer disconnects on disposal, and resize handling guards disposed applications. No layout polling is added to the animation loop.

## Production-browser evidence

The [browser harness](startup/browser-startup.mjs) runs the production viewer in Edge, holding the initial GPX response and deliberately delaying simulated VR/MR support promises. This tests the interface and layout policy; it does not emulate immersive poses or verify a Quest runtime. Terrain and imagery remain real provider data. DEM publication is paused after route readiness to keep terrain bounds fixed during the layout comparisons.

| Check | Result |
| --- | --- |
| Initial pending support / unloaded trek | Both entry controls disabled; status busy; zero session requests |
| Support succeeds while GPX remains held | Controls stay disabled until the trek is ready |
| Ready route with both modes supported | Controls enabled |
| Device change adds a support-status row | Controls disabled during checking; automatic terrain fit adapts to the taller header |
| Unsupported result | Both controls remain disabled; projected terrain fits inside available bounds |
| Footer padding changes after real wheel zoom | Camera and target preserved within `1e-12`; no fit callback |
| Explicit Fit terrain | Uses the changed footer bounds |
| Footer returns to its original size | Automatic fit runs once for that size change |
| Settled layout | No additional fitting during the measured 300 ms interval |
| Capability checks reject | Existing unknown/retryable state restored with explanation |
| 390 × 844 viewport | Terrain fits between controls; no horizontal overflow |
| Disposal | Observer disconnects once and is cleared; no additional fitting after teardown |
| Rendering / errors | Zero GL errors, page errors or console warnings/errors |

[Raw browser results](startup/browser.json) record the eight-corner projected envelope, available pixel area, camera/target poses and fit counters. The [availability layout](startup/availability-layout.png) and [mobile layout](startup/mobile-layout.png) capture the verified controls.

At 1233 × 821, adding the header support row changes the available top boundary from y=90 to y=122. Fitting responds once and keeps the terrain between the panels. A manually zoomed view intentionally keeps its camera when panel space changes; Fit terrain remains the explicit way to show the whole model again. These checks establish correct composition and readiness behavior, not a GPU or FPS improvement.

## Validation and limits

| Check | Result |
| --- | --- |
| Source and test TypeScript checks | Passed |
| Full local verification | [496 tests passed, 5 POSIX packaging fixtures skipped on Windows](startup/tests.log); production build passed |
| Production build before checkpoint commit | Main JS 911.28 kB / 238.55 kB gzip; worker 210.77 kB |
| Production browser | Delayed support/loading, border-box fitting, manual views, mobile controls and cleanup passed |
| Git whitespace check | Passed; existing line-ending notices only |
| Meta VR device listing | Empty |

New regressions cover pending capability checks, composition with loading/graphics/unknown support, and disposed applications. Existing route-readiness tests now explicitly finish support checking before expecting enabled buttons. Separate VR/MR results, stale checks and retryable probe failures retain their earlier regression coverage.

Run the browser harness from the repository root with `node docs/review-2026-10-13/startup/browser-startup.mjs`. Its Edge/Playwright paths match this Windows environment. The checkpoint workflow additionally requires passing [GitHub Linux CI](https://github.com/delphimon/trekviewer/actions), publication from a clean commit and hosted desktop/mobile checks using the browser's actual capability API.

Meta VR plugin verification identified the [WebXR overview](https://developers.meta.com/vr/documentation/web/webxr-overview) and [mixed reality browser support](https://developers.meta.com/vr/documentation/web/webxr-mixed-reality). Desktop rendering uses ANGLE D3D11 on an NVIDIA RTX 4060. No Quest is connected; native headset availability, immersive entry/exit, GPU duration, sustained FPS, thermals and comfort remain hardware checks. The main-bundle size warning remains.
