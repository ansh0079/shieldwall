import { TAGS } from "./lib/buyers.js";
const $ = (id) => document.getElementById(id);
let current = null, outcome = null; const picked = new Set();
const LABEL = { trusted: "Looks trustworthy", caution: "Proceed with caution", risky: "High risk", unverified: "Unverified shop" };

function render(r) {
  $("loading").hidden = true;
  if (!r) { $("loading").hidden = false; $("loading").textContent = "Open a website to check it."; return; }
  if (r.neutral) { $("loading").hidden = false; $("loading").textContent = "This is a search page, not a shop. Open a shop's own page to see its rating."; return; }
  current = r;
  $("main").hidden = false;
  $("report").hidden = false;
  if (!r.backendOn) { $("rs1").hidden = true; $("rs2").hidden = true; $("rmsg").hidden = false; $("rmsg").textContent = "Set a report server in Options to share and see buyer reports."; }
  $("ring").className = r.verdict; $("ring").textContent = r.verdict === "unverified" ? "?" : r.score;
  $("verdict").textContent = LABEL[r.verdict]; $("domain").textContent = r.domain;
  $("history").textContent = "";
  for (const h of r.history || []) { const d = document.createElement("div"); d.textContent = h; $("history").append(d); }
  $("reviews").textContent = "";
  if (r.merchantRating) {
    const d = document.createElement("div"); d.className = "claimed";
    d.textContent = `Merchant-published rating: ${r.merchantRating.value}/${r.merchantRating.best} from ${r.merchantRating.count.toLocaleString()} ratings (not independently verified)`;
    $("reviews").append(d);
  }
  if (r.reviews) {
    const a = document.createElement("a");
    a.href = r.reviews.url; a.target = "_blank"; a.rel = "noreferrer";
    a.textContent = `${r.reviews.source}: ${r.reviews.score?.toFixed(1)}/5 from ${r.reviews.count.toLocaleString()} reviews`;
    $("reviews").append(a);
    for (const th of r.reviews.themes || []) {
      const d = document.createElement("div");
      d.textContent = `${th.count} of ${r.reviews.sample} recent reviews: ${th.label}`;
      $("reviews").append(d);
    }
  }
  const tp = document.createElement("a");
  tp.href = `https://www.trustpilot.com/review/${encodeURIComponent(r.domain)}`; tp.target = "_blank"; tp.rel = "noreferrer";
  tp.textContent = `View ${r.domain} on Trustpilot ↗`; tp.className = "trustpilot"; $("reviews").append(tp);
  $("proof").textContent = r.purchase && !r.purchase.reported
    ? `TrustCheck observed an order confirmation on ${new Date(r.purchase.at).toLocaleDateString()}. No receipt details were saved.`
    : "This will be marked as an unverified buyer report.";
  $("signals").textContent = "";
  for (const s of r.signals) {
    const li = document.createElement("li"); li.className = s.status;
    const dot = document.createElement("i"), d = document.createElement("div");
    d.textContent = s.label;
    const sm = document.createElement("small"); sm.textContent = s.detail || ""; d.append(sm);
    li.append(dot, d); $("signals").append(li);
  }
  $("links").textContent = "";
  for (const l of r.links.filter((x) => x.name !== "Trustpilot")) {
    const a = document.createElement("a"); a.href = l.url; a.target = "_blank"; a.rel = "noreferrer"; a.textContent = l.name;
    $("links").append(a);
  }
}

const ask = (type) => chrome.runtime.sendMessage({ type }).then(render);
$("recheck").onclick = () => { $("main").hidden = true; $("loading").hidden = false; $("loading").textContent = "Re-checking…"; ask("recheck"); };
$("opts").onclick = (e) => { e.preventDefault(); chrome.runtime.openOptionsPage(); };
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
  const res = await chrome.runtime.sendMessage({ type: "submitReport", domain: current.domain, outcome, tags: [...picked], purchaseId: current.purchase?.id || null });
  $("rs1").hidden = true; $("rs2").hidden = true; $("rmsg").hidden = false;
  $("rmsg").textContent = res?.ok ? "Thanks - your report helps other shoppers." : "Could not send: " + (res?.error || "unknown error");
}
