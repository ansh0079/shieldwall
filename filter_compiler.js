// QuietBrowse - shared filter-list compiler
// Turns EasyList-syntax filter text into declarativeNetRequest rules and
// cosmetic selector maps. Used by both the in-extension auto-updater
// (background.js via importScripts) and the build script (tools/build_filters.js).

(function (global) {
  const TYPE_MAP = {
    script: "script",
    image: "image",
    stylesheet: "stylesheet",
    object: "object",
    xmlhttprequest: "xmlhttprequest",
    subdocument: "sub_frame",
    document: "main_frame",
    ping: "ping",
    websocket: "websocket",
    media: "media",
    font: "font",
    other: "other"
  };

  const UNSUPPORTED_OPTIONS = new Set([
    "popup", "csp", "redirect", "redirect-rule", "rewrite",
    "replace", "badfilter", "genericblock", "generichide", "elemhide",
    "webrtc", "object-subrequest", "denyallow", "header", "permissions",
    "all", "inline-script", "inline-font", "cname"
  ]);

  /**
   * Returns null if `urlFilter` is acceptable to Chrome's declarativeNetRequest
   * parser, otherwise a short reason string. Mirrors the checks in Chromium's
   * indexed_rule.cc that reject a whole static ruleset at load time:
   *   - must be a non-empty string of ASCII characters
   *   - must not consist only of anchors ("|", "||", "|||")
   *   - must not start with "||*" (domain anchor followed by a wildcard)
   */
  function urlFilterError(urlFilter) {
    if (typeof urlFilter !== "string" || urlFilter.length === 0) return "empty urlFilter";
    if (!/^[\x00-\x7f]*$/.test(urlFilter)) return "non-ASCII urlFilter";
    if (/^\|{1,3}$/.test(urlFilter)) return "anchor-only urlFilter";
    if (urlFilter.startsWith("||*")) return "urlFilter starts with '||*'";
    return null;
  }

  /**
   * Validate a single DNR rule's condition fields that Chrome rejects at load
   * time. Returns null if valid, otherwise a reason string.
   */
  function dnrRuleError(rule) {
    const cond = rule && rule.condition;
    if (!cond || typeof cond !== "object") return "missing condition";
    if (cond.urlFilter !== undefined) {
      const e = urlFilterError(cond.urlFilter);
      if (e) return e;
    }
    if (cond.urlFilter !== undefined && cond.regexFilter !== undefined) {
      return "both urlFilter and regexFilter set";
    }
    for (const key of ["requestDomains", "initiatorDomains", "domains"]) {
      if (cond[key] === undefined) continue;
      if (!Array.isArray(cond[key]) || cond[key].length === 0) return `empty ${key}`;
    }
    for (const key of ["requestDomains", "excludedRequestDomains", "initiatorDomains", "excludedInitiatorDomains", "domains", "excludedDomains"]) {
      if (cond[key] === undefined) continue;
      for (const d of cond[key]) {
        if (typeof d !== "string" || !d || !/^[\x00-\x7f]*$/.test(d) || d !== d.toLowerCase()) {
          return `invalid ${key} entry: ${JSON.stringify(d)}`;
        }
      }
    }
    if (cond.resourceTypes !== undefined && (!Array.isArray(cond.resourceTypes) || cond.resourceTypes.length === 0)) {
      return "empty resourceTypes";
    }
    return null;
  }

  const PURE_DOMAIN_RE =
    /^\|\|([a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+)\^$/;

  // Procedural/extended selectors we can't express as plain CSS.
  // has-text, upward, remove are handled by parseProceduralSel; the rest are skipped.
  const PROCEDURAL_RE =
    /:(?:-abp-|xpath|matches-css|min-text-length|style|watch-attr|matches-path|others|matches-media)/;

  const SUPPORTED_PROCEDURAL_RE = /:has-text\(|:upward\(|:remove\(\)/;

  // Translate AdBlock Plus :-abp-has(...) to native CSS :has(...).
  // Chrome 105+ supports :has(); our manifest requires 121+.
  function translateAbpHas(sel) {
    const token = ":-abp-has";
    let out = "";
    let i = 0;
    while (i < sel.length) {
      const idx = sel.indexOf(token, i);
      if (idx === -1) {
        out += sel.slice(i);
        break;
      }
      out += sel.slice(i, idx);
      const openIdx = idx + token.length;
      if (sel[openIdx] !== "(") {
        // Malformed; leave token as-is and continue.
        out += token;
        i = openIdx;
        continue;
      }
      let depth = 1;
      let j = openIdx + 1;
      while (j < sel.length && depth > 0) {
        const ch = sel[j];
        if (ch === "(") depth++;
        else if (ch === ")") depth--;
        j++;
      }
      out += ":has" + sel.slice(openIdx, j);
      i = j;
    }
    return out;
  }

  // Finds the last occurrence of :name(...) at the end of sel.
  // Returns { base, inner } or null if not found / unbalanced.
  function findProceduralPseudo(sel, name) {
    const needle = ":" + name + "(";
    const idx = sel.lastIndexOf(needle);
    if (idx === -1) return null;
    let depth = 1;
    let j = idx + needle.length;
    while (j < sel.length && depth > 0) {
      if (sel[j] === "(") depth++;
      else if (sel[j] === ")") depth--;
      j++;
    }
    if (depth !== 0) return null;
    if (j < sel.length && sel.slice(j).trim() !== "") return null;
    return { base: sel.slice(0, idx).trim(), inner: sel.slice(idx + needle.length, j - 1).trim() };
  }

  // Reject bases that are uBO HTML-filter or invalid CSS selector prefixes.
  function isValidCssBase(base) {
    return base && !base.startsWith("^") && !base.startsWith("<") && !PROCEDURAL_RE.test(base);
  }

  function parseProceduralSel(sel) {
    if (sel.endsWith(":remove()")) {
      const base = sel.slice(0, -9).trim();
      if (isValidCssBase(base)) return { type: "remove", base };
      return null;
    }
    const up = findProceduralPseudo(sel, "upward");
    if (up && /^\d+$/.test(up.inner)) {
      const n = parseInt(up.inner, 10);
      if (n > 0 && n <= 10 && isValidCssBase(up.base)) {
        return { type: "upward", base: up.base, arg: n };
      }
    }
    const ht = findProceduralPseudo(sel, "has-text");
    if (ht && ht.inner && isValidCssBase(ht.base)) {
      const reMatch = ht.inner.match(/^\/(.+)\/([gimsuy]*)$/);
      if (reMatch) return { type: "has-text", base: ht.base, arg: reMatch[1], flags: reMatch[2] || "i", isRegex: true };
      return { type: "has-text", base: ht.base, arg: ht.inner, isRegex: false };
    }
    return null;
  }

  function parseOptions(optStr) {
    const out = {
      types: new Set(),
      excludedTypes: new Set(),
      thirdParty: null,
      initiatorDomains: null,
      excludedInitiatorDomains: null,
      important: false,
      removeParams: null
    };
    if (!optStr) return out;

    for (const raw of optStr.split(",")) {
      const opt = raw.trim();
      if (!opt) continue;
      const neg = opt.startsWith("~");
      const name = neg ? opt.slice(1) : opt;

      if (name === "third-party" || name === "3p") {
        out.thirdParty = !neg;
      } else if (name === "first-party" || name === "1p") {
        out.thirdParty = neg;
      } else if (name === "important") {
        out.important = true;
      } else if (name === "match-case") {
        // DNR urlFilter is case-insensitive; close enough.
      } else if (name.startsWith("domain=")) {
        const domains = name.slice(7).split("|").filter(Boolean);
        const pos = domains.filter((d) => !d.startsWith("~"));
        const negd = domains.filter((d) => d.startsWith("~")).map((d) => d.slice(1));
        if (pos.length && negd.length) return null; // mixed - skip
        if (pos.length) out.initiatorDomains = pos;
        if (negd.length) out.excludedInitiatorDomains = negd;
      } else if (name.startsWith("removeparam=")) {
        // Support a safe subset: plain parameter names only (no regex/wildcards).
        // Multiple removeparam=foo,bar not in spec — lists use one per line.
        const val = name.slice("removeparam=".length).trim();
        if (!val) continue;
        // Strip optional leading ? and decode common encodings.
        const rawParam = val.replace(/^\?/, "");
        // If wrapped like /.../ treat as unsupported (skip this rule).
        if ((rawParam.startsWith("/") && rawParam.endsWith("/")) || rawParam.includes("*")) {
          return null;
        }
        // Accept a-z 0-9 _ - only (common analytics params).
        if (!/^[a-z0-9_-]+$/i.test(rawParam)) {
          return null;
        }
        if (!out.removeParams) out.removeParams = [];
        out.removeParams.push(rawParam);
      } else if (TYPE_MAP[name]) {
        (neg ? out.excludedTypes : out.types).add(TYPE_MAP[name]);
      } else if (UNSUPPORTED_OPTIONS.has(name)) {
        return null;
      } else {
        return null; // unknown option - be safe, skip
      }
    }
    if (out.types.size && out.excludedTypes.size) return null;
    return out;
  }

  function splitOptions(line) {
    const idx = line.lastIndexOf("$");
    if (idx <= 0) return [line, ""];
    const tail = line.slice(idx + 1);
    if (/^[a-z0-9~,=|._*-]+$/i.test(tail)) return [line.slice(0, idx), tail];
    return [line, ""];
  }

  function buildCondition(opts) {
    const cond = {};
    if (opts.types.size) cond.resourceTypes = [...opts.types];
    if (opts.excludedTypes.size) cond.excludedResourceTypes = [...opts.excludedTypes];
    if (opts.thirdParty === true) cond.domainType = "thirdParty";
    if (opts.thirdParty === false) cond.domainType = "firstParty";
    if (opts.initiatorDomains) cond.initiatorDomains = opts.initiatorDomains;
    if (opts.excludedInitiatorDomains)
      cond.excludedInitiatorDomains = opts.excludedInitiatorDomains;
    return cond;
  }

  // Parse a cosmetic line. Returns true if the line was cosmetic.
  function findMatchingParen(str, start) {
    let depth = 1;
    let i = start;
    while (i < str.length && depth > 0) {
      if (str[i] === "(") depth++;
      else if (str[i] === ")") depth--;
      i++;
    }
    return depth === 0 ? i : -1;
  }

  function parseScriptletArgs(inner) {
    const args = [];
    let current = "";
    let depth = 0;
    for (const ch of inner) {
      if (ch === "," && depth === 0) {
        args.push(current.trim());
        current = "";
      } else {
        current += ch;
        if (ch === "(") depth++;
        else if (ch === ")") depth--;
      }
    }
    if (current.trim()) args.push(current.trim());
    return args;
  }

  function parseCosmetic(line, out) {
    // Scriptlet rules: domain##+js(name, arg1, arg2)
    const scriptletIdx = line.indexOf("##+js(");
    const unhideScriptletIdx = line.indexOf("#@#+js(");
    if (scriptletIdx !== -1 || unhideScriptletIdx !== -1) {
      const isUnhide = unhideScriptletIdx !== -1 && (scriptletIdx === -1 || unhideScriptletIdx < scriptletIdx);
      const sepIdx = isUnhide ? unhideScriptletIdx : scriptletIdx;
      const prefix = line.slice(0, sepIdx).trim();
      const headLen = isUnhide ? 7 : 6; // #@#+js( or ##+js(
      const closeIdx = findMatchingParen(line, sepIdx + headLen);
      if (closeIdx === -1) return true;
      const inner = line.slice(sepIdx + headLen, closeIdx - 1);
      const args = parseScriptletArgs(inner);
      const name = args.shift();
      if (!name) return true;

      const domains = prefix
        ? prefix.toLowerCase().split(",").map((d) => d.trim()).filter(Boolean)
        : [""]; // generic scriptlet if no domain prefix

      if (isUnhide) {
        for (const d of domains) {
          addTo(out.scriptletUnhide, d, { name, args });
        }
      } else {
        for (const d of domains) {
          if (d.includes("*")) continue;
          addTo(out.scriptletRules, d, { name, args });
        }
      }
      return true;
    }

    const unhideIdx = line.indexOf("#@#");
    const hideIdx = line.indexOf("##");
    if (unhideIdx === -1 && hideIdx === -1) return false;
    // Procedural syntaxes we skip entirely.
    if (line.includes("#?#") || line.includes("#$#") || line.includes("#%#")) {
      return true;
    }

    const isUnhide = unhideIdx !== -1 && (hideIdx === -1 || unhideIdx < hideIdx);
    const sepIdx = isUnhide ? unhideIdx : hideIdx;
    const prefix = line.slice(0, sepIdx).trim();
    const rawSel = line.slice(sepIdx + (isUnhide ? 3 : 2)).trim();
    const sel = translateAbpHas(rawSel);
    if (!sel) return true;
    if (PROCEDURAL_RE.test(sel)) return true; // unsupported procedural — skip

    // Supported procedural selectors: has-text, upward, remove
    if (SUPPORTED_PROCEDURAL_RE.test(sel)) {
      if (!isUnhide) {
        const proc = parseProceduralSel(sel);
        if (proc) {
          if (!prefix) {
            addTo(out.proceduralRules, "", proc);
          } else {
            const pDomains = prefix.toLowerCase().split(",").map((d) => d.trim()).filter(Boolean);
            for (const d of pDomains.filter((d) => !d.startsWith("~"))) {
              if (!d.includes("*")) addTo(out.proceduralRules, d, proc);
            }
          }
        }
      }
      return true;
    }

    if (!prefix) {
      if (!isUnhide) out.genericSelectors.add(sel);
      return true;
    }

    const domains = prefix.toLowerCase().split(",").map((d) => d.trim()).filter(Boolean);
    const pos = domains.filter((d) => !d.startsWith("~"));
    const neg = domains.filter((d) => d.startsWith("~")).map((d) => d.slice(1));

    if (isUnhide) {
      // domain#@#sel : disable the (generic) rule on these domains.
      for (const d of pos) addTo(out.siteUnhide, d, sel);
      return true;
    }

    if (pos.length === 0 && neg.length > 0) {
      // ~example.com##sel : generic everywhere except listed domains.
      out.genericSelectors.add(sel);
      for (const d of neg) addTo(out.siteUnhide, d, sel);
      return true;
    }

    for (const d of pos) {
      if (d.includes("*")) continue; // wildcard domains - skip
      addTo(out.siteHide, d, sel);
    }
    return true;
  }

  function addTo(map, key, value) {
    if (!map[key]) map[key] = [];
    map[key].push(value);
  }

  /**
   * Compile filter-list texts.
   * Returns { allowRules, blockRules, paramRules, genericSelectors, siteHide, siteUnhide, stats }
   * Rules come WITHOUT ids - the caller assigns them.
   */
  function compileFilters(texts, options = {}) {
    const maxBlockRules = options.maxBlockRules ?? 26000;
    const maxAllowRules = options.maxAllowRules ?? 2000;
    const domainsPerGroup = options.domainsPerGroup ?? 1000;

    const seen = new Set();
    const cosmetic = {
      genericSelectors: new Set(),
      siteHide: {},
      siteUnhide: {},
      scriptletRules: {},
      scriptletUnhide: {},
      proceduralRules: {}
    };
    const domainGroups = new Map();
    const patternBlockRules = [];
    const allowRules = [];
    const paramRules = [];
    let skipped = 0;
    let invalidUrlFilters = 0;

    for (const text of texts) {
      for (let line of text.split("\n")) {
        line = line.trim();
        if (!line || line.startsWith("!") || line.startsWith("[")) continue;
        if (seen.has(line)) continue;
        seen.add(line);

        if (parseCosmetic(line, cosmetic)) continue;

        const isException = line.startsWith("@@");
        if (isException) line = line.slice(2);

        const [pattern, optStr] = splitOptions(line);
        if (!pattern) { skipped++; continue; }
        if (pattern.startsWith("/") && pattern.endsWith("/")) { skipped++; continue; }
        if (!/^[\x20-\x7e]+$/.test(pattern)) { skipped++; continue; }

        // Patterns Chrome's DNR parser rejects (e.g. "||*foo") would make the
        // whole ruleset fail to load, so drop them here.
        if (urlFilterError(pattern)) { skipped++; invalidUrlFilters++; continue; }

        const opts = parseOptions(optStr);
        if (!opts) { skipped++; continue; }

        // $removeparam support — exception not supported (skip if exceptioned).
        if (!isException && opts.removeParams && opts.removeParams.length) {
          // Build a redirect with queryTransform.removeParams
          const cond = buildCondition(opts);
          const m = pattern.match(PURE_DOMAIN_RE);
          const hasCondExtras =
            opts.types.size || opts.excludedTypes.size ||
            opts.initiatorDomains || opts.excludedInitiatorDomains || opts.important;
          if (m && !hasCondExtras) {
            // Group by requestDomains where possible.
            // Build one rule per domain chunk to keep conditions simple.
            // We'll accumulate and chunk later alongside other grouped rules if needed.
            // For now, express using requestDomains directly.
            paramRules.push({
              priority: opts.important ? 3 : 1,
              action: {
                type: "redirect",
                redirect: { transform: { queryTransform: { removeParams: opts.removeParams.slice(0, 8) } } }
              },
              condition: { requestDomains: [m[1]], ...cond }
            });
          } else {
            paramRules.push({
              priority: opts.important ? 3 : 1,
              action: {
                type: "redirect",
                redirect: { transform: { queryTransform: { removeParams: opts.removeParams.slice(0, 8) } } }
              },
              condition: { urlFilter: pattern, ...cond }
            });
          }
          continue;
        }

        if (isException) {
          if (allowRules.length >= maxAllowRules) { skipped++; continue; }
          allowRules.push({
            priority: opts.important ? 4 : 2,
            action: { type: "allow" },
            condition: { urlFilter: pattern, ...buildCondition(opts) }
          });
          continue;
        }

        const m = pattern.match(PURE_DOMAIN_RE);
        const hasCondExtras =
          opts.types.size || opts.excludedTypes.size ||
          opts.initiatorDomains || opts.excludedInitiatorDomains || opts.important;
        if (m && !hasCondExtras) {
          const key = `tp:${opts.thirdParty}`;
          if (!domainGroups.has(key)) domainGroups.set(key, { opts, domains: [] });
          domainGroups.get(key).domains.push(m[1]);
          continue;
        }

        if (patternBlockRules.length >= maxBlockRules) { skipped++; continue; }
        patternBlockRules.push({
          priority: opts.important ? 3 : 1,
          action: { type: "block" },
          condition: { urlFilter: pattern, ...buildCondition(opts) }
        });
      }
    }

    const groupedRules = [];
    let domainCount = 0;
    for (const { opts, domains } of domainGroups.values()) {
      domainCount += domains.length;
      for (let i = 0; i < domains.length; i += domainsPerGroup) {
        groupedRules.push({
          priority: 1,
          action: { type: "block" },
          condition: {
            requestDomains: domains.slice(i, i + domainsPerGroup),
            ...buildCondition(opts)
          }
        });
      }
    }

    const proceduralCount = Object.values(cosmetic.proceduralRules).reduce((n, a) => n + a.length, 0);
    return {
      allowRules,
      blockRules: [...groupedRules, ...patternBlockRules],
      paramRules,
      genericSelectors: [...cosmetic.genericSelectors],
      siteHide: cosmetic.siteHide,
      siteUnhide: cosmetic.siteUnhide,
      scriptletRules: cosmetic.scriptletRules,
      scriptletUnhide: cosmetic.scriptletUnhide,
      proceduralRules: cosmetic.proceduralRules,
      stats: {
        domainCount,
        groupedRules: groupedRules.length,
        patternRules: patternBlockRules.length,
        allowRules: allowRules.length,
        paramRules: paramRules.length,
        genericSelectors: cosmetic.genericSelectors.size,
        siteHideDomains: Object.keys(cosmetic.siteHide).length,
        siteUnhideDomains: Object.keys(cosmetic.siteUnhide).length,
        scriptletRules: Object.keys(cosmetic.scriptletRules).length,
        proceduralRules: proceduralCount,
        skipped,
        invalidUrlFilters
      }
    };
  }

  global.compileFilters = compileFilters;
  global.dnrRuleError = dnrRuleError;
  if (typeof module !== "undefined" && module.exports) {
    module.exports = { compileFilters, urlFilterError, dnrRuleError };
  }
})(typeof self !== "undefined" ? self : globalThis);
