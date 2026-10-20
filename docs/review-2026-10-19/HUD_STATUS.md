# Clear spatial controls and tabletop profile context

The clean landmark checkpoint `08e305c` passed [CI](https://github.com/delphimon/trekviewer/actions/runs/39354309521) and [hosted desktop/mobile validation](landmarks/hosted-08e305c.json). This checkpoint continues the diorama work with a reproduced spatial-control obstruction and more useful baseline reports.

## Visible status without obscuring controls

The status pill occupied canvas rows 612–660, over the horizon and playback-timing controls at rows 620–674. A deterministic test of the actual 1024×768 canvas found **39,114 changed control-row pixels** when a status message appeared. [Baseline data](hud-status/baseline.json), [before](hud-status/before.png).

The pill now occupies rows 680–716, replacing the footer hints temporarily. An opaque background keeps the status readable; credits remain below it. The control row stays byte-for-byte unchanged when status/progress appears. The panel resolution, physical dimensions and control hit areas are unchanged. [After](hud-status/after.png), [browser results](hud-status/browser.json).

Visual inspection also caught a landmark collision: a day boundary at the final route station could suppress Finish. Endpoint landmarks now remain distinct from co-located day boundaries/camps/summits, with a focused regression.

## Profiling and measurement limits

Profile windows now include playback mode, speed, play/pause, camera-follow state, route progress, HUD visibility and cumulative redraw-upload requests. A `playback-context` event records the initial state and subsequent changes without room, controller or head-pose data. Native capture and summary helpers retain these fields; older reports remain readable and show unknown playback context.

HUD counters measure redraw requests and logical uncompressed RGBA source bytes (`width × height × 4` per request). They do not measure actual GPU transfers, bandwidth, compositor delivery or GPU time. Requests can coalesce before rendering; counters restart when a route replaces the HUD. Summaries explicitly report sampled increases rather than claiming all uploads were observed. Playback fields are snapshots at each window's end; consult events when settings change within a window.

Validation covers the recorder fields, 620 passing tests (5 skipped), typechecking/build, desktop/mobile control pixel comparisons, zero hidden-HUD upload requests, route-tour/landmark regressions and an actual browser-generated [fixture profile](hud-status/390-profile.json). The summary helper was checked against this profile and the older `483e4d5` MR report. Browser validation now checks the executed entry filename and exact build ID, so an older HTML/client cannot pass merely because newer build metadata is available. Fixture source requests are deliberately blocked; these results do not measure geographic fidelity or native performance.

## Prepared native tabletop baseline

The October 19 device query returned no connected headset. Native gates remain open; this is a test protocol, not a completed run. First-person acceptance remains deferred.

1. Confirm the exact published client entry/build, chosen route, High/Aerial settings and `?profile=1` tab before attaching `scripts/capture-quest-profile.mjs`. Use one fixed route for comparisons and retain its source/provenance counters.
2. Start paused in the anchored tabletop overview. Inspect center, upper/lower and side terrain, then slowly turn away and return. Separate cold loading from revisiting established views.
3. Run a 1x, 90-second tour with the XR viewer and model anchored. Include pause/scrub/resume, hand/controller manipulation and seated inspection. The desktop Follow route feature is separate and stays disabled in XR.
4. Exit XR, retain the completed report on the device and copy it to the host. Check client identity, eye count, blend mode and playback-context events. Pair browser reports with available Meta GPU/frame-delivery/thermal measurements; callback timing alone does not certify 72 Hz or comfort.
5. Use matching paused/tour portions to choose the next terrain submission, upload/publication or selection/retention change. Preserve High's source detail and surrounding coverage during comparisons.
