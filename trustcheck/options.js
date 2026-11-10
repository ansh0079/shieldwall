const f = { sbKey: document.getElementById("sb"), backend: document.getElementById("be"), chKey: document.getElementById("ch") };
const remInput = document.getElementById("rem");

chrome.storage.local.get({ sbKey: "", backend: "", chKey: "", orderReminders: true }).then((s) => {
  for (const k in f) f[k].value = s[k] || "";
  if (remInput) remInput.checked = s.orderReminders !== false;
});

document.getElementById("save").onclick = async () => {
  const v = Object.fromEntries(Object.entries(f).map(([k, el]) => [k, el.value.trim()]));
  v.orderReminders = remInput ? remInput.checked : true;
  if (v.backend) {
    try {
      const o = new URL(v.backend).origin + "/*";
      if (!(await chrome.permissions.contains({ origins: [o] })))
        await chrome.permissions.request({ origins: [o] }); // needs a user click: we're in one
    } catch { document.getElementById("ok").textContent = "Invalid server URL"; return; }
  }
  await chrome.storage.local.set(v);
  await chrome.storage.local.remove("tpKey");
  const keys = await chrome.storage.local.get(null);
  await chrome.storage.local.remove(Object.keys(keys).filter((k) => k.startsWith("net:")));
  document.getElementById("ok").textContent = "Saved";
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
