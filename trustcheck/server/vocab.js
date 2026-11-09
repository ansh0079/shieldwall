// Pure shared definitions (no database), so tests and tools can import them on any Node version.
export const OUTCOMES = ["ok", "problem", "never"];
export const TAGS = ["delayed", "wrong_item", "fake_tracking", "missing_items", "not_as_described", "poor_quality",
  "counterfeit", "damaged", "refund_refused", "unresponsive", "hidden_fees", "charged_no_confirmation", "card_misuse"];
export class ApiError extends Error { constructor(status, message) { super(message); this.status = status; } }
export function cleanDomain(d) {
  d = String(d || "").toLowerCase().trim();
  return /^[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?$/.test(d) && !/^\d+(\.\d+){3}$/.test(d) ? d : null;
}
