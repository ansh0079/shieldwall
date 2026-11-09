const sb = document.getElementById("sb"), tp = document.getElementById("tp");
chrome.storage.local.get({ sbKey: "", tpKey: "" }).then((s) => { sb.value = s.sbKey; tp.value = s.tpKey; });
document.getElementById("save").onclick = async () => {
  await chrome.storage.local.set({ sbKey: sb.value.trim(), tpKey: tp.value.trim() });
  const keys = await chrome.storage.local.get(null);
  await chrome.storage.local.remove(Object.keys(keys).filter((k) => k.startsWith("net:")));
  document.getElementById("ok").textContent = "Saved";
};
