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

## Deployment blockers

- Railway CLI authentication must be completed interactively with
  `railway login`.
- A dedicated Linux Docker worker host and its provider/account must be chosen.
- A production Cloudflare R2 bucket and scoped S3 credentials must be created.
- Production PostgreSQL and S3 credentials must replace all local defaults.
- The scan-runner image must be published to a private registry accessible by
  the worker host.

## Safety requirements

- Never mount the Docker socket into the public API service.
- Keep the controlled Ganache proof demo disabled in production.
- Keep `INLINE_REPOSITORY_JOBS=false` in production.
- Restrict worker host access and run no unrelated workloads on it.
- Complete the hardening backlog before scanning untrusted third-party
  repositories publicly.
