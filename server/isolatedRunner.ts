import { spawn } from "node:child_process";
import type { ScanJob } from "./jobStore.js";

const image = process.env.SCAN_RUNNER_IMAGE ?? "manwall-scan-runner:local";
const timeoutMs = Number(process.env.SCAN_RUNNER_TIMEOUT_MS ?? 180_000);

function docker(args: string[], containerName: string, timeout = timeoutMs): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("docker", args, { windowsHide: true, shell: false });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      spawn("docker", ["kill", containerName], { windowsHide: true, shell: false });
      child.kill();
      reject(new Error("Isolated runner timed out."));
    }, timeout);
    child.stdout.on("data", (data) => { stdout += String(data); });
    child.stderr.on("data", (data) => { stderr += String(data); });
    child.once("error", reject);
    child.once("exit", (code) => {
      clearTimeout(timer);
      code === 0 ? resolve(stdout.trim()) : reject(new Error(stderr.trim() || `docker exited with ${code}`));
    });
  });
}

const restrictions = [
  "--rm",
  "--read-only",
  "--user", "1000:1000",
  "--cap-drop", "ALL",
  "--security-opt", "no-new-privileges",
  "--cpus", "1",
  "--memory", "1g",
  "--memory-swap", "1g",
  "--pids-limit", "128",
  "--env", "HOME=/tmp",
  "--tmpfs", "/tmp:rw,noexec,nosuid,size=128m"
];

export async function runIsolatedRepositoryScan(job: ScanJob) {
  const cloneContainer = `manwall-${job.id.toLowerCase()}-clone`;
  const scanContainer = `manwall-${job.id.toLowerCase()}-scan`;
  const volume = `manwall-${job.id.toLowerCase()}-workspace`;

  await docker(["volume", "create", volume], cloneContainer);
  try {
    await docker([
      "run", ...restrictions,
      "--name", cloneContainer,
      "--network", "bridge",
      "--mount", `type=volume,source=${volume},target=/workspace`,
      image, "clone", job.repository
    ], cloneContainer);

    const result = await docker([
      "run", ...restrictions,
      "--name", scanContainer,
      "--network", "none",
      "--mount", `type=volume,source=${volume},target=/workspace,readonly`,
      image, "scan"
    ], scanContainer);
    return JSON.parse(result) as NonNullable<ScanJob["result"]>;
  } finally {
    await docker(["volume", "rm", "-f", volume], scanContainer);
  }
}
