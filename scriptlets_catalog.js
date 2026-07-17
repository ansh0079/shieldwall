// QuietBrowse - MAIN-world scriptlet catalog (uBO-style primitives)
// Site rules are embedded below. Registration excludes paused / ads-allowed sites.

(function () {
  if (window.__qbScriptlets) return;
  window.__qbScriptlets = true;

  function abortOnPropertyRead(prop) {
    if (!prop || typeof prop !== "string") return;
    const parts = prop.split(".");
    let obj = window;
    for (let i = 0; i < parts.length - 1; i++) {
      if (!obj || typeof obj !== "object") return;
      const next = obj[parts[i]];
      if (next == null) {
        try {
          Object.defineProperty(obj, parts[i], {
            configurable: true,
            get: function () {
              return undefined;
            },
            set: function () {}
          });
        } catch {
          return;
        }
        return;
      }
      obj = next;
    }
    const last = parts[parts.length - 1];
    try {
      Object.defineProperty(obj, last, {
        configurable: true,
        get: function () {
          throw new ReferenceError("QuietBrowse aborted property read: " + prop);
        },
        set: function () {}
      });
    } catch {
      /* page may already own a non-configurable property */
    }
  }

  function setConstant(prop, value) {
    if (!prop || typeof prop !== "string") return;
    let resolved = value;
    if (value === "true") resolved = true;
    else if (value === "false") resolved = false;
    else if (value === "undefined") resolved = undefined;
    else if (value === "null") resolved = null;
    else if (value === "noopFunc") resolved = function () {};
    else if (value === "trueFunc") resolved = function () { return true; };
    else if (value === "falseFunc") resolved = function () { return false; };
    else if (value === "emptyArr") resolved = [];
    else if (value === "emptyObj") resolved = {};
    else if (value === "-1" || value === "") resolved = value === "-1" ? -1 : "";
    else if (/^-?\d+$/.test(String(value))) resolved = Number(value);

    const parts = prop.split(".");
    let obj = window;
    for (let i = 0; i < parts.length - 1; i++) {
      if (obj[parts[i]] == null || typeof obj[parts[i]] !== "object") {
        try {
          obj[parts[i]] = {};
        } catch {
          return;
        }
      }
      obj = obj[parts[i]];
    }
    const last = parts[parts.length - 1];
    try {
      Object.defineProperty(obj, last, {
        configurable: true,
        get: function () {
          return resolved;
        },
        set: function () {}
      });
    } catch {
      try {
        obj[last] = resolved;
      } catch {
        /* ignore */
      }
    }
  }

  // Prune dot-path keys from a parsed JSON object.
  function jsonPrune(propsStr, requiredStr) {
    if (!propsStr) return;
    const props = propsStr.split(/\s+/).filter(Boolean);
    const required = requiredStr ? requiredStr.split(/\s+/).filter(Boolean) : [];
    function pruneObj(obj) {
      if (!obj || typeof obj !== "object") return obj;
      if (required.length) {
        const hasAll = required.every((p) => {
          const parts = p.split(".");
          let v = obj;
          for (const k of parts) { if (v == null || typeof v !== "object") return false; v = v[k]; }
          return v !== undefined;
        });
        if (!hasAll) return obj;
      }
      for (const prop of props) {
        const parts = prop.split(".");
        let v = obj;
        for (let i = 0; i < parts.length - 1; i++) {
          if (v == null || typeof v !== "object") { v = null; break; }
          v = v[parts[i]];
        }
        if (v && typeof v === "object") delete v[parts[parts.length - 1]];
      }
      return obj;
    }
    const origParse = JSON.parse;
    JSON.parse = function () { return pruneObj(origParse.apply(this, arguments)); };
    if (typeof Response !== "undefined") {
      const origJson = Response.prototype.json;
      Response.prototype.json = function () { return origJson.call(this).then(pruneObj); };
    }
  }

  // Block fetch requests whose URL matches a pattern string.
  function noFetchIf(pattern) {
    if (!pattern) return;
    const origFetch = window.fetch;
    window.fetch = function (resource) {
      const url = typeof resource === "string" ? resource : (resource && resource.url) || "";
      if (url.includes(pattern)) {
        return Promise.resolve(new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } }));
      }
      return origFetch.apply(this, arguments);
    };
  }

  // Block setTimeout calls whose stringified handler contains matchStr.
  function preventSetTimeout(matchStr) {
    if (!matchStr) return;
    const origSetTimeout = window.setTimeout;
    window.setTimeout = function (fn, delay) {
      if (typeof fn === "function" && fn.toString().includes(matchStr)) return 0;
      if (typeof fn === "string" && fn.includes(matchStr)) return 0;
      return origSetTimeout.apply(this, arguments);
    };
  }

  // Block XMLHttpRequest to URLs matching a pattern.
  function preventXhr(pattern) {
    if (!pattern) return;
    const OrigXHR = window.XMLHttpRequest;
    function PatchedXHR() { OrigXHR.call(this); }
    PatchedXHR.prototype = Object.create(OrigXHR.prototype);
    PatchedXHR.prototype.constructor = PatchedXHR;
    PatchedXHR.prototype.open = function (method, url) {
      this.__qbBlocked = typeof url === "string" && url.includes(pattern);
      if (!this.__qbBlocked) OrigXHR.prototype.open.apply(this, arguments);
    };
    PatchedXHR.prototype.send = function () {
      if (!this.__qbBlocked) OrigXHR.prototype.send.apply(this, arguments);
    };
    try { window.XMLHttpRequest = PatchedXHR; } catch { /* non-configurable */ }
  }

  function run(name, args) {
    if (name === "abort-on-property-read" || name === "aopr") {
      abortOnPropertyRead(args[0]);
    } else if (name === "set-constant" || name === "set") {
      setConstant(args[0], args[1]);
    } else if (name === "json-prune") {
      jsonPrune(args[0], args[1]);
    } else if (name === "no-fetch-if") {
      noFetchIf(args[0]);
    } else if (name === "prevent-setTimeout" || name === "psto") {
      preventSetTimeout(args[0]);
    } else if (name === "prevent-xhr" || name === "no-xhr-if") {
      preventXhr(args[0]);
    }
  }

  // Hostname-keyed scriptlet prescriptions.
  const RULES = {
    "forbes.com": [
      ["set-constant", "adblock", "false"],
      ["set-constant", "canRunAds", "true"]
    ],
    "wired.com": [
      ["set-constant", "adblock", "false"],
      ["set-constant", "adblockDetected", "false"]
    ],
    "theverge.com": [["set-constant", "adblock", "false"]],
    "arstechnica.com": [["set-constant", "adblock", "false"]],
    "medium.com": [
      ["set-constant", "isAdFree", "true"],
      ["set-constant", "adblock", "false"]
    ],
    "sourcepoint.com": [["abort-on-property-read", "__sp_"]],
    "iheart.com": [["set-constant", "adBlockEnabled", "false"]],
    "cityam.com": [["set-constant", "canRunAds", "true"]],
    "independent.co.uk": [["set-constant", "adblock", "false"]],
    "telegraph.co.uk": [["set-constant", "adblock", "false"]],
    "dailymail.co.uk": [["set-constant", "adblock", "false"]],
    "nytimes.com": [
      ["set-constant", "adblockDetected", "false"],
      ["set-constant", "googletag.cmd", "emptyArr"]
    ],
    "washingtonpost.com": [["set-constant", "adblock", "false"]],
    "cnbc.com": [["set-constant", "adblock", "false"]],
    "businessinsider.com": [["set-constant", "adblock", "false"]],
    "sports.yahoo.com": [["set-constant", "adblock", "false"]],
    "yahoo.com": [["set-constant", "adblock", "false"]],
    "espn.com": [["set-constant", "adblock", "false"]],
    "cbssports.com": [["set-constant", "adblock", "false"]],
    "bleacherreport.com": [["set-constant", "adblock", "false"]],
    "techcrunch.com": [["set-constant", "adblock", "false"]],
    "engadget.com": [["set-constant", "adblock", "false"]],
    "huffpost.com": [["set-constant", "adBlockEnabled", "false"]],
    "thetimes.co.uk": [["set-constant", "adblock", "false"]],
    "theatlantic.com": [["set-constant", "adblock", "false"]],
    "salon.com": [["set-constant", "adblock", "false"]],
    "slate.com": [["set-constant", "adblock", "false"]],
    "variety.com": [["set-constant", "adblock", "false"]],
    "hollywoodreporter.com": [["set-constant", "adblock", "false"]],
    "rollingstone.com": [["set-constant", "adblock", "false"]],
    "usnews.com": [["set-constant", "adblock", "false"]],
    "newsweek.com": [["set-constant", "adblock", "false"]],
    "time.com": [["set-constant", "adblock", "false"]],
    "gamespot.com": [["set-constant", "adblock", "false"]],
    "ign.com": [["set-constant", "adblock", "false"]],
    "eurogamer.net": [["set-constant", "adblock", "false"]],
    "kotaku.com": [["set-constant", "adblock", "false"]],
    "pcgamer.com": [["set-constant", "adblock", "false"]],
    "speedtest.net": [["set-constant", "adblock", "false"]],
    "answers.yahoo.com": [["set-constant", "adblock", "false"]],
    "wikia.com": [["set-constant", "adblock", "false"]],
    "fandom.com": [
      ["set-constant", "adblock", "false"],
      ["set-constant", "canRunAds", "true"]
    ],
    "genius.com": [["set-constant", "adblock", "false"]],
    "imdb.com": [["set-constant", "adblock", "false"]],
    "tvtropes.org": [["set-constant", "adblock", "false"]],
    "weather.com": [["prevent-setTimeout", "adblock"]],
    "msn.com": [["set-constant", "adblock", "false"]],
    "mirror.co.uk": [["set-constant", "adblock", "false"]],
    "express.co.uk": [["set-constant", "adblock", "false"]],
    "thesun.co.uk": [["set-constant", "adblock", "false"]]
  };

  function hostMatches(host, ruleHost) {
    return host === ruleHost || host.endsWith("." + ruleHost);
  }

  const host = (location.hostname || "").toLowerCase().replace(/^www\./, "");
  for (const [ruleHost, scripts] of Object.entries(RULES)) {
    if (!hostMatches(host, ruleHost)) continue;
    for (const entry of scripts) {
      const [name, ...args] = entry;
      try {
        run(name, args);
      } catch {
        /* never break the page */
      }
    }
  }
})();
