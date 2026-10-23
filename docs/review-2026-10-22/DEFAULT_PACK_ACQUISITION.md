# Real default-pack acquisition

**Source-coverage follow-up:** the v1 Rainier run later stopped at source 1,771 because both USGS mosaics contained a few masked pixels. The [v2 source recovery checkpoint](OFFLINE_NAIP_RECOVERY.md) adds the existing online GeoPlatform source after source/usage review, fixes cached-alternate priority and retains the current High coverage checks. Earlier running-state descriptions below are historical snapshots; use the live progress files for current job state.

**PC pipeline follow-up:** the queue later reached 2,435 validated Rainier sources before a deliberate pause. [Bounded preparation](PC_PREPARATION_PIPELINE.md) now overlaps two source tasks while retaining one production browser validator and ordered progress/archive records. Both commands accept `--source-concurrency 1|2`, default `2`; inventory-only behavior remains unchanged. The published client is the verified `4d0a5f0` build described in the source-recovery report. Older build and job-state descriptions below remain historical.

**Completed-file follow-up:** [pre-transfer file verification](PACK_FILE_VERIFICATION.md) can independently verify a finished default archive against its current full plan, production body validators and a streaming SHA-256 digest. It does not import data, download sources or restart the current queue. Complete packs and full offline tours remain pending.

Rainier and Enchantments are being acquired locally, in that order, with the current complete High public-source inventories. Neither complete archive nor a complete real-route offline tour is accepted yet. The website remains the previously measured `fad1dc2-2026-10-22T03:52:42.030Z` build; this checkpoint changes PC preparation tools and evidence, without changing rendering or publishing unfinished packs.

The drive had 358,122,856,448 bytes free before acquisition. The first Rainier attempt retained 39 validated sequential sources before source 40 failed with the previous generic response error. A separate header check of that same request subsequently returned HTTP 200, `application/octet-stream`, and 1,844,234 encoded bytes for its 679 × 679 DEM. The original response status was not captured, so its cause is unresolved; this is not evidence of a coverage or size defect.

PC acquisition now retries transport timeouts/network errors and HTTP 408, 429, 500, 502, 503 and 504 up to three times per approved URL. Requests, byte limits and validators stay unchanged. Backoff is bounded, respects a usable `Retry-After`, and stops rather than retrying early when the service requests more than 30 seconds. Invalid/oversized bodies, missing source coverage and other HTTP errors remain failures. Retries do not invent elevations or switch to a coarser source. Nine focused regressions cover unchanged encoded bytes/requests, bounded attempts/backoff, cancellation, permanent errors and byte limits.

[Real recovery evidence](default-pack-acquisition/transient-recovery.json) records HTTP 502 on the first two attempts for source 197 (zero-based index 196), backoff of two/eight seconds, and subsequent production validation past that index. The third attempt succeeded without restarting the queue. This demonstrates recovery for that request; the cause of the earlier generic source-40 response remains unresolved.

The downloader now records atomic per-source progress with actual original/stored bytes, phase, PID and time. Locks record their owning PID. A stop file pauses acquisition and archive publication; it is polled during asynchronous requests and checked between bounded source writes. Cancellation during the actual TAR writer leaves a partial file, without publishing the completed filename. An abrupt process kill can still leave a stale lock; review the recorded process identity before manually removing a lock. No automatic process killing or stale-lock deletion is implemented.

## Commands and monitoring

Inventory only, without source acquisition:

```powershell
node scripts/prepare-default-route-packs.mjs --cache .review-cache/offline-real-defaults
```

Explicit sequential acquisition of both defaults:

```powershell
node scripts/prepare-default-route-packs.mjs --cache .review-cache/offline-real-defaults --download
```

The queue accepts `--out` and `--identity` as well. It starts one producer/browser validator at a time. A failed route retains its validated files, and the other route is still attempted. The queue refuses competing locks. Pre-existing completed archive names are retained and reported as requiring review, rather than silently replaced or treated as freshly verified. For an unfinished individual route, the original `build-offline-route-pack.mjs --route ... --download` command remains available.

Output defaults to `.review-cache/prepared-route-packs/output`. Inspect `defaults.progress.json` and `<route>.progress.json` there. This run uses a hidden local queue with `defaults.stdout.log` / `defaults.stderr.log` in the same directory. It continues while the PC stays running; it is not an OS service or a scheduled restart after reboot. Sources, component files, logs and unfinished inventories remain outside Git and the deployed site.

Progress JSON is advisory. A later Windows sharing failure stopped a producer when the old writer could not replace its status file. The [verified recovery](OFFLINE_NAIP_RECOVERY.md) now retries transient sharing errors and preserves the last complete status; a persistent reporting failure emits `progress-write-deferred` in stderr without aborting source acquisition. A stale progress timestamp therefore does not establish that the producer has exited. Source, inventory and archive writes still fail normally, and a complete archive still requires every validated source and successful final publication.

To pause this queue:

```powershell
New-Item .review-cache/prepared-route-packs/output/defaults.stop -ItemType File -Force
```

Wait for the progress state to become `paused` and locks to disappear. Remove that exact stop file when ready to resume, then rerun the queue. Resume rechecks retained hashes and production coverage; valid original body files are not rewritten. Original bodies, optional gzip components and the finished archive consume separate disk space. Gzip is exact-byte archive compression, not a smaller runtime DEM format or reduced sampling resolution.

## Validation so far

Both inventory-only queue runs report the expected 5,337 Rainier / 8,177 Enchantments sources and existing canonical fingerprints. A pre-existing stop marker aborts before source acquisition and releases its route lock. The real Rainier run passed source 40, then paused cleanly with **120 sources / 222,097,644 original bytes** validated and **173,969,619 stored component bytes**. Both queue and route locks were released. [Actual resume verification](default-pack-acquisition/partial-resume.json) passes the saved prefix and checks all 120 original body hashes and write timestamps: zero changed hashes and zero rewritten originals. This partial sample contains elevation only; it does not establish total pack size or imagery savings. The hidden queue remains active, with Enchantments following Rainier.

Both typechecks and **774 Windows tests with five skips** pass. The actual [controlled three-source producer/reader fixture](default-pack-acquisition/writer-check.json) still produces its 3,150,336-byte TAR, independently listed by system TAR; damaged source input and cancellation after the first written source both prevent completed-name publication. These fixture and partial-prefix checks do not establish multi-GB archive completion, hard-kill recovery, full default-route coverage, installed storage size, native file selection, native frame rate or a network-disabled complete High tour. The user has deferred headset testing, and no headset was queried or launched.

Tooling checkpoint `91a41eb5a998e62b9ca0189cd1092b26f847ccf7` passes [exact-commit CI](https://github.com/delphimon/trekviewer/actions/runs/39803233205), including both typechecks, the Linux suite and production build. Credential scanning passes. No app runtime source or site assets changed, so the measured hosted build is retained without rebuilding/redeploying it. Acquisition remains a local background job with live progress files, not a completed deliverable or native performance acceptance.
