# Load current terrain views before retained imagery

The broad High-quality selector kept the requested geographic coverage, but failed to raise the loading priority of a view tile already selected by its surrounding core. Newly added distant view targets had priority zero; a currently viewed edge already in the core could retain priority one. Previously viewed targets could consequently download before terrain currently in front of the user.

The selector now takes the better priority when an existing tile is encountered again. Current center-out view hits and their complete sibling groups receive ordered priority before the background neighborhood and retained view history. In 1:1 mode, the hiker anchor still comes first. Surrounding guard bands and all coarse ancestors remain selected; the change affects request order and the existing importance score, with the same tile and vertex budgets.

## Selection and scheduler checks

[Comparison script](native/view-priority-order.mjs), [result](native/view-priority-order.json). Run `node docs/review-2026-10-15/native/view-priority-order.mjs` from the repository root with Node 24. It evaluates the actual selector before this change (`f3a3c7f`) and after it, then compares tile keys and the initial order of distinct source exports.

In the representative fixture, a current view-edge source moved from **14th to 2nd**, directly after the hiker source. All **478 selected tiles**, including 244 fine tiles and their ancestors, were identical. The bare core and a larger history fixture also retained exactly the same tile keys. The larger-history case intentionally keeps later history behind current samples. This is an empty-resident selection/order comparison, not a measured download-time, GPU or frame-rate improvement. Existing sibling-completion priorities still apply when some tiles are already ready.

Four regressions exercise reprioritization of an already selected group, current-versus-retained ordering, full sibling/ancestor coverage, and the real imagery request scheduler. The scheduler tests verify that current view work starts first, that the hiker remains ahead of its view edge, and that the four pending requests still use distinct shared source rasters.

## Production browser check

The existing [failover harness](native/browser-failover.mjs) loaded the new production bundle in actual Edge using live public terrain and imagery while deliberately blocking the preferred NAIP+ endpoint. [Result](native/view-priority-browser.json). It published **72 opaque visible Z19 tiles**, each an exact 256-pixel crop from the configured USGS NAIP source, with zero JavaScript exceptions, zero WebGL error and no context loss. Five initial failed preferred-service requests were observed across startup/mode entry; none were repeated while fine coverage grew from 16 tiles to 72.

Expected blocked-request warnings and actual GeoPlatform CORS failures are retained in the result. The next configured NAIP service supplied the imagery. This validates the production selection/loading path on desktop, not native MR coverage or visual comfort.

## Verification and hardware limits

`npm run verify` passed source/test type checking, **567 tests on Windows with five POSIX-only tests skipped**, and the production build. Linux CI runs all 572 tests. [Verification log](native/view-priority-verify.log). Existing main-chunk and LERC build advisories remain.

The completed [native MR capture](MR.md) predates this priority change. A separate follow-up is armed on the already published `f3a3c7f` failover release; that capture must be attributed to its actual client build. There is no new native MR quality or timing result for the priority change in this checkpoint.
