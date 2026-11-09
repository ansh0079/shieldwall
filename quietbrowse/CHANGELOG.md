# Changelog

All notable changes to QuietBrowse are documented here.

## [4.7.0] — 2026-10-02

### Fixed
- **Chrome unpacked load failure** — the filter compiler emitted 12 DNR rules whose `urlFilter` started with `||*` (9 in AdGuard Base, 3 in AdGuard Tracking Protection), which Chrome's parser rejects. The compiler now drops patterns Chrome cannot load, the bundled rulesets were cleaned (`node tools/sanitize_rulesets.js`), and `tools/validate_extension.js` fails the build if any static rule has an invalid condition.
- **Firefox manifest version** — `manifest.firefox.json` was still at 4.6.5; it now matches 4.7.0, and validation checks the versions stay in sync.

## [4.6.4] — 2026-07-20

### Changed
- **Onboarding** — learning copy is review-first (not auto-block by default); added a **Fix broken sites** feature card.
- **Popup** — block diagnostics collapsed behind a disclosure so Fix this site / site mode stay primary.
- **Store listing** — rule counts refreshed from the bundled snapshot (`node tools/listing_metrics.js`); privacy/terms copied into `docs/` for GitHub Pages.

### Added
- Trusted enterprise/CDN suffix regression tests for phishing scoring.
- Chrome smoke QA step in `npm run release:check`.

## [4.6.3] — 2026-07-20

### Fixed
- **Phishing false positives** — Microsoft enterprise domains (`outlook.cloud.microsoft`, `*.onmicrosoft.com`, `*.sharepoint.com`, `*.office.net`) were incorrectly flagged as "misspelling of icloud.com / microsoft.com" due to the Levenshtein heuristic matching short SLDs like "cloud" and "onmicrosoft". Added these to the trusted-suffix list so they return "excellent" immediately.

## [4.6.2] — 2026-07-17

### Fixed
- **Cookie reject** — removed Cookiebot “allow all” and other accept-style selectors; cookie banners are hidden only after reject clicks finish (or after a short delay), so reject buttons stay clickable.
- **CNAME map** — trimmed to publisher first-party aliases only (removed broad tracker CDNs that EasyList already covers); `cnameMap` is loaded for diagnostics.
- **Sync prefs** — cross-device sync uses `prefsUpdatedAt` so older sync data cannot overwrite newer local settings.
- **Popup** — “Block” tracker button stays on “On” after a successful block.

### Changed
- Landing page CTA links to install instructions instead of a placeholder GitHub URL.
- Regenerated extension icons.

## [4.6.1] — 2026-07-17

### Changed
- **Faster page loads** — `psl_data.js` (~158 KB) is no longer injected into every page. Content scripts use a compact multi-part suffix fallback; full Public Suffix List scoring for phishing runs in the service worker via `analyzePhish`.
- **Slimmer popup** — global toggles (DNT/GPC, cookie handling, password shield, phishing, download guard) moved to Settings → Protection. Popup keeps site mode, Fix this site, zapper, and tracker list.
- **Store copy honesty** — listing/filter text now says 24-hour updates; tracking-parameter claim scoped to the static `privacy_rules.json` strip list.
- Removed placeholder `quietbrowse.example.com` uninstall URL until a real hosted page exists.

## [4.6.0] — 2026-07-17

### Added
- **Procedural cosmetic filters** — the content script now executes EasyList `:has-text()`, `:upward(N)`, and `:remove()` rules that were previously skipped (the compiler now parses them and the content script applies them via a debounced MutationObserver). Up to 2,000 rules are seeded from the bundled snapshot and updated on every filter refresh.
- **uBlock Quick Fixes list** — enabled by default as a new optional filter list, fetching `uAssets/filters/quick-fixes.txt`. This list is updated within hours of ad-delivery changes on major sites and is the single biggest gap between QuietBrowse and uBlock Origin in practice.
- **Expanded scriptlet catalog** — four new scriptlet functions: `json-prune` (strips named keys from `JSON.parse` / `Response.json` results), `no-fetch-if` (aborts `fetch()` calls to matching URLs), `prevent-setTimeout` (suppresses matching timer callbacks), `prevent-xhr` (blocks `XMLHttpRequest` to matching URLs). Site coverage expanded from 18 to 50+ anti-adblock hosts.

### Changed
- Filter lists now update every **24 hours** (was 48 hours). Fetches use `cache: "no-cache"` so the browser sends conditional GET requests (If-None-Match / If-Modified-Since) — unchanged lists return 304 and cost ~200 bytes instead of 5 MB.
- `tools/build_filters.js` now emits `BUNDLED_PROCEDURAL_RULES` into `cosmetic_filters.js` and reports procedural rule count in the build summary.

## [4.5.0] — 2026-07-16

### Added
- **Privacy Badger-style tracker learning** — QuietBrowse watches third-party domains that send cookies across multiple sites. After 3 sites, the domain is flagged for review (or auto-blocked if you enable the setting in Settings → Observed trackers).
- **CNAME uncloaking** — Known first-party CNAME aliases for trackers are blocked even when the tracker disguises itself under the site's own subdomain.
- **Cookie banner rejection** — Vendor-specific "Reject all" buttons are clicked automatically; banners with no reject path are hidden via CSS.
- **Element zapper** — Right-click any page or use the popup button to permanently hide an element. Hidden elements are stored per-domain and reapplied on every visit.
- **Download guard** — Double-extension files (e.g. `invoice.pdf.exe`) are cancelled and a notification is shown. Requires the `downloads` optional permission.
- **Password shield** — Copies from `<input type="password">` fields place random junk on the clipboard instead of the real password.
- **Phishing warnings** — A trust score (0–100) is computed for each page based on domain lookalikes, HTTPS status, and known risky patterns.
- **Cross-device pref sync** — Small toggles (protection on/off, cookie handling, shields, scriptlets) sync across signed-in Chrome profiles via `chrome.storage.sync`.
- **Custom filter lists** — Add any EasyList-compatible URL in Settings → Filter lists; rules are merged with EasyList/EasyPrivacy on every update.
- **Optional lists** — Fanboy Annoyance, Social, Cookie, and regional lists can be enabled individually.
- **Backup & restore** — Export all data (site rules, learned trackers, custom rules, stats, and toggle preferences) as JSON and restore on another device.
- **Site breakage reports** — Clicking "Fix this site" can optionally save a local JSON report (no upload). Reports can be exported from Settings.

### Changed
- Bundled EasyList/EasyPrivacy snapshot refreshed (2026-07-16). The previous snapshot was missing domain-anchored blocks for several current trackers (google-analytics.com regional endpoints, chartbeat.net, cxense.com, amplitude.com, quantserve.com and others), confirmed via automated comparison against uBlock Origin and Privacy Badger (`npm run compare`).
- Trust score displayed in popup header replaces the old single-colour badge.
- Statistics tab now shows a 30-day blocked-per-day bar chart.
- "Site mode" per-domain control moved to a dropdown in the popup toggles section.

### Fixed
- Sync startup ordering: synced preferences (`enabled`, `cnameUncloak`, etc.) are now applied before rule-syncing functions run on service-worker start.
- Site-mode rule IDs can no longer overflow into the learned-tracker ID range.
- Backup export now round-trips all toggle preferences, not only structural data.
- Learned-tracker lookup in hot network-event paths uses a `Set` (O(1)) instead of `Array.includes` (O(n)).

---

## [4.4.x] and earlier

Initial development versions. Not published to the Chrome Web Store.
