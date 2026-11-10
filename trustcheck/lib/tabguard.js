// Per-tab navigation tokens. An analysis may finish after the tab has navigated; its result must then be discarded.
import { sameDocument } from "./url.js";

export class TabGuard {
  constructor() { this.state = new Map(); }
  // Start a new analysis for a tab: supersedes (and aborts) any earlier one.
  begin(tabId, url) {
    this.state.get(tabId)?.ctl.abort();
    const ctl = new AbortController(), gen = (this.state.get(tabId)?.gen || 0) + 1;
    this.state.set(tabId, { gen, ctl });
    return { tabId, gen, url, signal: ctl.signal };
  }
  // The tab started navigating or changed URL: anything in flight is now stale.
  invalidate(tabId) {
    const s = this.state.get(tabId); if (!s) return;
    s.ctl.abort(); this.state.set(tabId, { gen: s.gen + 1, ctl: new AbortController() });
  }
  // currentUrl: the tab's URL right now (omit to skip the URL check).
  isCurrent(token, currentUrl) {
    const s = this.state.get(token.tabId);
    return !!s && s.gen === token.gen && !token.signal.aborted && (currentUrl === undefined || sameDocument(currentUrl, token.url));
  }
  forget(tabId) { this.state.get(tabId)?.ctl.abort(); this.state.delete(tabId); }
}
