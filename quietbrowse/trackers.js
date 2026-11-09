// QuietBrowse - tracker database
// Maps blocked domains to a human-readable name and category,
// so the popup can show WHAT was blocked (Ghostery-style).
// Categories: advertising | analytics | social

const TRACKER_DB = {
  // ---- Advertising ----
  "doubleclick.net": ["Google Ads (DoubleClick)", "advertising"],
  "googlesyndication.com": ["Google AdSense", "advertising"],
  "googleadservices.com": ["Google Ads", "advertising"],
  "adservice.google.com": ["Google Ads", "advertising"],
  "adnxs.com": ["Xandr (AppNexus)", "advertising"],
  "adsrvr.org": ["The Trade Desk", "advertising"],
  "criteo.com": ["Criteo", "advertising"],
  "criteo.net": ["Criteo", "advertising"],
  "taboola.com": ["Taboola", "advertising"],
  "outbrain.com": ["Outbrain", "advertising"],
  "rubiconproject.com": ["Magnite", "advertising"],
  "pubmatic.com": ["PubMatic", "advertising"],
  "openx.net": ["OpenX", "advertising"],
  "adform.net": ["Adform", "advertising"],
  "amazon-adsystem.com": ["Amazon Ads", "advertising"],
  "media.net": ["Media.net", "advertising"],
  "smartadserver.com": ["Smart AdServer", "advertising"],
  "yieldmo.com": ["Yieldmo", "advertising"],
  "sharethrough.com": ["Sharethrough", "advertising"],
  "33across.com": ["33Across", "advertising"],
  "gumgum.com": ["GumGum", "advertising"],
  "sovrn.com": ["Sovrn", "advertising"],
  "lijit.com": ["Sovrn", "advertising"],
  "indexexchange.com": ["Index Exchange", "advertising"],
  "casalemedia.com": ["Index Exchange", "advertising"],
  "bidswitch.net": ["BidSwitch", "advertising"],
  "teads.tv": ["Teads", "advertising"],
  "undertone.com": ["Undertone", "advertising"],
  "zedo.com": ["Zedo", "advertising"],
  "adcolony.com": ["AdColony", "advertising"],
  "unityads.unity3d.com": ["Unity Ads", "advertising"],
  "applovin.com": ["AppLovin", "advertising"],
  "popads.net": ["PopAds", "advertising"],
  "propellerads.com": ["PropellerAds", "advertising"],
  "exoclick.com": ["ExoClick", "advertising"],
  "juicyads.com": ["JuicyAds", "advertising"],
  "trafficjunky.net": ["TrafficJunky", "advertising"],
  "revcontent.com": ["Revcontent", "advertising"],
  "mgid.com": ["MGID", "advertising"],
  "adblade.com": ["Adblade", "advertising"],

  // ---- Analytics / tracking ----
  "google-analytics.com": ["Google Analytics", "analytics"],
  "googletagmanager.com": ["Google Tag Manager", "analytics"],
  "scorecardresearch.com": ["Comscore", "analytics"],
  "quantserve.com": ["Quantcast", "analytics"],
  "quantcount.com": ["Quantcast", "analytics"],
  "hotjar.com": ["Hotjar", "analytics"],
  "mixpanel.com": ["Mixpanel", "analytics"],
  "segment.io": ["Segment", "analytics"],
  "segment.com": ["Segment", "analytics"],
  "amplitude.com": ["Amplitude", "analytics"],
  "fullstory.com": ["FullStory", "analytics"],
  "mouseflow.com": ["Mouseflow", "analytics"],
  "crazyegg.com": ["Crazy Egg", "analytics"],
  "clarity.ms": ["Microsoft Clarity", "analytics"],
  "chartbeat.com": ["Chartbeat", "analytics"],
  "parsely.com": ["Parse.ly", "analytics"],
  "newrelic.com": ["New Relic", "analytics"],
  "nr-data.net": ["New Relic", "analytics"],
  "bugsnag.com": ["Bugsnag", "analytics"],
  "mc.yandex.ru": ["Yandex Metrica", "analytics"],
  "matomo.cloud": ["Matomo", "analytics"],
  "statcounter.com": ["StatCounter", "analytics"],
  "kissmetrics.com": ["Kissmetrics", "analytics"],
  "heapanalytics.com": ["Heap", "analytics"],
  "branch.io": ["Branch", "analytics"],
  "appsflyer.com": ["AppsFlyer", "analytics"],
  "adjust.com": ["Adjust", "analytics"],
  "kochava.com": ["Kochava", "analytics"],
  "singular.net": ["Singular", "analytics"],
  "demdex.net": ["Adobe Audience Manager", "analytics"],
  "omtrdc.net": ["Adobe Analytics", "analytics"],
  "everesttech.net": ["Adobe Advertising", "analytics"],
  "bluekai.com": ["Oracle BlueKai", "analytics"],
  "krxd.net": ["Salesforce Krux", "analytics"],
  "exelator.com": ["Nielsen", "analytics"],
  "eyeota.net": ["Eyeota", "analytics"],
  "agkn.com": ["Neustar", "analytics"],
  "rlcdn.com": ["LiveRamp", "analytics"],
  "tapad.com": ["Tapad", "analytics"],
  "adsafeprotected.com": ["Integral Ad Science", "analytics"],
  "doubleverify.com": ["DoubleVerify", "analytics"],
  "moatads.com": ["Oracle Moat", "analytics"],
  "moatpixel.com": ["Oracle Moat", "analytics"],

  // ---- Social media trackers ----
  "connect.facebook.net": ["Facebook Pixel", "social"],
  "ads.facebook.com": ["Facebook Ads", "social"],
  "an.facebook.com": ["Facebook Audience Network", "social"],
  "ads.twitter.com": ["X (Twitter) Ads", "social"],
  "static.ads-twitter.com": ["X (Twitter) Ads", "social"],
  "ads.linkedin.com": ["LinkedIn Ads", "social"],
  "px.ads.linkedin.com": ["LinkedIn Insight", "social"],
  "ads.pinterest.com": ["Pinterest Ads", "social"],
  "ct.pinterest.com": ["Pinterest Tag", "social"],
  "ads.tiktok.com": ["TikTok Ads", "social"],
  "analytics.tiktok.com": ["TikTok Pixel", "social"],
  "ads.reddit.com": ["Reddit Ads", "social"],
  "events.reddit.com": ["Reddit Pixel", "social"],
  "sc-static.net": ["Snapchat Pixel", "social"],
  "tr.snapchat.com": ["Snapchat Pixel", "social"]
};

const CATEGORY_LABELS = {
  advertising: "Advertising",
  analytics: "Analytics & Tracking",
  social: "Social Media",
  other: "Other Ads & Trackers",
  learned: "Learned by QuietBrowse"
};

// Look up a hostname in the DB, walking up subdomains
// (e.g. stats.g.doubleclick.net -> g.doubleclick.net -> doubleclick.net).
function lookupTracker(hostname) {
  let host = hostname;
  while (host.includes(".")) {
    if (TRACKER_DB[host]) {
      return { domain: host, name: TRACKER_DB[host][0], category: TRACKER_DB[host][1] };
    }
    host = host.substring(host.indexOf(".") + 1);
  }
  return null;
}

function getAdvertisingDomains() {
  return Object.keys(TRACKER_DB).filter(
    (d) => TRACKER_DB[d][1] === "advertising"
  );
}
