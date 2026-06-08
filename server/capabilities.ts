import { spawn } from "node:child_process";
import { infrastructureStatus } from "./infrastructure.js";

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
  const [docker, forge, slither, infrastructure] = await Promise.all([
    commandAvailable("docker", ["version"]),
    runnerToolAvailable("forge"),
    runnerToolAvailable("slither"),
    infrastructureStatus()
  ]);

  return [
    { id: "source-triage", name: "Solidity source triage", status: "ready", detail: "Compiler and transparent detectors are available." },
    { id: "verified-demo", name: "Executable proof demo", status: "ready", detail: "Controlled exploit and replay pipeline is available." },
    { id: "repository-scan", name: "GitHub repository scanning", status: docker ? "ready" : "unavailable", detail: docker ? "Restricted clone and no-network analysis containers are available." : "Docker daemon is not reachable." },
    { id: "isolated-runner", name: "Docker isolation", status: docker ? "ready" : "unavailable", detail: docker ? "Docker daemon is reachable." : "Docker daemon is not reachable." },
    { id: "foundry", name: "Foundry exploit and invariant tests", status: forge ? "ready" : "unavailable", detail: forge ? "Forge is installed in the isolated runner." : "Build the isolated runner with Foundry." },
    { id: "slither", name: "Slither static analysis", status: slither ? "ready" : "unavailable", detail: slither ? "Slither is installed in the isolated runner." : "Build the isolated runner with Slither." },
    { id: "database", name: "PostgreSQL metadata storage", status: infrastructure.databaseReady ? "ready" : "configuration-required", detail: infrastructure.databaseReady ? "PostgreSQL is reachable." : "Set DATABASE_URL and initialize the schema." },
    { id: "object-storage", name: "Evidence object storage", status: infrastructure.objectStoreReady ? "ready" : "configuration-required", detail: infrastructure.objectStoreReady ? "The evidence bucket is reachable." : "Configure S3-compatible evidence storage." },
    { id: "github-pr", name: "GitHub remediation pull requests", status: process.env.GITHUB_TOKEN ? "ready" : "configuration-required", detail: process.env.GITHUB_TOKEN ? "GitHub token is configured." : "Set GITHUB_TOKEN with scoped repository permissions." },
    { id: "telegram", name: "Telegram alerts and approvals", status: process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID ? "ready" : "configuration-required", detail: process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID ? "Telegram bot is configured." : "Set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID." },
    { id: "mantle-attestation", name: "Mantle Sepolia attestations", status: process.env.MANTLE_PRIVATE_KEY && process.env.ATTESTATION_REGISTRY_ADDRESS ? "ready" : "configuration-required", detail: process.env.MANTLE_PRIVATE_KEY && process.env.ATTESTATION_REGISTRY_ADDRESS ? "Publisher key and registry address are configured." : "Set MANTLE_PRIVATE_KEY and ATTESTATION_REGISTRY_ADDRESS after deploying the reviewed registry." }
  ];
}
