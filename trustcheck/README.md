# TrustCheck

A Manifest V3 browser extension (Chrome/Edge/Brave) that tells online shoppers, in real time,
whether the store they're on can be trusted. Separate from QuietBrowse; shares none of its code.

## What it checks
| Signal | Source | Needs key |
|---|---|---|
| HTTPS, raw-IP host, punycode, risky TLD, spammy pattern, brand lookalike (`amaz0n.com`) | local | no |
| Domain age + first-seen-online date | RDAP (rdap.org, Verisign fallback), Internet Archive | no |
| Price far below the going rate for the same search (median of results page) | Google results page | no |
| Contact / returns / privacy / about pages, payment form on HTTP, urgency tactics | page scan | no |
| Malware & phishing blocklists | Google Safe Browsing | yes (free) |
| Customer review score + recurring complaint themes | Trustpilot API (paid add-on) | yes |
| UK company number in footer verified (exists, active, age, name matches) | Companies House API | yes (free) |
| Links to Trustpilot, ScamAdviser, Reddit, Google, WHOIS | deep links | no |

**Hover cards:** on Google/Bing/DuckDuckGo results, hovering a result shows the seller site's quick rating in a side card (domain of the hovered result only; link redirects are unwrapped). Not verified against live Google Shopping markup.

Buyer reports are shown as **unverified context** and have **no effect on the score** until reporting is abuse-resistant (see PLAN_STATUS.md).

## How an assessment is made
Signals are grouped into independent **evidence families**: site safety, business identity, reputation, operational history,
store transparency and price. The verdict comes from decision rules, not from a score threshold:

| Verdict | When |
|---|---|
| **Dangerous** | an authoritative malware/phishing match for this exact page, or a payment form on an insecure page |
| **High risk** | strong warnings from at least two independent families (price is only ever supporting) |
| **Caution** | one strong warning, a price anomaly, or weaker warnings from two families |
| **Limited evidence** | not enough independent evidence either way (the common case without API keys) |
| **Lower risk indicators** | verified evidence from at least two independent families, no strong warning, evidence score 70+ |

HTTPS, policy links and domain age alone can never produce "Lower risk indicators". Every signal records its source, scope,
provenance (verified / inferred / user-reported / unavailable), check time and expiry. Unavailable checks are listed as
missing, never counted as clean. Confidence (Low/Medium/High) reflects how many independent families produced evidence.
The evidence score (0-100) is always kept consistent with the verdict. Only the two most severe verdicts interrupt a checkout.
TrustCheck cannot guarantee a seller or a transaction.

## Run
`chrome://extensions` -> Developer mode -> Load unpacked -> select this `trustcheck/` folder.
Add API keys under Options. Tests: `npm test`.

## Privacy
Only the registrable domain (RDAP, Trustpilot) or page URL (Safe Browsing) is sent, and only to those
services. Keys and cached results stay in `chrome.storage.local`. No developer server.

## Roadmap
Own backend for crowd-submitted reviews, search-result badges, checkout interstitial, Firefox build.

## Buyer-report server
Reported experiences ("did it arrive?" plus optional problem tags) are stored by a small dependency-free Node server and shown as
**unverified context with no effect on the score**. Identities are server-signed and rate-limited, new identities carry no weight,
coordinated clusters are held back for moderation, and nothing is shown until several separate networks agree. See
[server/DEPLOY.md](server/DEPLOY.md) for how it works, how to run it, moderation, disputes, deletion and its limits.

```bash
node server/server.js                     # dev: PORT=8787, DATA_FILE=data.json (production needs REPORT_SALT and CREDENTIAL_SECRET)
```
Then set the server URL in the extension's Options. The Options page can delete your reports and reporting identity.

## What is sent where
| Provider | Receives | Notes |
|---|---|---|
| RDAP (rdap.org, then Verisign directly for .com/.net) | registrable domain | skipped for sites hosted as a tenant of a shared platform (e.g. `*.github.io`) |
| Internet Archive | registrable domain (the tenant's own name for tenants) | |
| Google Safe Browsing (needs your key) | the full page URL, without fragment or credentials | hover lookups on search results drop the query string first |
| Trustpilot (needs your key) | registrable domain | |
| Companies House (needs your key) | the company number printed on the page | |
| Your report server (optional) | registrable domain, your answer, an anonymous install ID | |
Search engines and the pages you browse are never sent anywhere.

## Domain handling
Sites are keyed by the **registrable domain from the full Public Suffix List, including private suffixes**, so `safe.github.io` and
`evil.github.io` never share evidence. The list lives in `lib/psl_data.js` (MPL-2.0, from https://publicsuffix.org/);
refresh it with `node tools/build_psl.mjs`.

## Tests
`npm test` runs every `test/*.test.js` in its own process with a timeout, on Node 18+. A hung file is named and killed.
