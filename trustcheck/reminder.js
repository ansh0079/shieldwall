const params = new URLSearchParams(location.search);
const id = params.get("id") || "";
const shop = document.getElementById("shop");
const answers = document.getElementById("answers");
const status = document.getElementById("status");

chrome.storage.local.get({ reminders: [] }).then(({ reminders }) => {
  const reminder = reminders.find((item) => item.id === id);
  if (!reminder || reminder.status !== "pending") {
    shop.textContent = "This reminder has already been answered or is no longer available.";
    return;
  }
  shop.textContent = `Order from ${reminder.domain}${reminder.amount ? ` (${reminder.amount})` : ""}`;
  answers.hidden = false;
  if (reminder.askCount > 0) answers.querySelector('[data-answer="not_yet"]').textContent = "Still not here — stop reminders";
});

answers.addEventListener("click", async (event) => {
  const button = event.target.closest("button[data-answer]");
  if (!button) return;
  for (const item of answers.querySelectorAll("button")) item.disabled = true;
  const result = await chrome.runtime.sendMessage({ type: "answerReminder", id, answer: button.dataset.answer });
  if (result?.ok) {
    status.textContent = button.dataset.answer === "not_yet" ? "Saved." : "Thank you. Your outcome helps other shoppers.";
    answers.hidden = true;
  } else {
    status.textContent = result?.error || "Could not save this answer.";
    for (const item of answers.querySelectorAll("button")) item.disabled = false;
  }
});
