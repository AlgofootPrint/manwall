import fs from "node:fs";
import path from "node:path";
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
  "--tmpfs", "/tmp:rw,noexec,nosuid,size=128m"
];

export async function runIsolatedRepositoryScan(job: ScanJob) {
  const jobRoot = path.resolve("data", "workspaces", job.id);
  const repositoryRoot = path.join(jobRoot, "repository");
  const outputRoot = path.join(jobRoot, "output");
  fs.mkdirSync(jobRoot, { recursive: true });
  fs.mkdirSync(outputRoot, { recursive: true });

  const cloneContainer = `manwall-${job.id.toLowerCase()}-clone`;
  const scanContainer = `manwall-${job.id.toLowerCase()}-scan`;

  await docker([
    "run", ...restrictions,
    "--name", cloneContainer,
    "--network", "bridge",
    "--mount", `type=bind,source=${jobRoot},target=/workspace`,
    image, "clone", job.repository
  ], cloneContainer);

  await docker([
    "run", ...restrictions,
    "--name", scanContainer,
    "--network", "none",
    "--mount", `type=bind,source=${repositoryRoot},target=/workspace/repository,readonly`,
    "--mount", `type=bind,source=${outputRoot},target=/output`,
    image, "scan"
  ], scanContainer);

  return JSON.parse(fs.readFileSync(path.join(outputRoot, "result.json"), "utf8")) as NonNullable<ScanJob["result"]>;
}
