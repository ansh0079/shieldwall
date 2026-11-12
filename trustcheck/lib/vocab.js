// Shared vocabulary for buyer reports (client + server agree on these).
export const OUTCOMES = ["ok", "problem", "never"];
export const TAGS = {
  delayed: "order delayed",
  wrong_item: "wrong item received",
  fake_tracking: "tracking never updated / not genuine",
  missing_items: "items missing from order",
  not_as_described: "item not as described",
  poor_quality: "poor quality",
  counterfeit: "counterfeit or fake goods",
  damaged: "item arrived damaged",
  refund_refused: "refund refused",
  unresponsive: "seller unresponsive",
  hidden_fees: "hidden fees or extra charges",
  charged_no_confirmation: "charged but no order confirmation",
  card_misuse: "card or account misused afterwards"
};
