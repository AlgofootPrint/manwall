import fs from "node:fs";
import path from "node:path";

const reportDir = path.resolve("data", "reports");

function ensureStore() {
  fs.mkdirSync(reportDir, { recursive: true });
}

export function saveReport(report: { scanId: string }) {
  ensureStore();
  fs.writeFileSync(path.join(reportDir, `${report.scanId}.json`), JSON.stringify(report, null, 2));
}

export function getReport(scanId: string) {
  ensureStore();
  const file = path.join(reportDir, `${scanId.replace(/[^A-Z0-9-]/gi, "")}.json`);
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : null;
}

export function listReports() {
  ensureStore();
  return fs.readdirSync(reportDir)
    .filter((file) => file.endsWith(".json"))
    .map((file) => JSON.parse(fs.readFileSync(path.join(reportDir, file), "utf8")))
    .sort((a, b) => String(b.createdAt ?? b.completedAt).localeCompare(String(a.createdAt ?? a.completedAt)))
    .slice(0, 25);
}
