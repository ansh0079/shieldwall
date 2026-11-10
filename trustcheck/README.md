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

## Run
`chrome://extensions` -> Developer mode -> Load unpacked -> select this `trustcheck/` folder.
Add API keys under Options. Tests: `npm test`.

## Privacy
Only the registrable domain (RDAP) or page URL (Safe Browsing) is sent to those services.
Buyer outcomes go only to the report server explicitly configured in Options. Keys and cached results
stay in `chrome.storage.local`; receipt text, payment details, addresses and product details are not collected.

## Roadmap
Own backend for crowd-submitted reviews, search-result badges, checkout interstitial, Firefox build.

## Buyer-report server (new)
Buyer outcomes ("did it arrive?" + optional problem tags) are stored by a small dependency-free Node server.

```bash
node server/server.js            # PORT=8787 DATA_FILE=data.json MIN_REPORTS=3 RATE_LIMIT=20
node server/seed.js http://localhost:8787 <domain>   # DEMO ONLY: synthetic reports to preview the UI
```
Then set the server URL in the extension's Options. Reports are one per anonymous install per shop.
When TrustCheck sees an order-confirmation page, the next report is labelled purchase-observed; no receipt,
order number, product, address, payment details or page text is retained. Reports are
validated against a fixed tag list, rate-limited per IP, and only shown once `MIN_REPORTS` independent
buyers have reported in the last 30 days. Counts feed the score, the badge hover list and the checkout warning.

Deployment (Docker, HTTPS proxy, env vars, backups): see [server/DEPLOY.md](server/DEPLOY.md).
Still a pilot-grade service: JSON-file storage, basic abuse limits only, no shop dispute process.
Seeded data is fake - never ship it.
