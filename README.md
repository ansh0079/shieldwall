# QuietBrowse

A privacy-first ad & tracker blocker for **Chrome, Edge, Brave, and Firefox** —
Manifest V3, **zero data collection**. Everything runs locally on your device.

> QuietBrowse is not affiliated with Microsoft Defender, Windows Defender, or
> any antivirus product.

**Landing page:** [docs/index.html](docs/index.html)  
**Contributing:** [CONTRIBUTING.md](CONTRIBUTING.md)

## Privacy

- **No accounts, no analytics, no telemetry, no developer servers.**
- QuietBrowse downloads public filter-list updates from
  [easylist.to](https://easylist.to), plus any custom list URLs you add.
- Settings, stats, learned trackers, and zapped elements stay in
  `chrome.storage.local` (small toggles can sync via `chrome.storage.sync`).
- See [privacy.html](privacy.html), [terms.html](terms.html), [PERMISSIONS.md](PERMISSIONS.md).

## What it does

**Blocking**
- EasyList + EasyPrivacy with auto-updates
- Additional default static rulesets (enabled): uBO Filters, uBO Privacy, uBO Quick Fixes, AdGuard Base, AdGuard Tracking, Peter Lowe’s (auto-trimmed to stay within Chrome’s static DNR budget; overflow lists remain optional toggles)
- Optional Fanboy / Cookie / regional lists
- Cosmetics, `:has()` empty-ad collapse, element zapper, YouTube + scriptlet catalog
- Per-site modes: full / allow ads / pause · Fix this site · cookie reject-then-hide
- CNAME uncloaking map for known first-party tracker aliases

**Tracker intelligence**
- Popup trackers by category with **Block** on each row
- Observed trackers, review-first heuristic learning, DNT + GPC, trust score
- Optional cookie-confirmed auto-blocking and optional Download Guard

**Custom rules & backup**
- Domain/URL custom rules, export/import, full backup/restore

## Install (development)

**Chromium**
1. `chrome://extensions` → Developer mode → Load unpacked → this folder

**Firefox**
1. Copy `manifest.firefox.json` over `manifest.json` (or load it via your packaging step)
2. `about:debugging` → This Firefox → Load Temporary Add-on → pick `manifest.json`

## Builds (packs for stores)

Chrome / Edge (same package):

```bash
node tools/pack.js               # writes quietbrowse.zip for Chrome Web Store
node tools/pack.edge.js          # writes quietbrowse-edge.zip (identical content)
```

Firefox (separate XPI using `manifest.firefox.json`):

```bash
node tools/pack.firefox.js       # writes quietbrowse-firefox.xpi for AMO
```

## Tests

```bash
npm test
```

Runs packaging smoke checks (`tools/validate_extension.js`) and unit tests for
`filter_compiler`, `PhishScore`, and custom rules (`tools/test_unit.js`).

## License

- **QuietBrowse code:** [GPL-3.0](LICENSE)
- **Filter lists (EasyList, EasyPrivacy, AdGuard, uBO uAssets, Peter Lowe):** GPL-3.0 and/or CC BY-SA 3.0 — see [ATTRIBUTION.md](ATTRIBUTION.md)

## Store / release

- [BREAKAGE_QA.md](BREAKAGE_QA.md) · [STORE_LISTING.md](STORE_LISTING.md)

## Architecture

| File | Purpose |
|------|---------|
| `background.js` | SW router, downloads, site modes |
| `bg_*.js` | Filters, CNAME, scriptlets, learning, custom rules, sync |
| `content.js` / `cookie_reject.js` / `shield.js` | Page protections |
| `popup.*` / `options.*` | UI |
| `docs/index.html` | Public landing page |
| `manifest.firefox.json` | Firefox MV3 variant |
