// One place for the extension's stored settings and their defaults (Options page and background share it).
export const DEFAULT_BACKEND = "https://trustcheck.soloinvestor-ai.com";
export const DEFAULT_SETTINGS = {
  sbKey: "", tpKey: "", backend: "", chKey: "", sbTtlMin: 30,
  useRdap: true,            // domain-age lookup (rdap.org)
  useArchive: true,         // Internet Archive first-snapshot lookup
  badgeMode: "auto",        // "auto" (badge, opens briefly) | "quiet" (badge, never auto-opens) | "off" (toolbar only)
  orderReminders: true      // 14-day private order follow-up notifications
};
