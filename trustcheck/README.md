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
| Seller-level rating published in Schema.org markup, clearly labelled merchant-claimed | local page scan | no |
| UK company number in footer verified (exists, active, age, name matches) | Companies House API | yes (free) |
| Direct seller-profile links to Trustpilot, ScamAdviser, Reddit, Google, WHOIS | deep links | no |

**Hover cards:** on Google/Bing/DuckDuckGo results, hovering a result shows the seller site's quick rating in a side card (domain of the hovered result only; link redirects are unwrapped). Not verified against live Google Shopping markup.

Score = 50 + sum of signal points, clamped to 0-100. 70+ trusted, 40-69 caution, below 40 risky.
A Safe Browsing hit caps the score at 10. Risky pages get an in-page warning banner.

## Run & Test
- Unpacked: `chrome://extensions` -> Developer mode -> Load unpacked -> select `trustcheck/` folder.
- Run tests: `npm test`
- Build production release archives: `npm run pack` (outputs Chrome & Firefox `.zip` and `.xpi` in `dist/`).

## Unified Cloud Check Endpoint
The report server (`server/server.js`) supports unified caching and proxying:
- `GET /v1/check?domain=<domain>&url=<url>&companyNumber=<number>`: returns community buyer reports, verified merchant status, and proxied Safe Browsing / Companies House results in a single call.
- Environment variables: `GOOGLE_SAFE_BROWSING_KEY`, `COMPANIES_HOUSE_KEY`, `DATABASE_FILE` (or `DATA_FILE`, supporting `.sqlite`), `PORT` (default 8787).
- Deployment instructions: see [server/DEPLOY.md](server/DEPLOY.md).
