// Local, offline checks on the URL. Each signal: {id,label,status,points,detail}
import { registrableDomain, isIp, levenshtein } from "./domain.js";

const BRANDS = [
  "amazon", "ebay", "walmart", "target", "bestbuy", "aliexpress", "alibaba",
  "etsy", "paypal", "apple", "nike", "adidas", "shopify", "flipkart", "temu",
  "costco", "ikea", "zalando", "rakuten", "wayfair"
];

const KNOWN_STORES = new Set(BRANDS.map((b) => b + ".com").concat([
  "amazon.co.uk", "amazon.de", "amazon.in", "amazon.ca", "amazon.co.jp",
  "ebay.co.uk", "ebay.de", "ebay.com.au", "flipkart.com", "apple.com", "target.com",
  "walmart.com", "bestbuy.com", "costco.com", "ikea.com", "etsy.com", "paypal.com"
]));
// Marketplaces host many independent sellers: the platform's reputation says nothing about an individual seller.
const MARKETPLACE_LABELS = new Set(["amazon", "ebay", "etsy", "aliexpress", "alibaba", "temu", "rakuten"]);
const RISKY_TLDS = new Set(["tk", "ml", "ga", "cf", "gq", "top", "xyz", "click", "shop", "buzz", "icu", "cyou", "rest", "work", "live", "site"]);

const SCAM_AFFIXES = ["store", "shop", "outlet", "official", "sale", "deals", "login", "pay", "verify", "secure", "support", "help", "account", "order"];

function isLookalike(label, brand) {
  const stripped = label.replace(/[^a-z0-9]/g, "");
  // Number substitutions (e.g. amaz0n, paypa1)
  const deLeeted = stripped
    .replace(/0/g, "o")
    .replace(/1/g, "l")
    .replace(/5/g, "s")
    .replace(/8/g, "b")
    .replace(/3/g, "e");
  if (deLeeted === brand && stripped !== brand) return true;

  // Levenshtein distance 1 for brands with at least 5 characters (prevents short collisions like idea/ikea)
  if (brand.length >= 5 && levenshtein(stripped, brand) <= 1 && stripped !== brand) {
    return true;
  }

  // Brand as distinct token in hyphen/number separated label (e.g. amazon-deals, apple-login)
  const tokens = label.split(/[-_0-9]+/);
  if (tokens.includes(brand) && label !== brand) {
    return true;
  }

  // Brand combined with common scam suffixes/prefixes (e.g. nikestore, officialapple)
  for (const affix of SCAM_AFFIXES) {
    if (stripped === brand + affix || stripped === affix + brand) {
      return true;
    }
  }

  return false;
}

export function urlSignals(urlString) {
  const out = [];
  let u;
  try { u = new URL(urlString); } catch { return out; }
  const host = u.hostname.toLowerCase();
  const reg = registrableDomain(host);
  const label = reg.split(".")[0];
  const tld = reg.split(".").pop();
  const push = (id, label, status, points, detail) => out.push({ id, label, status, points, detail });

  if (u.protocol === "https:") push("https", "Encrypted connection (HTTPS)", "good", 5, "Traffic is encrypted. HTTPS alone does not prove a site is honest.");
  else push("https", "No HTTPS", "bad", -25, "Never enter card or login details on an unencrypted page.");

  if (isIp(host)) push("ip", "Site uses a raw IP address", "bad", -25, "Legitimate stores use a proper domain name.");
  if (host.includes("xn--")) push("punycode", "Internationalised (punycode) domain", "warn", -15, "Can disguise lookalike characters, e.g. a Cyrillic 'а' for 'a'.");
  if (RISKY_TLDS.has(tld)) push("tld", `Domain ends in .${tld}`, "warn", -8, "This TLD is disproportionately used by throwaway shops.");
  if ((label.match(/-/g) || []).length >= 3 || /\d{4,}/.test(label)) push("pattern", "Spammy domain pattern", "warn", -8, "Many hyphens or long digit runs are common in scam shops.");
  if (host.split(".").length - reg.split(".").length >= 3) push("subdomains", "Unusually deep subdomains", "warn", -8, host);

  if (KNOWN_STORES.has(reg) && MARKETPLACE_LABELS.has(label)) {
    push("marketplace", "Marketplace with independent sellers", "info", 0, "Many independent sellers trade here. The marketplace's own reputation does not cover this seller, so TrustCheck gives no positive verdict. Check the seller's own ratings.");
  } else if (KNOWN_STORES.has(reg)) {
    push("known", "Well-known retailer", "good", 20, "Domain matches a major retailer.");
  } else {
    for (const brand of BRANDS) {
      if (isLookalike(label, brand)) {
        push("lookalike", `Looks like "${brand}" but isn't`, "bad", -35, `${reg} imitates ${brand}.com. This is a classic phishing / fake-store tactic.`);
        break;
      }
    }
  }
  return out;
}

// Signals from the content script's page scan.
export function pageSignals(p) {
  const out = [];
  if (!p) return out;
  const push = (id, label, status, points, detail) => out.push({ id, label, status, points, detail });

  if (p.hasInsecurePaymentAction) {
    push("pay-hijack", "Payment form submits to an untrusted external server", "bad", -40, `Payment card details are sent to ${p.insecureActionHost || "an external server"} instead of this store or a recognized payment gateway. This is a severe card skimming / Magecart risk.`);
  }

  if (p.hasPaymentFields && !p.https) push("pay-http", "Payment form on an insecure page", "bad", -30, "Do not enter card details here.");

  if (p.isShop && p.hasFreeWebmailContact) {
    push("free-mail", "Customer support uses a free email provider", "warn", -10, "Official customer support uses a free public email address (such as Gmail or Outlook). Established commercial retailers use their own domain.");
  }

  if (p.isLiquidationClaim) {
    push("liquidation", "Liquidation / 'closing down' claims detected", "warn", -10, "Phrases like 'closing down sale' or 'all stock must go' are frequently fabricated by short-lived scam storefronts.");
  }

  const missing = [];
  if (!p.hasContact) missing.push("contact details");
  if (!p.hasReturns) missing.push("returns/refund policy");
  if (!p.hasPrivacyTerms) missing.push("privacy/terms");
  if (!p.hasAbout) missing.push("about page");
  if (p.isShop) {
    if (missing.length >= 3) push("policies", "Store lacks key trust pages", "bad", -15, "Missing: " + missing.join(", "));
    else if (missing.length) push("policies", "Some trust pages missing", "warn", -5, "Missing: " + missing.join(", "));
    else push("policies", "Contact, returns and policy pages found", "good", 8, "Standard for legitimate stores (not proof on its own).");
  }
  if (p.urgency) push("urgency", "High-pressure urgency tactics", "warn", -6, "Countdown timers / 'only N left' banners are common in scam shops.");
  return out;
}
