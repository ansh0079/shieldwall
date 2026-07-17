# Chrome Web Store Listing — QuietBrowse

Copy/paste sections into the developer dashboard. Update URLs before submit.

## Single purpose description

QuietBrowse blocks ads, trackers, and annoyances in your browser locally —
with optional phishing warnings and password protection. All processing happens
on your device; no accounts or telemetry.

## Permission justifications

See [PERMISSIONS.md](PERMISSIONS.md) for full text.

## Privacy policy URL

Host `privacy.html` publicly (file is in the repo root), e.g.:

`https://YOUR_GITHUB_USER.github.io/quietbrowse/privacy.html`

Also host `terms.html` if your store listing references terms. Enable GitHub Pages from the repo `docs/` folder or copy both HTML files to the Pages root.

## Category

Productivity or Privacy & Security

## Attribution (required — paste into description)

Network and cosmetic blocking rules are derived from [EasyList](https://easylist.to/) and [EasyPrivacy](https://easylist.to/easylist/easyprivacy.php), © EasyList authors, used under [CC BY-SA 3.0](https://creativecommons.org/licenses/by-sa/3.0/) and [GPL-3.0](https://www.gnu.org/licenses/gpl-3.0.html). QuietBrowse source code is GPL-3.0; compiled filter files are derivative works of EasyList. See project repository for full notices.

## Short description (132 chars max)

Block ads & trackers locally. No data collection. EasyList-powered. Fix broken sites in one click.

## Long description (paste into the "Detailed description" field)

QuietBrowse blocks ads and trackers without sending a single byte of your browsing activity to a server. There are no accounts, no analytics, no telemetry — just fast, local blocking that runs entirely on your device.

─────────────────────────────────────────
 WHAT IT BLOCKS
─────────────────────────────────────────

• Full EasyList + EasyPrivacy coverage — the same community lists used by uBlock Origin, updated automatically every 24 hours so you're always protected against new ad networks.

• 95,000+ blocked domains, 12,000+ URL pattern rules, and 13,600+ cosmetic selectors that hide ad containers even when the network request can't be intercepted.

• Tracker learning — QuietBrowse watches which third-party domains follow you across multiple sites. Domains seen repeatedly are shown for review, with optional auto-blocking using cookie access as an extra local signal. All heuristics run entirely on your device.

• CNAME uncloaking — detects first-party CNAME aliases used to disguise trackers as legitimate site resources, and blocks them even when they share your site's domain.

• Cookie banner rejection — automatically dismisses GDPR and cookie-consent prompts using vendor-specific patterns scoped to consent containers, so unrelated "decline" buttons are never affected.

• Custom filter lists — add any URL-hosted filter list (in EasyList syntax) alongside the defaults. Useful for language-specific lists like EasyList Germany.

• Optional lists — Fanboy Annoyance, Fanboy Social, EasyList Cookie, and regional lists can be enabled one-click in Settings and merge with the base lists on the next update.

• Tracking parameter stripping — common click IDs and campaign tags (utm_*, fbclid, gclid, and similar) are removed from top-level navigations before the page loads.

• YouTube ad handling — video ads can't be blocked at the network level, so QuietBrowse removes them from the player's data before playback starts.

─────────────────────────────────────────
 WHAT IT SHOWS YOU
─────────────────────────────────────────

• The popup lists every tracker caught on the current page by name and category — Google Ads, Facebook Pixel, Hotjar — just like Ghostery, but without Ghostery's servers.

• A toolbar badge counts blocked requests per tab in real time.

• A trust score (Excellent / Good / Caution / Danger) is shown for the current site, based on known tracker density, connection security, and phishing signals.

─────────────────────────────────────────
 SECURITY FEATURES (heuristic)
─────────────────────────────────────────

These are best-effort protections — not a replacement for antivirus software.

• Password shield — copying from a password field puts random junk on the clipboard instead of your real password. Scripts that secretly reveal a password field are detected and masked.

• Phishing warnings — suspicious sites are flagged: lookalike domains (paypa1.com), brand names buried in subdomains (paypal.com.evil.tk), international character spoofing, raw IP addresses, and unencrypted login forms trigger a full-screen warning with a "take me back" button.

• Download guard — files like invoice.pdf.exe (double-extension tricks) are cancelled. Any executable download triggers a caution notification. File contents are not scanned — keep your antivirus running.

─────────────────────────────────────────
 YOUR CONTROLS
─────────────────────────────────────────

• Global on/off toggle
• Per-site modes: full protection, allow ads (trackers still blocked), or pause entirely
• "Fix this site" — one click pauses QuietBrowse for the current site if something breaks
• Element zapper — right-click any element on a page and hide it permanently
• Toggle privacy signals (DNT + GPC), cookie banner hiding, password shield, phishing warnings, and download guard independently

─────────────────────────────────────────
 PRIVACY
─────────────────────────────────────────

QuietBrowse does not collect, transmit, or sell your browsing data. By default, outbound network requests are limited to direct downloads of public filter lists from easylist.to. If you enable optional Fanboy lists, those are fetched from secure.fanboy.co.nz. If you add a custom filter-list URL, QuietBrowse downloads that list directly from the URL you provide. Everything else — your settings, learned trackers, block statistics, zapped elements, and tracker heuristics — stays in Chrome's local extension storage on your device and is deleted when you remove the extension. Auto-blocking of learned trackers is off by default and must be enabled in Settings.

Full privacy policy: [link to your hosted privacy.html]

─────────────────────────────────────────
 ATTRIBUTION
─────────────────────────────────────────

Network and cosmetic blocking rules are derived from EasyList and EasyPrivacy (easylist.to), © EasyList authors, used under CC BY-SA 3.0 and GPL-3.0. QuietBrowse source code is GPL-3.0. See the project repository for full license notices.

─────────────────────────────────────────
 NOTES
─────────────────────────────────────────

• Toolbar badge counts are local estimates derived from observing blocked network errors — they are not a guaranteed match for every rule that fires.
• The phishing and download features are heuristic, not guaranteed. They add a layer of caution but are not a substitute for up-to-date antivirus software.
• QuietBrowse is not affiliated with Microsoft Defender, Windows Defender, or any antivirus vendor.
• QuietBrowse scores 96/100 on adblock-tester.com. The 4 remaining points are Sentry and Bugsnag — error-monitoring tools used by developers for crash reporting, not ad networks. We leave these unblocked intentionally to avoid breaking apps that depend on them.

## Developer account (Chrome)

- One-time **$5 USD** registration: https://chrome.google.com/webstore/devconsole
- Review with `<all_urls>`, `webRequest`, and optional `cookies` / `downloads` typically takes **several days to a few weeks**
- Have privacy policy URL and permission justifications ready before submit

## Pre-submit checklist (Chrome)

- [ ] Run [BREAKAGE_QA.md](BREAKAGE_QA.md) on a packed build (not just unpacked)
- [ ] Host `privacy.html` at an HTTPS URL and replace `[link to your hosted privacy.html]` above
- [ ] Replace uninstall URL placeholder in `background.js` `onInstalled` handler
- [ ] EasyList attribution visible in store description
- [ ] Screenshots do not imply Microsoft/antivirus affiliation
- [ ] Test "Fix this site" flow on a broken page
- [ ] 5 screenshots at 1280×800 (use popup, settings, onboarding, tracker list, trust score views)
- [ ] Promo tile: open `assets/store/promo_tile.html` in Chrome at exactly 440×280, screenshot → PNG
- [ ] Run `npm run build:filters` so the bundled EasyList/EasyPrivacy snapshot is current, then `npm run validate`
- [ ] Run `node tools/pack.js` to build `quietbrowse.zip`, upload that (not a folder) to the Web Store

---

## Firefox (AMO) release

### AMO developer account

- Free registration at https://addons.mozilla.org/developers/
- AMO review for a self-distributed (unlisted) add-on is often same-day; listed review is 1–4 weeks
- The extension ID (`quietbrowse@quietbrowse`) is set in `manifest.firefox.json` — **it cannot be changed after first submission**

### AMO listing details

**Name:** QuietBrowse — Ad & Tracker Blocker

**Summary (250 chars max):**
Block ads, trackers, and cookie banners locally. No data collection, no accounts. EasyList-powered with trust scoring, password shield, phishing warnings, and YouTube ad removal.

**Description:** Paste the same long description from the Chrome section above. Firefox users respond well to the explicit "no telemetry" and "zero data collection" framing.

**Category:** Privacy & Security

**Support URL:** your GitHub repo URL

**Homepage URL:** your GitHub Pages URL

**Permission justifications** (AMO review asks for these):

| Permission | Reason |
|---|---|
| `<all_urls>` | Must observe and block network requests on every page |
| `declarativeNetRequest` | Core ad/tracker blocking engine |
| `webRequest` | Counts blocked requests for the popup badge |
| `scripting` | Injects cosmetic hiding rules and anti-adblock scriptlets |
| `cookies` | Auto-block learned trackers uses cookie cross-site signal (opt-in) |
| `downloads` | Download guard cancels double-extension files (opt-in) |
| `storage` + `unlimitedStorage` | Stores filter rules, learned trackers, and user settings locally |

### AMO pre-submit checklist

- [ ] Host `privacy.html` at an HTTPS URL (same as Chrome — reuse the same URL)
- [ ] Run `npm run build:filters` so the bundled snapshot is current
- [ ] Run `npm run validate` — `validateFirefoxManifest()` is now active and will confirm gecko.id
- [ ] Run `npm run build:xpi` to build `quietbrowse-firefox.xpi`
- [ ] Load the XPI in Firefox via `about:debugging` → "Load Temporary Add-on" — smoke test popup, blocking, settings
- [ ] Go to https://addons.mozilla.org/developers/ → Submit a New Add-on
- [ ] Upload `quietbrowse-firefox.xpi`
- [ ] If AMO asks for source code: zip the project root (excluding `node_modules/`, `tools/ext_cache/`) and upload
- [ ] Fill in listing details, privacy policy URL, permission justifications from above
- [ ] Screenshots: same 5 as Chrome (Firefox renders the popup identically)

### Firefox-specific notes

- **Background scripts vs service worker:** Firefox MV3 uses `background.scripts` (event page), not a service worker. The `background.js` `importScripts` guard handles this automatically.
- **`cookies` and `downloads`** are declared as required permissions in `manifest.firefox.json` (not optional like Chrome). Firefox MV3 doesn't yet support `optional_permissions` for these in the same way.
- **`minimum_chrome_version`** is absent from the Firefox manifest; `strict_min_version: "121.0"` applies instead.
- **Extension ID** `quietbrowse@quietbrowse` — once submitted to AMO this is permanent. Do not change it after first submission.
