const f = { sbKey: document.getElementById("sb"), tpKey: document.getElementById("tp"), backend: document.getElementById("be") };
chrome.storage.local.get({ sbKey: "", tpKey: "", backend: "" }).then((s) => { for (const k in f) f[k].value = s[k]; });
document.getElementById("save").onclick = async () => {
  const v = Object.fromEntries(Object.entries(f).map(([k, el]) => [k, el.value.trim()]));
  if (v.backend) {
    try {
      const o = new URL(v.backend).origin + "/*";
      if (!(await chrome.permissions.contains({ origins: [o] })))
        await chrome.permissions.request({ origins: [o] }); // needs a user click: we're in one
    } catch { document.getElementById("ok").textContent = "Invalid server URL"; return; }
  }
  await chrome.storage.local.set(v);
  const keys = await chrome.storage.local.get(null);
  await chrome.storage.local.remove(Object.keys(keys).filter((k) => k.startsWith("net:")));
  document.getElementById("ok").textContent = "Saved";
};
