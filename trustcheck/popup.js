import { TAGS } from "./lib/buyers.js";
const $ = (id) => document.getElementById(id);
let current = null, outcome = null; const picked = new Set();
const PROV = { verified: "Verified", inferred: "Inferred", "user-reported": "Unverified user report", unavailable: "Unavailable", stale: "Stale" };
const ago = (t) => { const m = Math.round((Date.now() - t) / 60000); return m < 1 ? "just now" : m < 60 ? `${m} min ago` : `${Math.round(m / 60)} h ago`; };
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };
const item = (s, detail) => { const li = el("li", s.status), d = el("div"); d.append(el("span", "", s.label)); if (detail) d.append(el("small", "", detail)); li.append(el("i"), d); return li; };

function render(r) {
  $("loading").hidden = true;
  if (!r) { $("loading").hidden = false; $("loading").textContent = "Open a website to check it."; return; }
  if (r.neutral) { $("loading").hidden = false; $("loading").textContent = "This is a search page, not a shop. Open a shop's own page to see its rating."; return; }
  current = r;
  $("main").hidden = false;
  $("report").hidden = false;
  if (!r.backendOn) { $("rs1").hidden = true; $("rs2").hidden = true; $("rmsg").hidden = false; $("rmsg").textContent = "Set a report server in Options to share and see buyer reports."; }
  $("ring").className = r.verdict; $("ring").textContent = r.verdict === "limited" ? "?" : r.verdict === "dangerous" ? "!" : r.score;
  $("ring").setAttribute("aria-label", `Evidence score ${r.score} of 100`);
  $("verdict").textContent = r.verdictLabel; $("domain").textContent = r.domain;
  $("conf").textContent = r.verdict === "limited" ? `${r.confidenceLabel} confidence · not enough evidence for a score` : `${r.confidenceLabel} confidence · evidence score ${r.score}/100`;
  $("summary").textContent = r.summary || "";
  $("findings").textContent = "";
  for (const f of r.findings || []) $("findings").append(item(f));
  $("findingsH").hidden = !(r.findings || []).length;
  $("history").textContent = "";
  for (const h of r.history || []) $("history").append(el("div", "", h));
  $("reviews").textContent = "";
  if (r.reviews) {
    const a = el("a", "", `${r.reviews.source}: ${r.reviews.score?.toFixed(1)}/5 from ${r.reviews.count.toLocaleString()} reviews`);
    a.href = r.reviews.url; a.target = "_blank"; a.rel = "noreferrer";
    $("reviews").append(a);
    for (const th of r.reviews.themes || []) $("reviews").append(el("div", "", `${th.count} of ${r.reviews.sample} recent reviews: ${th.label}`));
  }
  $("missing").textContent = "";
  for (const m of r.missingChecks || []) $("missing").append(item(m, m.explanation));
  $("missingWrap").hidden = !(r.missingChecks || []).length;
  $("groups").textContent = "";
  for (const g of r.groups || []) {
    const box = el("section"); box.append(el("h3", "", g.label));
    const ul = el("ul");
    for (const s of g.signals) ul.append(item(s, `${s.explanation && s.explanation !== s.label ? s.explanation + " " : ""}${s.source} · ${PROV[s.provenance] || s.provenance} · checked ${ago(s.checkedAt)}${s.effect ? ` · ${s.effect > 0 ? "+" : ""}${s.effect} points` : ""}`));
    box.append(ul); $("groups").append(box);
  }
  $("setup").textContent = "";
  for (const s of r.setup || []) $("setup").append(item(s, s.explanation));
  $("setupWrap").hidden = !(r.setup || []).length;
  $("disclaimer").textContent = r.disclaimer || "TrustCheck cannot guarantee a seller or a transaction.";
  $("fresh").textContent = `Checked ${ago(r.checkedAt)}`;
  $("links").textContent = "";
  for (const l of r.links) {
    const a = el("a", "", l.name); a.href = l.url; a.target = "_blank"; a.rel = "noreferrer";
    $("links").append(a);
  }
}

const ask = (type) => chrome.runtime.sendMessage({ type }).then(render);
$("recheck").onclick = () => { $("main").hidden = true; $("loading").hidden = false; $("loading").textContent = "Re-checking…"; ask("recheck"); };
$("opts").onclick = (e) => { e.preventDefault(); chrome.runtime.openOptionsPage(); };
// Feedback loop: a prefilled GitHub issue the user reviews before posting (nothing is sent automatically).
$("wrong").onclick = (e) => {
  e.preventDefault();
  if (!current) return;
  const title = `Incorrect result: ${current.domain} rated "${current.verdictLabel}"`;
  const body = [`**Domain:** ${current.domain}`, `**Verdict shown:** ${current.verdictLabel} (score ${current.score}, ${current.confidenceLabel} confidence)`,
    `**Extension version:** ${chrome.runtime.getManifest().version}`, "", "**What is wrong with this rating?**", "", "",
    "_Please do not include personal details or order information._"].join("\n");
  chrome.tabs.create({ url: `https://github.com/ansh0079/shieldwall/issues/new?title=${encodeURIComponent(title)}&body=${encodeURIComponent(body)}` });
};
ask("get");

// two-step report: one tap for the outcome, optional tags for what went wrong
for (const b of document.querySelectorAll("#rs1 button")) b.onclick = () => {
  outcome = b.dataset.o;
  if (outcome === "ok") return send();
  $("rs1").hidden = true; $("rs2").hidden = false;
  $("chips").textContent = "";
  for (const [k, label] of Object.entries(TAGS)) {
    const c = document.createElement("button"); c.textContent = label;
    c.onclick = () => { picked.has(k) ? picked.delete(k) : picked.add(k); c.classList.toggle("on"); };
    $("chips").append(c);
  }
};
$("send").onclick = send;
async function send() {
  const res = await chrome.runtime.sendMessage({ type: "submitReport", domain: current.domain, outcome, tags: [...picked] });
  $("rs1").hidden = true; $("rs2").hidden = true; $("rmsg").hidden = false;
  $("rmsg").textContent = res?.ok ? "Thanks - your report helps other shoppers." : "Could not send: " + (res?.error || "unknown error");
}
