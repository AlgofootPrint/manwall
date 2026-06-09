import fs from "node:fs";
import path from "node:path";
import { getJobRecord, listJobRecords, saveJobRecord } from "./infrastructure.js";

export interface ScanJob {
  id: string;
  type: "repository-scan";
  status: "queued" | "running" | "completed" | "failed";
  repository: string;
  createdAt: string;
  updatedAt: string;
  attempts?: number;
  maxAttempts?: number;
  error?: string;
  result?: {
    commit: string;
    filesScanned: number;
    findings: number;
    summary?: {
      securityFindings: number;
      gasOptimizations: number;
      compilationFailures: number;
      toolFailures: number;
    };
    reports: unknown[];
    tools?: {
      compilation?: ToolResult;
      slither: ToolResult;
      foundry: ToolResult;
    };
  };
}

export interface ToolResult {
  status: "passed" | "blocked" | "failed" | "skipped";
  findings: number;
  summary: string;
  output: string;
}

const jobDir = path.resolve("data", "jobs");
const safeId = (id: string) => id.replace(/[^A-Z0-9-]/gi, "");

function ensureStore() {
  fs.mkdirSync(jobDir, { recursive: true });
}

export async function saveJob(job: ScanJob) {
  ensureStore();
  fs.writeFileSync(path.join(jobDir, `${safeId(job.id)}.json`), JSON.stringify(job, null, 2));
  await saveJobRecord(job);
}

export async function getJob(id: string): Promise<ScanJob | null> {
  const stored = await getJobRecord(id);
  if (stored) return stored;
  ensureStore();
  const file = path.join(jobDir, `${safeId(id)}.json`);
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : null;
}

export async function listJobs(): Promise<ScanJob[]> {
  const stored = await listJobRecords();
  if (stored) return stored.filter(Boolean);
  ensureStore();
  return fs.readdirSync(jobDir)
    .filter((file) => file.endsWith(".json"))
    .map((file) => JSON.parse(fs.readFileSync(path.join(jobDir, file), "utf8")))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, 25);
}
