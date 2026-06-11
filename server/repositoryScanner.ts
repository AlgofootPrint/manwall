import crypto from "node:crypto";
import { saveJob, type ScanJob } from "./jobStore.js";
import { runIsolatedRepositoryScan } from "./isolatedRunner.js";
import { sendTelegram } from "./notifications.js";
import { writeOperationAudit } from "./infrastructure.js";

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
    job.error = reason instanceof Error ? reason.message : "Repository scan failed";
    job.status = (job.attempts ?? 0) < (job.maxAttempts ?? 3) ? "queued" : "failed";
  } finally {
    job.updatedAt = new Date().toISOString();
    await saveJob(job);
    await writeOperationAudit("worker", "repository.scan", job.id, job.status, {
      repository: job.repository,
      attempts: job.attempts ?? 0,
      error: job.error
    });
    if (job.status === "completed" || job.status === "failed") {
      await sendTelegram(`scan.${job.status}`, `${job.id} ${job.status}: ${job.repository}`).catch(() => {});
    }
  }
}

export async function queueRepositoryJob(job: ScanJob) {
  await saveJob(job);
  const inlineRepositoryJobs = process.env.INLINE_REPOSITORY_JOBS ?? (process.env.NODE_ENV === "production" ? "false" : "true");
  if (inlineRepositoryJobs === "true") void runRepositoryScan(job);
}

export function createRepositoryJob(repository: string): ScanJob {
  const now = new Date().toISOString();
  return {
    id: `JOB-${crypto.randomBytes(4).toString("hex").toUpperCase()}`,
    type: "repository-scan",
    status: "queued",
    repository: validateRepository(repository),
    createdAt: now,
    updatedAt: now,
    maxAttempts: Number(process.env.WORKER_JOB_MAX_ATTEMPTS ?? 3)
  };
}
