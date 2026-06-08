import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { analyzeSource } from "./sourceScanner.js";
import { saveJob, type ScanJob } from "./jobStore.js";

const workRoot = path.resolve("data", "workspaces");
const maxFiles = 250;
const maxSourceBytes = 500_000;

function run(command: string, args: string[], cwd?: string, timeoutMs = 120_000): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, windowsHide: true, shell: false });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`${command} timed out`));
    }, timeoutMs);
    child.stdout.on("data", (data) => { stdout += String(data); });
    child.stderr.on("data", (data) => { stderr += String(data); });
    child.once("error", reject);
    child.once("exit", (code) => {
      clearTimeout(timer);
      code === 0 ? resolve(stdout.trim()) : reject(new Error(stderr.trim() || `${command} exited with ${code}`));
    });
  });
}

export function validateRepository(repository: string) {
  const url = new URL(repository);
  if (url.protocol !== "https:" || url.hostname !== "github.com") {
    throw new Error("Only public GitHub HTTPS repository URLs are accepted.");
  }
  const segments = url.pathname.replace(/\.git$/, "").split("/").filter(Boolean);
  if (segments.length !== 2 || !segments.every((part) => /^[A-Za-z0-9_.-]+$/.test(part))) {
    throw new Error("Repository URL must use https://github.com/owner/repository.");
  }
  return `https://github.com/${segments[0]}/${segments[1]}.git`;
}

function solidityFiles(root: string) {
  const files: string[] = [];
  const visit = (directory: string) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if ([".git", "node_modules", "lib", "out", "cache", "artifacts"].includes(entry.name)) continue;
      const fullPath = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(fullPath);
      else if (entry.isFile() && entry.name.endsWith(".sol")) files.push(fullPath);
      if (files.length > maxFiles) throw new Error(`Repository exceeds the ${maxFiles} Solidity file limit.`);
    }
  };
  visit(root);
  return files;
}

export async function runRepositoryScan(job: ScanJob) {
  job.status = "running";
  job.updatedAt = new Date().toISOString();
  saveJob(job);
  const workspace = path.join(workRoot, job.id);

  try {
    fs.mkdirSync(workRoot, { recursive: true });
    await run("git", ["clone", "--depth", "1", "--filter=blob:none", job.repository, workspace], undefined, 180_000);
    const commit = await run("git", ["rev-parse", "HEAD"], workspace);
    const files = solidityFiles(workspace);
    const reports = files.map((file) => {
      const source = fs.readFileSync(file, "utf8");
      if (Buffer.byteLength(source) > maxSourceBytes) throw new Error(`${path.basename(file)} exceeds source size limit.`);
      return analyzeSource(path.relative(workspace, file).replaceAll("\\", "/"), source);
    });
    job.status = "completed";
    job.result = {
      commit,
      filesScanned: files.length,
      findings: reports.reduce((total, report) => total + report.findings.length, 0),
      reports
    };
  } catch (reason) {
    job.status = "failed";
    job.error = reason instanceof Error ? reason.message : "Repository scan failed";
  } finally {
    job.updatedAt = new Date().toISOString();
    saveJob(job);
  }
}

export function createRepositoryJob(repository: string): ScanJob {
  const now = new Date().toISOString();
  return {
    id: `JOB-${crypto.randomBytes(4).toString("hex").toUpperCase()}`,
    type: "repository-scan",
    status: "queued",
    repository: validateRepository(repository),
    createdAt: now,
    updatedAt: now
  };
}
