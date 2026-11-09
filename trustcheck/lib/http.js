// Shared fetch helper for every provider: timeout, size limit, content-type check, useful error categories.
// Error messages name the host only (never the full URL), so API keys in query strings cannot leak into the UI/logs.
export class ProviderError extends Error {
  constructor(kind, message, extra = {}) { super(message); this.name = "ProviderError"; this.kind = kind; Object.assign(this, extra); }
}
// kinds: timeout | network | rate_limited | http | content_type | too_large | parse | invalid | aborted

// Remove anything that could carry a credential from text we may show or log.
export const scrub = (m) => String(m ?? "")
  .replace(/https?:\/\/\S+/gi, "[url]")
  .replace(/\b(api[-_]?key|key|token|secret|password|authorization)\s*[=:]\s*\S+/gi, "$1=[redacted]")
  .slice(0, 80);

const hostOf = (u) => { try { return new URL(u).host; } catch { return "provider"; } };

async function readLimited(res, maxBytes, host) {
  if (res.body?.getReader) {
    const reader = res.body.getReader(), chunks = []; let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) { try { await reader.cancel(); } catch { /* ignore */ } throw new ProviderError("too_large", `${host}: response too large`); }
      chunks.push(value);
    }
    const all = new Uint8Array(total); let o = 0;
    for (const c of chunks) { all.set(c, o); o += c.byteLength; }
    return new TextDecoder().decode(all);
  }
  const text = await res.text();
  if (text.length > maxBytes) throw new ProviderError("too_large", `${host}: response too large`);
  return text;
}

export async function fetchJson(url, { method = "GET", headers, body, timeoutMs = 8000, maxBytes = 1 << 20, signal, accept = /json/i, fetchImpl } = {}) {
  const host = hostOf(url), doFetch = fetchImpl || globalThis.fetch;
  if (signal?.aborted) throw new ProviderError("aborted", `${host}: cancelled`);
  const ctl = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; ctl.abort(); }, timeoutMs);
  const onAbort = () => ctl.abort();
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    let res;
    try { res = await doFetch(url, { method, headers, body, signal: ctl.signal }); }
    catch (e) {
      if (timedOut) throw new ProviderError("timeout", `${host}: timed out after ${timeoutMs / 1000}s`);
      if (signal?.aborted) throw new ProviderError("aborted", `${host}: cancelled`);
      throw new ProviderError("network", `${host}: ${scrub(e?.message || e)}`);
    }
    if (res.status === 429) throw new ProviderError("rate_limited", `${host}: rate limited`, { status: 429 });
    if (!res.ok) {
      let detail;
      try { const j = JSON.parse(await readLimited(res, 4096, host)); if (typeof j?.error === "string") detail = j.error.slice(0, 120); } catch { /* no body */ }
      throw new ProviderError("http", `${host}: HTTP ${res.status}`, { status: res.status, detail });
    }
    const ct = res.headers?.get?.("content-type");
    if (ct && accept && !accept.test(ct)) throw new ProviderError("content_type", `${host}: unexpected content type`);
    const len = Number(res.headers?.get?.("content-length") || 0);
    if (len > maxBytes) throw new ProviderError("too_large", `${host}: response too large`);
    let text;
    try { text = await readLimited(res, maxBytes, host); }
    catch (e) {
      if (e instanceof ProviderError) throw e;
      if (timedOut) throw new ProviderError("timeout", `${host}: timed out after ${timeoutMs / 1000}s`);
      if (signal?.aborted) throw new ProviderError("aborted", `${host}: cancelled`);
      throw new ProviderError("network", `${host}: read failed`);
    }
    try { return JSON.parse(text); }
    catch { throw new ProviderError("parse", `${host}: response is not valid JSON`); }
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}

// Short human label for UI: the detail line of an "unavailable" check.
export function describeFailure(e) {
  if (e instanceof ProviderError) return e.message;
  return scrub(e?.message || e);
}
