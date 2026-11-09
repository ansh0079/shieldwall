// Server-side fetch used only to verify merchant ownership files. Public host names only, no redirects, tiny responses.
export async function safeFetchText(url) {
  const u = new URL(url);
  if (u.protocol !== "https:" || !/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(u.hostname) || /(^|\.)(localhost|local|internal|lan)$/i.test(u.hostname)) throw new Error("host not allowed");
  const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), 5000);
  try {
    const res = await fetch(url, { redirect: "error", signal: ctl.signal });
    if (!res.ok) throw new Error("HTTP " + res.status);
    const text = await res.text();
    if (text.length > 512) throw new Error("file too large");
    return text;
  } finally { clearTimeout(timer); }
}
