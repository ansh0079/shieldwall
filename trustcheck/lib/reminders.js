// Order follow-up reminders: 14-day post-order delivery checks.
// Pure client-side logic with no receipt or buyer identity stored.

export const DAY = 86400000;

export async function hashOrderId(orderId, salt = "tc-order-salt") {
  if (!orderId || typeof orderId !== "string") return null;
  const bytes = new TextEncoder().encode(`${salt}:${orderId.trim()}`);
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 32);
}

export async function createReminder({
  domain,
  amount = null,
  orderId = null,
  orderIdHash = null,
  storefrontName = null,
  now = Date.now()
} = {}) {
  if (!domain || typeof domain !== "string") throw new Error("domain is required");
  const cleanDomain = domain.toLowerCase().trim().replace(/^www\./, "");
  const hash = orderIdHash || (orderId ? await hashOrderId(orderId) : globalThis.crypto.randomUUID().replace(/-/g, "").slice(0, 32));

  return {
    id: "rem:" + globalThis.crypto.randomUUID(),
    domain: cleanDomain,
    amount: amount ? String(amount).slice(0, 32) : null,
    orderIdHash: hash,
    storefrontName: storefrontName ? String(storefrontName).slice(0, 80) : null,
    createdAt: now,
    remindAt: now + 14 * DAY,
    askCount: 0,
    status: "pending" // "pending" | "answered" | "dismissed"
  };
}

export function handleReminderAnswer(reminder, answer, { now = Date.now() } = {}) {
  if (!reminder) throw new Error("reminder is required");

  // "Not yet": asks once more 7 days later, then stops
  if (answer === "not_yet") {
    if (reminder.askCount === 0) {
      return {
        updatedReminder: {
          ...reminder,
          remindAt: now + 7 * DAY,
          askCount: 1,
          shownAt: null,
          status: "pending"
        },
        report: null
      };
    }
    return {
      updatedReminder: {
        ...reminder,
        status: "dismissed",
        dismissedAt: now
      },
      report: null
    };
  }

  // "No" (did not arrive)
  if (answer === "no" || answer === "did_not_arrive") {
    return {
      updatedReminder: {
        ...reminder,
        status: "answered",
        answeredAt: now,
        outcome: "did_not_arrive"
      },
      report: {
        domain: reminder.domain,
        outcome: "never",
        tags: ["delayed"],
        purchaseId: reminder.orderIdHash,
        storefrontName: reminder.storefrontName,
        orderDate: new Date(reminder.createdAt).toISOString(),
        answerDate: new Date(now).toISOString()
      }
    };
  }

  // "Yes - did not match listing"
  if (answer === "yes_unmatched" || answer === "did_not_match") {
    return {
      updatedReminder: {
        ...reminder,
        status: "answered",
        answeredAt: now,
        outcome: "did_not_match"
      },
      report: {
        domain: reminder.domain,
        outcome: "problem",
        tags: ["not_as_described"],
        purchaseId: reminder.orderIdHash,
        storefrontName: reminder.storefrontName,
        orderDate: new Date(reminder.createdAt).toISOString(),
        answerDate: new Date(now).toISOString()
      }
    };
  }

  // "Yes - arrived and matched"
  if (answer === "yes_matched" || answer === "arrived") {
    return {
      updatedReminder: {
        ...reminder,
        status: "answered",
        answeredAt: now,
        outcome: "arrived"
      },
      report: {
        domain: reminder.domain,
        outcome: "ok",
        tags: [],
        purchaseId: reminder.orderIdHash,
        storefrontName: reminder.storefrontName,
        orderDate: new Date(reminder.createdAt).toISOString(),
        answerDate: new Date(now).toISOString()
      }
    };
  }

  throw new Error("unrecognized answer: " + answer);
}
