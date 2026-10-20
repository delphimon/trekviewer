# Publish ready terrain and coalesce HUD uploads

Three reproduced issues delayed useful terrain or generated unnecessary display work:

1. Parallel DEM acquisition still awaited the first selected request. Completed sections stayed blocked behind a slower server response. The geometry lane now waits for any eligible acquisition, then selects completed sections in the current wanted order. The first request remains available and publishes when it arrives. Concurrency, source precision, resident budgets and one-section-per-frame publication are preserved.
2. When imagery arrived during surface preparation, its publication guard rejected the prepared result. The streamer discarded an already validated terrain chunk, reacquired its DEM and rebuilt it. It now retains that one staged chunk and refreshes only imagery preparation. Generation, wanted-set and disposal guards still reject stale candidates. Capacity is reserved for the actual completed footprint, including partial edge tiles; failed/missing DEM does not evict warm terrain.
3. Hover, leave, drag, clicks and state changes could force HUD uploads past the intended cap. Every redraw cause now uses the same 85 ms minimum interval after the initial display. Input callbacks and session state update immediately; the latest display is coalesced and flushed by the frame update, including pause and scrub completion. Hidden HUDs remain upload-free.

## Matched production-browser reproduction

`scripts/check-terrain-readiness-browser.mjs` exercises the actual bundled streamer and real browser terrain worker. It injects synthetic DEM completion order and imagery-publication invalidation, and replays 720 combined hover/drag events over a controlled one-second display clock. The original app is the exact previously published `e8f0d28` entry, preserved locally before publication changes. This fixture measures scheduling and requested display work, **not** native frame delivery, real server latency, DEM accuracy or GPU transfer bytes.

| Controlled condition | Published baseline | Updated implementation |
| --- | ---: | ---: |
| Sections published while the first request remains pending | 0 | 2 |
| Sections published after all three requests complete | 3 | 3 |
| DEM acquisitions after one imagery invalidation | 2 | 1 |
| Terrain builds after that invalidation | 2 | 1 |
| Imagery preparations after that invalidation | 2 | 2 |
| HUD upload requests, including final display | 1,441 | 12 |
| Logical RGBA source bytes requested | 4,532,994,048 | 37,748,736 |

The same final scrub progress is displayed, with no dirty display left pending. The fixture observes a real worker, no worker-startup fallback and no page exceptions. [Baseline evidence](terrain-readiness/before.json); [updated local evidence](terrain-readiness/after.json). Run with `TREK_READINESS_BASELINE=1` and `TREK_READINESS_DIST` pointing at the preserved baseline to reproduce the negative control. The fixture requires the earlier locally captured Olympus LERC file in `.review-cache/dem-registration/olympus-corrected.lerc`; refresh it with the existing DEM registration audit if needed. Use `TREK_READINESS_URL` for a hosted client and `TREK_READINESS_OUT` for a separate output directory.

Regression coverage includes slow-first-request bypass, eventual arrival, imagery invalidation without reacquisition/rebuild, disposal during retry, capacity with a larger completed tile, missing-DEM retention, callback immediacy, the strict display cap and final paused display. `npm run verify` passes **670 Windows tests with five platform-specific skips**, source/test typechecking and the production build. [Desktop/mobile checks](terrain-readiness/tour-local.json) cover tour, follow, status, landmarks, XML import and sampled ridge clearance.

Application commit **`62893a4`** passed [CI](https://github.com/delphimon/trekviewer/actions/runs/39386529420), was rebuilt cleanly and published to the existing test site. The [hosted worker/HUD fixture](terrain-readiness/hosted-62893a4.json) reproduces the updated column above on exact entry `index-D-Yd30s8.js`, build `62893a4-2026-10-20T07:26:35.311Z`. [Hosted desktop/mobile checks](terrain-readiness/hosted-tour-62893a4.json) also pass on that same client. The evidence-only follow-up retains this measured application build on the site. No new native headset result is claimed.

The whole-route overview DEM and mesh density remain unchanged. These fixes do not establish restored native terrain detail or 72 Hz delivery. The [second-review response](REVIEW_RESPONSE.md) identifies compatible imagery batching and coordinated terrain/imagery ownership as the next architectural work, with physical exaggeration, source precision and broad High coverage retained as constraints.
