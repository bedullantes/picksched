# Production deployment

How PickSched is configured per environment, how secrets are handled, and
what to check before going live.

## Environments

The API decides its environment at startup from `APP_ENV`
(`development` | `staging` | `production`). When `APP_ENV` isn't set,
`NODE_ENV=production` means production and anything else means
development, so a production deploy can't fall back to development rules
by accident. `APP_ENV=development` together with `NODE_ENV=production` is
refused.

| | development | staging | production |
|---|---|---|---|
| Configuration source | Shell, then `api/.env.local` (git-ignored), then `api/.env.development` (committed, no secrets) | Platform environment / secret manager only | Platform environment / secret manager only |
| PayMongo | Simulator or `sk_test_` keys. **Live keys refused** | `sk_test_` keys only. **Live keys refused** | `sk_live_` keys only, real API (no simulator override) |
| SendGrid | Simulator or test key | Real API. Sandbox mode allowed | Real API. Sandbox mode refused |
| Twilio | Simulator or test credentials | Real API (test/trial account) | Real API, or `SMS_PROVIDER=off`. Twilio magic test numbers refused |
| Database TLS | Off by default | Required (`require` or `verify-full`) | `verify-full` (`require` only with `DATABASE_SSL_ALLOW_UNVERIFIED=true`) |
| Cookies | Not `Secure` (plain HTTP on localhost) | `Secure`, `HttpOnly`, `SameSite=Lax` | Same as staging |
| HSTS / HTTPS redirect | Off | On | On (HSTS required) |
| Logs | Readable lines, debug level | JSON | JSON |
| Demo seed | Allowed | Allowed | **Refused** (demo accounts have a published password) |

Templates for each environment: [`api/.env.development`](../api/.env.development)
(the real development defaults), [`api/.env.staging.example`](../api/.env.staging.example)
and [`api/.env.production.example`](../api/.env.production.example). The
`.example` files are documentation only and are never loaded.

If a rule is broken, the server doesn't start. It prints all problems at
once, without the secret values, for example:

```
FATAL Configuration error, the server cannot start. Invalid configuration for APP_ENV=production:
  - production must use PayMongo live keys (sk_live_), not test keys
  - database connections must use TLS (DATABASE_SSL=verify-full)
```

At startup the server logs one `startup` line describing what it is running
with: environment, config sources, database host/user/TLS version, pool
size, and each integration's mode (`live`, `test`, `simulator`,
`sandbox`). It never prints a secret.

## Secrets

These values are secrets. They must never be committed and are injected
per environment:

`DATABASE_URL`, `MIGRATION_DATABASE_URL`, `DATABASE_CA_CERT`,
`SESSION_SECRET`, `PAYMONGO_SECRET_KEY`, `PAYMONGO_WEBHOOK_SECRET`,
`SENDGRID_API_KEY`, `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`,
`NOTIFICATIONS_WEBHOOK_URL`, `ERROR_WEBHOOK_URL`

- **Where they live:** the hosting platform's secret store. Examples are
  AWS Secrets Manager or SSM Parameter Store, GCP Secret Manager, Azure Key
  Vault, Doppler, Vault, or the platform's encrypted environment settings
  (Render, Fly.io, Railway, Heroku). Keep one set per environment. Staging
  and production never share keys.
- **How they get in:** as environment variables, or as files. For any
  secret above, set `NAME_FILE=/path` instead of `NAME`, for example
  `DATABASE_URL_FILE=/run/secrets/database_url`. The file's contents are
  used and a trailing newline is ignored. This suits Docker/Kubernetes
  secrets and secret-manager volume mounts, and keeps values out of
  `docker inspect` and process listings. Setting both forms is an error.
- **Generating:** `SESSION_SECRET` should be random, for example
  `openssl rand -base64 48`. In staging and production, weak values are refused.
- **In the repository:** `.env`, `.env.*` (except `.env.development` and
  `*.example`), `*.pem` and `*.key` are git-ignored. `npm run check:secrets`
  scans tracked files, and `npm run check:secrets -- --history` scans every
  commit. Both pass. The only key-like strings in the repository are
  simulator placeholders such as `sk_test_local`. Five invented test values
  in an older commit are recorded as reviewed false positives in
  `.secrets-allowlist`, by hash. Run the scan in CI.
- **Logs:** values of fields named like secrets (password, token, secret,
  authorization, cookie, api key, signature) are replaced with
  `[REDACTED]`. Passwords inside connection strings and PayMongo, SendGrid
  and bearer tokens inside messages are masked.
- **Rotation:** update the value in the secret store and restart or redeploy.
  - Database: credentials are re-read on start, and pooled connections are
    recycled every `DB_MAX_LIFETIME_SECONDS` (30 minutes by default).
  - `SESSION_SECRET`: rotating it signs everyone out.
  - PayMongo webhook secret: rotate the secret in the PayMongo dashboard and
    the app at the same time.

## Database

- **Encrypted connections.** `DATABASE_SSL=verify-full` encrypts the
  connection and verifies the server certificate and host name. For a
  provider or private CA, add `DATABASE_CA_CERT_FILE=/path/ca.pem`, for
  example the AWS RDS global bundle. `sslmode` in the URL is also understood.
  Either way, TLS settings come from one place, and URL parameters can't
  silently weaken them.
- **Checked at startup.** The server verifies that TLS is actually in use
  (`pg_stat_ssl`) and exits if it isn't. The live-updates `LISTEN`
  connection uses the same TLS settings.
- **Least privilege.** The app connects as a login role that is only a
  member of `picksched_app`. Every query runs under
  `SET LOCAL ROLE picksched_app` with row-level security. Migrations use a
  separate, privileged `MIGRATION_DATABASE_URL`.

  ```sql
  CREATE ROLE picksched_api LOGIN PASSWORD '<from the secret store>';
  GRANT picksched_app TO picksched_api;   -- after migrations have created picksched_app
  ```

  Preflight fails in staging and production if the login role is a
  superuser, has `BYPASSRLS`, or owns tables, because those bypass RLS.
- **Pooling.** Each instance keeps a pool (`DB_POOL_MAX`, default 20).
  Keep `instances × DB_POOL_MAX` (+1 `LISTEN` connection per instance)
  below the server's `max_connections`. Behind PgBouncer, use **session**
  pooling: live updates need `LISTEN`. Other settings are
  `DB_CONNECTION_TIMEOUT_MS`, `DB_IDLE_TIMEOUT_MS`, `DB_MAX_LIFETIME_SECONDS`
  and `DB_STATEMENT_TIMEOUT_MS` (per request, 5 s).

## HTTP security

Every response carries:

| Header | Value |
|---|---|
| `Content-Security-Policy` | `default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; manifest-src 'self'; worker-src 'self'; media-src 'none'; object-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'`, plus `upgrade-insecure-requests` when HSTS is on and `report-uri` when `CSP_REPORT_URI` is set |
| `Strict-Transport-Security` | `max-age=63072000; includeSubDomains` (HTTPS requests, staging/production) |
| `X-Frame-Options` | `DENY` |
| `X-Content-Type-Options` | `nosniff` |
| `Referrer-Policy` | `strict-origin-when-cross-origin` |
| `Permissions-Policy` | camera, microphone, geolocation, payment, usb, topics disabled |
| `Cross-Origin-Opener-Policy` / `-Resource-Policy` | `same-origin` |
| `Origin-Agent-Cluster`, `X-DNS-Prefetch-Control`, `X-Permitted-Cross-Domain-Policies` | `?1`, `off`, `none` |
| `Cache-Control` | `no-store` on `/api/*`. `immutable` for fingerprinted `/assets/*`. `no-cache` for the app page |
| `X-Request-Id` | Per request. A valid id from the load balancer is reused |

The CSP has no `unsafe-inline` or `unsafe-eval`. The web app and API share
one origin, and PayMongo checkout is a full-page redirect. The end-to-end
suite fails if the browser reports any CSP violation during the booking
journey or on the live dashboard.

Other hardening:

- `X-Powered-By` is removed.
- Unknown API routes return a plain 404.
- Server errors return a generic message and a `requestId`, never stack
  traces or database errors.
- Oversized request bodies get 413.
- Plain HTTP is redirected (308) to `APP_BASE_URL`, never to the request's
  `Host` header. `/api/health` stays reachable over HTTP for load-balancer
  checks.
- Set `TRUST_PROXY` to the number of proxies in front of the app (default
  1), so client IPs and HTTPS detection come from `X-Forwarded-*`.

## Logging and error tracking

- **Format:** JSON lines on stdout. Warnings and errors go to stderr. Each
  line has `time`, `level`, `severity` (Google Cloud), `msg`, `service`
  and `env`. CloudWatch, Datadog, Cloud Logging/Error Reporting, Loki and
  most platforms ingest this as-is.
- **Access log:** one `type: "access"` line per request, with `requestId`,
  `method`, `path` (no query string), `status`, `durationMs`, `bytes`, `ip`,
  `userId` and `userAgent`. 5xx requests are logged at warn. Turn it off
  with `ACCESS_LOG=false`.
- **Errors:** every 5xx produces a `type: "error"` line with the request
  context and the full (redacted) stack. The client gets the same
  `requestId`, so a support ticket leads straight to the log line.
  Unhandled promise rejections are logged. Uncaught exceptions are logged
  as `fatal` and the process exits, so the platform restarts it. Existing
  log calls in the background jobs (holds, payments, notifications) use the
  same format.
- **Alerting:** set `ERROR_WEBHOOK_URL` to receive a JSON POST for each
  error, deduplicated per error for 60 seconds. It includes a
  Slack-compatible `text` field. Alternatively, alert on
  `severity >= ERROR` in your log platform.
- Suggested alerts:
  - any `fatal`
  - an error rate above normal
  - `Rejected PayMongo webhook` warnings, which mean misconfiguration or
    probing
  - notifications stuck `pending` for more than 5 minutes

## Container image

The root [`Dockerfile`](../Dockerfile) builds one image (Node 22 Alpine,
about 280 MB) that serves the API and the web app on port 3000. It runs as
the non-root `node` user and has a built-in health check on `/api/health`.
It contains no configuration or secrets: `.env` files, keys and
certificates are excluded by `.dockerignore`. Any container host can run it,
for example Render, Fly.io, Railway, Google Cloud Run, AWS ECS/App Runner,
Azure Container Apps or Kubernetes.

```sh
docker build -t picksched .
# release step (same image, production environment + MIGRATION_DATABASE_URL)
docker run --rm --env-file prod.env picksched npm run migrate -w api
docker run --rm --env-file prod.env picksched npm run preflight -w api
# serve
docker run -d -p 3000:3000 --env-file prod.env picksched
```

`prod.env` here stands for your platform's way of injecting environment
variables. Prefer its secret store, or mount secrets as files and use
`NAME_FILE`. The image defaults to `NODE_ENV=production`; set
`APP_ENV=staging` for staging.

Verified locally: the image built, then migrate, preflight and the server
all ran in containers. The database connection used `verify-full` TLS with
an unprivileged role and secrets mounted as files. The health check reported
`healthy`, the security headers and HTTP→HTTPS redirect were present,
sign-up worked, and `docker stop` shut down cleanly (exit 0).

## Release procedure

1. Build the image (or `npm ci && npm run build` and serve with
   `WEB_DIST=web/dist node api/dist/server.js`).
2. `npm run migrate -w api`, with `MIGRATION_DATABASE_URL`.
3. `APP_ENV=production npm run preflight -w api`, with production's
   environment. It validates the configuration and checks the database:
   TLS and certificate, pooled connections, an unprivileged role, RLS and
   migrations. Example from a verified run:

   ```
   Configuration
     ✔ valid for production
     ✔ PayMongo: live keys
   Database
     ✔ encrypted with TLSv1.3, server certificate verified
     ✔ connection pool: 5 concurrent connections opened (max 20)
     ✔ login role "picksched_api" is unprivileged
     ✔ can act as picksched_app (row-level security applies)
     ✔ all 7 migrations applied
   Preflight passed
   ```

4. Start the new version. Point the load balancer's health check at
   `GET /api/health`. On `SIGTERM` the server stops accepting connections,
   stops the background jobs, waits for in-progress notification sends and
   closes its database connections.

## Launch checklist

- [ ] Production secrets are in the secret store, and none are in the
      repository (`npm run check:secrets -- --history`)
- [ ] PayMongo: live secret key, and a live webhook to
      `https://<domain>/api/webhooks/paymongo` with its signing secret
      ([payments.md](payments.md))
- [ ] SendGrid: verified sender domain (SPF/DKIM), production API key with
      Mail Send permission only
- [ ] Twilio: production account, Messaging Service, and
      `TWILIO_STATUS_CALLBACK_URL` set
- [ ] Database:
      - TLS with `verify-full`
      - `picksched_api` role created and granted `picksched_app`
      - backups and point-in-time recovery enabled
- [ ] `APP_BASE_URL` is the public HTTPS origin, and TLS is terminated at
      the load balancer with a valid certificate
- [ ] `npm run preflight -w api` passes with production's environment
- [ ] Log shipping and alerts set up (and `ERROR_WEBHOOK_URL` if used)
- [ ] The [manual staging script](qa/manual-test-script.md) passed on staging
- [ ] After launch, check https://securityheaders.com (or `curl -I`) shows
      the headers above. Consider HSTS preload once all subdomains serve HTTPS
