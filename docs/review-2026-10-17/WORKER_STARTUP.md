# Recovering terrain worker startup

During hosted cache-checkpoint verification, a cold normal load failed with `Terrain worker failed: undefined`, leaving no active trek. A subsequent instrumented normal load passed with the worker script returning HTTP 200. The failing run did not capture a resource response sufficient to identify the original network/browser cause; no claim is made that it was specifically CDN propagation or a GPU fault.

The application recovery defect was reproducible: worker construction returned before the module loaded, and the first job transferred its only terrain/image buffer immediately. A module error then rejected route construction after that buffer had detached. Constructor-only fallback could not protect asynchronous module loading.

## Change

The worker posts a readiness message after imports initialize and its message handler is installed. The serialized job queue waits for that message before transferring caller-owned buffers. Startup has a five-second deadline per attempt, one fresh retry, then a ten-second cooldown using the existing identical local computation. A later job retries the worker after the cooldown. Successful workers retain the existing single-worker serialization and surface-source reuse.

Cancellation during initialization terminates the worker and rejects without retrying or computing locally. Disposal and cancellation between readiness and dispatch are checked before transfer. Startup listeners/timers are removed on every path. Execution and message-decoding errors after dispatch remain errors rather than replaying a job with detached data. Empty runtime error messages now receive a descriptive label.

No terrain samples, mesh spacing, imagery resolution, source priority or memory budgets change. The temporary local fallback can cost main-thread time; it is a recovery path, not a claimed performance improvement or a silent quality reduction. Native timing/comfort acceptance remains open.

## Validation

`npm run verify` passed types, **601 Windows tests plus five POSIX-only skips**, and production build. [Log](worker-startup/verify.log). Five focused tests cover readiness before detachment and retry, repeated failure/cooldown fallback with intact bytes, cancellation, never-ready timeouts/recovery, and non-replay of execution errors. Existing streaming tests retain exact geometry, bounded pending jobs, surface revision and cancellation coverage with the new readiness protocol.

The [production browser harness](worker-startup-browser.mjs) deliberately aborts worker script requests using actual Edge WebGL and real USGS data. [Result](worker-startup/browser.json):

- One blocked startup: two script attempts, automatic recovery through a real worker, no local-fallback warning.
- Two blocked startups: route still loads with original USGS elevation via local computation; one bounded warning. After cooldown and trail entry, a third script attempt succeeds and worker use resumes.
- Both routes have identical base elevation Float32 SHA-256 hashes, zero JavaScript exceptions and zero WebGL errors.

Injected script/imagery failures and the intentional local-fallback warning are retained as diagnostic evidence. This is desktop recovery evidence, not native GPU/FPS validation.
