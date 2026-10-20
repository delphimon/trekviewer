# Refine terrain beneath the displayed hiker

Diorama Follow now prioritizes DEM beneath the visible hiker, using its model-local X/Z coordinates. Previously it used analytical GPS telemetry, although the displayed route is independently smoothed. On Olympus these progress representations differ by up to 969 m during the first 30 seconds. This is a correspondence along the route, not evidence of an incorrect DEM projection. Recorded telemetry remains unchanged.

Desktop camera following and anchored XR model following both use the displayed marker. The DEM focus now agrees with that same marker, independent of room placement, rotation, scale and vertical exaggeration. Stopping Follow restores inspected-view focus. Existing first-person behavior and all source, geometry and memory limits remain unchanged.

## Evidence and unresolved loading

The [baseline](visual-ground/baseline.json) records the published `787ece6` application. Its first 30 seconds have a maximum playing/following focus error of 968.97 m. The [local full tour](visual-ground/local-full-tour.json) completes the 90-second tour to progress 1 with focus error below 0.00001 m in every playing/following sample. This numerical tolerance describes the shared model coordinates, not real-world survey accuracy. The earlier local report's fixed condition text says “not full-tour”; its finished checkpoint and progress-1 samples establish the actual complete coverage of playback.

Fine terrain was ready beneath the hiker in **218/368** playing/following samples over the complete local tour. The first observation was 1.755 seconds after monitoring started. Fine coverage falls behind late in the route: correcting the target does not fix acquisition latency or establish better full-tour loading. The earlier baseline covers only 30 seconds, so its 117/124 fine samples cannot be compared as a whole-tour improvement. Both tests use real public services and uncontrolled cold network timing in desktop Edge with the Quest geometry budget.

Requested USGS local raster sampling remains approximately 1 m; rendered fine cells remain approximately 4.96 m. The broad overview still has approximately 94 m rendered cells. Two worker contexts remain alive without restarts. Local checkpoints retain the existing imagery-comparison tolerances and marker checks, with no page/GL errors. Paired draws range from 103→94 at overview to 187→105 during playback; these compare imagery rendering paths within this build and are not a speedup caused by the focus correction. Profiling includes deliberate render/readback stress and does not establish native frame delivery.

`npm run verify` passes both typechecks, **696 Windows tests with five platform skips**, and the production build. Two new application-loop regressions verify desktop/XR focus alignment, transformed model placement, unchanged telemetry and inspected-focus restoration. Desktop/mobile control checks additionally verify the focus against the actual marker rather than the analytical GPS value.

Native 72 Hz performance and subjective DEM clarity remain unverified; the user deferred the next headset run. Complete tour loading and broad overview detail remain open.

## Published checkpoint

Application `e3d5b882c6e37362e3b469f9ffef5a500ecc4611` passed [CI](https://github.com/delphimon/trekviewer/actions/runs/39501376903), was rebuilt with a clean working tree, credential-scanned and published successfully to [TrekViewer](https://trekviewer.surge.sh/). Exact build: `e3d5b88-2026-10-20T21:34:31.057Z`, entry `index-Ch59zhy4.js`.

The [hosted full tour](visual-ground/hosted-full-tour-e3d5b88.json) confirms that exact client and completes playback to progress 1. All 367 playing/following focus samples agree with the visible hiker within 0.00001 m. Fine ground is ready in **264/367** samples, with first fine observation 1.752 seconds after monitoring begins. The difference from the local run is not a controlled speed improvement: cold service timing varies. Two workers are created and none close before teardown; page/GL errors are absent. Maximum paired image error is 0.0555/255 mean, 1.560/255 RMS, with at most 0.659% changed pixels, within the existing direct-rendering tolerances. Marker appearance checks pass.

[Hosted desktop/mobile controls](visual-ground/hosted-controls-e3d5b88.json) pass Play/Follow, anchored model motion with no tracked-camera movement, spatial stop/start, manual takeover, sampled ridge clearance, imports, landmarks and route replacement. These controls ran near the end of the live audit; its recorded timing is not an isolated performance comparison. The evidence-only follow-up retains the measured clean application build above.
