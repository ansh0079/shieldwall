# TrustCheck

A Manifest V3 browser extension (Chrome/Edge/Brave) that tells online shoppers, in real time,
whether the store they're on can be trusted. Separate from QuietBrowse; shares none of its code.

## What it checks
| Signal | Source | Needs key |
|---|---|---|
| HTTPS, raw-IP host, punycode, risky TLD, spammy pattern, brand lookalike (`amaz0n.com`) | local | no |
| Domain age | RDAP (rdap.org) | no |
| Contact / returns / privacy / about pages, payment form on HTTP, urgency tactics | page scan | no |
| Malware & phishing blocklists | Google Safe Browsing | yes (free) |
| Customer review score | Trustpilot API | yes |
| Links to Trustpilot, ScamAdviser, Reddit, Google, WHOIS | deep links | no |

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
