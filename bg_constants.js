// QuietBrowse - shared background constants (ID ranges must not overlap)

const RULESET_ID = "quiet_rules";
const EASYLIST_RULESET_ID = "quiet_easylist";
// EasyPrivacy network rules (always-on static ruleset)
const EASYPRIVACY_RULESET_ID = "quiet_privacy";
// Privacy headers/params toggles (enable/disable via Settings)
const PRIVACY_RULESET_ID = "quiet_headers";
const BLOCK_RULESETS = [RULESET_ID, EASYLIST_RULESET_ID, EASYPRIVACY_RULESET_ID];

const EASYLIST_BLOCK_ID_START = 50000;

// Dynamic rule ID ranges (must not overlap):
const WHITELIST_ID_START = 10000;       // site mode allow rules
const LEARNED_ID_START = 20000;         // Privacy Badger-style learned blocks
const LEARNED_ID_END = 29999;           // inclusive
const CNAME_ID_START = 30000;           // CNAME-uncloaked tracker hosts
const CNAME_ID_END = 39999;             // inclusive
const UPDATE_ALLOW_ID_START = 100000;   // auto-updated EasyList allow
const UPDATE_BLOCK_ID_START = 150000;   // auto-updated EasyList block
const UPDATE_ID_END = 299999;           // inclusive upper bound for updates (custom starts at 300000)
const CUSTOM_BLOCK_ID_START = 300000;   // user custom block rules
const CUSTOM_ALLOW_ID_START = 350000;   // user custom allow rules
const CUSTOM_RULES_MAX = 200;

const LEARN_THRESHOLD = 3;
const LEARNABLE_RESOURCE_TYPES = new Set([
  "script",
  "xmlhttprequest",
  "image",
  "ping",
  "websocket",
  "other"
]);
const LEARNING_INFRASTRUCTURE_ALLOWLIST = [
  "akamaihd.net",
  "amazonaws.com",
  "azureedge.net",
  "cloudflare.com",
  "cloudflare.net",
  "cloudfront.net",
  "fastly.net",
  "githubusercontent.com",
  "googleapis.com",
  "gstatic.com",
  "jsdelivr.net",
  "microsoft.com",
  "microsoftonline.com",
  "stripe.com"
];
const SESSION_KEY = "tabSessionData";
const SETTINGS_REVISION_KEY = "settingsRevision";
const DAILY_RETENTION_DAYS = 90;
const OBSERVED_TRACKERS_MAX = 500;
const LEARNED_SEEN_MAX = 500;
const MIN_SANE_BLOCK_RULES = 5000;

const DEFAULT_FILTER_URLS = [
  "https://easylist.to/easylist/easylist.txt",
  "https://easylist.to/easylist/easyprivacy.txt"
];

// Optional EasyList-family lists (CC BY-SA 3.0 / GPL-3.0). Toggled in Settings.
// Fanboy Annoyance already includes Cookie + Social — prefer one or the other.
const OPTIONAL_FILTER_LISTS = [
  {
    id: "adguard-base",
    title: "AdGuard Base",
    url: "https://filters.adtidy.org/extension/ublock/filters/2.txt",
    defaultEnabled: true,
    note: "General ads/tracking; complements EasyList"
  },
  {
    id: "adguard-tracking",
    title: "AdGuard Tracking Protection",
    url: "https://filters.adtidy.org/extension/ublock/filters/3.txt",
    defaultEnabled: true,
    note: "Tracker blocking; complements EasyPrivacy"
  },
  {
    id: "peterlowe",
    title: "Peter Lowe’s ad/tracking list",
    url: "https://pgl.yoyo.org/adservers/serverlist.php?hostformat=adblockplus&showintro=0&mimetype=plaintext",
    defaultEnabled: true,
    note: "Domain-based blocklist"
  },
  {
    id: "ublock-filters",
    title: "uBlock Origin – Filters",
    url: "https://raw.githubusercontent.com/uBlockOrigin/uAssets/master/filters/filters.txt",
    defaultEnabled: true,
    note: "Base uBO list"
  },
  {
    id: "ublock-privacy",
    title: "uBlock Origin – Privacy",
    url: "https://raw.githubusercontent.com/uBlockOrigin/uAssets/master/filters/privacy.txt",
    defaultEnabled: true,
    note: "uBO privacy list"
  },
  {
    id: "ubo-quick-fixes",
    title: "Quick Fixes (uBlock Assets)",
    url: "https://raw.githubusercontent.com/uBlockOrigin/uAssets/master/filters/quick-fixes.txt",
    defaultEnabled: true,
    note: "Same-day patches for ad delivery changes on major sites — updated within hours of breakage"
  },
  {
    id: "fanboy-annoyance",
    title: "Fanboy's Annoyance List",
    url: "https://easylist.to/easylist/fanboy-annoyance.txt",
    defaultEnabled: false,
    note: "Includes EasyList Cookie + Fanboy Social"
  },
  {
    id: "easylist-cookie",
    title: "EasyList Cookie List",
    url: "https://secure.fanboy.co.nz/fanboy-cookiemonster.txt",
    defaultEnabled: false,
    note: "Cookie / GDPR banners only (skip if Annoyance is on)"
  },
  {
    id: "fanboy-social",
    title: "Fanboy's Social Blocking List",
    url: "https://easylist.to/easylist/fanboy-social.txt",
    defaultEnabled: false,
    note: "Skip if Annoyance is on"
  },
  {
    id: "easylist-germany",
    title: "EasyList Germany",
    url: "https://easylist.to/easylistgermany/easylistgermany.txt",
    defaultEnabled: false
  },
  {
    id: "easylist-france",
    title: "EasyList France",
    url: "https://easylist.to/easylistfrance/easylistfrance.txt",
    defaultEnabled: false
  }
];

const FILTER_UPDATE_ALARM = "quiet-filter-update";
const FILTER_UPDATE_PERIOD_MIN = 60 * 24;
