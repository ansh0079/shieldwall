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

Score = 50 + sum of signal points, clamped to 0-100. 70+ trusted, 40-69 caution, below 40 risky.
A Safe Browsing hit caps the score at 10. Risky pages get an in-page warning banner.

## Run
`chrome://extensions` -> Developer mode -> Load unpacked -> select this `trustcheck/` folder.
Add API keys under Options. Tests: `npm test`.

## Privacy
Only the registrable domain (RDAP, Trustpilot) or page URL (Safe Browsing) is sent, and only to those
services. Keys and cached results stay in `chrome.storage.local`. No developer server.

## Roadmap
Own backend for crowd-submitted reviews, search-result badges, checkout interstitial, Firefox build.

## Buyer-report server (new)
Buyer outcomes ("did it arrive?" + optional problem tags) are stored by a small dependency-free Node server.

```bash
node server/server.js            # PORT=8787 DATA_FILE=data.json MIN_REPORTS=3 RATE_LIMIT=20
node server/seed.js http://localhost:8787 <domain>   # DEMO ONLY: synthetic reports to preview the UI
```
Then set the server URL in the extension's Options. Reports are one per anonymous install per shop,
validated against a fixed tag list, rate-limited per IP, and only shown once `MIN_REPORTS` independent
buyers have reported in the last 30 days. Counts feed the score, the badge hover list and the checkout warning.

Deployment (Docker, HTTPS proxy, env vars, backups): see [server/DEPLOY.md](server/DEPLOY.md).
Still a pilot-grade service: JSON-file storage, basic abuse limits only, no shop dispute process.
Seeded data is fake - never ship it.

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
