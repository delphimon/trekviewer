# Keep completed diagnostic runs across browser restarts

The opt-in profiler previously held its completed report only in the page's JavaScript memory. A reload or browser restart could discard it before download, and a bounded external recording window could expire before a headset run began. Neither an empty external capture nor an unavailable sleeping-browser tab establishes that the user did not run MR.

Completed nonempty reports now save asynchronously to IndexedDB when profiling stops, including normal XR exit. The profile controls restore the last saved report when reopened with `?profile=1`, display its recorded build ID, and enable Download JSON. The download name uses the report's original build and completion time, even when the running app is a different release.

The UI says **Saved on this device** only after the transaction commits. If local storage is denied or unavailable, the report stays downloadable in memory and says **Ready to download**. Starting another recording does not delete the stored previous result. An empty recording cannot overwrite it, and a late write from an older run cannot replace a report with a newer completion time.

Only one completed report is retained, bounded by the recorder's existing 1,800 windows and 128 events. No database work is added to animation callbacks. Restoration is asynchronous and cannot replace a newer in-memory report or a recording already in progress. A page-hide handler attempts to stop/save an active recording, but an abrupt browser/process termination before a committed save is not guaranteed recoverable. Clearing browser site data also removes the report.

## Session provenance

Recorded windows now include `xrPresenting`, `xrEnvironmentBlendMode`, and `xrEyeCount`. These describe actual presentation state sampled with the other counters, after the runtime has established its view. They help distinguish desktop, opaque VR and passthrough MR without storing head poses or room images. Existing older reports remain readable; their missing fields must not be inferred. Existing callback/GPU measurement limits still apply.

These changes apply only to the already opt-in profiler. They do not enable profiling on ordinary app launches or change terrain, imagery, source selection or render quality.

## Verification

`npm run verify` passed source/test type checks, **569 Windows tests with five POSIX-only tests skipped**, and the production build. Linux CI runs all 574 tests. [Verification log](verify.log).

[Production browser harness](profile-recovery-browser.mjs), [result](browser.json). Actual Edge and real IndexedDB verified:

- a desktop report survives closing and restarting the browser with the same browser profile;
- restored JSON matches the saved report;
- a simulated historical build ID remains intact in the displayed report, filename and downloaded JSON;
- profile controls fit within a 390-pixel viewport;
- denied database access leaves a newly completed report downloadable, without a JavaScript exception.

The test's historical build ID is a deliberate fixture. These are desktop storage/lifecycle checks, not a new native MR quality result. The existing headset follow-up report still requires retrieval from the device; no successful MR result is claimed from the expired external recording.
