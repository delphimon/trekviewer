# Prepared route-pack file verification

The default Rainier/Enchantments acquisition queue continues without a restart. This checkpoint adds an independent, read-only pre-transfer check for a completed archive. It does not change the published app, preparation source inventory, original bytes, rendering or runtime budgets.

The verifier selects the existing local TAR through a native browser `File` handle. It never converts the entire archive to base64 or a whole-file Node/Playwright buffer. Production import code checks bounded headers, the current bundled route/layout fingerprint, original request provenance, stored and original body hashes, bounded gzip decompression, and every source's production worker/Canvas coverage validation. One source is loaded and validated at a time; the existing 8 MiB imagery / 32 MiB DEM body limits remain. All external browser requests are blocked, and any attempted external request fails verification.

After source verification, Node streams the archive through SHA-256 in 64 KiB chunks. The file size, identity and modification/change timestamps must agree before and after the check, and the browser's file size must match the streamed byte count. A completion report is written only after these checks succeed. Its digest identifies the measured file; an older report is historical evidence, not automatic approval for a subsequently replaced file.

## Commands

Use Node 24 with the repository's existing local Edge/Playwright tools. No tooling is installed and no source acquisition or headset access occurs.

```powershell
node --experimental-transform-types scripts/verify-offline-route-pack.mjs --route rainier-emmons --file .review-cache/prepared-route-packs/output/rainier-emmons.trekpack.tar
node --experimental-transform-types scripts/verify-offline-route-pack.mjs --route enchantments-dragontail --file .review-cache/prepared-route-packs/output/enchantments-dragontail.trekpack.tar
```

The command refuses a partial filename and only builds plans for the two supported bundled routes. Use `--out <directory>` to select report output; the default is `.review-cache/verified-route-packs`. An exclusive per-route verification lock prevents competing verification commands in that output directory. Progress JSON is advisory and uses the existing Windows sharing-lock recovery; the final `.verified.json` report is a required write. Errors and cancellation publish no new success report and release the lock. An abrupt process kill may still require manual lock-owner review.

SIGINT/SIGTERM or `--stop-file <path>` cancel the operation. Existing archive/source files are untouched. Verification currently restarts from the first source after interruption; it does not persist a resumable verification prefix or import data into browser storage. A [separate post-processing watcher](PACK_VERIFICATION_QUEUE.md) can now run this check automatically as complete default archives appear, without restarting acquisition. Full installed-pack import/tour acceptance follows independently.

## Evidence and limits

The [native-file component check](pack-file-verification/native-file.json) verifies the real three-component archive: **3,150,336 archive bytes**, 3,147,543 original source bytes, one LERC DEM and two original images. The independent streamed SHA-256 is `ba526f2866707bb54428f05f563bc68dc663e3a2c75182232486cadebda7f4d2`, matching the existing one/two-lane archive-parity check. It reports zero external requests. A damaged archive body and wrong route revision are rejected; cancellation stops after one validated source. The [command revision guard](pack-file-verification/cli-rejection.json) rejects this controlled fixture when asked to verify it as the full current Rainier pack, leaves no success report and releases its lock.

The [large-file negative check](pack-file-verification/large-file-negative.json) uses an actual **4,362,200,576-byte local file** with 130 valid bounded USTAR headers. The browser indexes its final source at offset **4,328,645,120**, beyond 4 GiB, using native file slices. Deliberately invalid source data fails the first stored-body hash, with zero sources accepted. This closes the previous virtual-only evidence gap for large file header/offset reads; it does not establish a valid multi-GB pack import, browser quota/recovery, headset file selection or native performance. The fixture is opt-in (`scripts/check-offline-archive-preparation.mjs --large-file`), requires its actual disk space plus headroom and stays outside Git and site deployment.

Five focused regressions cover the independent file fingerprint, rejected production source verification, file mutation, browser/Node size disagreement and cancellation. The complete suite passes **808 Windows tests with five skips**. Complete real Rainier/Enchantments archives, measured installed sizes, browser imports and network-disabled High tours remain open. The measured website remains `4d0a5f0-2026-10-22T20:47:14.831Z`; this PC-tool checkpoint does not rebuild/redeploy it.
