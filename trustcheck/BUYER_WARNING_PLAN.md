# Buyer warning plan

The product is a warning the buyer sees before they pay a bad shop, then a short question two weeks later that records whether the order arrived. Payment companies get a feed only after that record holds many orders.

Worked example: `koadclo.com`, ASICS Gel-Kayano 31, £59.99, paid with PayPal to IDJ GROUP LLC. Trustpilot for that shop was 2.0 / 5 from 78 reviews, with months of reports that orders never arrived and that buyers were charged again. The buyer has said they would not have paid if they had seen that page first.

This plan does not change QuietBrowse.

## Where we are

TrustCheck 0.2.0 already does most of the surrounding work.

| Already built | What it does today | Why this order still goes through |
|---|---|---|
| Trustpilot lookup | Score, review count, and complaint themes (non-delivery, refund, scam) when an API key is set | The key is the buyer's. With no key, the check does not run |
| Trustpilot link | `https://www.trustpilot.com/review/{domain}` is the first research link | The checkout notice never opens for this case, so the buyer never sees the link |
| Checkout notice | Full-page dialog on a payment page, with reasons and "Go back to safety" | It opens only for **High risk** or **Dangerous** |
| Poor Trustpilot score | Score under 3 with at least 5 reviews is one strong warning | One strong warning is **Caution**. Caution does not open the notice |
| Buyer reports | Server stores outcomes and resists coordinated spam | Reports are unverified, cover 30 days, have no score effect, and the buyer has to go looking for the form |
| Order follow-up | Not built | No `alarms` or `notifications` permission. Nothing is stored when an order is confirmed |

A 2.0 Trustpilot score on its own leaves the verdict at Caution. The PayPal button still works, and the buyer is not shown the review page.

The PayPal legal name (IDJ GROUP LLC) is on the receipt and sometimes on the PayPal sheet. It is usually absent from the shop page, so the first warning does not depend on it.

## What this plan does not include

- A consumer subscription, a Pro tier, or a price.
- A badge a merchant can buy or display.
- The twelve-week commercialization plan (Stripe, merchant dashboards, SEO pages, Companies House as the product).
- Changing QuietBrowse, or mixing its ad-block stats into this warning.

## Step 1. Show the Trustpilot warning before payment

On a checkout page, a poor Trustpilot rating opens the existing full-page notice. The notice states the score and the recent complaint, and it links straight to that shop's Trustpilot page.

For the example order the notice says:

- Trustpilot 2.0 / 5 from 78 reviews.
- Recent reviews report orders that never arrived, and at least one extra charge.
- One link, labelled with the shop: [Trustpilot reviews for koadclo.com](https://www.trustpilot.com/review/koadclo.com).

Rules:

- Open the notice when Trustpilot is under 3.0 and has at least 5 reviews, even if the verdict is only Caution. Do not open it for every Caution (a price anomaly or a young domain alone stays as it is).
- The link is the shop's own review page, not a generic "check reviews" search. Show the link even when the score could not be loaded.
- Keep the existing choice: go back, or continue and suppress the same shop for 24 hours.
- Keep the existing disclaimer. The notice reports evidence. It does not guarantee the seller.

The score and the six-month complaint line need Trustpilot's API. Buyers should not paste an API key. Put one Trustpilot key on the existing report server and have the extension ask that server for the public summary (score, count, theme counts, review URL). The key never ships inside the extension. If the server is down, the notice still shows the link.

Done when a replay of the Koadclo checkout, with that Trustpilot summary, opens the notice before the PayPal button is used, and the link opens `https://www.trustpilot.com/review/koadclo.com`.

## Step 2. Ask once, fourteen days after the order confirmation

When the extension sees an order-confirmation page (a Shopify thank-you page, `/thank_you`, `/orders/`, or the return page from PayPal, Klarna, or a card checkout), it stores a reminder on that computer.

Stored locally:

- shop domain
- date
- amount, if it is visible
- a hash of the order id, if one is visible

Not stored and not sent: name, email, address, card, or PayPal account.

Fourteen days later a browser notification asks two questions:

1. Did your order from this shop arrive? Yes / No / Not yet.
2. If it arrived: did it match the listing? Yes / No.

"Not yet" asks once more seven days later, then stops. Any other answer is sent once, as the outcome only, through the existing report server. The buyer can turn reminders off in Options.

This needs the `alarms` and `notifications` permissions. Nothing else messages the buyer. There is no email and no account.

Done when a confirmation page creates one local reminder, the notification fires at day 14, and a "no" answer is stored as "did not arrive" for that domain with no personal data in the payload.

## Step 3. Use those answers on the next buyer's warning

Once enough buyers have answered, the same checkout notice adds a second sentence:

> In the last 6 months, N TrustCheck buyers reported this shop did not deliver.

Rules:

- The window is 6 months, not the current 30 days.
- The sentence appears only after the server's existing display threshold is met, so a handful of replies cannot brand a shop.
- Until that threshold is met, the notice cites Trustpilot only.
- A reply counts only when this extension saw that buyer's order-confirmation page and the buyer answered the reminder. It is stronger than a form filled in from a cold visit, and it is still the buyer's own word. Keep the server's per-network caps.
- "Did not match the listing" is a separate count, shown only when it also clears the threshold.
- Crossing the threshold opens the checkout notice on its own, the same way a poor Trustpilot score does in step 1.

Done when a shop with enough "did not arrive" answers shows the six-month sentence and the Trustpilot link on the next checkout, and a shop under the threshold does not.

## Step 4. Offer the log to a payment company after it holds many orders

Do not approach PayPal, Klarna, or a smaller payment processor with one missed pair of shoes. Approach them when the log has many completed orders across many shops, each row collected the same way.

Each row:

| Field | Example |
|---|---|
| Shop domain | `koadclo.com` |
| Storefront name | KOAD'CLO, when the page shows it |
| Receiver name | IDJ GROUP LLC, only when the PayPal or Klarna sheet actually shows it |
| Trustpilot page and score that day | 2.0 / 5, 78 reviews, URL |
| Outcome | arrived, did not arrive, or did not match the listing |
| Date of the order and date of the answer | |

The receiver name is a later addition inside this step. The shop page usually does not contain it. Read it only from the payment sheet the buyer is already looking at, and store the name, not the buyer's account.

The pitch is the table, not a prediction: shops with a poor Trustpilot page and a high share of "did not arrive" answers. The payment company already has the merchant. This log says what happened after the payment.

Done when the export is aggregate rows with no buyer identity, and it is not offered until the order count is large enough to be useful to a processor.

## Order of work

1. Step 1, including the server-side Trustpilot summary, so the Koadclo case is warned before payment.
2. Step 2, so answers start accumulating from real orders.
3. Step 3, once the display threshold can be met with real replies.
4. Step 4, once the log covers many shops. The receiver-name field is part of this step, not of the first warning.

## Privacy

- The reminder lives on the buyer's computer until they answer.
- The server receives the shop domain, the outcome, and the time. It does not receive who the buyer is.
- The Trustpilot key stays on the server.
- Reminders are off if the buyer turns them off, and a single order produces at most two notifications.
