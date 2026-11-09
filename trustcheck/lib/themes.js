// Keyword-based theme counting over review texts (no copying of review content).
export const THEMES = [
  ["non_delivery", "order never arrived", /never (arrived|received|came|delivered)|(not|n't|never) (arrive|receive|deliver)|still waiting|no delivery|not (arrived|received|delivered)|didn'?t (arrive|come)/i],
  ["delay", "late or delayed delivery", /\b(delay(ed)?|late|slow)\b|weeks?\b/i],
  ["tracking", "tracking problems", /tracking/i],
  ["fake", "fake or counterfeit goods", /\b(fake|counterfeit|knock-?off|not genuine|not authentic)\b/i],
  ["scam", "described as a scam", /\b(scam|scammers?|fraud(ulent)?|rip-?off|stole|stolen)\b/i],
  ["refund", "refund difficulties", /refund|money back|charge-?back/i],
  ["support", "no customer response", /no (reply|response|answer)|ignored|unresponsive|can'?t (get|reach)|customer (service|support)/i],
  ["quality", "poor quality", /poor quality|low quality|cheap|fell apart|broke|flimsy/i]
];

export function summarizeThemes(texts) {
  const n = texts.length;
  if (!n) return { sample: 0, themes: [] };
  const themes = [];
  for (const [id, label, re] of THEMES) {
    const count = texts.filter((t) => re.test(t)).length;
    if (count >= 2 || (count >= 1 && count / n >= 0.15)) themes.push({ id, label, count });
  }
  themes.sort((a, b) => b.count - a.count);
  return { sample: n, themes: themes.slice(0, 4) };
}
