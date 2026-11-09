// Evidence cache: successes and failures are stored separately. Failures are cached only briefly (no request storms)
// and are never reported as clean results. Storage is injected so this is testable without a browser.
import { ProviderError } from "./http.js";

export const memoryStore = () => {
  const m = new Map();
  return { get: async (k) => m.get(k), set: async (k, v) => { m.set(k, v); }, entries: async () => [...m.entries()], remove: async (ks) => { ks.forEach((k) => m.delete(k)); }, _map: m };
};
export const chromeStore = (area, prefixes) => ({
  get: async (k) => (await area.get(k))[k],
  set: (k, v) => area.set({ [k]: v }),
  entries: async () => Object.entries(await area.get(null)).filter(([k]) => prefixes.some((p) => k.startsWith(p))),
  remove: (ks) => area.remove(ks)
});

export class EvidenceCache {
  constructor(store, { now = () => Date.now(), failTtlMs = 60_000 } = {}) { this.store = store; this.now = now; this.failTtlMs = failTtlMs; }
  async get(key, ttlMs) { const e = await this.store.get("ev:" + key); return e && this.now() - e.at <= ttlMs ? e : undefined; }
  async set(key, v) { await this.store.set("ev:" + key, { v, at: this.now() }); }
  async getFail(key) { const f = await this.store.get("fail:" + key); return f && this.now() - f.at <= this.failTtlMs ? f : undefined; }
  async setFail(key, e) { await this.store.set("fail:" + key, { kind: e?.kind || "network", message: String(e?.message || e).slice(0, 120), at: this.now() }); }
  async cached(key, ttlMs, fn, opts) { return (await this.cachedMeta(key, ttlMs, fn, opts)).v; }
  // Like cached(), but also returns when the evidence was actually fetched ({ v, at }) for provenance.
  async cachedMeta(key, ttlMs, fn, { force = false } = {}) {
    if (!force) {
      const hit = await this.get(key, ttlMs);
      if (hit) return { v: hit.v, at: hit.at };
      const f = await this.getFail(key);
      if (f) throw new ProviderError(f.kind, f.message, { cachedFailure: true });
    }
    try { const v = await fn(), at = this.now(); await this.store.set("ev:" + key, { v, at }); return { v, at }; }
    catch (e) { if (!(e instanceof ProviderError && e.kind === "aborted")) await this.setFail(key, e); throw e; }
  }
  // Drop entries older than maxAgeMs (and legacy-format keys) so storage cannot grow without bound.
  async prune(maxAgeMs = 7 * 86400000, legacy = ["net:", "co:"]) {
    const dead = [];
    for (const [k, v] of await this.store.entries()) if (legacy.some((p) => k.startsWith(p)) || (v && typeof v.at === "number" && this.now() - v.at > maxAgeMs)) dead.push(k);
    if (dead.length) await this.store.remove(dead);
    return dead.length;
  }
}
