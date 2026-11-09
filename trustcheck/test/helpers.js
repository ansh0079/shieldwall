// Test helpers: real Response objects so the streaming/size-limit paths are exercised.
export const json = (obj, { status = 200, headers = {} } = {}) =>
  new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json", ...headers } });
export const text = (t, { status = 200, type = "text/plain" } = {}) => new Response(t, { status, headers: { "content-type": type } });
export const withFetch = async (impl, fn) => {
  const real = globalThis.fetch; globalThis.fetch = impl;
  try { return await fn(); } finally { globalThis.fetch = real; }
};
export const regEvent = (iso) => ({ events: [{ eventAction: "registration", eventDate: iso }] });
