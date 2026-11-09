const f = { sbKey: document.getElementById("sb"), tpKey: document.getElementById("tp"), backend: document.getElementById("be"), chKey: document.getElementById("ch"), sbTtlMin: document.getElementById("sbttl") };
chrome.storage.local.get({ sbKey: "", tpKey: "", backend: "", chKey: "", sbTtlMin: 30 }).then((s) => { for (const k in f) f[k].value = s[k]; });
document.getElementById("save").onclick = async () => {
  const v = Object.fromEntries(Object.entries(f).map(([k, el]) => [k, el.value.trim()]));
  v.sbTtlMin = Math.min(1440, Math.max(1, Number(v.sbTtlMin) || 30));
  if (v.backend) {
    try {
      const o = new URL(v.backend).origin + "/*";
      if (!(await chrome.permissions.contains({ origins: [o] })))
        await chrome.permissions.request({ origins: [o] }); // needs a user click: we're in one
    } catch { document.getElementById("ok").textContent = "Invalid server URL"; return; }
  }
  await chrome.storage.local.set(v);
  const keys = await chrome.storage.local.get(null);       // settings changed: drop cached evidence so the new settings apply
  await chrome.storage.local.remove(Object.keys(keys).filter((k) => /^(ev|fail|net|co):/.test(k)));
  document.getElementById("ok").textContent = "Saved";
};
document.getElementById("erase").onclick = async () => {
  const r = await chrome.runtime.sendMessage({ type: "eraseReports" });
  document.getElementById("erased").textContent = r?.ok ? "Done: your reports and identity were deleted." : "Could not delete: " + (r?.error || "unknown error");
};
