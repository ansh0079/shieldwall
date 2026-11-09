# shieldwall

Two separate browser extensions live in this repository:

| Folder | What it is |
|---|---|
| [`quietbrowse/`](quietbrowse/) | **QuietBrowse**: privacy-first ad and tracker blocker (no servers, no data collection). |
| [`trustcheck/`](trustcheck/) | **TrustCheck**: real-time shop trust score, buyer reports and scam warnings for online shoppers. |
| [`docs/`](docs/) | QuietBrowse's public site (served by GitHub Pages from this folder; it must stay at the repo root). |

Load either extension with `chrome://extensions` -> Developer mode -> **Load unpacked**, then pick
`quietbrowse/` or `trustcheck/` (the folder containing that extension's `manifest.json`).

Each folder has its own `package.json`: run `npm test` inside it.
The [LICENSE](LICENSE) (GPL-3.0) covers QuietBrowse.
