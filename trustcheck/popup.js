import { TAGS } from "./lib/buyers.js";

const $ = (id) => document.getElementById(id);
let current = null, outcome = null;
const picked = new Set();
const LABEL = {
  trusted: "Lower risk indicators",
  caution: "Proceed with caution",
  risky: "High risk",
  unverified: "Unverified shop"
};

function buildTimeline(r) {
  const container = $("timeline");
  container.textContent = "";
  const events = [];

  if (r.registered) {
    const d = new Date(r.registered);
    const dateStr = !isNaN(d.getTime()) ? d.toLocaleDateString("en-US", { month: "short", year: "numeric" }) : r.registered.slice(0, 7);
    events.push({
      date: dateStr,
      title: "Domain Registered",
      sub: (r.history || []).find((h) => h.includes("Domain registered")) || `Registered in ${dateStr}`,
      status: "good"
    });
  }

  if (r.archived) {
    const d = new Date(r.archived);
    const dateStr = !isNaN(d.getTime()) ? d.toLocaleDateString("en-US", { month: "short", year: "numeric" }) : r.archived.slice(0, 7);
    events.push({
      date: dateStr,
      title: "First Seen Online",
      sub: (r.history || []).find((h) => h.includes("First seen online")) || `Archived in ${dateStr}`,
      status: "good"
    });
  }

  const coSig = (r.signals || []).find((s) => s.id === "company");
  if (coSig) {
    events.push({
      date: "Registry",
      title: "Corporate Identity",
      sub: coSig.label,
      status: coSig.status
    });
  }

  const sbSig = (r.signals || []).find((s) => s.id === "sb");
  if (sbSig) {
    events.push({
      date: "Security",
      title: "Safe Browsing Check",
      sub: sbSig.label,
      status: sbSig.status
    });
  }

  if (!events.length) {
    for (const h of r.history || []) {
      events.push({ date: "History", title: h, sub: "", status: "good" });
    }
  }

  if (!events.length) {
    const none = document.createElement("div");
    none.className = "timeline-event";
    none.innerHTML = '<div class="timeline-title">No historical archive or registry record found</div><div class="timeline-sub">This site may be newly created or private</div>';
    container.append(none);
    return;
  }

  for (const ev of events) {
    const div = document.createElement("div");
    div.className = `timeline-event ${ev.status}`;
    const t = document.createElement("div");
    t.className = "timeline-title";
    t.textContent = `${ev.title} (${ev.date})`;
    div.append(t);
    if (ev.sub) {
      const s = document.createElement("div");
      s.className = "timeline-sub";
      s.textContent = ev.sub;
      div.append(s);
    }
    container.append(div);
  }
}

function render(r) {
  $("loading").hidden = true;
  if (!r) {
    $("loading").hidden = false;
    $("loading").textContent = "Open a retail shopping site to see its seller check.";
    return;
  }
  if (r.neutral) {
    $("loading").hidden = false;
    $("loading").textContent = "This is a search page, not a shop. Open a shop's own page to see its rating.";
    return;
  }
  current = r;
  $("main").hidden = false;
  $("report").hidden = false;

  if (!r.backendOn) {
    $("rs1").hidden = true;
    $("rmsg").hidden = false;
    $("rmsg").textContent = "Start the local report server or set a report server in Options to share buyer feedback.";
  }

  $("ring").className = r.verdict;
  $("ring").textContent = r.verdict === "unverified" ? "?" : r.score;
  $("verdict").textContent = r.verdictLabel || LABEL[r.verdict];
  $("domain").textContent = r.domain;

  // Confidence pill
  const conf = r.confidence || "low";
  $("confPill").textContent = `${conf} confidence`;
  $("confPill").className = `conf-pill conf-${conf}`;

  // Summary card
  $("summaryBox").textContent = r.summary || "Real-time e-commerce trust and safety check.";
  const checked = r.analysis?.checkedCount ?? 0;
  const totalChecks = r.analysis?.totalChecks ?? 0;
  const checkedAt = new Date(r.checkedAt || Date.now()).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  $("analysisMeta").textContent = totalChecks
    ? `${checked} of ${totalChecks} evidence areas checked · Viewed ${checkedAt}`
    : `Viewed ${checkedAt}`;

  const outcomes = r.outcomeSummary;
  if (outcomes?.total > 0) {
    $("outcomes").hidden = false;
    $("outcomeStats").textContent = "";
    const items = [
      ["Delivered", outcomes.delivered, outcomes.deliveredPercent, "good"],
      ["Not delivered", outcomes.nonDelivery, outcomes.nonDeliveryPercent, "bad"],
      ["Did not match", outcomes.notMatched, outcomes.notMatchedPercent, "warn"],
      ["Other problems", outcomes.otherProblems, outcomes.otherProblemsPercent, "warn"]
    ];
    for (const [label, count, percent, status] of items) {
      const item = document.createElement("div");
      item.className = `outcome ${status}`;
      const value = document.createElement("b"); value.textContent = `${percent}%`;
      const name = document.createElement("span"); name.textContent = `${label} (${count})`;
      item.append(value, name); $("outcomeStats").append(item);
    }
    $("outcomeNote").textContent = `${outcomes.total} outcomes followed an order confirmation observed by BeforeYouBuy. Small samples may be unrepresentative.`;
  } else {
    $("outcomes").hidden = true;
  }

  // Visual timeline
  buildTimeline(r);

  // Reviews & Merchant-published aggregate ratings
  $("reviews").textContent = "";
  if (r.merchantRating) {
    const d = document.createElement("div");
    d.className = "claimed";
    d.textContent = `Merchant-published rating: ${r.merchantRating.value}/${r.merchantRating.best} from ${r.merchantRating.count.toLocaleString()} ratings (not independently verified)`;
    $("reviews").append(d);
  }
  if (r.reviews) {
    const a = document.createElement("a");
    a.href = r.reviews.url;
    a.target = "_blank";
    a.rel = "noreferrer";
    const hasRating = Number.isFinite(r.reviews.score) && Number.isFinite(r.reviews.count);
    a.textContent = hasRating
      ? `${r.reviews.source}: ${r.reviews.score.toFixed(1)}/5 from ${r.reviews.count.toLocaleString()} reviews`
      : `View ${r.domain} on ${r.reviews.source || "Trustpilot"} ↗`;
    $("reviews").append(a);
    for (const th of r.reviews.themes || []) {
      const d = document.createElement("div");
      d.textContent = `${th.count} of ${r.reviews.sample} recent reviews: ${th.label}`;
      $("reviews").append(d);
    }
  }

  if (!r.reviews?.url) {
    const tp = document.createElement("a");
    tp.href = `https://www.trustpilot.com/review/${encodeURIComponent(r.domain)}`;
    tp.target = "_blank";
    tp.rel = "noreferrer";
    tp.textContent = `View ${r.domain} on Trustpilot ↗`;
    tp.className = "trustpilot";
    $("reviews").append(tp);
  }
  const votes = r.buyerOutcomes;
  $("buyerVotes").hidden = !votes;
  if (votes) $("buyerVotes").textContent = `BeforeYouBuy buyers (last 30 days): ${votes.ok} good experience, ${votes.problem} problem, ${votes.never} never arrived. ${r.buyerTotal} reports; self-reported unless marked confirmation-observed.`;

  $("proof").textContent = r.purchase && !r.purchase.reported
    ? `BeforeYouBuy observed an order confirmation on ${new Date(r.purchase.at).toLocaleDateString()}. The date and optional order amount stay on this device.`
    : "This will be marked as an unverified community report.";

  // Key Findings vs Optional Configuration notices
  $("signals").textContent = "";
  $("setupSignals").textContent = "";
  let setupCount = 0;

  for (const s of r.signals || []) {
    const isSetup = s.id.endsWith("-off");
    const li = document.createElement("li");
    li.className = s.status;
    const dot = document.createElement("i");
    const d = document.createElement("div");
    d.textContent = s.label;
    if (s.detail) {
      const sm = document.createElement("small");
      sm.textContent = s.detail;
      d.append(sm);
    }
    li.append(dot, d);

    if (isSetup) {
      setupCount++;
      $("setupSignals").append(li);
    } else {
      $("signals").append(li);
    }
  }

  if (setupCount > 0) {
    $("setupDetails").hidden = false;
    $("setupSummary").textContent = `Optional Provider Integrations (${setupCount} not connected)`;
  } else {
    $("setupDetails").hidden = true;
  }

  // Independent review links
  $("links").textContent = "";
  for (const l of (r.links || []).filter((x) => x.name !== "Trustpilot")) {
    const a = document.createElement("a");
    a.href = l.url;
    a.target = "_blank";
    a.rel = "noreferrer";
    a.textContent = l.name;
    $("links").append(a);
  }
}

const ask = (type) => chrome.runtime.sendMessage({ type }).then(render);
$("recheck").onclick = () => {
  $("main").hidden = true;
  $("loading").hidden = false;
  $("loading").textContent = "Re-checking…";
  ask("recheck");
};
$("opts").onclick = (e) => {
  e.preventDefault();
  chrome.runtime.openOptionsPage();
};
ask("get");

// One-click buyer reporting; issue tags can be selected beforehand.
for (const [k, label] of Object.entries(TAGS)) {
  const c = document.createElement("button");
  c.type = "button";
  c.textContent = label;
  c.onclick = () => {
    picked.has(k) ? picked.delete(k) : picked.add(k);
    c.classList.toggle("on");
  };
  $("chips").append(c);
}
for (const b of document.querySelectorAll("#rs1 button[data-o]")) {
  b.onclick = () => {
    outcome = b.dataset.o;
    send();
  };
}

async function send() {
  if (!current || !outcome || $("rs1").dataset.sending === "true") return;
  $("rs1").dataset.sending = "true";
  for (const button of $("rs1").querySelectorAll("button[data-o]")) button.disabled = true;
  const purchaseId = current?.purchase && !current.purchase.reported ? current.purchase.id : null;
  try {
    const res = await chrome.runtime.sendMessage({
      type: "submitReport",
      domain: current.domain,
      outcome,
      tags: [...picked],
      details: $("reportDetails").value.trim(),
      purchaseId
    });
    if (res?.ok) $("rs1").hidden = true;
    $("rmsg").hidden = false;
    $("rmsg").textContent = res?.ok ? "Thanks — your feedback helps other shoppers." : "Could not send: " + (res?.error || "unknown error");
  } catch (error) {
    $("rmsg").hidden = false;
    $("rmsg").textContent = "Could not send: " + (error?.message || "connection error");
  } finally {
    $("rs1").dataset.sending = "false";
    for (const button of $("rs1").querySelectorAll("button[data-o]")) button.disabled = false;
  }
}
