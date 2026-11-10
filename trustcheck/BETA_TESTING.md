# TrustCheck beta testing

Works in **Chrome, Edge and Brave** (desktop). Not Firefox yet, and not on phones.

## 1. Install (5 minutes, no coding)
1. Get the build, using either option:
   - **From GitHub:** open the repository's **Actions** tab, open the newest green run of **CI** on the beta branch, scroll to **Artifacts**,
     download **trustcheck-extension**, and unzip it twice (GitHub wraps the zip in another zip). You end up with a folder that contains `manifest.json`.
   - **From a checkout:** `cd trustcheck && npm run package`, then unzip `dist/trustcheck-<version>.zip` into a folder.
2. Open `chrome://extensions` (Edge: `edge://extensions`), switch on **Developer mode** (top right), click **Load unpacked**, and pick that folder.
3. Pin it: click the puzzle-piece icon in the toolbar, then the pin next to TrustCheck.
4. If you already had an older TrustCheck loaded, remove it first.

**Updating:** download the new build, replace the folder's contents, then click the circular **reload** arrow on TrustCheck's card in
`chrome://extensions`. Refresh any open shop tabs afterwards. Tabs left open from before an update show "refresh this page".

## 2. Optional: connect more checks (Options page)
Without keys, TrustCheck runs its page checks plus domain age and site history. Every key below is free or optional:
- **Google Safe Browsing**: in Google Cloud Console, enable the "Safe Browsing API" and create an API key. This is the most valuable one.
- **Companies House**: free at developer.company-information.service.gov.uk (only useful for UK shops).
- **Trustpilot**: needs a business API key. Skip it unless you have one.
- **Buyer-report server**: skip it for the beta unless you are running the server (see `server/DEPLOY.md`).

## 3. What to test (about 20 minutes)
Tick each item as you go. Anything surprising is worth reporting.

**Everyday shops** (well-known retailers you already use)
- [ ] The badge appears top-right within a few seconds, opens briefly, then collapses. Hovering re-opens it.
- [ ] The verdict feels fair. Big, old shops should not be "Caution" for silly reasons.
- [ ] The toolbar icon shows the same score. Clicking it opens the full report: findings, evidence, "Not checked".
- [ ] Navigating between pages of the same shop doesn't flicker to a different shop's result.

**Small or unfamiliar shops** (Instagram/TikTok ad shops, marketplace links, brand-new stores)
- [ ] The "Domain registered" and "First seen online" dates are right. You can compare them with a WHOIS site.
- [ ] Low-evidence shops say **Limited evidence** rather than pretending to be safe.
- [ ] The reasons listed match what you can see on the page (missing returns policy, urgency banners, and so on).

**Search results** (Google Shopping, a Google search for a product)
- [ ] Hovering a result shows a quick rating card for that shop, and the card goes away when you move off.
- [ ] The search page itself gets no rating badge.

**Controls**
- [ ] × hides the badge for that page only. "Don't show this badge on this site for 30 days" keeps it hidden after a reload.
- [ ] Options → badge mode **quiet**: the badge appears but never opens on its own. **Toolbar only**: no badge on pages at all.
- [ ] Options → "Show the badge again on all sites" brings muted sites back.
- [ ] Options → turning off Domain age or Site history makes the popup say that check is "turned off", not "unavailable".
- [ ] Options → typing an `http://` server URL is refused with a clear message.

**Keyboard** (try it once)
- [ ] Pressing Tab after the page's own links reaches the badge, and Enter opens and closes it.

**The checkout warning** is shown only when a shop is rated *Dangerous* or *High risk* **and** you are on a payment page. It is hard to trigger
safely on purpose, so don't visit known scam sites to test it. If you ever see it, report whether it was right.

## 4. Reporting what you find
- **Wrong rating:** open the toolbar popup and choose **"Report an incorrect result"**. It opens a pre-filled GitHub issue with the domain,
  verdict and version. Add a sentence about what's wrong and check the text before posting. Don't include order numbers or personal details.
- **Bugs and ideas:** open a GitHub issue that says what you did, what you expected, what happened, and the version
  (shown in `chrome://extensions`). A screenshot helps a lot.
- **If something breaks completely:** in `chrome://extensions`, click **service worker** on TrustCheck's card and copy any red errors into the issue.

## 5. What it sends (so testers know)
Domain age: the shop's domain name goes to rdap.org. Site history: the domain name goes to web.archive.org. Both can be turned off.
Safe Browsing, Companies House and Trustpilot are used only if you add a key. No browsing history, account data or personal details are
collected, and nothing is sent to us.

## Known limitations in this beta
- The ratings are evidence about a shop, not a guarantee. The scoring rules were tested on synthetic cases, and this beta is the first real-world check.
- Without a report server there are no buyer reports, so that section stays empty.
- Chromium browsers only. A Firefox build is not done yet.
