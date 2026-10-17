# Completed Quest MR run: sharp imagery, substantial turnover

The replacement run was retrieved from the physical Quest 3 on release **`483e4d5`**. The app reported `profileSavedOnDevice: true`, which is set after its IndexedDB transaction commits. The completed JSON was also copied to the host before the headset became unavailable again. A subsequent direct database-read verification timed out, so an independent stored-versus-memory comparison is not claimed.

[Summary](mr-completed/summary.json), [completed report](mr-completed/profile.json).

The 164.7-second session used the bundled **Olympus and Bailey Range June 2026** route. It began in 1:1 trail mode, switched to tabletop at 91.8 seconds and exited XR at 164.7 seconds. There was a visibility pause/resume around 32–34 seconds. All 158 windows marked as presenting reported alpha-blend and two eye cameras. The final partial export window was outside XR. This was a user-driven run on a different route from the earlier Rainier capture; it is not a controlled performance comparison.

## Fidelity and retention

All **87 trail windows** with sampled terrain had at least one visible Z19 hit; **78/87** had Z19 at every sampled point. These are discrete terrain samples, not a full-screen pixel measurement or proof that every frame stayed sharp. USGS 3DEP remained the local elevation source, with approximately 1 m source sampling and 4.96 × 4.96 m local mesh cells.

No tracked fine tile became hidden while still resident, and there was no WebGL context loss. However, the resident limits were reached: 512 patches in trail mode and 448 in tabletop. The one-second snapshots observed **2,130 fine eviction events in trail mode** and 494 in tabletop; a key can be evicted more than once. The finer-grained cumulative counters show 3,502 patch creations and disposals between the first and last trail windows, followed by another 1,956 of each between the first and last tabletop windows.

Thus, stable visibility of resident tiles does **not** establish stable retained resolution: memory-pressure eviction and recreation remain substantial problems. The snapshot count can miss shorter cycles, so it is a conservative view of turnover.

## Performance remains below target

| Mode | Median callback rate | Median window CPU-submit p95 | Peak draw calls | Peak triangles |
| --- | ---: | ---: | ---: | ---: |
| 1:1 trail | 29.9 Hz | 18.1 ms | 872 | 3.40 million |
| Tabletop | 32.0 Hz | 25.5 ms | 1,068 | 7.64 million |

The runtime target was 72 Hz. There were 178 browser Long Tasks across the report. Callback intervals reached 595.5 ms and CPU submission reached 315.3 ms. These browser/application counters are not compositor-delivered FPS or measured GPU completion time. Async image/geometry work outside animation callbacks is not fully attributed by the per-frame phase timer.

The next performance investigation must separate selection-driven turnover, geometry preparation, texture uploads and render/GPU cost. This capture does not justify lowering source resolution or reducing the surrounding high-detail footprint. It does establish that the rendering/loading path still needs work even though fine imagery now reaches the sampled view.

## Exit lifecycle mitigation

The collector observed an `InvalidStateError` involving `XRFrame.detectedPlanes`, plus one unspecified promise rejection. It does not record exception timestamps or distinguish diagnostic evaluations from application execution, so the unspecified rejection cannot be conclusively attributed to the app. The parallel-shader extension warning remained.

The installed Three.js `WebXRManager` calls the application's animation callback and then reads `frame.detectedPlanes`. TrekViewer's in-app exit action can run inside that callback through XR input handling. Ending the session there risks invalidating frame data before the renderer finishes. The app now schedules its requested session end in a later task, suppresses duplicate pending requests, and handles a rejected `end()` promise with an actionable message.

The observed stack is consistent with this risk, but does not prove which action caused the runtime error. This change covers in-app exit ordering; it is not a verified fix for every headset/system-driven exit. Tests model the renderer's post-callback read and exercise asynchronous exit rejection. A new native exit result is still required. Frame lifetimes are described in the [WebXR frame-loop specification](https://immersive-web.github.io/webxr/#xrframe-interface).

## Verification

`npm run verify` passed type checking, **571 Windows tests with five POSIX-only tests skipped**, and the production build. Linux CI runs all 576 tests. [Log](mr-completed/verify.log). This checkpoint adds the completed native evidence and the narrow exit mitigation; it does not claim to have solved the recorded turnover or timing problems.

Raw room images, head poses and controller trajectories remain outside the published artifacts.
