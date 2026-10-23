# Verify route packs as acquisition finishes

The existing two-route acquisition process remains running. A separate local post-processing watcher now waits for completed Rainier and Enchantments archives and runs the [native-file verifier](PACK_FILE_VERIFICATION.md) for each. It does not restart the downloads, acquire sources, import data, publish files or access a headset. Full real packs and network-disabled tours remain unaccepted.

```powershell
node scripts/verify-default-route-packs.mjs --packs .review-cache/prepared-route-packs/output --out .review-cache/verified-route-packs --watch
```

Omit `--watch` for a single pass over currently available archives. Missing files produce an unfinished result and exit code 2. Watch mode polls every five seconds, with waiting-status writes limited to once every 30 seconds. It starts one verification child/browser at a time; source acquisition can continue independently. Like the preparation queue, it requires this PC to remain running and is not an OS service or a reboot-resume mechanism.

## Publication and result guards

The watcher waits for the final `.trekpack.tar` filename and its bounded, readable inventory with `complete: true`. Route identity, source count, original bytes, inventory fingerprint and exact archive size must be well formed and consistent. A partial filename, torn inventory write, mismatched size or incomplete inventory cannot start verification. Readiness is a publication gate, not proof of source validity.

Each ready file gets a fresh verifier process. That child binds the file to the current bundled GPX and complete source plan, verifies every stored/original hash and production source coverage, and streams the unchanged file's fingerprint. The watcher requires exit code zero and a matching complete report with all sources checked, the expected sizes/identities and zero external requests. An existing success JSON cannot bypass a failed child. Archive and source files remain untouched.

Either available route can be checked while the other remains missing. A verifier failure is recorded and does not prevent attempting the other ready route. When the source queue finishes, fails or pauses, any remaining missing archives produce an unfinished result rather than an endless wait. No default route is labeled verified until its child completes successfully. Starting the watcher again rechecks available files instead of silently trusting earlier reports; complete browser import/tour acceptance remains separate.

## Status and pause

The live watcher writes `.review-cache/verified-route-packs/defaults.verification.progress.json`, with `waiting-archives`, `verifying`, `verified`, `unfinished`, `failed` or `paused` state. Per-route verification progress and `.verified.json` reports are in the same directory. This run's hidden process forwards child output into `defaults.verification.stdout.log` and `defaults.verification.stderr.log` there. The watcher has its own `defaults.verify.lock`; each child also owns its route verification lock. Competing verification commands fail ownership checks.

Pause verification independently of acquisition:

```powershell
Set-Content .review-cache/verified-route-packs/defaults.verification.stop 'Pause verification'
```

The watcher and verifier child share that stop path. Wait for `paused` and released verification locks; remove the exact pause marker and rerun the command to restart verification. Acquisition's separate `defaults.stop` is unaffected. An abrupt process kill may still leave a lock requiring owner review. No automatic process killing or lock deletion is implemented.

## Evidence and limits

Eight focused regressions cover delayed final publication, incomplete/torn/oversized inventory, route/size/count/fingerprint mismatch, stale verification results and acquisition terminal-state reads. The full suite passes **816 Windows tests with five skips**.

The [command integration checks](pack-verification-queue/command-checks.json) show missing archives remain unfinished without launching verification, an isolated invalid fixture fails the child despite a deliberately stale success certificate, and a stop-file pause releases ownership without touching acquisition. The [live attachment snapshot](pack-verification-queue/attached.json) records the separate watcher waiting for the real files; its empty results list is not a complete-pack result. The source queue was not restarted. Real full-route verification will only be recorded after the corresponding archive becomes available.

The published app remains the measured `4d0a5f0-2026-10-22T20:47:14.831Z` build. This PC-tool checkpoint does not rebuild/redeploy it. It does not establish complete installed sizes, browser storage/import recovery, network-disabled High tours, signed APK behavior or native performance.
