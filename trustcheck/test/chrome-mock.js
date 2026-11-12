// Minimal chrome.* mock so the real background.js runs under Node.
export function makeChrome() {
  const local = new Map(), session = new Map(), L = {}, sent = [], badges = [], tabUrls = new Map();
  const area = (m) => ({
    get: async (k) => {
      if (k === null) return Object.fromEntries(m);
      if (typeof k === "string") return m.has(k) ? { [k]: m.get(k) } : {};
      const out = {}; for (const [key, def] of Object.entries(k)) out[key] = m.has(key) ? m.get(key) : def; return out;
    },
    set: async (o) => { for (const [k, v] of Object.entries(o)) m.set(k, v); },
    remove: async (ks) => { [].concat(ks).forEach((k) => m.delete(k)); }
  });
  return {
    sent, badges, tabUrls, L,
    storage: { local: area(local), session: area(session) },
    tabs: {
      onUpdated: { addListener: (f) => { L.updated = f; } }, onRemoved: { addListener: (f) => { L.removed = f; } },
      get: async (id) => (tabUrls.has(id) ? { id, url: tabUrls.get(id) } : Promise.reject(new Error("No tab"))),
      sendMessage: async (id, msg) => { sent.push([id, msg]); }, query: async () => []
    },
    action: { setBadgeText: async (o) => { badges.push(o); }, setBadgeBackgroundColor: async () => {} },
    runtime: { onMessage: { addListener: (f) => { L.message = f; } } }
  };
}

