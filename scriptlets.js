// QuietBrowse - YouTube ad scriptlets
// Runs in the page's MAIN world (registered by background.js) so it can
// hook the same JavaScript the player uses. Video ads are served from the
// same domains as videos, so network blocking can't stop them — instead we
// strip the ad sections out of the player data before the player reads it.

(function () {
  if (window.__qbYT) return;
  window.__qbYT = true;

  // Ad-related keys commonly observed in YouTube player payloads.
  // Keep this list conservative and purely subtractive to avoid breaking playback.
  const AD_KEYS = [
    "adPlacements",
    "adSlots",
    "playerAds",
    "adBreakHeartbeatParams",
    "adBreaks",
    "adSignals",
    "adSafetyReasons",
    "adLayoutLoggingStrings",
    "adSlotLoggingUrls",
    "preroll",
    "adDeviceSignals",
    "adInfos",
    "adTrackingParams",
    "adPlacementsDebug"
  ];

  function prune(obj) {
    try {
      if (obj && typeof obj === "object") {
        for (const key of AD_KEYS) {
          if (key in obj) delete obj[key];
        }
        if (obj.playerResponse) prune(obj.playerResponse);
        if (Array.isArray(obj)) {
          for (const item of obj) prune(item);
        } else {
          // Shallowly walk nested objects one level to catch ad blobs under alternate containers.
          for (const k in obj) {
            const v = obj[k];
            if (v && typeof v === "object") prune(v);
          }
        }
      }
    } catch {
      /* never break the page */
    }
    return obj;
  }

  // Player data usually arrives through JSON.parse or fetch().json().
  const origParse = JSON.parse;
  JSON.parse = function () {
    return prune(origParse.apply(this, arguments));
  };

  const origJson = Response.prototype.json;
  Response.prototype.json = function () {
    return origJson.call(this).then(prune);
  };

  // Belt and braces: the initial player response can land before our hooks.
  const sweep = setInterval(() => {
    if (window.ytInitialPlayerResponse) {
      prune(window.ytInitialPlayerResponse);
      clearInterval(sweep);
    }
  }, 500);
  setTimeout(() => clearInterval(sweep), 10000);

  // Expose for unit tests (no effect on pages).
  try { window.__qbYT_prune = prune; } catch {}
})();
