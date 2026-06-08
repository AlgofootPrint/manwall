import crypto from "node:crypto";
import { saveJob, type ScanJob } from "./jobStore.js";
import { runIsolatedRepositoryScan } from "./isolatedRunner.js";

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

export async function runRepositoryScan(job: ScanJob) {
  job.status = "running";
  job.updatedAt = new Date().toISOString();
  await saveJob(job);
  try {
    job.result = await runIsolatedRepositoryScan(job);
    job.status = "completed";
  } catch (reason) {
    job.status = "failed";
    job.error = reason instanceof Error ? reason.message : "Repository scan failed";
  } finally {
    job.updatedAt = new Date().toISOString();
    await saveJob(job);
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
