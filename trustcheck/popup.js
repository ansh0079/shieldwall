const $ = (id) => document.getElementById(id);
const LABEL = { trusted: "Looks trustworthy", caution: "Proceed with caution", risky: "High risk" };

function render(r) {
  $("loading").hidden = true;
  if (!r) { $("loading").hidden = false; $("loading").textContent = "Open a website to check it."; return; }
  $("main").hidden = false;
  $("ring").className = r.verdict; $("ring").textContent = r.score;
  $("verdict").textContent = LABEL[r.verdict]; $("domain").textContent = r.domain;
  $("reviews").textContent = "";
  if (r.reviews) {
    const a = document.createElement("a");
    a.href = r.reviews.url; a.target = "_blank"; a.rel = "noreferrer";
    a.textContent = `${r.reviews.source}: ${r.reviews.score?.toFixed(1)}/5 from ${r.reviews.count.toLocaleString()} reviews`;
    $("reviews").append(a);
  }
  $("signals").textContent = "";
  for (const s of r.signals) {
    const li = document.createElement("li"); li.className = s.status;
    const dot = document.createElement("i"), d = document.createElement("div");
    d.textContent = s.label;
    const sm = document.createElement("small"); sm.textContent = s.detail || ""; d.append(sm);
    li.append(dot, d); $("signals").append(li);
  }
  $("links").textContent = "";
  for (const l of r.links) {
    const a = document.createElement("a"); a.href = l.url; a.target = "_blank"; a.rel = "noreferrer"; a.textContent = l.name;
    $("links").append(a);
  }
}

const ask = (type) => chrome.runtime.sendMessage({ type }).then(render);
$("recheck").onclick = () => { $("main").hidden = true; $("loading").hidden = false; $("loading").textContent = "Re-checking…"; ask("recheck"); };
$("opts").onclick = (e) => { e.preventDefault(); chrome.runtime.openOptionsPage(); };
ask("get");
