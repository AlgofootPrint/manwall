import fs from "node:fs";
import path from "node:path";
import { getReportRecord, listReportRecords, saveReportRecord } from "./infrastructure.js";

const reportDir = path.resolve("data", "reports");

function ensureStore() {
  fs.mkdirSync(reportDir, { recursive: true });
}

export async function saveReport(report: { scanId: string; createdAt?: string; completedAt?: string }) {
  ensureStore();
  fs.writeFileSync(path.join(reportDir, `${report.scanId}.json`), JSON.stringify(report, null, 2));
  await saveReportRecord(report);
}

export async function getReport(scanId: string) {
  const stored = await getReportRecord(scanId);
  if (stored) return stored;
  ensureStore();
  const file = path.join(reportDir, `${scanId.replace(/[^A-Z0-9-]/gi, "")}.json`);
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : null;
}

export async function listReports() {
  const stored = await listReportRecords();
  if (stored) return stored;
  ensureStore();
  return fs.readdirSync(reportDir)
    .filter((file) => file.endsWith(".json"))
    .map((file) => JSON.parse(fs.readFileSync(path.join(reportDir, file), "utf8")))
    .sort((a, b) => String(b.createdAt ?? b.completedAt).localeCompare(String(a.createdAt ?? a.completedAt)))
    .slice(0, 25);
}
