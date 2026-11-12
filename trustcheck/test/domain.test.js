import test from "node:test";
import assert from "node:assert/strict";
import { normalizeHost, registrableDomain, publicSuffixInfo, isPublicSuffix, tenantPlatform, isIp } from "../lib/domain.js";

test("ordinary domains and public suffixes", () => {
  assert.equal(registrableDomain("shop.example.co.uk"), "example.co.uk");
  assert.equal(registrableDomain("a.b.example.com"), "example.com");
  assert.equal(registrableDomain("www.example.com.au"), "example.com.au");
  assert.equal(registrableDomain("example.com"), "example.com");
  assert.equal(registrableDomain("co.uk"), "co.uk");               // a bare suffix is returned as-is
  assert.equal(isPublicSuffix("co.uk"), true);
  assert.equal(isPublicSuffix("example.co.uk"), false);
});
test("private suffixes isolate tenants", () => {
  for (const [host, site] of [
    ["safe.github.io", "safe.github.io"], ["x.evil.github.io", "evil.github.io"],
    ["shop.pages.dev", "shop.pages.dev"], ["a.blogspot.com", "a.blogspot.com"],
    ["app.web.app", "app.web.app"], ["bucket.s3.amazonaws.com", "bucket.s3.amazonaws.com"],
    ["store.myshopify.com", "store.myshopify.com"]]) assert.equal(registrableDomain(host), site, host);
  assert.notEqual(registrableDomain("safe.github.io"), registrableDomain("evil.github.io"));
  assert.equal(tenantPlatform("safe.github.io"), "github.io");
  assert.equal(tenantPlatform("shop.example.co.uk"), null);
  assert.equal(tenantPlatform("github.io"), null);                 // the platform itself is not a tenant
});
test("wildcard and exception rules", () => {
  assert.equal(registrableDomain("a.b.ck"), "a.b.ck");             // *.ck
  assert.equal(registrableDomain("www.ck"), "www.ck");             // !www.ck
  assert.equal(registrableDomain("x.www.ck"), "www.ck");
  assert.equal(registrableDomain("x.city.kawasaki.jp"), "city.kawasaki.jp");
  assert.equal(registrableDomain("a.b.foo.kawasaki.jp"), "b.foo.kawasaki.jp");
});
test("IDN, punycode and case", () => {
  assert.equal(registrableDomain("münchen.de"), "xn--mnchen-3ya.de");
  assert.equal(registrableDomain("shop.xn--mnchen-3ya.de"), "xn--mnchen-3ya.de");
  assert.equal(registrableDomain("магазин.рф"), "xn--80aairftm.xn--p1ai");
  assert.equal(registrableDomain("WWW.Example.COM"), "example.com");
});
test("IPv4, IPv6, ports, brackets, trailing dots", () => {
  assert.equal(registrableDomain("192.168.4.4"), "192.168.4.4");
  assert.equal(isIp("192.168.4.4"), true); assert.equal(isIp("999.1.1.1"), false);
  assert.equal(registrableDomain("[2001:DB8::1]"), "2001:db8::1");
  assert.equal(registrableDomain("2001:db8::1"), "2001:db8::1");
  assert.equal(registrableDomain("example.com."), "example.com");
  assert.equal(registrableDomain("example.com:8443"), "example.com");
  assert.equal(registrableDomain("localhost"), "localhost");
  assert.equal(publicSuffixInfo("192.168.4.4"), null);
});
test("malformed hosts are rejected", () => {
  for (const bad of ["", " ", "a b.com", "exa mple.com", "http://x.com", "a..com", "-a.com", "a-.com", "x@y.com", "a/b.com", "1.2.3", "a.b.123", null, undefined, 5, "x".repeat(70) + ".com"])
    assert.equal(normalizeHost(bad), null, String(bad));
  assert.equal(registrableDomain("not a host"), "");
});
