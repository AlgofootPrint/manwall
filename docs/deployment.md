# Manwall production deployment

## Selected architecture

- Public API and frontend: Railway service built from `Dockerfile.api`.
- Metadata database: Railway PostgreSQL on private networking.
- Evidence artifacts: Cloudflare R2 through its S3-compatible API.
- Isolated scan worker: dedicated Linux Docker host built from
  `Dockerfile.worker`.

The API and worker share PostgreSQL. The API only creates queued jobs. The
worker atomically claims queued jobs and is the only service with Docker daemon
access.

## Required production variables

API:

- `NODE_ENV=production`
- `PORT`
- `INLINE_REPOSITORY_JOBS=false`
- `DATABASE_URL`
- `S3_ENDPOINT`
- `S3_REGION=auto`
- `S3_BUCKET`
- `S3_ACCESS_KEY_ID`
- `S3_SECRET_ACCESS_KEY`
- `S3_FORCE_PATH_STYLE=true`

Worker:

- `NODE_ENV=production`
- `DATABASE_URL`
- `SCAN_RUNNER_IMAGE`
- `SCAN_RUNNER_TIMEOUT_MS`
- `WORKER_POLL_INTERVAL_MS`
- `WORKER_CONCURRENCY`
- `WORKER_JOB_MAX_ATTEMPTS`
- `CLONE_NETWORK`

Optional production integrations:

- `MANWALL_ADMIN_KEY`
- `GITHUB_TOKEN`, `GITHUB_REPOSITORY`, optional `MANTLE_MONITORED_REPOSITORIES`, `GITHUB_WEBHOOK_SECRET`
- `GITHUB_MONITOR_ENABLED=true`, `GITHUB_MONITOR_POLL_INTERVAL_MS=300000`
- `GITHUB_OAUTH_CLIENT_ID`, `GITHUB_OAUTH_CLIENT_SECRET`, `GITHUB_OAUTH_CALLBACK_URL`
- `OPENAI_API_KEY`
- `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`
- `MANTLE_PRIVATE_KEY`, `ATTESTATION_REGISTRY_ADDRESS`

## Deployment blockers

- Pending rollout: deploy the wallet-only attestation policy after Railway's
  free-tier window opens on June 9, 2026 at 7:00 PM Africa/Lagos
  (8:00 PM Europe/Amsterdam). Then run:

  ```bash
  railway up -s manwall-api -d
  MANWALL_BASE_URL=https://manwall-api-production.up.railway.app npm run smoke
  MANWALL_BASE_URL=https://manwall-api-production.up.railway.app npm run verify:attestation-policy
  ```

- Railway project `manwall`, service `manwall-api`, evidence bucket
  `manwall-evidence`, and public domain
  `https://manwall-api-production.up.railway.app` have been created.
- Railway free-tier deploys are blocked during peak hours
  (`8 AM - 8 PM Europe/Amsterdam`). Retry the API deploy off-peak with:
  `railway up -s manwall-api -d`.
- Railway PostgreSQL provisioning currently returns an authorization error
  despite valid CLI authentication. Retry off-peak or configure an external
  managed PostgreSQL provider.
- A dedicated Linux Docker worker host and its provider/account must be chosen.
- Production PostgreSQL and S3 credentials must replace all local defaults.
- The scan-runner image must be published to a private registry accessible by
  the worker host.

## Safety requirements

- Never mount the Docker socket into the public API service.
- Keep the controlled Ganache proof demo disabled in production.
- Keep `INLINE_REPOSITORY_JOBS=false` in production.
- Keep `ALLOW_DEMO_ATTESTATION_APPROVAL=false`. Production attestation
  publication always requires a valid wallet signature; authentication and
  `approved: true` do not bypass this policy.
- Restrict webhook monitoring to `GITHUB_REPOSITORY`,
  `MANTLE_MONITORED_REPOSITORIES`, or team-authorized repositories.
- Restrict worker host access and run no unrelated workloads on it.
- Complete the hardening backlog before scanning untrusted third-party
  repositories publicly.
- Run `npm run migrate` after deployments and `npm run smoke` after rollout.
