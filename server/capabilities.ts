import { spawn } from "node:child_process";

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

export async function getCapabilities(): Promise<Capability[]> {
  const [git, docker, forge, slither] = await Promise.all([
    commandAvailable("git", ["--version"]),
    commandAvailable("docker", ["version"]),
    commandAvailable("forge", ["--version"]),
    commandAvailable("slither", ["--version"])
  ]);

  return [
    { id: "source-triage", name: "Solidity source triage", status: "ready", detail: "Compiler and transparent detectors are available." },
    { id: "verified-demo", name: "Executable proof demo", status: "ready", detail: "Controlled exploit and replay pipeline is available." },
    { id: "repository-scan", name: "GitHub repository scanning", status: git ? "ready" : "unavailable", detail: git ? "Scoped public GitHub clone and Solidity analysis are available." : "Git is not installed." },
    { id: "isolated-runner", name: "Docker isolation", status: docker ? "ready" : "unavailable", detail: docker ? "Docker daemon is reachable." : "Docker daemon is not reachable." },
    { id: "foundry", name: "Foundry exploit and invariant tests", status: forge ? "ready" : "unavailable", detail: forge ? "Forge is installed." : "Install Foundry to enable arbitrary test execution." },
    { id: "slither", name: "Slither static analysis", status: slither ? "ready" : "unavailable", detail: slither ? "Slither is installed." : "Install Slither to enable production static analysis." },
    { id: "github-pr", name: "GitHub remediation pull requests", status: process.env.GITHUB_TOKEN ? "ready" : "configuration-required", detail: process.env.GITHUB_TOKEN ? "GitHub token is configured." : "Set GITHUB_TOKEN with scoped repository permissions." },
    { id: "telegram", name: "Telegram alerts and approvals", status: process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID ? "ready" : "configuration-required", detail: process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID ? "Telegram bot is configured." : "Set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID." },
    { id: "mantle-attestation", name: "Mantle Sepolia attestations", status: process.env.MANTLE_PRIVATE_KEY && process.env.ATTESTATION_REGISTRY_ADDRESS ? "ready" : "configuration-required", detail: process.env.MANTLE_PRIVATE_KEY && process.env.ATTESTATION_REGISTRY_ADDRESS ? "Publisher key and registry address are configured." : "Set MANTLE_PRIVATE_KEY and ATTESTATION_REGISTRY_ADDRESS after deploying the reviewed registry." }
  ];
}
