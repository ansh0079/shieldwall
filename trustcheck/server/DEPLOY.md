# Deploying the report server

1. **Run it** (Docker):
   ```bash
   export REPORT_SALT=$(openssl rand -hex 32)   # store this somewhere safe
   export ADMIN_TOKEN=$(openssl rand -hex 32)   # protects order-outcome exports
   export CORS_ORIGIN=chrome-extension://YOUR_PUBLISHED_EXTENSION_ID
   docker compose up -d --build
   ```
2. **Put HTTPS in front.** The extension should only talk to an `https://` URL. Example Caddy config
   (automatic certificates): `reports.example.com { reverse_proxy 127.0.0.1:8787 }`.
   Keep `TRUST_PROXY=true` (the Dockerfile default) only when a proxy sets `X-Forwarded-For`; otherwise unset it,
   or anyone can fake their IP and dodge rate limits.
3. **Check it:** `curl https://reports.example.com/healthz` then `.../v1/summary?domain=example.com`.
4. **Point the extension at it:** Options -> Buyer-report server URL.
5. **Back up** the `/data` volume. Use a `.sqlite` `DATABASE_FILE` for a real beta. Reports older than 180 days are dropped automatically.

## Before real users
- Publish the included privacy policy at the URL used in the store listing.
- Keep `ENABLE_MERCHANT_VERIFICATION` unset during the consumer beta. Domain ownership is not evidence of reliable fulfilment.
- Treat `ADMIN_TOKEN` like a password. The export endpoint rejects requests without it.
- Decide how shops can dispute reports, and who moderates. Nothing here detects coordinated fake reports beyond the per-install, per-IP and minimum-reports limits.
- A JSON file is fine for a small pilot. Move to a real database if reports reach the tens of thousands.
