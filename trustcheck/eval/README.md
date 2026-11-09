# TrustCheck evaluation corpus

Measures how the decision rules behave on a fixed set of evidence profiles, so that rule changes are judged by
numbers, not by a handful of examples. Run it with `npm run eval`.

## What this is, and what it is not
- **It is a regression and design tool.** It runs the real analysis code (validators, caches, scoring) against recorded
  evidence with a fixed clock and no network, so every result is deterministic.
- **It is not a measure of real-world accuracy.** Corpus v1 is **synthetic**: evidence profiles modelled on the patterns
  in `IMPROVEMENT_PLAN.md`, written by the same people who wrote the rules. Fraud prevalence (about 45-50%) is far above
  reality, so precision, recall and false-positive rates describe this corpus only. Samples are small: every rate is
  printed with a 95% Wilson interval, and those intervals are wide.
- **No real site is labelled fraudulent.** All fraud-labelled cases use `fixture` names, reserved/documentation addresses,
  or a `fixture-` item path on a real marketplace. A test enforces this. Real sites appear only as legitimate examples or
  as hosts of a synthetic item path, and their evidence is approximate.

## Layout
```
eval/
  corpus/v1/dev.jsonl        tunable cases (per-case output allowed)
  corpus/v1/holdout.jsonl    held-out cases (aggregates only; frozen by checksum)
  corpus/v1/MANIFEST.json    case counts + sha256 of each file
  harness.mjs                loads cases, mocks providers, runs analyze(), computes metrics and gates
  run.mjs                    CLI report
  manifest.mjs               regenerates the manifest
  thresholds.json            regression gates
  results/baseline.dev.json  committed verdict per dev case (drift detection)
  results/history.json       one entry per recorded run (per-release tracking)
```

## Case format (one JSON object per line)
```json
{"id":"fraud-new-cheap","cat":"confirmed_fraud","label":"fraud","url":"https://fixture-kayano-outlet.top/p",
 "desc":"...","ev":{"age":"2026-10-28","arch":"never","tp":"none","scan":"bare","price":0.5},"gap":"optional reason","hover":true}
```
- `label`: ground truth, `fraud` or `legit`. `cat`: one of the nine categories in the plan (known legitimate, confirmed
  fraudulent, compromised legitimate, new legitimate, marketplace, multi-tenant, international/IDN, URL-specific
  threats, contradictory/unavailable evidence).
- `ev` (what each provider said; an omitted key means that provider is not connected):
  `age` ISO date | `"none"` | `"err"` · `arch` ISO date | `"never"` | `"err"` · `sb` `"clean"` | `"err"` | `{"flagged":[url substrings]}`
  · `tp` `[score,count]` | `"none"` | `"err"` · `co` `{number,status,created,name}` (`status:"notfound"` for a missing number)
  · `scan` `full|partial|bare|none|pay-http` · `price` ratio to the market median · `buyers` summary.
- `gap`: the case is **out of scope of the evidence model by design** (e.g. a fraudulent seller on a legitimate
  marketplace). Gap cases are reported separately and never hidden, but not counted in recall/FPR. A gap case rated
  "Lower risk" is still a failure (it is the worst outcome), and a gate fails on it.
- `hover`: evaluate as a search-result hover lookup (query string dropped before URL-level checks).

## Metrics
- **Alarm** = verdict High risk or Dangerous. **Warn** = alarm or Caution.
- Recall / false-negative rate (fraud cases), false-positive rate (legit cases), precision, each at alarm and warn level.
- **False reassurance**: a fraud case rated *Lower risk indicators*. This is the most damaging error and the gate allows none.
- **Calibration**: observed fraud rate per verdict bucket. Verdicts must be ordered by severity (the gate requires
  monotonicity). ECE and Brier use *placeholder* prior probabilities per verdict (`PRIOR` in `harness.mjs`) and are
  informative only until real labelled data exists.
- **Confidence** reflects how much independent evidence supports the assessment, not the probability it is right.
  "Limited evidence" always carries Low confidence. The report also shows accuracy of decided verdicts by confidence.

## Rules for using the two sets
1. Tune only against **dev**. The holdout prints aggregates only; `--holdout-details` exists for debugging but using it
   means that set is no longer held out.
2. Do not edit `holdout.jsonl`. A test compares its checksum with the manifest. If you must change it, **create corpus
   v2**: a changed holdout no longer measures generalisation.
3. Any verdict change in dev must be reviewed, then accepted with `node eval/run.mjs --update-baseline`.
4. Thresholds in `thresholds.json` are regression guards set at current performance. They are not adequacy targets.

## Commands
```bash
npm run eval                 # dev report
npm run eval:check           # dev gates + verdict drift (also part of npm test)
npm run eval:holdout         # held-out aggregates + gates (run before a release, not while tuning)
node eval/run.mjs --set all --record --label "what changed"   # append to results/history.json
```

## Adding real cases
Real, verified cases are what this corpus lacks most. Add them as a **new corpus version** and keep real names out of
public files unless you have documentary proof and the right to publish:
1. Require at least two independent confirmations for a `fraud` label (for example, a payment-provider dispute outcome and
   a regulator/consumer-body report). Record the sources privately.
2. Record each provider's actual response at the time of the check, not your later view of the site.
3. Use a neutral id (`real-017`), keep the evidence profile in the file, and store the source notes outside the repository.
4. Add legitimate cases from the same period, and include new-but-honest businesses, otherwise false positives are hidden.
5. Keep at least a third of the real cases held out, untouched while rules are tuned.

## Known limitations of v1
- Written by the rule authors; the holdout is not independent. Prefer a holdout written by someone else.
- Small samples (about 25 scored cases per set); intervals are wide.
- No time dimension (the same domain at different dates) and no redirect-chain fixtures, because TrustCheck only sees the
  final URL.
- The reputation, company and price inputs are simplified to the fields the rules use.
