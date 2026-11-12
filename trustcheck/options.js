import { backendUrlError } from "./lib/validate.js";
import { DEFAULT_SETTINGS } from "./lib/settings.js";

const f = { sbKey: document.getElementById("sb"), tpKey: document.getElementById("tp"), backend: document.getElementById("be"), chKey: document.getElementById("ch"),
  sbTtlMin: document.getElementById("sbttl"), useRdap: document.getElementById("useRdap"), useArchive: document.getElementById("useArchive"), badgeMode: document.getElementById("badge"), orderReminders: document.getElementById("rem") };
const isBox = (el) => el.type === "checkbox";
chrome.storage.local.get(DEFAULT_SETTINGS).then((s) => { for (const k in f) isBox(f[k]) ? (f[k].checked = !!s[k]) : (f[k].value = s[k]); });

document.getElementById("save").onclick = async () => {
  const ok = document.getElementById("ok");
  const v = Object.fromEntries(Object.entries(f).map(([k, el]) => [k, isBox(el) ? el.checked : el.value.trim()]));
  v.sbTtlMin = Math.min(1440, Math.max(1, Number(v.sbTtlMin) || 30));
  const bad = backendUrlError(v.backend);
  if (bad) { ok.textContent = bad; return; }
  if (v.backend) {
    try {
      const o = new URL(v.backend).origin + "/*";
      if (!(await chrome.permissions.contains({ origins: [o] })))
        await chrome.permissions.request({ origins: [o] }); // needs a user click: we're in one
    } catch { ok.textContent = "Invalid server URL"; return; }
  }
  await chrome.storage.local.set(v);
  const keys = await chrome.storage.local.get(null);       // settings changed: drop cached evidence so the new settings apply
  await chrome.storage.local.remove(Object.keys(keys).filter((k) => /^(ev|fail|net|co):/.test(k)));
  ok.textContent = "Saved";
};

document.getElementById("clear").onclick = async () => {
  const keys = Object.keys(await chrome.storage.local.get(null)).filter((k) => /^(ev|fail|net|co):/.test(k));
  await chrome.storage.local.remove(keys);
  document.getElementById("cleared").textContent = `Done: ${keys.length} cached result${keys.length === 1 ? "" : "s"} removed.`;
};

document.getElementById("unhide").onclick = async () => {
  const keys = Object.keys(await chrome.storage.local.get(null)).filter((k) => k.startsWith("hide:"));
  await chrome.storage.local.remove(keys);
  document.getElementById("unhidden").textContent = keys.length ? `Done: the badge will show again on ${keys.length} site${keys.length === 1 ? "" : "s"}.` : "No hidden sites.";
};

document.getElementById("erase").onclick = async () => {
  const r = await chrome.runtime.sendMessage({ type: "eraseReports" });
  document.getElementById("erased").textContent = r?.ok ? "Done: your reports and identity were deleted." : "Could not delete: " + (r?.error || "unknown error");
};

const testBtn = document.getElementById("testNotif");
if (testBtn) {
  testBtn.onclick = async () => {
    try {
      chrome.runtime.sendMessage({ type: "testReminder" }, (res) => {
        document.getElementById("ok").textContent = res?.ok ? "Notification sent!" : (res?.error || "Check notifications permission");
      });
    } catch (e) {
      document.getElementById("ok").textContent = e.message;
    }
  };
}
