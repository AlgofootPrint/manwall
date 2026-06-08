# manwall

manwall is an evidence-first smart-contract security engineer built for the Mantle Turing Test Hackathon. It coordinates specialist agents that discover a vulnerability, prove it with an executable exploit, create a patch, replay the exploit, measure gas impact, and publish identity-bound validation evidence on-chain.

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
- **Verified proof demo** executes a controlled exploit, applies a controlled patch, and replays the exploit. Only this workflow currently produces a confirmed proof.

manwall does not claim that heuristic findings are confirmed vulnerabilities, that generated remediations are production-safe, or that it replaces a professional audit.

Every report is persisted under `data/reports` and is retrievable through:

- `POST /api/analyze` for arbitrary Solidity source triage
- `POST /api/scan` for the controlled executable proof
- `GET /api/reports` for recent reports
- `GET /api/reports/:scanId` for a specific evidence record
- `GET /api/capabilities` for live integration readiness
- `POST /api/jobs/repository` to scan a public GitHub repository
- `GET /api/jobs/:jobId` to retrieve durable repository job results

Repository jobs accept only public `https://github.com/owner/repository` URLs. A restricted clone container fetches a shallow snapshot, then a separate no-network container scans it with a read-only root filesystem, dropped Linux capabilities, and CPU, memory, process, and timeout limits. Results record the scanned commit and persist under `data/jobs`.

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

## Wallet Approval

The web interface supports MetaMask-compatible injected wallets:

- Connect and display the active account and MNT balance.
- Detect the current chain and add or switch to Mantle Sepolia (`5003`).
- Sign a verified evidence record using an EIP-191 message signature.
- React to wallet account and network changes.

Evidence approval costs no gas and does not submit a transaction. The signed message includes the scan ID, evidence hash, and Mantle Sepolia network. Disconnecting clears manwall's local wallet state; wallet-extension site permissions must be revoked from the wallet itself.

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
| GitHub pull requests | Scoped `GITHUB_TOKEN` and repository installation |
| Telegram alerts and approvals | `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` |
| Mantle Sepolia publication | `MANTLE_PRIVATE_KEY` and `ATTESTATION_REGISTRY_ADDRESS` |

Dynamic exploit generation and automated patching must remain disabled until the isolated runner, Foundry, and Slither are available. Running generated security code directly on the API host is not an acceptable production design.

## Proof Pipeline

1. Architecture Agent maps the vault's asset and trust boundaries.
2. Attack Agent identifies interaction-before-effect reentrancy.
3. Exploit Agent deploys and executes `ReentrancyAttacker.sol`.
4. Patch Agent applies checks-effects-interactions and a reentrancy lock.
5. Verification Agent replays the original exploit against the patch.
6. Gas Agent measures the secured path.
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
