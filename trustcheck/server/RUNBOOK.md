# Report server runbook

Audience: whoever is on call. Keep this short and true: if a step here stops working, fix this file.
Setup is in `DEPLOY.md`. All commands run in the container (`docker compose exec trustcheck-server ...`) unless noted.

## Daily facts
- One process, one SQLite file (`/data/data.db`, WAL), backups in `/data/backups` every 6 h (28 kept). **Copy backups off the volume.**
- `/healthz` = process alive. `/readyz` = database usable and schema current (503 while draining or when the DB is faulty).
- Logs are JSON lines, with addresses, tokens and domains redacted. Metrics: `GET /metrics` with an admin token.

## Alerts -> action
| Alert / symptom | Meaning | Do this |
|---|---|---|
| `backup_stale` | no good backup within 2 intervals | `cli.js backup`; check disk space and `BACKUP_DIR` permissions; read logs for `backup_failed` |
| `audit_chain_broken` | the audit log was altered or corrupted | **Treat as an incident.** Stop moderation, take a copy of the DB file, find the first bad entry (`/admin/audit/verify`), compare with the last backup (`cli.js verify`), restore if the live DB is the tampered one |
| `db_errors_total{kind="disk full"}` rising, writes return 503 | disk full | free space (old backups, logs); the server recovers without a restart. Then size the volume up |
| `readyz` 503 not draining | DB unreachable or schema mismatch | `cli.js status`; if "newer schema", you deployed an old image over a migrated DB: roll the image forward, never edit the DB |
| auth failures spiking (`auth_failures_total`) | token guessing or a stale client | check source in your proxy logs (the app log redacts addresses); lockout is automatic (10 failures/hour) |
| moderation queue growing | possible coordinated campaign | review `/admin/queue`; see "Moderation" |
| clients report dropped connections ("socket closed") under load | the server hit `MAX_CONNECTIONS` (default 512) and is refusing new sockets, by design | check open connections at the proxy; raise `MAX_CONNECTIONS` if the host has headroom, or let the reverse proxy queue/limit instead |
| process restarts in a loop | config refused or crash | read the first log line: config errors list every problem; `uncaught_exception` names the fault |

## Routine procedures
**Moderation.** `GET /admin/queue` lists held-back reports with reasons. Approve genuine ones, reject campaigns, revoke the credentials behind a campaign
(`POST /admin/credentials/<id>/revoke`). Every action is audited with the moderator's token name. Two people should review any bulk rejection.

**Disputes and appeals.** A merchant who proved domain ownership appears as `disputed`. Read `/admin/disputes`, resolve with a written resolution
(`POST /admin/disputes/<id>/resolve`). Respond within the SLA you publish; an appeal (`/v1/disputes/<id>/appeal`) must be reviewed by someone other than the first reviewer.

**Deletion requests.** Reporters self-serve (`DELETE /v1/report`, `DELETE /v1/credential`). Requests received by email cannot be matched to a report
(we do not store identities): explain that and point to the extension's Options button. Backups keep deleted data until they rotate out (max 28 backups = 7 days at 6-hourly); say so in the privacy policy.

**Backup and restore (rehearse quarterly).**
```bash
node server/cli.js backup                       # verified on creation
node server/cli.js verify /data/backups/<file>  # checksum, integrity, foreign keys, schema, audit chain; exit 1 if bad
docker compose stop trustcheck-server
mv /data/data.db /data/data.db.broken           # never delete before the restore is proven
node server/cli.js restore /data/backups/<file> /data/data.db
docker compose start trustcheck-server
```
Data written since that backup is lost, and credentials issued after it are rejected (clients re-enrol automatically). Expect up to the backup interval of loss.

**Migrations.** Run automatically on start, each in a transaction with a checksum. `cli.js migrate --dry-run` previews. Take a backup first.
Never edit applied migrations; add a new one. A server refuses to run against a newer schema than it knows.

**Rotating secrets.** `CREDENTIAL_SECRET` change: every client re-enrols (no data loss). `REPORT_SALT` change: network hashes reset, so per-network caps start over: do it only after an incident. Admin tokens: edit `ADMIN_TOKENS` and restart.

**Retention.** Reports 90 days (job daily); rate-limit events and used challenges pruned continuously; quarantined/rejected reports follow report retention; audit log kept (contains no content).

## Incident: suspected coordinated fake reports
1. `GET /admin/queue`, `/metrics`: look at held-back volume and which domains.
2. Revoke credentials in the campaign, reject the reports, note why (the audit log records the action, not the reasoning: keep notes elsewhere).
3. If a target domain is displaying a bad rate, reject reports until it drops below the display threshold; the page hides it automatically.
4. Raise `POW_BITS` or tighten `limits` via `REPORT_CONFIG_JSON` and restart if enrolment is the vector.
5. Afterwards: add the pattern to `test/reports-abuse.test.js` so a regression is caught.

## When to move to PostgreSQL
Move when any of these is true: you need more than one server instance or zero-downtime deploys; a recovery point under a few minutes
(continuous archiving); sustained writes where `p99` of `/v1/report` on the hot domain exceeds your target (measured here: ~1 s p99 at 8 000 reports on one domain under a 30-way hammer);
the DB file exceeds what you are willing to restore in your downtime budget. The store is isolated behind `ReportStore` and `Database` (`server/db.js`), so a port touches those two files and the migrations.

## Known limits (honest list)
- Single writer, single instance. Backup interval = recovery point.
- Load figures come from a development container with synthetic traffic, not production hardware or real network paths.
- `/readyz` returning 503 during drain was not observed in the self-test (shutdown completes in tens of ms when idle); the behaviour is covered by unit tests only.
- The Docker image and compose file were not built in the environment where this was written.
