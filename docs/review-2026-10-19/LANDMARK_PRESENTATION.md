# Shared diorama landmark navigation

The tour checkpoint `c2aab97` passed [CI](https://github.com/delphimon/trekviewer/actions/runs/39350321491) and was published to the existing test site. [Hosted desktop/mobile checks](diorama-tour/hosted-c2aab97.json) identify that exact clean build. Its publication is separate from the landmark change described here.

Desktop chips, the dropdown, both elevation profiles and spatial landmark navigation previously deduplicated or projected landmarks separately. Rounding coordinates could remove nearby named camps, and projecting the Finish of a loop could return its Start. The dropdown also reconstructed names from visible option text, truncating a genuine parenthetical suffix.

`resolveRouteLandmarks` now produces one sorted presentation list when a route commits. Both UI renderers receive the same list. Derived landmarks carry known cumulative route distance from the GPX parser, which route preparation preserves. Start and Finish have distinct endpoint progress, even at identical coordinates; repeated visits at different route stations remain distinct. Duplicate copies at one station are removed while nearby named stops remain available.

Selection callbacks carry the selected route progress through to navigation. The dropdown indexes its current route list instead of reconstructing coordinates/names from labels. The spatial chart tooltip also chooses nearby landmarks by route distance, so a returning hiker can see Finish rather than Start. This consolidates presentation/navigation metadata; it does not replace the terrain system or change physical pin placement/collision behavior.

Validation includes four focused data regressions, the existing landmark/dropdown/chart tests, the complete suite (619 passing, 5 skipped), and typechecking/build. The [browser script](diorama-tour-browser.mjs) checks shared-list identity, nearby camp retention, names containing parentheses, and actual Finish selection through desktop controls and spatial Next Landmark on a loop in desktop and mobile layouts. [Local results](landmarks/browser.json) use synthetic fallback terrain with external source requests blocked; this is control/lifecycle evidence, not source-fidelity or native performance acceptance.

Next work remains the tabletop native baseline, then performance changes chosen from measured CPU/GPU costs. First-person development/acceptance remains deferred. Caching, precise imagery UVs and High fidelity remain requirements.
