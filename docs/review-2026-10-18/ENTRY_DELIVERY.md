# Verified application startup and bounded delivery recovery

During hosted Swiss-source validation, the same published JavaScript URL intermittently returned different bytes. A response associated with Surge edge prefix `2920175` had its first 799,289 bytes zeroed; other sampled edges returned the exact clean build. Both bodies were 953,837 bytes and advertised the correct ETag. Identical republishing and query parameters did not eliminate the discrepancy. [Sample response headers and hashes](entry-delivery/delivery-headers.json) preserve the observed evidence. This does not establish the cause of earlier worker errors or native tile behavior.

The good entry's SHA-256 was `d3d7c93125be262e82c10bb575271f29ddbaebcca6f22a0e0c81372fa2fc080b`; the damaged response was `c404d3dc6c7082ffbb12ebdcdf77483b1d5ac27ebcab5789fe318482f09de2a1`. This is a delivery problem, not a terrain quality setting.

## Implemented recovery

The production build now stamps its exact application entry bytes with SHA-384 [Subresource Integrity](https://developer.mozilla.org/en-US/docs/Web/Security/Defenses/Subresource_Integrity). The browser rejects mismatching entry downloads before execution. A small inline handler permits two delayed retries using the same expected digest and a distinct request URL. Exhaustion displays an accessible alert and reload button; it never runs unchecked downloaded code or retries indefinitely. App initialization also handles a verified module arriving after DOMContentLoaded.

The [Vite build hook](https://vite.dev/guide/api-plugin.html) fails if it cannot match exactly one application entry. This guard covers that entry, not all imported chunks, workers, HTML or source-data endpoints. It does not repair the underlying hosting edge, authenticate HTML against a hostile host, provide offline startup, or guarantee recovery when all three downloads fail. Existing terrain-worker startup recovery still applies independently. No source sampling, FOV coverage, texture quality, DEM precision, render profile or cache budget changes.

## Validation

- Types, production build and **609 Windows tests passed, with five POSIX-only skips**. [Log](entry-delivery/verify.log). Two focused build-hook tests verify exact digest stamping and refusal to publish an unmatched entry.
- The [real-browser harness](entry-delivery-browser.mjs) checks the actual built file against its HTML digest, then intercepts application requests with deliberately wrong executable bytes. With zero, one or two injected failures, the app starts with exactly one rendering canvas and no page exceptions. With three failures, no app starts and the alert appears. The sentinel wrong code never executes in any case. [Results](entry-delivery/browser.json).
- Hosted build metadata, browser startup and Swiss-source regression checks are publication checks performed after the clean commit is rebuilt. Local browser evidence above is distinct from native acceptance and from live hosting availability.

Native fidelity, frame delivery, comfort and lifecycle gates remain open while headset testing is deferred. Swiss terrain still uses the documented global fallback; regional DEM/lidar integration remains on the completion plan.
