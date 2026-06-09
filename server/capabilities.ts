import { spawn } from "node:child_process";
import { getAiStatus } from "./ai.js";
import { infrastructureStatus, repositoryWorkerStatus } from "./infrastructure.js";
import { getGitHubRepositoryAccess } from "./github.js";

export interface Capability {
  id: string;
  name: string;
  status: "ready" | "configuration-required" | "unavailable";
  detail: string;
}

function commandAvailable(command: string, args: string[]) {
  return new Promise<boolean>((resolve) => {
    const child = spawn(command, args, { windowsHide: true, stdio: "ignore" });
    let settled = false;
    const finish = (available: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(available);
    };
    const timer = setTimeout(() => {
      child.kill();
      finish(false);
    }, 5_000);
    child.once("error", () => finish(false));
    child.once("exit", (code) => finish(code === 0));
  });
}

function runnerToolAvailable(tool: "forge" | "slither") {
  const image = process.env.SCAN_RUNNER_IMAGE ?? "manwall-scan-runner:local";
  return commandAvailable("docker", ["run", "--rm", "--network", "none", "--entrypoint", tool, image, "--version"]);
}

export async function getCapabilities(): Promise<Capability[]> {
  const [docker, forge, slither, infrastructure, worker, githubAccess, aiStatus] = await Promise.all([
    commandAvailable("docker", ["version"]),
    runnerToolAvailable("forge"),
    runnerToolAvailable("slither"),
    infrastructureStatus(),
    repositoryWorkerStatus(),
    getGitHubRepositoryAccess(),
    getAiStatus()
  ]);
  const repositoryScanReady = docker || worker.active;
  const foundryReady = forge || worker.tools.foundry;
  const slitherReady = slither || worker.tools.slither;

  const githubReady = Boolean(process.env.GITHUB_TOKEN && process.env.GITHUB_REPOSITORY)
    && githubAccess.accessible
    && githubAccess.pullRequestsReadable
    && githubAccess.actionsReadable
    && githubAccess.webhooksReadable
    && githubAccess.writable;

  return [
    { id: "source-triage", name: "Solidity source triage", status: "ready", detail: "Compiler and transparent detectors are available." },
    { id: "verified-demo", name: "Executable proof demo", status: "ready", detail: "Controlled exploit and replay pipeline is available." },
    { id: "mantle-gas", name: "Mantle live gas estimates", status: process.env.MANTLE_RPC_URL ? "ready" : "configuration-required", detail: process.env.MANTLE_RPC_URL ? "Measured proof gas is priced with live Mantle Sepolia gas price and base-fee data." : "Set MANTLE_RPC_URL to enable live Mantle fee estimates." },
    { id: "repository-scan", name: "GitHub repository scanning", status: repositoryScanReady ? "ready" : "unavailable", detail: docker ? "Restricted clone and no-network analysis containers are available locally." : worker.detail },
    { id: "isolated-runner", name: "Docker isolation", status: repositoryScanReady ? "ready" : "unavailable", detail: docker ? "Docker daemon is reachable locally." : worker.active ? "A separate isolated repository worker recently processed jobs." : worker.detail },
    { id: "foundry", name: "Foundry exploit and invariant tests", status: foundryReady ? "ready" : "unavailable", detail: foundryReady ? "Foundry is available in the isolated runner." : "Build the isolated runner with Foundry." },
    { id: "slither", name: "Slither static analysis", status: slitherReady ? "ready" : "unavailable", detail: slitherReady ? "Slither is available in the isolated runner." : "Build the isolated runner with Slither." },
    { id: "database", name: "PostgreSQL metadata storage", status: infrastructure.databaseReady ? "ready" : "configuration-required", detail: infrastructure.databaseReady ? "PostgreSQL is reachable." : "Set DATABASE_URL and initialize the schema." },
    { id: "object-storage", name: "Evidence object storage", status: infrastructure.objectStoreReady ? "ready" : "configuration-required", detail: infrastructure.objectStoreReady ? "The evidence bucket is reachable." : "Configure S3-compatible evidence storage." },
    {
      id: "github-pr",
      name: "GitHub remediation pull requests",
      status: githubReady ? "ready" : "configuration-required",
      detail: githubReady
        ? `GitHub access verified for ${githubAccess.repository}.`
        : githubAccess.detail
    },
    {
      id: "openai",
      name: "OpenAI analysis workflow",
      status: aiStatus.ready ? "ready" : "configuration-required",
      detail: aiStatus.ready
        ? `${aiStatus.provider} configured for ${aiStatus.model} with ${aiStatus.remainingUsd.toFixed(2)} USD remaining estimate.`
        : aiStatus.detail
    },
    {
      id: "telegram",
      name: "Telegram alerts and approvals",
      status: process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID && process.env.TELEGRAM_WEBHOOK_SECRET && process.env.TELEGRAM_APPROVER_USER_IDS ? "ready" : "configuration-required",
      detail: process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID && process.env.TELEGRAM_WEBHOOK_SECRET && process.env.TELEGRAM_APPROVER_USER_IDS
        ? "Telegram notifications and one-time approvals are configured."
        : "Set Telegram bot, chat, webhook secret, and approver user IDs."
    },
    { id: "mantle-attestation", name: "Mantle Sepolia attestations", status: process.env.MANTLE_PRIVATE_KEY && process.env.ATTESTATION_REGISTRY_ADDRESS ? "ready" : "configuration-required", detail: process.env.MANTLE_PRIVATE_KEY && process.env.ATTESTATION_REGISTRY_ADDRESS ? "User wallet approval is verified; Manwall publisher wallet pays gas and submits the public transaction." : "Set MANTLE_PRIVATE_KEY and ATTESTATION_REGISTRY_ADDRESS after deploying the reviewed registry." }
  ];
}
