# Prefer visible warm imagery during budget eviction

The [native MR recording](MR_COMPLETED.md) observed 2,130 fine eviction events in its 87 trail snapshots. Some fine keys appeared in seven separate eviction observations. It establishes repeated removal of prior sharp views, but does not identify the complete candidate pool or visibility of every victim immediately before removal. This checkpoint addresses a reproducible retention-policy problem; it is not proof that this policy explains all native turnover.

Previously, distance/recency scoring could retain a hidden, unselected coarse fallback while evicting visible fine imagery from an earlier view. The fallback could have a higher score despite contributing no current pixels. Each eviction also scored every resident patch and queried route telemetry separately for every scored patch.

Eviction now uses three priority tiers:

1. Hidden, unselected patches that are not loading fallbacks are the first candidates.
2. Visible warm imagery and unselected loading fallbacks remain until that obsolete hidden work is exhausted.
3. Selected patches remain protected while any unselected patch is available.

Distance, recency and route proximity still choose the victim within a tier. Only that tier is scored, and its candidates share one route-position lookup. The existing hard resident limit remains enforced even if a reduced budget is smaller than the desired set.

Current selected tiles, source resolution, mesh density, overscanned view rays, filtering and materials are unchanged. The policy preserves visible detail longer by reclaiming hidden obsolete work. Under continued pressure, visible warm imagery can still be evicted. A removed unselected coarse fallback may need loading again if a later view requests it; selected and loading fallbacks keep their protection.

## Controlled comparison

The [comparison script](eviction-comparison.mjs) executes the current manager with either its new eviction method or the actual method from `6c1b71e`. Both begin with the same 512 residents: selected coverage, 128 published warm fine tiles and 32 fully covered, hidden warm fallbacks. Sixteen new selected fine tiles then arrive.

| Result | Previous method | New method |
| --- | ---: | ---: |
| Resident limit / final count | 512 / 512 | 512 / 512 |
| Prior fine tiles retained | 112 | 128 |
| Prior fine tiles missing on revisit | 16 | 0 |
| Obsolete hidden fallbacks reclaimed | 0 | 16 |
| All current selected tiles resident | Yes | Yes |
| Importance-score calls | 8,208 | 392 |
| Route-position queries | 8,208 | 16 |

[Machine-readable result](eviction-retention/comparison.json). These are deterministic residency and operation counts in a synthetic scenario, not measured network requests, elapsed-time speedups, native MR frame rates or a replay of the user's head movements.

## Instrumentation and checks

The opt-in profile report now includes `imageryBudgetEvictionsTotal`, `imageryVisibleBudgetEvictionsTotal` and `imageryDesiredBudgetEvictionsTotal`. These cumulative counters distinguish pressure eviction from style/disposal cleanup, and record whether a victim was visible or desired at eviction. Visible means the scene mesh was enabled; it does not establish that either eye's frustum contained it or that it contributed pixels. Older reports without these optional fields remain compatible. A route/manager replacement starts a new set of counters, like the existing imagery creation/disposal counters.

Five new tests cover visible warm retention, selected hidden work, loading fallbacks, a 512-patch scoring case and forced desired eviction under a smaller budget. The recorder test checks that the new fields reach exported windows. `npm run verify` passed type checking, **581 Windows tests with five POSIX-only tests skipped**, and the production build; Linux CI runs all 586 tests. [Verification log](eviction-retention/verify.log).

The actual production-browser streaming test reached at least 64 opaque visible Z19 tiles with full 256 × 256 imagery crops and no JavaScript exceptions, context loss or WebGL errors. Its controlled preferred-source failures fell through to configured public imagery. GeoPlatform CORS failures are retained in the evidence; USGS imagery succeeded. [Browser result](eviction-retention/browser.json).

Meta's [WebXR performance workflow](https://developers.meta.com/horizon/documentation/web/webxr-perf-workflow/) was verified through the Meta VR tools for this checkpoint. Native GPU/compositor timing, sustained frame pacing and the real-world retention benefit still require a comparable headset run. Stereo draw-call cost remains open.
