# IMPROVEMENT_PLAN status

Legend: **done** (with tests) / **partial** / **not started**.

| # | Item | Status | Notes |
|---|---|---|---|
| 1 | Complete Public Suffix List | **done** | Full list with private suffixes (`lib/psl_data.js`, regenerate with `tools/build_psl.mjs`). Caches keyed per tenant; tenants skip registration lookups and are labelled. Tests: public/private suffixes, wildcards/exceptions, IDN, IPv4/IPv6, trailing dots, malformed hosts. |
| 2 | Safe Browsing on complete URLs | **done** | Full normalised URL (no fragment/credentials), separate URL-level cache, configurable TTL (Options), failures are "unavailable" not clean. |
| 3 | Prevent stale tab results | **done** | Per-tab generation tokens + `AbortController`, result published only if token and live tab URL match, state cleared on close. Tests include the real `background.js` with a late, cancellation-ignoring provider. |
| 4 | Provider timeouts and validation | **done** | Shared `fetchJson` (timeout, size cap, content type, error kinds, credential scrubbing); validators for RDAP, Archive, Safe Browsing, Trustpilot, Companies House, buyer backend; short separate failure cache; failures shown as unavailable checks. |
| 5 | Unverified buyer reports out of scoring | **done** | Zero score impact, labelled unverified with sample size and window; no longer counted as evidence. |
| 6 | Abuse-resistant reporting | not started | Needs server-issued signed identities, burst detection, moderation. |
| 7 | Evidence-family scoring | **done** | Evidence families, rule-based verdicts (Dangerous / High risk / Caution / Limited evidence / Lower risk indicators), two independent families required for a positive verdict, score kept consistent with the verdict. Property tests for monotonicity and contradictory evidence. |
| 8 | Confidence and provenance | **done** | Each signal records source, scope, provenance (verified/inferred/user-reported/unavailable/stale), checked and expiry times, score effect and explanation; reports carry a Low/Medium/High confidence and a plain-language summary. |
| 9 | Calibrated language | **done** | Calibrated verdict names and a permanent "cannot guarantee" statement in the popup, badge panel, hover card and checkout warning. "Trust score" is now "evidence score". |
| 10 | Company verification | not started | |
| 11 | Product-price comparison | not started | Current signal compares with the median of the results page only; capped at "caution". |
| 12 | Review evidence | partial | Absence from Trustpilot is neutral; no business/domain matching, recency or burst analysis. |
| 13 | Minimise data sent | partial | Documented in README; hover lookups drop the query. No per-provider toggles or cache reset UI yet. |
| 14 | Protect API credentials | partial | Credentials scrubbed from all error text. HTTPS-only backend validation and permission confirmation not done. |
| 15 | Harden report backend | not started | Still a JSON file; see `server/DEPLOY.md`. |
| 16 | Toolbar as primary interface | partial | Only Dangerous / High risk can interrupt a checkout; the on-page badge still auto-opens briefly. No toolbar-only mode, per-reason dismissals or "Report incorrect result" yet. |
| 17 | Report presentation | partial | Popup leads with verdict and confidence, summary, key findings, missing checks, evidence by family, research links; setup notices are separate. Freshness is shown per signal. |
| 18 | Accessibility | partial | Focus outlines, reduced-motion, labelled score ring. No keyboard trap/restore in the checkout dialog, contrast audit or screen-reader testing. |
| 19 | Repair hanging test suite | **done** | Cause: idle keep-alive sockets kept `server.close()` pending (5-6 s per file on Node 18, longer elsewhere). Fixed; `npm test` runner gives each file a timeout; verified on Node 18/20/22. |
| 20 | Evaluation corpus | not started | |
| 21 | Automated coverage | partial | Added suffix, URL cache, stale-navigation, provider failure and report-burst tests. No accessibility, performance or packed-build tests. |
| 22 | Release gates | partial | CI runs on Node 18/20/22 with a 10-minute timeout; no other gates. |
