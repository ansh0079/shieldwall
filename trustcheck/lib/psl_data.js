// Curated public and private multi-tenant suffixes for accurate registrable domain extraction.
// Derived from the Public Suffix List (PSL).

export const MULTI_TENANT_SUFFIXES = [
  // E-commerce & Store builders
  "myshopify.com",
  "shopify.com",
  "mybigcommerce.com",
  "bigcommerce.com",
  "wixsite.com",
  "squarespace.com",
  "weebly.com",
  "wordpress.com",
  "shoplineapp.com",
  "shoplightspeed.com",
  "myecwid.com",
  "ecwid.com",
  "shopsettings.com",
  "storenvy.com",
  "bigcartel.com",

  // Cloud host / developer hosting often abused for phishing / rogue storefronts
  "github.io",
  "gitlab.io",
  "pages.dev",
  "workers.dev",
  "webflow.io",
  "netlify.app",
  "vercel.app",
  "fly.dev",
  "onrender.com",
  "azurewebsites.net",
  "appspot.com",
  "firebaseapp.com",
  "web.app",
  "blogspot.com"
];

export const CCTLD_TWO_LEVEL_SUFFIXES = [
  // UK
  "co.uk", "org.uk", "me.uk", "ltd.uk", "plc.uk", "net.uk", "sch.uk", "gov.uk", "ac.uk",
  // Australia & New Zealand
  "com.au", "net.au", "org.au", "edu.au", "gov.au", "asn.au", "id.au",
  "co.nz", "net.nz", "org.nz", "govt.nz", "ac.nz", "geek.nz", "school.nz",
  // Japan & East Asia
  "co.jp", "ne.jp", "or.jp", "ac.jp", "go.jp", "ed.jp", "gr.jp",
  "com.hk", "org.hk", "net.hk", "gov.hk", "edu.hk",
  "com.tw", "org.tw", "net.tw", "gov.tw", "edu.tw", "idv.tw",
  "com.sg", "org.sg", "net.sg", "gov.sg", "edu.sg",
  "co.kr", "ne.kr", "or.kr", "re.kr", "pe.kr", "go.kr", "mil.kr", "ac.kr",
  "com.cn", "org.cn", "net.cn", "gov.cn", "edu.cn",
  // South & Southeast Asia
  "co.in", "net.in", "org.in", "gen.in", "firm.in", "ind.in", "gov.in", "ac.in", "edu.in", "res.in",
  "com.my", "org.my", "net.my", "gov.my", "edu.my",
  "com.ph", "org.ph", "net.ph", "gov.ph", "edu.ph",
  "co.id", "or.id", "net.id", "go.id", "ac.id", "sch.id", "web.id", "my.id", "biz.id",
  "co.th", "or.th", "ac.th", "go.th", "net.th", "in.th",
  "com.pk", "org.pk", "net.pk", "gov.pk", "edu.pk",
  // Americas
  "com.br", "org.br", "net.br", "gov.br", "edu.br", "art.br", "eco.br", "ind.br", "inf.br",
  "com.mx", "org.mx", "net.mx", "edu.mx", "gob.mx",
  "com.ar", "net.ar", "org.ar", "gov.ar",
  "com.co", "org.co", "net.co", "edu.co", "gov.co",
  // Europe
  "com.es", "org.es", "nom.es", "gob.es", "edu.es",
  "com.pl", "org.pl", "net.pl", "gov.pl", "edu.pl",
  "com.pt", "org.pt", "edu.pt", "gov.pt",
  "com.ru", "org.ru", "net.ru", "pp.ru",
  "com.tr", "org.tr", "net.tr", "gov.tr", "edu.tr",
  // Africa & Middle East
  "co.za", "org.za", "web.za", "net.za", "gov.za", "ac.za",
  "com.ng", "org.ng", "net.ng", "gov.ng", "edu.ng",
  "com.sa", "org.sa", "net.sa", "gov.sa", "edu.sa",
  "com.eg", "org.eg", "net.eg", "gov.eg", "edu.eg",
  "co.il", "org.il", "net.il", "ac.il", "gov.il"
];

export const PUBLIC_SUFFIX_SET = new Set([
  ...MULTI_TENANT_SUFFIXES,
  ...CCTLD_TWO_LEVEL_SUFFIXES
]);
