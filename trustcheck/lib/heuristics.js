// Local, offline checks on the URL. Each signal: {id,label,status,points,detail}
import { registrableDomain, isIp, levenshtein } from "./domain.js";

const BRANDS = [
  "amazon", "ebay", "walmart", "target", "bestbuy", "aliexpress", "alibaba",
  "etsy", "paypal", "apple", "nike", "adidas", "shopify", "flipkart", "temu",
  "costco", "ikea", "zalando", "rakuten", "wayfair"
];
const KNOWN_STORES = new Set(BRANDS.map((b) => b + ".com").concat([
  "amazon.co.uk", "amazon.de", "amazon.in", "ebay.co.uk", "flipkart.com"
]));
// Marketplaces host many independent sellers: the platform's reputation says nothing about an individual seller.
const MARKETPLACE_LABELS = new Set(["amazon", "ebay", "etsy", "aliexpress", "alibaba", "temu", "rakuten"]);
const RISKY_TLDS = new Set(["tk", "ml", "ga", "cf", "gq", "top", "xyz", "click", "shop", "buzz", "icu", "cyou", "rest", "work", "live", "site"]);

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
      const stripped = label.replace(/-/g, "");
      const near = levenshtein(stripped, brand) <= 1 && stripped !== brand;
      const embeds = stripped.includes(brand) && stripped !== brand;
      if (near || embeds) {
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
  if (p.hasPaymentFields && !p.https) push("pay-http", "Payment form on an insecure page", "bad", -30, "Do not enter card details here.");
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
