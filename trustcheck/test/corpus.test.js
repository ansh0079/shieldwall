import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { registrableDomain } from "../lib/domain.js";
import { urlSignals, pageSignals } from "../lib/heuristics.js";
import { buildReport } from "../lib/score.js";
import { detectJurisdiction, extractVatNumber } from "../lib/companies.js";
import { buyerSignals } from "../lib/buyers.js";
import { filterOutliers, median } from "../lib/price.js";
import { Store } from "../server/store.js";

const getIds = (signals) => signals.map((s) => s.id);

test("corpus: known major retailers are recognized and not flagged as lookalikes", () => {
  const retailers = [
    "https://www.amazon.co.uk/",
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
  const rep = buildReport({
    url: "https://shop.example/checkout",
    domain: "shop.example",
    signals: sigs,
    links: []
  });
  assert.equal(rep.verdict, "risky");
  assert.ok(rep.score <= 20, "Form hijacking must cap score at <= 20");
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

test("corpus: native SQLite store persists and reads reports", () => {
  const dbFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "tc-sql-")), "reports.sqlite");
  const store = new Store({ file: dbFile, minReports: 1, salt: "test-salt" });
  assert.ok(store.useSqlite, "Store should use SQLite for .sqlite files");

  store.add({
    installId: "install-user-12345",
    domain: "sqlite-shop.example",
    outcome: "never",
    tags: ["fake_tracking"]
  });

  const sum = store.summary("sqlite-shop.example");
  assert.equal(sum.total, 1);
  assert.equal(sum.outcomes.never, 1);
  assert.equal(sum.tags.fake_tracking, 1);

  // Test merchant verification
  store.addMerchantVerification("sqlite-shop.example", "test-token-123", "well-known");
  const ver = store.getMerchantVerification("sqlite-shop.example");
  assert.ok(ver);
  assert.equal(ver.token, "test-token-123");
  assert.equal(store.summary("sqlite-shop.example").verifiedMerchant, true);
});

test("corpus: established 30-year-old domain with HTTPS scores trusted (not capped at 69 caution)", () => {
  const sigs = [
    ...urlSignals("https://footy.com/products/asics-gel-kayano-31"),
    { id: "age", label: "Established domain (30.7 years)", status: "good", points: 20 }
  ];
  const rep = buildReport({
    url: "https://footy.com/products/asics-gel-kayano-31",
    domain: "footy.com",
    signals: sigs,
    links: []
  });
  assert.equal(rep.score, 75);
  assert.equal(rep.verdict, "trusted");
});
