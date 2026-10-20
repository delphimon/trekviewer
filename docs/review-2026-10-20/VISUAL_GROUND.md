# Refine terrain beneath the displayed hiker

Diorama Follow now prioritizes DEM beneath the visible hiker, using its model-local X/Z coordinates. Previously it used analytical GPS telemetry, although the displayed route is independently smoothed. On Olympus these progress representations differ by up to 969 m during the first 30 seconds. This is a correspondence along the route, not evidence of an incorrect DEM projection. Recorded telemetry remains unchanged.

Desktop camera following and anchored XR model following both use the displayed marker. The DEM focus now agrees with that same marker, independent of room placement, rotation, scale and vertical exaggeration. Stopping Follow restores inspected-view focus. Existing first-person behavior and all source, geometry and memory limits remain unchanged.

## Evidence and unresolved loading

The [baseline](visual-ground/baseline.json) records the published `787ece6` application. Its first 30 seconds have a maximum playing/following focus error of 968.97 m. The [local full tour](visual-ground/local-full-tour.json) completes the 90-second tour to progress 1 with focus error below 0.00001 m in every playing/following sample. This numerical tolerance describes the shared model coordinates, not real-world survey accuracy. The earlier local report's fixed condition text says “not full-tour”; its finished checkpoint and progress-1 samples establish the actual complete coverage of playback.

Fine terrain was ready beneath the hiker in **218/368** playing/following samples over the complete local tour. The first observation was 1.755 seconds after monitoring started. Fine coverage falls behind late in the route: correcting the target does not fix acquisition latency or establish better full-tour loading. The earlier baseline covers only 30 seconds, so its 117/124 fine samples cannot be compared as a whole-tour improvement. Both tests use real public services and uncontrolled cold network timing in desktop Edge with the Quest geometry budget.

Requested USGS local raster sampling remains approximately 1 m; rendered fine cells remain approximately 4.96 m. The broad overview still has approximately 94 m rendered cells. Two worker contexts remain alive without restarts. Local checkpoints retain the existing imagery-comparison tolerances and marker checks, with no page/GL errors. Paired draws range from 103→94 at overview to 187→105 during playback; these compare imagery rendering paths within this build and are not a speedup caused by the focus correction. Profiling includes deliberate render/readback stress and does not establish native frame delivery.

`npm run verify` passes both typechecks, **696 Windows tests with five platform skips**, and the production build. Two new application-loop regressions verify desktop/XR focus alignment, transformed model placement, unchanged telemetry and inspected-focus restoration. Desktop/mobile control checks additionally verify the focus against the actual marker rather than the analytical GPS value.

Native 72 Hz performance and subjective DEM clarity remain unverified; the user deferred the next headset run. Complete tour loading and broad overview detail remain open.
