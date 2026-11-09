# Deploying the report server

1. **Run it** (Docker):
   ```bash
   export REPORT_SALT=$(openssl rand -hex 32)   # store this somewhere safe
   docker compose up -d --build
   ```
2. **Put HTTPS in front.** The extension should only talk to an `https://` URL. Example Caddy config
   (automatic certificates): `reports.example.com { reverse_proxy 127.0.0.1:8787 }`.
   Keep `TRUST_PROXY=true` (the Dockerfile default) only when a proxy sets `X-Forwarded-For`; otherwise unset it,
   or anyone can fake their IP and dodge rate limits.
3. **Check it:** `curl https://reports.example.com/healthz` then `.../v1/summary?domain=example.com`.
4. **Point the extension at it:** Options -> Buyer-report server URL.
5. **Back up** the `/data` volume (`data.json`). Reports older than 90 days are dropped automatically.

## Before real users
- Write a privacy policy: you store domain, outcome, tags, a salted hash of an anonymous install ID, and a timestamp. No names, emails or IPs are stored (IPs are only held in memory for rate limiting).
- Decide how shops can dispute reports, and who moderates. Nothing here detects coordinated fake reports beyond the per-install, per-IP and minimum-reports limits.
- A JSON file is fine for a small pilot. Move to a real database if reports reach the tens of thousands.
