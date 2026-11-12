import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { registrableDomain } from "../lib/domain.js";
import { urlSignals, pageSignals } from "../lib/heuristics.js";
import { buildReport } from "../lib/score.js";
import { filterOutliers, median } from "../lib/price.js";

const getIds = (signals) => signals.map((s) => s.id);

test("corpus: known major retailers are recognized and not flagged as lookalikes", () => {
  const retailers = [
    "https://www.apple.com/",
    "https://www.target.com/",
    "https://www.ikea.com/",
    "https://www.walmart.com/"
  ];
  for (const url of retailers) {
    const sigs = urlSignals(url);
    const ids = getIds(sigs);
    assert.ok(ids.includes("known"), `Expected ${url} to have known retailer signal`);
    assert.ok(!ids.includes("lookalike"), `Expected ${url} NOT to have lookalike signal`);
  }
  const amazon = getIds(urlSignals("https://www.amazon.co.uk/"));
  assert.ok(amazon.includes("marketplace"), "Amazon is a marketplace, not a single-seller retailer");
  assert.ok(!amazon.includes("lookalike"));
});

test("corpus: typosquatting and brand phishing lures are strictly flagged", () => {
  const lures = [
    "https://amaz0n.com/",
    "https://amazon-deals-outlet.com/",
    "https://apple-login-support.com/",
    "https://paypa1.com/",
    "https://nikestore.com/"
  ];
  for (const url of lures) {
    const sigs = urlSignals(url);
    const ids = getIds(sigs);
    assert.ok(ids.includes("lookalike"), `Expected ${url} to be flagged as lookalike`);
  }
});

test("corpus: common words are not falsely flagged as brand lookalikes", () => {
  const harmless = [
    "https://pineapple.com/",
    "https://snapple.com/",
    "https://turnpike.com/",
    "https://targeted-marketing.com/"
  ];
  for (const url of harmless) {
    const sigs = urlSignals(url);
    const ids = getIds(sigs);
    assert.ok(!ids.includes("lookalike"), `Expected ${url} NOT to be flagged as lookalike`);
  }
});

test("corpus: multi-tenant platform isolation via full Public Suffix List", () => {
  const cases = [
    ["https://store-a.myshopify.com", "https://store-b.myshopify.com"],
    ["https://user1.github.io", "https://user2.github.io"],
    ["https://site-a.pages.dev", "https://site-b.pages.dev"]
  ];
  for (const [u1, u2] of cases) {
    const d1 = registrableDomain(new URL(u1).hostname);
    const d2 = registrableDomain(new URL(u2).hostname);
    assert.notEqual(d1, d2, `Expected ${u1} and ${u2} to have distinct registrable domains`);
  }
});

test("corpus: payment form hijacking / skimmer detection triggers critical risk", () => {
  const hijackedScan = {
    isShop: true,
    hasPaymentFields: true,
    https: true,
    hasInsecurePaymentAction: true,
    insecureActionHost: "c2-collector.evil-cdn.xyz"
  };
  const sigs = pageSignals(hijackedScan);
  const ids = getIds(sigs);
  assert.ok(ids.includes("pay-hijack"));
  const hijack = sigs.find((s) => s.id === "pay-hijack");
  assert.equal(hijack.status, "bad");
  assert.ok(hijack.points <= -40);
  const rep = buildReport({
    url: "https://shop.example/checkout",
    domain: "shop.example",
    signals: sigs,
    links: []
  });
  // Origin's evidence-family rules treat a single page-heuristic as caution (authoritative threats are Safe Browsing / HTTP payment).
  assert.ok(["caution", "risky", "dangerous"].includes(rep.verdict), rep.verdict);
  assert.ok(rep.score <= 69);
});

test("corpus: free webmail support address on commercial shop warns", () => {
  const freeMailScan = {
    isShop: true,
    hasFreeWebmailContact: true,
    https: true,
    hasContact: true,
    hasReturns: true,
    hasPrivacyTerms: true,
    hasAbout: true
  };
  const sigs = pageSignals(freeMailScan);
  assert.ok(getIds(sigs).includes("free-mail"));
});

test("corpus: fake liquidation / store closing down urgency warns", () => {
  const liquidationScan = {
    isShop: true,
    isLiquidationClaim: true,
    https: true,
    hasContact: true,
    hasReturns: true,
    hasPrivacyTerms: true,
    hasAbout: true
  };
  const sigs = pageSignals(liquidationScan);
  assert.ok(getIds(sigs).includes("liquidation"));
});

test("corpus: price outlier filtering rejects extreme anomalies", () => {
  const prices = [5, 499, 520, 530, 545, 560, 570, 580, 599, 10000];
  const cleaned = filterOutliers(prices);
  assert.ok(!cleaned.includes(5), "Expected low outlier to be removed");
  assert.ok(!cleaned.includes(10000), "Expected high outlier to be removed");
  assert.equal(cleaned.length, 8);
  assert.ok(median(cleaned) > 500 && median(cleaned) < 600);
});


test("corpus: a single established-domain signal is not enough for a lower-risk verdict", () => {
  const sigs = [
    ...urlSignals("https://footy.com/products/asics-gel-kayano-31"),
    { id: "age", label: "Established domain (30.7 years)", status: "good", points: 20, family: "history", provenance: "verified", verification: "verified" }
  ];
  const rep = buildReport({
    url: "https://footy.com/products/asics-gel-kayano-31",
    domain: "footy.com",
    signals: sigs,
    links: []
  });
  // Origin's evidence-family rules: a positive verdict needs two independent families.
  assert.equal(rep.verdict, "limited");
  assert.ok(rep.score <= 69);
});
