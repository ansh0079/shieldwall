# TrustCheck — Buyer Warning & Intervention Implementation Plan

**Document:** `BUYER_WARNING_PLAN.md`  
**Target:** TrustCheck v0.2.x+ Browser Security & Commercial Release  
**Status:** Architecture & Operational Specification  

---

## 1. Executive Summary

TrustCheck's core commercial differentiator over passive review sites (Trustpilot, ScamAdviser) and traditional ad blockers is **active intervention at the exact moment of financial risk**. 

Passive reputation lookups fail because consumers rarely remember to research a store before entering credit card details. By intervening contextually—at search discovery, during browsing, and immediately upon reaching a checkout form—TrustCheck stops fraudulent transactions before payment credentials leave the browser.

However, displaying aggressive warnings about commercial businesses carries legal and technical risks:
1. **Defamation & Merchant Liability:** Publishing false "scam" accusations exposes the platform to lawsuits and takedown demands.
2. **User Fatigue:** Showing intrusive overlays on every unfamiliar store causes users to disable the extension.
3. **Cart Abandonment Impact:** A false warning harms legitimate independent merchants.

This plan defines the **calibrated warning tiers**, **trigger criteria**, **checkout interstitial architecture**, **legal liability shield**, and **dispute handling workflow** required for a commercial-grade consumer product.

---

## 2. Calibrated Warning Tiers

TrustCheck uses a **four-tier progressive warning hierarchy**. Warnings escalate only as evidence of active harm increases.

```
+-------------------------------------------------------------------------+
| Level 4: Checkout Interstitial Modal (Blocker / High-Risk Confirmation)  |
|          Active payment entry on confirmed critical risk stores         |
+-------------------------------------------------------------------------+
                                    ^
+-------------------------------------------------------------------------+
| Level 3: Dropdown Top-Right Banner (In-Page Notification)               |
|          Automatic expansion on Risky / Caution stores                  |
+-------------------------------------------------------------------------+
                                    ^
+-------------------------------------------------------------------------+
| Level 2: Search Result Hover Cards & Price Badges                       |
|          Pre-click evaluation on Google / Bing search result listings   |
+-------------------------------------------------------------------------+
                                    ^
+-------------------------------------------------------------------------+
| Level 1: Passive Toolbar Badge & Popup Details                          |
|          Continuous score indicator (75 green, 69 amber, 20 red, ? grey)|
+-------------------------------------------------------------------------+
```

### Warning Tier Specification Matrix

| Tier | UI Component | Trigger Condition | User Impact | Dismissal / Cooldown |
|---|---|---|---|---|
| **Tier 1: Passive Badge** | Chrome extension toolbar icon | Every navigable page (`score: 0–100` or `?`) | Non-intrusive color/number pill in toolbar | Always visible |
| **Tier 2: Search Preview** | Floating card on search result hover | Search result hover on Google / Bing Shopping | Pre-click decision cue; shows price deviation vs. median | Disappears on mouse leave |
| **Tier 3: In-Page Banner** | Floating pill at top right (`content.js`) | Page load on `risky`, `caution`, or `unverified` stores | Slides down; auto-collapses to pill after 4s (stays open if `risky`) | Click `×` hides for active page session |
| **Tier 4: Checkout Interstitial** | Full-screen focus-trapped alert dialog | Navigating to payment/checkout page on a **Tier-4 Critical Risk** store | Blocks interaction until buyer explicitly acknowledges or exits | 24-hour domain acknowledgment (`ack:<domain>`) |

---

## 3. Tier 4: Checkout Interstitial Architecture

The checkout interstitial is TrustCheck's strongest protection mechanism. It intercepts the user when payment fields are detected.

### 3.1 Detection of Checkout Intent (`content.js:scan()`)
An interstitial is only evaluated if `scan().isCheckout` returns `true`:
- Credit card input fields detected: `input[autocomplete^="cc-"]`, `input[name*="card"]`, `input[name*="cvv"]`, `input[name*="cvc"]`
- External hosted payment iframes detected: `iframe[src*="stripe.com"]`, `iframe[src*="paypal.com"]`, `iframe[src*="klarna.com"]`
- Explicit payment submission buttons: `/(pay now|pay with|place order|complete purchase|buy now)/i`
- Checkout URL paths: `/(checkout|payment|pay)(\/|$|\?)/i`

### 3.2 Critical Triggers for Checkout Blocking
The checkout interstitial is **never** shown merely because a store is new or has zero reviews. To trigger Level 4, at least **one definitive threat flag** or a **composite critical score** ($\le 20$) must be present:

1. **`pay-hijack` (Payment Form Hijack):** `<form>` submits credit card fields to an untrusted external origin that is not a certified payment gateway (Stripe, PayPal, Adyen, Worldpay, Shopify, Klarna).
2. **`sb` (Safe Browsing Hit):** Domain or URL is flagged on Google Safe Browsing / PhishTank blocklists.
3. **`pay-http` (Unencrypted Payment):** Credit card form on an unencrypted `http://` page.
4. **`lookalike` (Brand Typosquatting):** Deceptive character substitutions (`amaz0n.com`, `nikestore-outlet.com`) targeting verified retailers.
5. **Severe Buyer Non-Delivery (`never / total >= 0.4` with $\ge 5$ reports):** Over 40% of verified buyers report that goods never arrived.
6. **Price Outlier Trap ($\ge 65\%$ below median) + New Domain ($< 60$ days old):** High-confidence counterfeit or fake-liquidation signature.

### 3.3 Interstitial Accessibility & UX Specification
- **Container Isolation:** Injected into `document.documentElement` via Closed Shadow DOM (`attachShadow({ mode: "closed" })`) to prevent host page CSS pollution or malicious script tampering.
- **ARIA Compliance:** `role="alertdialog"`, `aria-modal="true"`, `aria-label="TrustCheck Security Warning"`.
- **Focus Management:** Focus trapped inside the dialog; `Escape` key listener closes the modal and redirects back.
- **Primary CTA ("Leave Site"):** Green button (`background: #16a34a`), autofocus: `"Take me back (Recommended)"` triggers `history.back()`.
- **Secondary CTA ("Proceed"):** Subdued text link: `"I understand the risk, continue to checkout"`.
- **Cooldown:** When bypassed, stores `ack:<domain> = Date.now()` in `chrome.storage.local` with a 24-hour expiration so the user is not spammed if they choose to proceed.

---

## 4. Legal Defensibility & Defamation Shield

Calling a business a "scam" or "fraud" without a criminal conviction is libelous under English defamation law (Defamation Act 2013) and actionable under US commercial disparagement laws. TrustCheck protects itself through strict structural rules:

### 4.1 Opinion & Factual Signal Calibration
| Dangerous Terminology (Never Used) | Calibrated Replacement (Legally Defensible) |
|---|---|
| "This site is a scam" | "Multiple high-risk indicators detected" |
| "Fake shop" | "Brand lookalike — does not match official domain" |
| "Fraudulent seller" | "Order non-delivery reported by 6 of 10 buyers" |
| "Untrustworthy" | "Unverified store — limited public trading history" |
| "Malicious site" | "Listed on Google Safe Browsing malware directory" |

### 4.2 Objective Factual Sourcing
Every negative point displayed on a warning must map to an independently verifiable public record:
- **Registry:** Public RDAP registration date (e.g., `Registered 12 days ago`).
- **Archive:** Public Internet Archive snapshot date (e.g., `Site first appeared online Nov 2026`).
- **Government:** UK Companies House / EU VIES VAT registry lookup result.
- **Technical Inspection:** Insecure HTTP action, cross-origin form target, or missing SSL certificate.
- **Attributed Community Data:** Explicitly phrased as attribution: `"X buyers reported an unfulfilled order"` rather than `"This merchant steals money"`.

### 4.3 Mandatory Disclaimer
All UI footers and warning cards must display:
> *"TrustCheck ratings are automated, informational risk evaluations based on public web signals and buyer feedback. Ratings do not constitute legal advice or factual determinations of merchant intent. See Terms."*

---

## 5. Merchant Dispute & Appeals Workflow

A commercial trust platform must provide a clear, rapid path for legitimate merchants to dispute erroneous ratings.

```
[Merchant Disputes Rating]
           |
           v
[Step 1: Automated Verification Challenge]
  - DNS TXT record or /.well-known/trustcheck.json challenge
  - Verifies ownership of domain
           |
           v
[Step 2: Automated Signal Recheck]
  - Did merchant fix missing policy pages?
  - Was company registration updated at Companies House?
  - Has Safe Browsing delisted the domain?
           |
     +-----+-----+
     |           |
  [Resolved]   [Unresolved]
     |           |
     v           v
[Instant Score [Step 3: Human Review Queue (5-day SLA)]
 Recalculation]  - Merchant submits invoice/business evidence
                 - Manual review by TrustCheck operations
                 - Domain whitelist or custom score annotation
```

### 5.1 Dispute SLA & Process
- **Intake Channel:** `trustcheck.app/merchant/dispute` and `support@trustcheck.app`.
- **SLA:** Initial response within 48 hours; resolution or escalation within 5 business days.
- **Automated Re-check:** When a merchant verifies ownership via `/.well-known/trustcheck.json`, the backend automatically purges cached network records (`net:<domain>`) and triggers a clean re-scan.

---

## 6. Implementation Task Checklist

### Phase A: UI & Warning Calibration (Week 1–2)
- [x] Calibrate scoring engine so established domains ($\ge 5$ years, zero flags) never receive artificial caution caps (`3733c47`).
- [x] Separate **Key trust checks** from **Most common feedback** headers in `content.js` (`3733c47`).
- [x] Implement closed-shadow DOM checkout interstitial in `content.js` with 24h acknowledgment cache.
- [ ] Add `role="alertdialog"` and keyboard focus trapping to checkout overlay in `content.js`.
- [ ] Add explicit `"Safer Steps"` guide to interstitial card (chargeback protection advice, credit card usage).

### Phase B: Backend Verification & Dispute Routing (Week 3–4)
- [x] Implement `/v1/check` endpoint with server-side Safe Browsing and Companies House caching.
- [x] Support merchant domain ownership verification via `/.well-known/trustcheck.json` (`store.js`).
- [ ] Build public dispute submission form on landing page (`docs/trustcheck/dispute.html`).
- [ ] Add dispute triage webhook notifying operations on new merchant appeals.

### Phase C: Corpus Testing & Verification (Ongoing)
- [x] Expand `test/corpus.test.js` to cover lookalikes, liquidation traps, payment hijacking, and outliers (66/66 passing).
- [ ] Add specific unit tests for checkout interstitial triggers (`hasInsecurePaymentAction`, high-ratio non-delivery).
- [ ] Validate false-positive rates against top 1,000 legitimate e-commerce domains.
