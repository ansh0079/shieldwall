// On search / shopping pages: hover a result to see the seller's rating in a side card.
// Only the domain of the result you hover is ever looked up.
(() => {
  const SEARCH = /(^|\.)(google|bing|duckduckgo|yahoo|ecosia|startpage|brave|yandex|baidu|qwant)\.[a-z.]+$/i;
  if (!SEARCH.test(location.hostname)) return;
  // Diagnostic marker: check `document.documentElement.dataset.trustcheckHover` in the page console.
  document.documentElement.dataset.trustcheckHover = window.top === window ? "active" : "active-frame";
  console.debug("[TrustCheck] hover script active", window.top === window ? "(top page)" : "(frame)", location.href.slice(0, 80));

  const PARAMS = ["url", "q", "adurl", "dest", "dest_url", "u", "ued"];
  // Real destination of a result link, unwrapping the engine's redirect wrappers.
  function destination(a) {
    let u; try { u = new URL(a.href, location.href); } catch { return null; }
    if (!/^https?:$/.test(u.protocol)) return null;
    if (!SEARCH.test(u.hostname)) return u.href;
    for (const p of PARAMS) {
      const v = u.searchParams.get(p);
      if (v && /^https?:\/\//i.test(v)) { try { const d = new URL(v); if (!SEARCH.test(d.hostname)) return d.href; } catch { /* next */ } }
    }
    return null;
  }

  // Smallest card-sized ancestor of the hovered element that holds a resolvable seller link.
  function findCard(el) {
    let n = el, unresolved = null;
    for (let i = 0; n && n !== document.body && i < 8; i++, n = n.parentElement) {
      const r = n.getBoundingClientRect();
      if (r.width > 560 || r.height > 720) break;                       // too big: a whole grid, not one result
      const links = n.matches("a[href]") ? [n] : [...n.querySelectorAll("a[href]")];
      for (const a of links) { const d = destination(a); if (d) return { card: n, url: d }; }
      if (links.length && !unresolved) unresolved = { card: n, url: null, hrefs: links.slice(0, 5).map((a) => a.href) };
    }
    return unresolved;     // card found, but no seller website could be read from its links
  }

  const COLORS = { trusted: "#16a34a", caution: "#d97706", risky: "#dc2626" };
  const WORDS = { trusted: "Looks trustworthy", caution: "Proceed with caution", risky: "High risk" };
  let host, shadow, current = null, showTimer = null, hideTimer = null, token = 0;

  function ensure() {
    if (host?.isConnected) return;
    host = document.createElement("div");
    host.id = "trustcheck-hover";
    host.style.cssText = "all:initial;position:fixed;z-index:2147483646;display:none;pointer-events:none;"; // never blocks the results underneath
    shadow = host.attachShadow({ mode: "closed" });
    document.documentElement.appendChild(host);
  }
  function hide() { clearTimeout(hideTimer); hideTimer = setTimeout(() => { if (host) host.style.display = "none"; current = null; }, 250); }

  function points(r) {
    const pts = [];
    if (r.buyerTotal) pts.push({ s: "info", t: `Based on ${r.buyerTotal} buyer reports (30 days)` });
    for (const f of r.feedback || []) pts.push({ s: "bad", t: `${f.count} buyers: ${f.label}` });
    if (r.reviews) pts.push({ s: r.reviews.score >= 4 ? "good" : r.reviews.score >= 3 ? "warn" : "bad", t: `${r.reviews.source} ${r.reviews.score?.toFixed(1)}/5 from ${r.reviews.count.toLocaleString()} reviews` });
    for (const th of r.reviews?.themes || []) pts.push({ s: "bad", t: `${th.count} of ${r.reviews.sample} recent reviews: ${th.label}` });
    for (const sg of r.signals) if ((sg.status !== "info" || ["age", "buyers"].includes(sg.id)) && !(sg.id === "buyers" && (r.feedback?.length || r.buyerTotal))) pts.push({ s: sg.status, t: sg.label });
    return pts.slice(0, 6);
  }

  function show(rect, build) {
    ensure(); shadow.textContent = "";
    const st = document.createElement("style");
    st.textContent = `*{box-sizing:border-box;font:13px system-ui,sans-serif}
      .c{width:280px;background:#fff;color:#111827;border-radius:12px;padding:12px;box-shadow:0 6px 24px rgba(0,0,0,.35);border:1px solid #e5e7eb}
      .top{display:flex;gap:10px;align-items:center}.sc{flex:none;width:44px;height:44px;border-radius:50%;color:#fff;font-weight:700;display:grid;place-items:center;background:#6b7280}
      .v{font-weight:700}.d{color:#6b7280;font-size:11px;word-break:break-all}
      .h{font-size:11px;text-transform:uppercase;letter-spacing:.05em;color:#6b7280;margin:10px 0 3px}
      .p{display:flex;gap:6px;margin:4px 0}.p i{flex:none;width:8px;height:8px;border-radius:50%;margin-top:5px;background:#9ca3af}
      .good i{background:#16a34a}.warn i{background:#d97706}.bad i{background:#dc2626}.n{color:#6b7280;font-size:11px;margin-top:8px}`;
    const c = document.createElement("div"); c.className = "c";
    build(c); shadow.append(st, c);
    host.style.display = "block";
    const w = 300, fitsRight = innerWidth - rect.right > w + 12;
    host.style.left = Math.max(8, fitsRight ? rect.right + 10 : rect.left - w - 10) + "px";
    host.style.top = Math.max(8, Math.min(rect.top, innerHeight - 320)) + "px";
  }
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };

  function render(rect, domain, r) {
    show(rect, (c) => {
      const top = el("div", "top"), sc = el("div", "sc", r.score), tx = el("div");
      sc.style.background = COLORS[r.verdict];
      const v = el("div", "v", WORDS[r.verdict]); v.style.color = COLORS[r.verdict];
      tx.append(v, el("div", "d", domain)); top.append(sc, tx); c.append(top);
      c.append(el("div", "h", "Recent feedback & checks"));
      for (const p of points(r)) { const d = el("div", "p " + p.s); d.append(el("i"), el("span", "", p.t)); c.append(d); }
      c.append(el("div", "n", "Quick check from the seller's web address. Open the shop for a full check."));
    });
  }
  function note(rect, text) { show(rect, (c) => c.append(el("div", "d", text))); }

  // Hold Alt while hovering: shows what the page contains around the pointer (for diagnosing unreadable listings).
  function debugCard(el) {
    const lines = [];
    let n = el;
    for (let i = 0; n && n !== document.documentElement && i < 8; i++, n = n.parentElement) {
      const r = n.getBoundingClientRect(), as = n.matches("a[href]") ? [n] : [...n.querySelectorAll("a[href]")];
      lines.push(`${i}. <${n.tagName.toLowerCase()}> ${Math.round(r.width)}x${Math.round(r.height)}px, ${as.length} link(s)`);
      if (as.length && lines.filter((l) => l.startsWith("  ")).length < 3)
        for (const a of as.slice(0, 2)) lines.push("  " + a.href.replace(/^https?:\/\//, "").slice(0, 70) + " -> " + (destination(a) ? "OK" : "no seller"));
    }
    return lines;
  }

  document.addEventListener("mouseover", (e) => {
    if (host && e.composedPath().includes(host)) return;
    if (e.altKey) {
      clearTimeout(showTimer); current = null;
      const rect = (e.target.closest?.("a,li,article,div") || e.target).getBoundingClientRect();
      return show(rect, (c) => { c.append(el("div", "v", "TrustCheck debug")); for (const l of debugCard(e.target)) c.append(el("div", "d", l)); });
    }
    const hit = findCard(e.target);
    clearTimeout(showTimer);
    if (!hit) return hide();
    clearTimeout(hideTimer);
    if (hit.card && hit.card === current) return;
    showTimer = setTimeout(async () => {
      const my = ++token;
      current = hit.card;
      const rect = hit.card.getBoundingClientRect();
      if (!hit.url) {
        console.debug("[TrustCheck] could not read a seller website from this result. Links seen:", hit.hrefs);
        return note(rect, "TrustCheck can't read this seller's website from the listing. Open the shop to see its rating.");
      }
      let domain; try { domain = new URL(hit.url).hostname.replace(/^www\./, ""); } catch { return; }
      note(rect, `Checking ${domain}...`);
      let report = null;
      try { report = await chrome.runtime.sendMessage({ type: "lookup", url: hit.url }); } catch { /* extension reloaded */ }
      if (my !== token || current !== hit.card) return;     // user moved on
      if (!report || report.neutral) return hide();
      render(rect, domain, report);
    }, 350);
  }, true);
  document.addEventListener("scroll", () => { if (host) host.style.display = "none"; current = null; }, { passive: true, capture: true });
})();
