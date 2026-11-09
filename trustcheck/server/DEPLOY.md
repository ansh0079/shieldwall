# Report server: deployment and operations

The server stores anonymous **reported experiences** ("did your order arrive?"). They are unverified context: the extension
shows them but they have **no effect on the score**. Read "What this cannot stop" before relying on them.

## Run it
```bash
export REPORT_SALT=$(openssl rand -hex 32)          # network hashes (keep it)
export CREDENTIAL_SECRET=$(openssl rand -hex 32)    # signs credentials (changing it makes every client re-enrol)
export ADMIN_TOKEN=$(openssl rand -hex 24)          # optional: enables /admin/* (moderation)
docker compose up -d --build
```
Put HTTPS in front (Caddy: `reports.example.com { reverse_proxy 127.0.0.1:8787 }`). Keep `TRUST_PROXY=true` only behind a proxy that
sets `X-Forwarded-For`, otherwise anyone can fake an address and dodge every network limit. Then set the URL in the extension's Options.

| Variable | Purpose |
|---|---|
| `REPORT_SALT`, `CREDENTIAL_SECRET` | required in production |
| `ADMIN_TOKEN` | enables the moderation API; leave unset to disable it |
| `POW_BITS` (16) | proof-of-work difficulty for enrolment |
| `REPORT_CONFIG_JSON` | override any value in `abuse.js` `DEFAULTS`, e.g. `{"display":{"minEffective":8}}` |
| `DATA_FILE`, `PORT`, `RATE_LIMIT`, `CORS_ORIGIN`, `TRUST_PROXY` | as named |

## How reports are protected
| Control | What it does |
|---|---|
| **Server-signed credentials** | A client cannot invent an identity. `POST /v1/enroll` returns an HMAC-signed token; reports without one are refused (401). |
| **Enrolment limits** | At most 3 new identities per /24 (IPv4) or /48 (IPv6) per day, 200 per hour overall, each needing a single-use proof of work. |
| **Maturity weighting** | An identity's weight is 0 for its first 24 h, 0.3 until 7 days, then 1. It is fixed **at report time**, so waiting does not launder an early report. |
| **Per-network cap** | Unverified reports from one network add up to at most 1.0 of weight per domain, however many identities it has. |
| **Velocity limits** | 20 reports/day per identity, 30/hour per network, and at most 5 reports/day on one domain from identities younger than 7 days (extra ones are held back). |
| **Coordination detection** | Held back from scoring and sent to the moderation queue: 4+ reports from one network; 5+ reports within 10 minutes making up half of a domain's volume; 5+ identical reports from brand-new identities; a domain whose reports are 95% one outcome and mostly from identities under 14 days old. |
| **Display threshold + smoothing** | Nothing is shown until effective weight is at least 5 **and** reports come from at least 4 separate networks. The problem rate is Beta-smoothed towards a placeholder prior (15%, strength 10) and shown with a range. |
| **Verified vs reported** | Counted separately. No purchase verifier is configured, so nothing is verified; a supplied proof is ignored unless a verifier exists. |
| **Quiet quarantine** | The submitter is never told whether a report was held back, so attackers cannot probe the rules. |

## Moderation (needs `ADMIN_TOKEN`)
```bash
H="authorization: Bearer $ADMIN_TOKEN"
curl -H "$H" https://reports.example.com/admin/queue                                  # held-back reports with reasons
curl -H "$H" -d '{"ids":["<id>"],"action":"approve"}' https://reports.example.com/admin/reports/moderate   # approve | reject | restore
curl -X POST -H "$H" https://reports.example.com/admin/credentials/<credentialId>/revoke
curl -H "$H" https://reports.example.com/admin/disputes
curl -H "$H" -d '{"resolution":"..."}' https://reports.example.com/admin/disputes/<id>/resolve
curl -H "$H" https://reports.example.com/admin/audit/verify                          # {"ok":true,"length":N}
```
Approved reports bypass the automatic rules; rejected ones never count. Ten failed admin attempts lock an address out for an hour.
Every moderator action, quarantine, revocation, deletion and dispute event is written to a **hash-chained audit log** that
records no report content, addresses or raw credentials; editing or deleting an entry makes `/admin/audit/verify` fail.
Run that check on a schedule and alert on `ok:false`.

## Merchant disputes and corrections
- A merchant opens a dispute (`POST /v1/disputes`) and receives a token to publish at `https://<domain>/.well-known/trustcheck-dispute.txt`,
  then calls `POST /v1/disputes/<id>/verify`. Only a dispute with **proven ownership** is shown publicly (as `disputed: true`); unproven
  claims are visible to moderators only, so competitors cannot mark every shop "disputed". The server fetches that file over HTTPS only,
  public host names only, no redirects, 512 bytes max. Run the server in an egress-restricted network: this does not defend against DNS
  rebinding to internal addresses.
- Reporters can correct a report (3 edits per domain), delete it (`DELETE /v1/report?domain=`) or erase their whole identity and every
  report it made (`DELETE /v1/credential`; the extension's Options has a button). Reports older than 90 days are deleted automatically.

## What is stored
Domain, outcome, tags, a timestamp, the identity's age, an **HMAC of the network range** (never the address), and the credential id.
No names, emails or IPs. IPs exist in memory only for rate limiting.

## What this cannot stop (known limits)
- **A patient, diverse attacker.** 40 identities from 40 different networks, aged 15+ days, reporting a few hours apart, look like real
  consensus. It costs 40 proofs of work, 40 networks and weeks of waiting, and the result is still smoothed, labelled unverified and has no
  effect on the score, but it can move what is *displayed*. (Pinned by a test; if a rule starts catching it, update the test and this text.)
- **Residential proxies and shared networks.** Network limits assume a /24 is "one party". A botnet on residential proxies spreads wider;
  a large shared network (a university) is throttled even when honest.
- **Honest mistakes and genuine bad experiences that are not fraud.** Reports describe experiences, not intent.
- **Purchase verification does not exist yet.** Until a verifier is built, every report is an unverified claim.
- **Single process and a JSON file.** Rate-limit counters live in memory and reset on restart; the store is one file. Move to a database
  (plan item 15) before real scale. A pre-credential data file is backed up as `data.json.v1.bak` and not read.
- The thresholds are reasoned defaults, not tuned on real attacks. Treat them as a starting point and watch the moderation queue.

## Before real users
Write a privacy policy matching "What is stored"; decide who moderates, how fast disputes are answered, and how an appeal works;
set up backups of the data volume and the audit-verify alert; and get legal advice about publishing reports about named businesses.
`node server/seed.js <domain>` writes **demo-only** data (stop the server first, use the same secrets); never run it on a real deployment.
