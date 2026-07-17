# Contributing to QuietBrowse

Thanks for helping. QuietBrowse is GPL-3.0; filter-list derivatives stay under EasyList licences (see [ATTRIBUTION.md](ATTRIBUTION.md)).

## Dev setup

1. Clone this repo
2. Load the folder as an unpacked extension (`chrome://extensions` or `about:debugging` on Firefox)
3. Run tests: `npm test`

## Firefox

Use [manifest.firefox.json](manifest.firefox.json):

```bash
cp manifest.firefox.json manifest.json
# load as temporary add-on in about:debugging
```

Or keep the Chrome manifest for Chromium browsers. Firefox 121+ is required.

## Code map

| Area | Files |
|------|--------|
| Service worker | `background.js` + `bg_*.js` modules |
| Content | `content.js`, `cookie_reject.js`, `shield.js`, `zapper.js` |
| Filters | `filter_compiler.js`, `tools/build_filters.js` |
| UI | `popup.*`, `options.*`, `docs/index.html` |

## Pull requests

- Keep changes focused; match existing style
- Run `npm test` before opening a PR
- Do not commit secrets or telemetry
- Update ATTRIBUTION if you ship new list derivatives
