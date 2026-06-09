# manwall

manwall is an evidence-first smart-contract security engineer built for the Mantle Turing Test Hackathon. It coordinates specialist agents that discover a vulnerability, prove it with an executable exploit, create a patch, replay the exploit, measure gas impact, surface Mantle-specific gas optimization guidance, and publish identity-bound validation evidence on-chain.

## Demo

```bash
npm install
npm run test
npm run dev
```

Open `http://localhost:3000` and select **Run Live Scan**.

The live proof uses a local EVM configured with Mantle Sepolia's chain ID (`5003`) so the complete workflow is deterministic and does not require testnet funds. Configure `.env` with a funded `MANTLE_PRIVATE_KEY` to extend deployment to Mantle Sepolia.

## Evidence Standards

manwall exposes two intentionally separate workflows:

- **Source triage** accepts arbitrary Solidity, compiles it, and runs transparent detectors. Results are heuristic and always marked `unverified`.
- **Gas optimization triage** flags reviewable Solidity gas improvements such as calldata parameters, cached loop lengths, custom errors, immutable configuration, and unchecked loop increments. These are optimization hints, not vulnerability proofs.
- **Mantle live fee analysis** measures equivalent proof transactions before and after a patch, reads live Mantle Sepolia gas price and base-fee data, and reports estimated MNT costs with the sampled block. Manwall reports when nonstandard rollup fee methods are unavailable rather than inventing them.
- **Source-specific reentrancy proof** executes the exact submitted source when it matches the bounded supported vault interface: one deployable contract, payable `deposit()`, `withdraw()`, no constructor arguments, and the detected interaction-before-effect pattern. Manwall executes an attacker, applies a deterministic checks-effects-interactions patch, and replays the same attack.
- **Verified proof demo** executes the predefined vulnerable-vault pipeline when no eligible analyzed source is selected.

manwall does not claim that heuristic findings are confirmed vulnerabilities, that generated remediations are production-safe, or that it replaces a professional audit.

Verified proof runs use one evidence standard across all seven stages. The
Architecture, Attack, Patch, and Attestation stages emit expandable,
cryptographically hashed artifacts: an architecture manifest, executable attack
plan, reviewable patch diff, and canonical proof manifest. The Exploit and
Verification stages execute transactions, while the Gas stage records measured
execution gas and live Mantle Sepolia fee estimates. The final evidence hash
commits to the complete proof manifest.

Every report is persisted under `data/reports` and is retrievable through:

- `POST /api/analyze` for arbitrary Solidity source triage
- `POST /api/scan` for the controlled executable proof
- `GET /api/reports` for recent reports
- `GET /api/reports/:scanId` for a specific evidence record
- `GET /api/capabilities` for live integration readiness
- `POST /api/wallet/scan` for free Mantle Sepolia wallet posture and approval exposure checks
- `POST /api/jobs/repository` to scan a public GitHub repository
- `GET /api/jobs/:jobId` to retrieve durable repository job results
- `GET /api/ai/status` for OpenAI budget and readiness
- `POST /api/ai/review` for OpenAI-assisted security analysis
- `POST /api/ai/patch` for approval-gated patch drafts
- `GET /api/ai/audit` for local AI audit history
- `POST /api/github/remediation-pr` for authenticated, approval-gated draft remediation PRs
- `POST /api/attestations/publish` for authenticated, approval-gated Mantle Sepolia publication
- `POST /api/approvals/telegram` for one-time, exact-payload Telegram approval requests
- `POST /api/telegram/webhook` for authenticated Telegram approval callbacks
- `GET /api/auth/github` and `GET /api/auth/me` for GitHub OAuth sessions
- `GET /api/operations/audit` for authenticated operational audit history
- `POST /api/admin/team-authorization` for admin-managed team repository access

Repository jobs accept one or more public `https://github.com/owner/repository`
URLs. Production submissions are limited to `GITHUB_REPOSITORY`,
comma/newline-separated `MANTLE_MONITORED_REPOSITORIES`, or team-authorized
repositories. A restricted clone container fetches a shallow snapshot, then a
separate no-network container runs Manwall source triage, Slither, and available
Foundry tests with a read-only root filesystem, dropped Linux capabilities, and
CPU, memory, process, and timeout limits. Normalized results record the scanned
commit and persist under `data/jobs`, PostgreSQL, and configured S3 evidence
storage.

To accept GitHub webhooks, set `GITHUB_WEBHOOK_SECRET` and register `POST /api/github/webhook` in the repository settings with push, pull request, and deployment events enabled. Manwall verifies the `X-Hub-Signature-256` header before accepting push, relevant pull request, and created deployment events.

The initial Mantle monitoring set is `mantle-lsp/contracts`,
`merchant-moe/moe-core`, `pendle-finance/pendle-core-v2-public`, and
`mantlenetworkio/mantle`. Add them to `MANTLE_MONITORED_REPOSITORIES`.
Because Manwall does not administer these external repositories, it monitors
them through read-only GitHub API polling. The production API records a durable
baseline and queues a scan when a default-branch commit, open pull request, or
deployment marker changes. Configure the interval with
`GITHUB_MONITOR_POLL_INTERVAL_MS`.

The repository status endpoint at `GET /api/github/status` reports whether the configured GitHub token can read the repository, list pull requests, read Actions runs, and list webhooks.

The AI workflow uses OpenAI and enforces a local monthly budget gate before making any request. AI patch generation is approval-gated and never auto-applies code changes.

The configured Telegram group can request a constrained draft documentation PR
with `/pr Title | Description`. Manwall generates a unique `manwall/telegram-*`
branch and a file under `docs/telegram/`, then requires an authorized Telegram
approver to approve the exact payload before creating the draft PR. Telegram
also exposes bounded Manwall workflows through a persistent Telegram button
menu. Tapping a button prompts the user for the required wallet, repository,
job ID, or Solidity source. Slash commands remain available as a fallback:

- Paste an EVM address or use `/wallet <address>` to scan Mantle wallet posture.
- Use `/scan <GitHub URL>` for monitored repositories and `/status <job-id>` for results.
- Use `/ai <completed job-id>` for an approver-only AI security review.
- Use `/analyze <Solidity source>` for static source triage.
- Use `/help` to display the command reference.

Repository scans retain the production hourly quota and execute in the isolated
VPS worker. Group users can scan monitored repositories; users listed in
`TELEGRAM_APPROVER_USER_IDS` can scan any valid public GitHub repository. AI
review remains restricted to `TELEGRAM_APPROVER_USER_IDS`.
When a regular user requests an unmonitored repository, Manwall posts an
approval-needed group alert and returns a direct link when the configured chat
is a Telegram supergroup or `TELEGRAM_GROUP_ALERT_URL` is configured. Legacy
basic groups do not support direct message links. The alert includes one-time
Approve and Reject buttons; approval queues that exact repository URL.
Telegram commands cannot edit application, server, or contract code.

Production repository submissions require an authenticated GitHub OAuth session
or `X-Manwall-Admin-Key`. Repository access is restricted to
`GITHUB_REPOSITORY` or a repository assigned through the team authorization
tables. Remediation PRs are always created as drafts and require
`approved: true`.

Build the local isolated runner before starting repository jobs:

```bash
docker build -f Dockerfile.runner -t manwall-scan-runner:local .
```

The runner pins Foundry to an immutable official image digest and includes
Slither `0.11.5`. Tool execution remains inside the restricted no-network
analysis container.

Start local PostgreSQL and S3-compatible evidence storage:

```bash
docker compose -f compose.infrastructure.yml up -d
```

PostgreSQL listens only on `127.0.0.1:5432`. MinIO's S3 endpoint and local
console listen only on `127.0.0.1:9000` and `127.0.0.1:9001`. The compose
defaults are local-development credentials and must not be used in production.

## Production Services

Production separates the public API from the Docker-enabled worker:

- `Dockerfile.api` serves the frontend and API, queues repository jobs, and never
  receives Docker socket access.
- `Dockerfile.worker` claims queued jobs from PostgreSQL and is the only service
  permitted to access the Docker daemon.
- `compose.production.yml` is a local production-parity deployment used to verify
  the split before configuring managed hosts.

Use strong non-default PostgreSQL and S3 credentials, then start:

```bash
docker compose --env-file .env -f compose.production.yml up -d --build
```

The API readiness endpoint is `GET /api/ready`. Public production deployment
requires separate API and worker hosts; do not mount the Docker socket into the
public API service.

Apply idempotent database migrations after each API deployment:

```bash
npm run migrate
```

Run production smoke checks with `MANWALL_BASE_URL` configured:

```bash
npm run smoke
```

PostgreSQL backup and restore helpers are available under `scripts/`. Test
restores regularly; an untested backup is not a recovery plan.

## Wallet Approval

The web interface supports MetaMask-compatible injected wallets:

- Connect and display the active account and MNT balance.
- Detect the current chain and add or switch to Mantle Sepolia (`5003`).
- Run a free wallet posture scan without requesting a signature or transaction.
- Sign a verified evidence record using an EIP-191 message signature.
- React to wallet account and network changes.

The free wallet scan checks public Mantle Sepolia state: native balance, account
activity, EOA vs contract wallet status, and configured ERC-20 token allowances
against `MANTLE_WALLET_SCAN_TOKENS` and `MANTLE_WALLET_SCAN_SPENDERS`.

Evidence approval costs no gas. For on-chain attestation publication, the
frontend asks the wallet to sign the exact scan ID, subject, evidence hash,
evidence URI, registry address, and Mantle Sepolia network. The backend verifies
that EIP-191 signature before publishing. Production always requires this valid
wallet signature; authenticated sessions and `approved: true` cannot bypass it.
After approval, Manwall's funded publisher wallet pays the Mantle Sepolia gas
and submits the publicly searchable attestation transaction.
The demo bypass is available only outside production when
`ALLOW_DEMO_ATTESTATION_APPROVAL=true`. Disconnecting clears manwall's local wallet state;
wallet-extension site permissions must be revoked from the wallet itself.

## Production Roadmap

Required before operating against production protocols:

1. Isolated container execution with strict CPU, memory, timeout, and network policies.
2. Repository ingestion through a scoped GitHub App.
3. Slither, Foundry fuzzing, invariant tests, and forked Mantle execution.
4. Human approval before patches, pull requests, deployments, or on-chain writes.
5. Authenticated teams, encrypted secrets, audit logs, and durable database/object storage.
6. Real Mantle Sepolia registry deployment followed by reviewed mainnet contracts.

## Integration Requirements

The dashboard reads `/api/capabilities` and reports live readiness. A feature is only shown as ready when its executable or required credentials are available.

| Capability | Requirement |
|---|---|
| Public repository scans | Git |
| Isolated arbitrary execution | Running Docker daemon |
| Foundry proofs, fuzzing, invariants, and forks | Foundry/Forge inside the isolated runner |
| Slither analysis | Slither inside the isolated runner |
| GitHub pull requests and monitoring | Scoped `GITHUB_TOKEN`, `GITHUB_REPOSITORY`, optional `MANTLE_MONITORED_REPOSITORIES`, and webhook secret |
| OpenAI review and patch drafts | `AI_PROVIDER=openai` and `OPENAI_API_KEY` |
| Telegram alerts and approvals | `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, `TELEGRAM_WEBHOOK_SECRET`, and `TELEGRAM_APPROVER_USER_IDS` |
| Mantle Sepolia publication | `MANTLE_PRIVATE_KEY` and `ATTESTATION_REGISTRY_ADDRESS` |

Dynamic exploit generation and automated patching must remain disabled until the isolated runner, Foundry, and Slither are available. Running generated security code directly on the API host is not an acceptable production design.

## Proof Pipeline

1. Architecture Agent maps the vault's asset and trust boundaries.
2. Attack Agent identifies interaction-before-effect reentrancy.
3. Exploit Agent deploys and executes `ReentrancyAttacker.sol`.
4. Patch Agent applies checks-effects-interactions and a reentrancy lock.
5. Verification Agent replays the original exploit against the patch.
6. Gas Agent measures the secured path and emits Mantle-aware optimization guidance.
7. Attestation Agent publishes the evidence hash to `GuardianAttestationRegistry`.

## Contracts

- `VulnerableVault.sol`: deliberately vulnerable demo protocol.
- `ReentrancyAttacker.sol`: executable adversarial proof.
- `SecuredVault.sol`: minimal verified remediation.
- `GuardianAttestationRegistry.sol`: ERC-8004-aligned identity and validation evidence registry.

## Mantle

- Mantle Sepolia chain ID: `5003`
- RPC: `https://rpc.sepolia.mantle.xyz`
- Explorer: `https://explorer.sepolia.mantle.xyz`
