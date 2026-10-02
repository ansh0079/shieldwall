# Third-Party Attributions

QuietBrowse includes compiled filter data derived from community-maintained
lists. **You must retain this notice** when redistributing compiled rules or
derivatives.

## EasyList & EasyPrivacy

| List | Source | License |
|------|--------|---------|
| EasyList | https://easylist.to/easylist/easylist.txt | [CC BY-SA 3.0](https://creativecommons.org/licenses/by-sa/3.0/) **and** [GPL-3.0](https://www.gnu.org/licenses/gpl-3.0.html) |
| EasyPrivacy | https://easylist.to/easylist/easyprivacy.txt | [CC BY-SA 3.0](https://creativecommons.org/licenses/by-sa/3.0/) **and** [GPL-3.0](https://www.gnu.org/licenses/gpl-3.0.html) |
| Fanboy's Annoyance / Social / Cookie (optional) | https://easylist.to/ | Same EasyList licences |
| EasyList Germany / France (optional) | https://easylist.to/ | Same EasyList licences |

Official licence page: https://easylist.to/pages/licence.html

### Files derived from EasyList / EasyPrivacy

These files are **generated or compiled** from the lists above (via
`tools/build_filters.js` and `filter_compiler.js`):

- `easylist_rules.json` — network blocking rules for `declarativeNetRequest`
- `cosmetic_filters.js` — generic element-hiding selectors
- `cosmetic_sites.json` — per-site cosmetic hide/unhide selectors
- Auto-updated copies stored locally after filter refresh (`updatedRules`,
  `genericSelectors`, `cs_*` / `cx_*` storage keys)

If you modify and redistribute compiled rules, you must:

1. **Attribute** EasyList / EasyPrivacy as the source
2. **Share alike** under CC BY-SA 3.0 and/or GPL-3.0 (see EasyList licence page)
3. **State changes** you made to the compiled output

### Suggested Chrome Web Store attribution (short)

> Network and cosmetic blocking rules are derived from [EasyList](https://easylist.to/) and [EasyPrivacy](https://easylist.to/easylist/easyprivacy.php), © EasyList authors, used under CC BY-SA 3.0 / GPL-3.0.

### Suggested Chrome Web Store attribution (full)

> QuietBrowse uses filter lists from the EasyList project (easylist.to). EasyList and EasyPrivacy are copyright their respective authors and licensed under the Creative Commons Attribution-ShareAlike 3.0 Unported license and GNU General Public License v3.0. Compiled rule files in this extension are derived from those lists. Source code for QuietBrowse is available under GPL-3.0; see the project repository for full license text.

## AdGuard filters

| List | Source | License |
|------|--------|---------|
| AdGuard Base | https://filters.adtidy.org/extension/ublock/filters/2.txt | [GPL-3.0](https://github.com/AdguardTeam/AdguardFilters/blob/master/LICENSE) |
| AdGuard Tracking Protection | https://filters.adtidy.org/extension/ublock/filters/3.txt | [GPL-3.0](https://github.com/AdguardTeam/AdguardFilters/blob/master/LICENSE) |

## uBlock Origin (uAssets)

| List | Source | License |
|------|--------|---------|
| uBO Filters | https://github.com/uBlockOrigin/uAssets/blob/master/filters/filters.txt | [GPL-3.0](https://github.com/uBlockOrigin/uAssets/blob/master/LICENSE) |
| uBO Privacy | https://github.com/uBlockOrigin/uAssets/blob/master/filters/privacy.txt | [GPL-3.0](https://github.com/uBlockOrigin/uAssets/blob/master/LICENSE) |
| Quick Fixes | https://github.com/uBlockOrigin/uAssets/blob/master/filters/quick-fixes.txt | [GPL-3.0](https://github.com/uBlockOrigin/uAssets/blob/master/LICENSE) |

## Peter Lowe’s ad/tracking list

| List | Source | License |
|------|--------|---------|
| Peter Lowe | https://pgl.yoyo.org/adservers/ | [GPL-3.0](https://pgl.yoyo.org/adservers/) |

## QuietBrowse original code

Original source files (not listed above) are © QuietBrowse contributors and
licensed under **GPL-3.0** (see [LICENSE](LICENSE)).

The curated blocklist in `rules.json` and tracker names in `trackers.js` are
original QuietBrowse data unless noted otherwise.
