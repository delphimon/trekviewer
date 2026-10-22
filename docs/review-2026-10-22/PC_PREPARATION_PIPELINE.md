# Bounded PC route-pack preparation

The single-source default queue reached 2,435 validated Rainier sources, retaining 2,440,911,251 original bytes, before a deliberate pause for this checkpoint. It recovered from intermittent public-service timeouts/502s and rejected masked imagery in favor of existing approved alternatives. Downloading, decoding, coverage validation and archive bookkeeping previously waited for each other on every source. Neither default route was complete.

PC preparation now overlaps at most **two source tasks**, with **one production browser validation job**. This changes local preparation tools, without changing the published app, source inventories, request identities, decoded pixels/heights, runtime memory/GPU limits or archive format. Rainier remains first, followed by Enchantments.

## Work and retention bounds

The ordered window counts completed results waiting behind an earlier source, as well as acquisitions still running. A blocked earlier request cannot accumulate a route's worth of downloaded bodies in memory. The existing per-body limits remain 8 MiB for imagery and 32 MiB for DEM; the two acquisition slots therefore hold at most 64 MiB of accepted encoded source bodies, separately from transport, decoder, hashing, compression and archive-writing allocations. This is not a bound on total process memory.

Every resource still checks all retained aliases before network acquisition, uses the same transport retry/cooldown behavior and passes the same production worker/Canvas coverage validator. The validation lane serializes both DEM and imagery work, recovers after a rejected candidate and checks cancellation before starting queued validation. Original body and metadata writes occur only after successful validation. A source may finish and be retained ahead of the ordered progress prefix; resume revalidates it normally.

Archive records, byte totals and progress advance in inventory order. The pipeline observes later task failures immediately, stops admitting further work after a known failure and cancels/drains pending acquisitions before browser teardown or lock release. Consumer failure and pause use the same drain. Required source/archive writes retain their failure behavior; advisory progress JSON retains the [Windows sharing-error recovery](OFFLINE_NAIP_RECOVERY.md).

Both preparation entry points accept `--source-concurrency 1` or `2`, defaulting to `2`. Other values fail before acquisition. This option is PC-only; browser downloads retain their existing single acquisition/validation lane.

```powershell
node scripts/prepare-default-route-packs.mjs --cache .review-cache/offline-real-defaults --download --source-concurrency 2
```

To compare or reduce network overlap, use `--source-concurrency 1`. The stop-file and lock procedure in the [acquisition guide](DEFAULT_PACK_ACQUISITION.md) remains applicable. Progress now includes the configured source/validation caps and actual active/peak task counts. These are software job counts, not GPU or native frame measurements.

## Verification

The [real-component fixture](pc-preparation-pipeline/archive-parity.json) uses the existing real Rainier LERC and two original public imagery bodies, with controlled delayed transport responses and no external requests. With one source lane, completion order is `[0,1,2]`; with two, it is `[1,0,2]`. Peak production validation remains one. Both runs produce the exact same **3,150,336-byte archive**, SHA-256 `ba526f2866707bb54428f05f563bc68dc663e3a2c75182232486cadebda7f4d2`. System TAR independently lists the expected manifest and three members; cancellation and a damaged source prevent final archive publication. This is a controlled component test, not a full route or a public-service speed benchmark.

Thirteen focused pipeline regressions cover the bounded pending window, original byte identity/order, single-lane operation, failures in earlier/later jobs, consumer and parent cancellation, validation serialization/recovery, queued validation cancellation and invalid concurrency settings. The full suite passes **803 Windows tests with five skips**. Inventory-only PC runs retain the exact v2 source counts and fingerprints: 5,337 Rainier sources (`a1afd42ff813193d26a5a5739de4803eaa791a3c2a6cf8e6e98dbe32cacfd290`) and 8,177 Enchantments sources (`b4f79c2cd58443f7783e85ec73451385a643b6b4787d0f23be0139298c95dcfb`). No sources are acquired by the inventory-only command.

The live sequential queue resumes using the bounded pipeline and revalidates retained originals before new acquisition. Actual task counters reach two source tasks and one validation job. A [cache-wide original-body check](pc-preparation-pipeline/retained-originals.json) after restart verifies **2,696 originals / 2,921,669,398 bytes** against the pre-restart snapshot, with zero changed hashes, rewritten files or missing originals. This includes retained data for both routes; it is not a complete-route coverage result.

Complete archives, measured installed sizes, full network-disabled real-route tours and native acceptance remain open. The measured [published app](https://trekviewer.surge.sh/) stays at `4d0a5f0-2026-10-22T20:47:14.831Z`; this PC-tool checkpoint does not rebuild/redeploy it.
