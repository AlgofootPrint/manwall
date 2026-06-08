import fs from "node:fs";
import path from "node:path";

export interface ScanJob {
  id: string;
  type: "repository-scan";
  status: "queued" | "running" | "completed" | "failed";
  repository: string;
  createdAt: string;
  updatedAt: string;
  error?: string;
  result?: {
    commit: string;
    filesScanned: number;
    findings: number;
    reports: unknown[];
  };
}

const jobDir = path.resolve("data", "jobs");
const safeId = (id: string) => id.replace(/[^A-Z0-9-]/gi, "");

function ensureStore() {
  fs.mkdirSync(jobDir, { recursive: true });
}

export function saveJob(job: ScanJob) {
  ensureStore();
  fs.writeFileSync(path.join(jobDir, `${safeId(job.id)}.json`), JSON.stringify(job, null, 2));
}

export function getJob(id: string): ScanJob | null {
  ensureStore();
  const file = path.join(jobDir, `${safeId(id)}.json`);
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : null;
}

export function listJobs(): ScanJob[] {
  ensureStore();
  return fs.readdirSync(jobDir)
    .filter((file) => file.endsWith(".json"))
    .map((file) => JSON.parse(fs.readFileSync(path.join(jobDir, file), "utf8")))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, 25);
}
