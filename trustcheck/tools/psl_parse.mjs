// Parses publicsuffix.org's public_suffix_list.dat into section-aware rule sets (all ASCII/punycode).
// The list is licensed MPL-2.0: https://publicsuffix.org/
const toAscii = (s) => /^[\x00-\x7f]*$/.test(s) ? s.toLowerCase() : new URL("http://" + s).hostname;

export function parsePsl(text) {
  const out = { icann: [], private: [], wildIcann: [], wildPrivate: [], exceptions: [] };
  let section = "icann";
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith("// ===BEGIN PRIVATE DOMAINS===")) { section = "private"; continue; }
    if (line.startsWith("// ===BEGIN ICANN DOMAINS===")) { section = "icann"; continue; }
    if (!line || line.startsWith("//")) continue;
    const rule = line.split(/\s+/)[0];
    if (rule.startsWith("!")) out.exceptions.push(toAscii(rule.slice(1)));
    else if (rule.startsWith("*.")) (section === "private" ? out.wildPrivate : out.wildIcann).push(toAscii(rule.slice(2)));
    else (section === "private" ? out.private : out.icann).push(toAscii(rule));
  }
  for (const k of Object.keys(out)) out[k] = [...new Set(out[k])].sort();
  return out;
}
