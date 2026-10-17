# Explicit High-quality XR rendering

Implements completion-plan checkpoint 1. High (`quest-high` and `desktop-high`) now requests fixed foveation **0**, removing the inherited Three.js request for maximum peripheral reduction. Balanced explicitly requests **1** as its power-saving policy. Both keep the existing framebuffer scale request of 1; terrain sampling, imagery sources, meshes, overscan, filtering and resident budgets are unchanged.

The request is set before XR entry, reapplied after layer/session creation, and updated during live quality changes. Session re-entry uses the latest selected profile. Disposal removes the session handler. The policy does not modify the viewer's camera pose or the terrain transform. A rejected setter is logged; diagnostics still report the layer independently.

## Runtime evidence, not a cached request

Opt-in profile windows now contain requested foveation and the actual layer's readable `fixedFoveation` value, support status, projection/WebGL layer type, texture/framebuffer dimensions, array length and at most two eye viewport dimensions. The existing refresh-target fields remain. Unsupported values are null; an unavailable/detached layer leaves support unknown. Ordinary desktop windows report layer type `none` and unknown applied foveation.

Three.js's `getFoveation()` returns its cached request, so it is deliberately not used as confirmation. A layer's readback is still the runtime-reported setting, not a physical display-resolution measurement or GPU timing. The summary CLI prints requested/reported foveation and layer dimensions when present; older reports remain compatible.

Meta's [FFR documentation](https://developers.meta.com/horizon/documentation/web/webxr-ffr/) was verified for this checkpoint. Removing peripheral reduction can increase fragment work. No reduction elsewhere in High compensates for that cost; device performance remains an acceptance gate.

## Validation

- `npm run verify`: types, **587 Windows tests plus five POSIX-only skips**, and production build passed. Linux CI runs all 592 tests. [Log](xr-quality/verify.log).
- Six new tests cover construction/session setup, re-entry, live switching and listener cleanup; actual layer versus cached request; unsupported values; detached layers; metadata bounds. Existing recorder coverage verifies export of the new fields.
- Actual Edge WebGL with Quest user-agent policy verified High → Balanced → High requests 0 → 1 → 0, preserved camera/target/model/progress, a committed saved report with unknown applied XR values, and zero JavaScript/console/WebGL errors. This was not an immersive session. [Result](xr-quality/browser.json), [harness](xr-quality-browser.mjs).

## Prepared native capture

`scripts/capture-quest-profile.mjs` attaches to an existing Quest Browser CDP forward. It does not navigate, change proximity/Guardian settings, or store head poses/room images. Select the exact tab with `--tab` if multiple profiling tabs exist. The expected actual client script is mandatory; server metadata alone is not accepted as client provenance.

```powershell
node scripts/capture-quest-profile.mjs --build <short-sha> --script <index-hash.js> --tab <CDP-id> --out .review-cache/quest-current --seconds 1200 --cpu-seconds 8
```

The helper copies each completed nonempty matching-build report as soon as it is observed, preserves prior copies on sleep/disconnect, timestamps runtime errors and separately labels diagnostic evaluation failures. It only treats a run as completed for this capture after observing XR recording and a report containing native stereo windows. Optional eight-second CPU sampling begins after 30 seconds of active XR and is marked in the app report; exclude that interval from uninstrumented timing comparisons. No CPU sampling occurs by default.

For the baseline, use the bundled Olympus/Bailey route, fixed progress 0.3555875547854273, High/Aerial, stationary 1:1 inspection followed by slow up/down/left/right turns and returns. Record VR and MR separately and include tabletop inspection. Attach capture before requesting the user's test. Verify the client build, layer readback, actual view dimensions, committed save and host copy. Add Meta CPU/GPU/compositor/thermal capture while native XR is active; browser counters alone are insufficient.

If a controlled legacy-foveation comparison is needed, keep the same route/progress/view and isolate an explicitly marked diagnostic interval requesting 1, followed by restoration to High's 0. Do not change production High defaults or use Balanced as an A/B proxy: its terrain budgets differ. No such native comparison has been claimed from the desktop results.

At preparation time the Quest was connected and in standby. Current-build native clarity, GPU cost, frame pacing, exits, restart recovery and sustained usability remain open under plan checkpoints 2–5.
