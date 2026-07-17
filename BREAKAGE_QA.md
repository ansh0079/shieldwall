# QuietBrowse — Pre-Release Breakage QA

Run this checklist **before every store release** on a **packed** build (Load unpacked is not enough — zip the extension or use Chrome's "Pack extension" and install the `.crx`).

**Pass criteria:** No P0/P1 failures. P2 failures must be documented in release notes.

**Priority:**
- **P0** — Login, checkout, or payment broken; data loss; extension crash loop
- **P1** — Core feature unusable (video won't play, page blank, bank app errors)
- **P2** — Cosmetic glitch, minor annoyance, fixable via "Fix this site"

---

## Setup

- [ ] Fresh profile or incognito + only QuietBrowse enabled
- [ ] Protection **ON**, default settings
- [ ] Packed build installed (not dev unpacked-only test)
- [ ] Note extension version: __________

---

## Top sites — General (all should load usable content)

| Site | Loads | Login | Checkout/video | Notes | P |
|------|-------|-------|----------------|-------|---|
| google.com / search | | | N/A | | |
| youtube.com | | | Video plays | | |
| gmail.com | | | N/A | | |
| reddit.com | | | Feed scrolls | | |
| twitter.com / x.com | | | Feed loads | | |
| facebook.com | | | Feed loads | | |
| instagram.com | | | Feed loads | | |
| wikipedia.org | | | N/A | | |
| github.com | | | N/A | | |
| stackoverflow.com | | | N/A | | |
| amazon.com | | | Search + product page | | |
| ebay.com | | | Listing page | | |
| netflix.com | | | Video (if subscribed) | | |
| spotify.com / open | | | Player | | |
| linkedin.com | | | Feed | | |
| microsoft.com / outlook | | | Login | | |
| apple.com / icloud.com | | | Login | | |
| paypal.com | | | Login (don't pay) | | |
| stripe.com (docs/demo) | | | Demo checkout | | |
| walmart.com | | | Cart page | | |

---

## Banking & finance (extra care — any P0 here blocks release)

| Site | Loads | Login safe | Transfer/pay UI visible | Notes | P |
|------|-------|------------|-------------------------|-------|---|
| Your primary bank | | | Do not complete transfers | | |
| chase.com | | | | | |
| bankofamerica.com | | | | | |
| wellsfargo.com | | | | | |
| coinbase.com | | | | | |

If banking breaks: verify **Fix this site** restores the page after reload.

---

## QuietBrowse-specific flows

| Test | Pass | Notes |
|------|------|-------|
| Popup opens, favicon + trust score show | | |
| Toolbar badge increments on tracker-heavy site | | |
| **Fix this site** pauses + saves report | | |
| Reload after Fix restores broken page | | |
| Site mode: Allow ads (trackers still blocked) | | |
| Settings → Export site reports JSON | | |
| Filter update (Settings → Update now) completes | | |
| Kill browser mid-update → extension still blocks on restart | | |
| Toggle cookie shield without reload | | |
| Zap element + reload persists hide | | |

---

## Regression after filter update

- [ ] Run **Update now** in Settings
- [ ] Re-test youtube.com, amazon.com, one bank site
- [ ] Confirm bundled easylist disabled only after successful update

---

## Sign-off

| Role | Name | Date | Version |
|------|------|------|---------|
| Tester | | | |
| Release | | | |

---

## If something breaks during QA

1. Click **Fix this site** in the popup → reload
2. Export report from Settings → Site reports
3. File issue with domain, URL, steps, and exported JSON
4. Add domain to site rules if needed until fixed upstream

---

## Known patterns (expected behaviour, not bugs)

### Cookie banner: CSS hide fires before reject click

`cookie_reject.js` attempts a vendor-specific reject click first (`VENDOR_SELECTORS`), then falls back to generic CSS hiding. For CMPs not in `VENDOR_SELECTORS`, the banner is hidden via `display:none` at `document_start` before a reject button can be clicked. The banner disappears (good UX) but no formal consent signal is sent to the CMP. Most CMPs default to rejected when no choice is recorded; a minority may re-show on the next visit.

**Fix:** Add the CMP to `VENDOR_SELECTORS` in `cookie_reject.js` with a working reject selector, then remove the CSS hide rule so the button is visible when the click runs.

### CNAME-uncloaked domain also serves CDN resources

A hostname in `cname_trackers.json` may also serve legitimate first-party assets on some sites. CNAME blocking is applied globally (by resolved hostname). If a site breaks with CNAME uncloaking enabled, disable the toggle and report the domain for removal from the list.

### Learned tracker blocks a CDN or auth provider

The learner watches third-party domains with cookies across ≥ 3 sites. A shared CDN or SSO provider can hit that threshold. Auto-blocking is off by default. If auto-blocking is on and something breaks, go to Settings → Learned Trackers and click Unblock for the domain.

### Anti-adblock gate

Sites that detect the extension via missing ad slots will show a gate. Enable **Anti-adblock bait** in Settings → Scriptlets to inject a fake slot. If the gate persists, the site uses a non-DOM detection vector; use the Zapper to hide the overlay and file a report.
