// QuietBrowse - phishing heuristics + trust score (shared across shield.js and popup)

const PhishScore = (function () {
  const OFFICIAL_DOMAINS = new Set([
    "google.com", "gmail.com", "youtube.com", "facebook.com",
    "instagram.com", "whatsapp.com", "paypal.com", "amazon.com",
    "apple.com", "icloud.com", "microsoft.com", "outlook.com",
    "office.com", "live.com", "netflix.com", "linkedin.com",
    "twitter.com", "x.com", "coinbase.com", "binance.com",
    "chase.com", "wellsfargo.com", "bankofamerica.com", "dropbox.com",
    "steampowered.com", "steamcommunity.com", "github.com", "yahoo.com",
    "ebay.com", "walmart.com", "adobe.com", "spotify.com", "tiktok.com",
    "discord.com", "roblox.com", "epicgames.com"
  ]);

  const BRAND_TOKENS = [
    "paypal", "facebook", "instagram", "whatsapp", "netflix", "linkedin",
    "coinbase", "binance", "metamask", "wellsfargo", "chase", "icloud",
    "dropbox", "microsoft", "amazon", "google", "apple", "steam",
    "discord", "roblox"
  ];

  const BRAND_NAMES = [
    "google", "gmail", "youtube", "facebook", "instagram", "whatsapp",
    "paypal", "amazon", "apple", "icloud", "microsoft", "outlook",
    "netflix", "linkedin", "twitter", "coinbase", "binance", "chase",
    "wellsfargo", "dropbox", "steampowered", "github", "spotify",
    "tiktok", "discord", "roblox"
  ];

  const OFFICIAL_SERVICE_HOSTS = new Set([
    "login.microsoftonline.com", "outlook.cloud.microsoft",
    "account.live.com", "accounts.google.com", "appleid.apple.com"
  ]);

  const RISKY_TLDS = new Set([
    "tk", "ml", "ga", "cf", "gq", "zip", "mov", "top", "icu", "rest",
    "cyou", "monster", "sbs", "cfd"
  ]);

  // Words commonly glued to a brand in lookalike hostnames.
  const BRAND_LURES = [
    "login", "logon", "signin", "secure", "security", "account", "accounts",
    "verify", "verification", "update", "support", "service", "auth",
    "my", "web", "online", "official"
  ];

  // A brand token inside a label that is not that brand's own name.
  // Matches hyphenated labels (login-paypal-secure) and lure+brand compounds
  // (loginpaypal) without treating googleusercontent as "google".
  function labelHasBrand(label, brand) {
    if (!label || !brand) return false;
    if (label === brand) return true;
    if (label.split(/[^a-z0-9]+/).filter(Boolean).includes(brand)) return true;
    if (brand.length < 5) return false;
    const stripped = label.replace(/[^a-z0-9]/g, "");
    return BRAND_LURES.some((lure) => {
      const flat = lure.replace(/[^a-z0-9]/g, "");
      return stripped === flat + brand || stripped === brand + flat;
    });
  }

  function levenshtein(a, b) {
    if (Math.abs(a.length - b.length) > 2) return 99;
    const dp = Array.from({ length: a.length + 1 }, (_, i) => [i]);
    for (let j = 0; j <= b.length; j++) dp[0][j] = j;
    for (let i = 1; i <= a.length; i++) {
      for (let j = 1; j <= b.length; j++) {
        dp[i][j] = Math.min(
          dp[i - 1][j] + 1,
          dp[i][j - 1] + 1,
          dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)
        );
      }
    }
    return dp[a.length][b.length];
  }

  function analyze(hostname, protocol, hasPasswordField, signals) {
    signals = signals || {};
    const host = hostname.toLowerCase();
    const base = getBaseDomain(host);

    if (protocol !== "http:" && protocol !== "https:") {
      return { riskScore: 0, reasons: [], level: "unknown", trustScore: null };
    }

    const officialHost = OFFICIAL_SERVICE_HOSTS.has(host) ||
      OFFICIAL_DOMAINS.has(host.replace(/^www\./, ""));

    let riskScore = 0;
    const reasons = [];

    if (host.includes("xn--")) {
      riskScore += 3;
      reasons.push("Disguised international characters in the address");
    }

    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) {
      riskScore += hasPasswordField ? 3 : 1;
      reasons.push("Raw IP address instead of a normal domain");
    }

    const subLabels = host
      .slice(0, host.length - base.length)
      .split(".")
      .filter(Boolean);
    const sld = base.split(".")[0];

    if (!officialHost) {
      let brandReason = null;
      for (const token of BRAND_TOKENS) {
        if (sld === token) continue;
        const inSub = subLabels.some((l) => labelHasBrand(l, token));
        const inSld = labelHasBrand(sld, token);
        if (inSub && !inSld) {
          brandReason = `Brand name "${token}" hidden in subdomain`;
          break;
        }
        if (inSld || inSub) {
          brandReason = `Brand name "${token}" appears in a different site's address`;
          break;
        }
      }
      if (!brandReason) {
        for (const brand of BRAND_NAMES) {
          if (sld === brand) continue;
          const stripped = sld.replace(/[^a-z0-9]/g, "");
          const dist = levenshtein(stripped, brand);
          if (dist > 0 && dist <= (brand.length >= 8 ? 2 : 1)) {
            brandReason = `Looks like a misspelling of ${brand}.com`;
            break;
          }
        }
      }
      if (brandReason) {
        riskScore += 3;
        reasons.push(brandReason);
      }
    }

    const tld = host.split(".").pop();
    if (RISKY_TLDS.has(tld)) {
      riskScore += hasPasswordField ? 2 : 1;
      reasons.push(`Risky ".${tld}" domain ending`);
    }

    const insecureLogin = protocol === "http:" && hasPasswordField;
    if (insecureLogin) {
      riskScore += 2;
      reasons.push("Password form over unencrypted http");
    } else if (protocol === "http:") {
      riskScore += 1;
      reasons.push("Connection is not encrypted (http)");
    }

    if (host.length > 60 || host.split(".").length >= 6) {
      riskScore += 1;
      reasons.push("Unusually long or nested address");
    }

    if (signals.suspiciousSubdomain) {
      riskScore += 1;
      reasons.push("Suspicious random-looking subdomain");
    }

    if (signals.insecureLoginForm) {
      riskScore += 2;
      reasons.push("Login form submits over unencrypted http");
    }

    if (signals.externalFormAction) {
      riskScore += 2;
      reasons.push("Login form sends data to a different site");
    }

    if (signals.mixedContent) {
      riskScore += 1;
      reasons.push("Page loads insecure content over http");
    }

    if (signals.suspiciousLinkTargets) {
      riskScore += 1;
      reasons.push("Links point to lookalike domains");
    }

    const trustScore = Math.max(5, Math.min(100, 100 - riskScore * 12));

    let level;
    if (riskScore >= 3) level = "danger";
    else if (riskScore >= 1) level = "caution";
    else if (protocol === "https:") level = officialHost ? "excellent" : "good";
    else level = "caution";

    if (reasons.length === 0) {
      reasons.push("No phishing warning signs detected");
    }

    return { riskScore, reasons, level, trustScore };
  }

  // Blocker stats stay beside the site score. They do not change it.
  function activityNote(mode, blocked, trackers) {
    const modeText = mode === SITE_MODE.OFF
      ? "Protection paused on this site"
      : mode === SITE_MODE.ADS
        ? "Ads allowed on this site"
        : "Full protection on this site";
    const requests = `${blocked} request${blocked === 1 ? "" : "s"} blocked`;
    const from = trackers
      ? ` from ${trackers} tracker${trackers === 1 ? "" : "s"}`
      : "";
    return `${modeText}. ${requests}${from}.`;
  }

  function enrich(base, context) {
    context = context || {};
    const blockedCount = context.blockedCount || 0;
    const trackerCount = context.trackerCount || 0;
    const siteMode = context.siteMode || SITE_MODE.FULL;
    if (!context.enabled) {
      return {
        riskScore: base?.riskScore || 0,
        reasons: ["Protection is off"],
        level: "off",
        trustScore: null,
        blockedCount,
        trackerCount,
        siteMode,
        activityNote: "Protection is off"
      };
    }

    return {
      riskScore: base?.riskScore || 0,
      reasons: [...(base?.reasons || [])],
      level: base?.level || "unknown",
      trustScore: base?.trustScore ?? null,
      blockedCount,
      trackerCount,
      siteMode,
      activityNote: activityNote(siteMode, blockedCount, trackerCount)
    };
  }

  function getBaseDomainSafe(hostname) {
    try {
      return getBaseDomain(hostname.toLowerCase());
    } catch {
      return hostname;
    }
  }

  function isLoginForm(form) {
    const inputs = form.querySelectorAll("input");
    const hasPassword = [...inputs].some((el) => el.type === "password");
    const hasUsername = [...inputs].some((el) => {
      const t = el.type;
      const name = (el.name || "").toLowerCase();
      return t === "text" || t === "email" || t === "tel" || name.includes("user") || name.includes("login") || name.includes("email");
    });
    return hasPassword || (hasUsername && form.querySelector("button[type=submit], input[type=submit]"));
  }

  function getFormAction(form) {
    let action = form.getAttribute("action") || "";
    if (!action || action === "") return location.href;
    try {
      return new URL(action, location.href).href;
    } catch {
      return location.href;
    }
  }

  function calculateEntropy(str) {
    const map = new Map();
    for (const ch of str) map.set(ch, (map.get(ch) || 0) + 1);
    const len = str.length;
    let entropy = 0;
    for (const count of map.values()) {
      const p = count / len;
      entropy -= p * Math.log2(p);
    }
    return entropy;
  }

  function collectSignals() {
    const signals = {
      passwordFieldCount: 0,
      loginFormCount: 0,
      insecureLoginForm: false,
      externalFormAction: false,
      mixedContent: false,
      suspiciousSubdomain: false,
      suspiciousLinkTargets: false
    };

    const pageBase = getBaseDomainSafe(location.hostname);

    const passwordFields = document.querySelectorAll("input[type=password]");
    signals.passwordFieldCount = passwordFields.length;

    const forms = document.querySelectorAll("form");
    for (const form of forms) {
      if (!isLoginForm(form)) continue;
      signals.loginFormCount++;

      const actionUrl = getFormAction(form);
      const actionHost = safeHostname(actionUrl);
      const actionBase = actionHost ? getBaseDomainSafe(actionHost) : pageBase;
      const actionProtocol = actionUrl.startsWith("https:")
        ? "https:"
        : actionUrl.startsWith("http:")
          ? "http:"
          : location.protocol;

      if (location.protocol === "https:" && actionProtocol === "http:") {
        signals.insecureLoginForm = true;
      }
      if (actionBase && actionBase !== pageBase) {
        signals.externalFormAction = true;
      }
    }

    if (location.protocol === "https:") {
      const selectors = [
        "img[src^='http:']",
        "iframe[src^='http:']",
        "script[src^='http:']",
        "link[rel=stylesheet][href^='http:']",
        "audio[src^='http:']",
        "video[src^='http:']",
        "source[src^='http:']"
      ];
      signals.mixedContent = selectors.some((sel) => document.querySelector(sel) !== null);
    }

    const host = location.hostname.toLowerCase();
    const labels = host.split(".");
    if (labels.length >= 3) {
      const subdomain = labels.slice(0, labels.length - 2).join(".");
      if (subdomain.length >= 20 || (subdomain.length >= 12 && calculateEntropy(subdomain) > 4.2)) {
        signals.suspiciousSubdomain = true;
      }
    }

    const brandPattern = new RegExp("(" + BRAND_NAMES.join("|") + ")");
    // Cap the scan: 200 links is plenty of signal, and this runs on every
    // trust-score refresh while the popup is open.
    const links = [...document.querySelectorAll("a[href]")].slice(0, 200);
    for (const link of links) {
      const href = link.getAttribute("href") || "";
      if (!href.startsWith("http")) continue;
      let targetHost;
      try {
        targetHost = new URL(href).hostname.toLowerCase();
      } catch {
        continue;
      }
      const targetBase = getBaseDomainSafe(targetHost);
      if (targetBase !== pageBase && brandPattern.test(targetHost) && !brandPattern.test(targetBase)) {
        signals.suspiciousLinkTargets = true;
        break;
      }
    }

    return signals;
  }

  return { analyze, enrich, collectSignals };
})();
