document.getElementById("doneBtn").addEventListener("click", () => window.close());
document.getElementById("openOptions").addEventListener("click", () => {
  chrome.runtime.openOptionsPage();
});
document.getElementById("privacyLink").href = chrome.runtime.getURL("privacy.html");
