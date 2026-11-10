# TrustCheck — Commercial Viability Implementation Plan

**Version:** 1.0 · **Date:** 2026-11-10 · **Codebase baseline:** v0.2.0 (66/66 tests passing)

---

## 1. Executive Summary

TrustCheck is a well-engineered browser extension (MV3, zero runtime dependencies, calibrated
trust-scoring engine, Chrome + Firefox builds, buyer-report server) that is currently a
**developer tool, not a consumer product**. Three structural blockers prevent commercialization:

1. **BYO-API-key model** — the two strongest signals (Google Safe Browsing, UK Companies House)
   require end users to paste personal API keys into Options. Consumers will not do this.
2. **No production backend** — the manifest points at `http://localhost:8787`; the report server
   is self-described "pilot-grade" (JSON file storage, `CORS_ORIGIN=*`, `dev-salt` default, and the
   signed-credential endpoint `/v1/register` is built but never called by the extension).
3. **Not store-submittable** — no icons, no privacy policy, no Terms of Service, and no merchant
   dispute/appeal process (a legal requirement when publishing "High risk" verdicts about named
   businesses).

**The single highest-leverage move is building the managed backend.** It simultaneously fixes
consumer adoption (no more user-supplied keys), enables monetization (free/pro key split), and
creates the data moat (crowd-sourced, purchase-verified buyer reports — a signal no competitor has).

**Target timeline:** 12 weeks to paid public launch on Chrome Web Store + Firefox Add-ons.

---

## 2. Business Model

| Tier | Price | Contents |
|---|---|---|
| **Free** | $0 | Local heuristics, domain age (RDAP), Archive history, price-anomaly detection, basic verdict, viewing community report counts |
| **Pro** | ~$3/mo or $25/yr (7-day trial) | Safe Browsing + Companies House via managed backend, checkout interstitial warning, purchase-verified reporting badge, priority recheck, up to 5 devices |
| **B2B (post-launch)** | Usage-based | Merchant "verified" badge, trust-score API for marketplaces / insurers / payment providers |

**Hard rule: no affiliate or referral revenue from rated shops.** A trust tool earning commissions
from the shops it scores is a conflict of interest that destroys the brand and invites litigation.

**Competitive reference:** Guardio (~$10/mo consumer), Norton/McAfee bundles, ScamAdviser/Trustpilot
(free, data-only, no checkout-time protection). TrustCheck's differentiator is *intervention at the
moment of purchase* plus *purchase-verified outcome reports*.

---

## 3. Phase 0 — Legal & Compliance Foundation (Week 1)

These items gate everything else; none require new product code.

| # | Task | Deliverable | Notes |
|---|------|-------------|-------|
| 0.1 | Privacy policy | `PRIVACY.md` + hosted URL | Must cover: domains sent to RDAP/Safe Browsing, report-server payloads, install IDs, hashed IPs, purchase-observed tokens (no receipt data) |
| 0.2 | Terms of Service + verdict disclaimer | `TERMS.md` + hosted URL | Verdicts are "informational risk indicators, not factual claims of fraud"; limitation of liability; not a guarantee |
| 0.3 | Merchant dispute/appeal policy | Public page + intake email/form | Required defamation shield. Commits to review SLA (e.g. 5 business days), ties into Phase 3 verification flow |
| 0.4 | GDPR pass on report server | Code + docs | Stop storing raw IPs for rate limiting → store HMAC(ip, daily-rotating salt); document data retention; add `/v1/privacy` data-deletion endpoint keyed by install credential |
| 0.5 | Choose legal entity + jurisdiction | — | Needed for store developer accounts, Stripe, and liability shielding |

---

## 4. Phase 1 — Managed Backend (Weeks 1–3)

**Goal:** eliminate all user-supplied API keys; one hosted service brokers Safe Browsing,
Companies House, and buyer reports behind TrustCheck-issued credentials.

### 4.1 Infrastructure

| # | Task | Detail |
|---|------|--------|
| 1.1.1 | Provision hosting | Single VPS or Fly.io/Render; HTTPS via Caddy/nginx (see `server/DEPLOY.md`); domain e.g. `api.trustcheck.app` |
| 1.1.2 | Migrate storage JSON → SQLite | `server/store.js` already supports SQLite (`useSqlite`); make it the default, add migration script for `data.json`, add nightly backup job |
| 1.1.3 | Harden config | Fail fast in production unless `REPORT_SALT`, `CORS_ORIGIN` (extension origin allowlist, not `*`), and `TRUST_PROXY=true` are set |
| 1.1.4 | Observability | Structured request logs, uptime probe on `/healthz`, alert on error rate; basic metrics endpoint (reports/day, active installs) |

### 4.2 Credential & licensing service

| # | Task | Detail |
|---|------|--------|
| 1.2.1 | Wire `/v1/register` into the extension | `background.js` currently never calls it. On first run: register → store signed credential in `chrome.storage.local`; attach to every backend request as `Authorization: Bearer` |
| 1.2.2 | License tiers | Server-side: credential → `{ tier: "free" \| "pro", expiresAt }`. Stripe webhook upgrades tier. Free tier: rate-limited proxy access; Pro: full |
| 1.2.3 | Proxy endpoints | `GET /v1/check/safebrowsing?url=…` and `GET /v1/check/company?number=…` — server holds the Google/Companies House keys, caches responses (Safe Browsing 30 min, Companies House 24 h), enforces per-tier quotas |
| 1.2.4 | Abuse hardening | Verify signed credentials on every write; keep IP/subnet rate limits (with hashed IPs per 0.4); add per-credential report cap (1 report per shop per credential — already partially enforced client-side, must be enforced server-side) |

### 4.3 Extension changes

| # | Task | Files | Detail |
|---|------|-------|--------|
| 1.3.1 | Replace key fields with account state | `options.html`, `options.js`, `background.js` (`settings()`) | Options page becomes: server status, tier, "Upgrade to Pro" link. Remove `sbKey`/`chKey` inputs |
| 1.3.2 | Route signals through proxy | `lib/providers.js`, `lib/companies.js`, `background.js` | `safeBrowsing()` and `fetchCompany()` call the proxy endpoints with the credential instead of direct APIs; keep direct-key path as a hidden dev flag |
| 1.3.3 | Update manifest hosts | `manifest.json`, `manifest.firefox.json` | Replace `localhost:8787` and direct API hosts with the production API origin |
| 1.3.4 | Graceful degradation | `background.js` | Backend unreachable → local-signals-only report, verdict capped at "unverified/caution", clear UI notice (tests exist for this pattern — extend `test/unverified.test.js`) |
| 1.3.5 | Paywall UX | `popup.html`, `popup.js` | Pro-locked signals show as "locked" rows with upgrade link, not silent absence |

**Phase 1 exit criteria:** a fresh install with zero configuration gets Safe Browsing + Companies
House + community reports within 10 seconds of install; all keys live server-side; free/pro split
enforced server-side; tests updated and green.

---

## 5. Phase 2 — Store Submission (Weeks 3–5)

| # | Task | Detail |
|---|------|--------|
| 2.1 | Icon set | 16/32/48/128 px action + store icons; declare in both manifests (`action.default_icon`, top-level `icons`) |
| 2.2 | Chrome Web Store listing | Name, short + full description, 5 screenshots (popup verdict, risky banner, search hover card, timeline, buyer-report flow), category "Shopping", privacy policy URL, single-purpose + permission justifications |
| 2.3 | Permission review strategy | Content scripts on `http://*/*` and `https://*/*` trigger extended review. Prepare written justification (core function requires reading any shop page), OR refactor to `activeTab` + user gesture + `optional_host_permissions` (already declared) for a faster review — decide during 2.2 |
| 2.4 | Data-use disclosures | Chrome's data collection certification: disclose domain lookups + report submissions; certify no sale of data |
| 2.5 | Firefox Add-ons | `dist/trustcheck-firefox-v0.2.0.xpi` already builds — resubmit with new manifest; note Firefox's stricter minified-code and remote-code rules (we comply: no remote code) |
| 2.6 | Landing page | One-page site: what it does, privacy stance, store links, merchant verification/dispute entry point. Also hosts the legal docs from Phase 0 |

**Phase 2 exit criteria:** listed (or in review) on both stores; landing page live with legal docs.

---

## 6. Phase 3 — Trust Network & Data Moat (Weeks 5–8)

| # | Task | Detail |
|---|------|--------|
| 3.1 | Merchant portal v1 | "Claim your shop": serve token at `/.well-known/trustcheck.json` (server endpoint `/v1/merchant/verify` already exists), show "Merchant-verified" signal (`merchant-verified` already in scoring families — surface it in the popup timeline) |
| 3.2 | Dispute/appeal flow | Merchant flags a verdict → case queue → evidence review → verdict annotation or adjustment. Manual at first; the *process existing* is what matters legally |
| 3.3 | Cold-start data seeding | `MIN_REPORTS=3` means community data is invisible for months. Mitigate: (a) lower to 2 for launch; (b) import third-party reputation at read-time as a separate clearly-labelled signal (ScamAdviser score / Trustpilot free API — never merge into buyer-report counts); (c) never seed synthetic data into production (README's own warning) |
| 3.4 | Report integrity | Enforce one-report-per-shop-per-credential server-side; purchase-verified reports weighted higher in `buyerSignals()`; anomaly detection (burst of reports from one subnet — `clientSubnet` already computed) |
| 3.5 | Opt-in telemetry | Anonymous, off by default until consented: installs, verdict distribution, backend errors. No URLs, no shop domains tied to individuals. Needed to run the business (activation, retention, conversion) |

**Phase 3 exit criteria:** ≥1 merchant completes verification end-to-end; dispute inbox operational;
reputation signal visible on day one for known shops; telemetry dashboard live.

---

## 7. Phase 4 — Monetization & Launch (Weeks 8–12)

| # | Task | Detail |
|---|------|--------|
| 4.1 | Stripe integration | Checkout + customer portal; webhook → license tier flip (1.2.2); annual discount; 7-day trial without card |
| 4.2 | Pro feature gating | Safe Browsing depth, Companies House detail, checkout interstitial, multi-device (credential linking), priority recheck — gated server-side per tier |
| 4.3 | Checkout interstitial | Promised on the roadmap; strong Pro selling point: full-page warning when entering payment details on a risky/unverified shop (extends existing in-page banner in `content.js`) |
| 4.4 | Launch marketing | SEO pages: "is {shop} legit" programmatic pages from public aggregate data; scam-awareness short-form content; Product Hunt launch; subreddit/niche-community outreach |
| 4.5 | Feedback loop | In-popup "wrong verdict?" link → same queue as merchant disputes; weekly review of false-positive/negative reports against `test/corpus.test.js` corpus |

**Phase 4 exit criteria:** paying customers; verdict-appeal SLA being met; refund/churn baseline
established.

---

## 8. Post-Launch Roadmap (Quarter 2)

- **B2B trust API** — sell score lookups to marketplaces, payment providers, insurers (the scoring
  engine is already modular: `lib/score.js` consumes a signal array and is backend-agnostic)
- **Email/link checker** — paste a shop URL on the landing page, get a report (SEO funnel +
  acquisition channel)
- **Mobile** — Safari Web Extension (iOS) or Firefox Android
- **Localization** — en-GB/en-US first, then DE/FR (manifest already lists those Google domains)
- **Broader registries** — company verification beyond UK (US SOS, EU VIES) as Pro differentiators

---

## 9. Risk Register

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Defamation claim from a rated shop | Medium | High | Phase 0 legal docs, dispute SLA, calibrated "unverified" language (already in scoring engine), insurance |
| Chrome review rejection (broad host permissions) | Medium | Medium | `activeTab` refactor fallback (2.3); single-purpose justification |
| Report-server abuse/botting | High | High | Signed credentials (1.2.1), hashed-IP rate limits, per-credential caps, subnet burst detection |
| Cold-start: empty community data | High | Medium | Third-party seeding (3.3), lower MIN_REPORTS, purchase-verified emphasis |
| Safe Browsing quota costs at scale | Low (early) | Medium | Server-side caching (1.2.3), tier quotas, paid tiers fund usage |
| Competitor clones scoring approach | Medium | Low | Moat is the purchase-verified report network, not the heuristic list |

---

## 10. Success Metrics

| Metric | 90-day target |
|---|---|
| Store installs | 5,000 |
| Weekly active checkers | 40% of installs |
| Free → Pro conversion | 2–4% |
| Purchase-verified reports / week | 100+ |
| Merchant verifications | 25 |
| Verdict disputes upheld (false-positive rate) | <5% |

---

*Working assumptions: solo/small team, ~12 weeks part-to-full-time, minimal budget (VPS + Stripe +
store fees). Phase 1 is the critical path — everything else can slip without blocking revenue.*
