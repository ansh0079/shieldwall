# QuietBrowse — Permission Justifications

Use this document when filling out the Chrome Web Store listing or responding to review questions.

## Summary for users

QuietBrowse needs broad access because **blocking ads and trackers only works if the extension can see network requests on the pages you visit**. All processing is local. Nothing is sent to QuietBrowse servers — we don't have any.

---

## `host_permissions`: `<all_urls>`

**Why:** Ad and tracker domains appear on every website. Declarative network rules and content scripts must apply to all HTTP/HTTPS pages to block third-party requests and hide ad elements.

**Can it be removed?** No, not for a general-purpose blocker.

---

## `declarativeNetRequest`

**Why:** Core blocking engine (Manifest V3). Applies EasyList/EasyPrivacy rules to block tracker and ad network requests.

---

## `storage` + `unlimitedStorage`

**Why:** Saves your settings, site rules, learned trackers, zapped elements, daily block stats, and cached cosmetic filter data (large EasyList-derived selector sets). All data stays on device.

---

## `tabs`

**Why:** Resets per-tab block statistics when you navigate; removes stats when tabs close; opens onboarding on first install.

**Note:** We do **not** read tab URLs for tracking or upload. Tab IDs are used only for local counters.

---

## `activeTab`

**Why:** When you open the popup or use the zapper, access to the current tab is granted by user gesture without extra prompts.

---

## `webRequest` (non-blocking)

**Why two uses:**
1. **Block counting (store-safe):** Observes `net::ERR_BLOCKED_BY_CLIENT` to estimate how many requests were blocked per tab (replaces dev-only debug APIs).
2. **Tracker learning:** Observes completed third-party requests to detect domains that follow you across sites (Privacy Badger-style heuristic).

**We do not** modify requests via `webRequest` — blocking is done by `declarativeNetRequest`.

---

## `webNavigation`

**Why:** Single-page apps can change URL without a full page load. QuietBrowse listens for those history updates so phishing warnings and trust scores are recalculated after in-page navigation.

---

## Optional: `cookies`

**Why:** If you enable automatic learned-tracker blocking, QuietBrowse asks for cookie access so it can confirm a candidate domain holds cookies before auto-blocking it. Without this permission, candidates are still shown for review but are not auto-blocked.

---

## Optional: `downloads`

**Why:** If you enable Download Guard, QuietBrowse asks for downloads access so it can inspect filenames (e.g. `invoice.pdf.exe`) and cancel deceptive downloads or show a warning notification.

---

## `notifications`

**Why:** Shows local alerts when download guard blocks or warns about a download. No remote push notifications.

---

## `contextMenus`

**Why:** Adds "Zap element on this page" to the right-click menu for the element picker.

---

## `alarms`

**Why:** Schedules automatic EasyList/EasyPrivacy updates every 24 hours.

---

## `scripting`

**Why:** Registers YouTube scriptlets in the page's main world (required to strip in-player ad data that network blocking cannot reach). Registered/unregistered dynamically when protection or site mode changes.

---

## Removed: `declarativeNetRequestFeedback`

Previously requested for `onRuleMatchedDebug`, which **only works in unpacked/dev builds**. Removed in v4.0. Counting now uses store-safe APIs (see `webRequest` above + DNR action-count badge).

---

## Data collection statement (for store form)

> QuietBrowse does not collect, store, or transmit personal or browsing data to the developer. All settings and statistics are stored locally. External network requests are limited to public filter-list downloads from easylist.to by default, plus any custom filter-list URLs the user explicitly adds.

---

## Trademark note

**QuietBrowse** is not Microsoft Defender, Windows Defender, or any Microsoft product. Do not use Microsoft logos or imply endorsement in store assets.
