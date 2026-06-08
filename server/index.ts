import "dotenv/config";
import cors from "cors";
import express from "express";
import path from "node:path";
import { z } from "zod";
import { getReport, listReports, saveReport } from "./reportStore.js";
import { analyzeSource } from "./sourceScanner.js";
import type { ScanReport } from "./types.js";
import { getCapabilities } from "./capabilities.js";
import { createRepositoryJob, runRepositoryScan } from "./repositoryScanner.js";
import { getJob, listJobs, saveJob } from "./jobStore.js";
import { infrastructureStatus } from "./infrastructure.js";

const app = express();
const port = Number(process.env.PORT ?? 8787);
const inlineRepositoryJobs = process.env.INLINE_REPOSITORY_JOBS ?? (process.env.NODE_ENV === "production" ? "false" : "true");
let latest: ScanReport | null = null;
let activeScan: Promise<ScanReport> | null = null;

app.use(cors());
app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.resolve("dist")));

app.get("/api/health", (_request, response) => {
  response.json({ ok: true, service: "manwall", network: "Mantle Sepolia", chainId: 5003 });
});

app.get("/api/ready", async (_request, response) => {
  const status = await infrastructureStatus();
  response.status(status.databaseReady && status.objectStoreReady ? 200 : 503).json(status);
});

app.get("/api/capabilities", async (_request, response) => response.json(await getCapabilities()));

app.get("/api/report", (_request, response) => {
  response.json(latest);
});

app.post("/api/scan", async (_request, response) => {
  if (process.env.NODE_ENV === "production") {
    response.status(404).json({ error: "Controlled proof demo is disabled in production." });
    return;
  }
  const { runGuardianScan } = await import("./guardian.js");
  activeScan ??= runGuardianScan().finally(() => { activeScan = null; });
  latest = await activeScan;
  await saveReport(latest);
  response.json(latest);
});

const sourceRequest = z.object({
  name: z.string().trim().min(1).max(120).regex(/\.sol$/),
  source: z.string().min(20).max(500_000)
});

app.post("/api/analyze", async (request, response) => {
  const parsed = sourceRequest.safeParse(request.body);
  if (!parsed.success) {
    response.status(400).json({ error: "Invalid Solidity source request", details: parsed.error.flatten() });
    return;
  }
  const report = analyzeSource(parsed.data.name, parsed.data.source);
  await saveReport(report);
  response.json(report);
});

app.get("/api/reports", async (_request, response) => response.json(await listReports()));

app.get("/api/reports/:scanId", async (request, response) => {
  const report = await getReport(request.params.scanId);
  if (!report) {
    response.status(404).json({ error: "Report not found" });
    return;
  }
  response.json(report);
});

const repositoryRequest = z.object({ repository: z.string().url().max(300) });

app.post("/api/jobs/repository", async (request, response) => {
  const parsed = repositoryRequest.safeParse(request.body);
  if (!parsed.success) {
    response.status(400).json({ error: "Invalid repository request", details: parsed.error.flatten() });
    return;
  }
  try {
    const job = createRepositoryJob(parsed.data.repository);
    await saveJob(job);
    if (inlineRepositoryJobs === "true") void runRepositoryScan(job);
    response.status(202).json(job);
  } catch (reason) {
    response.status(400).json({ error: reason instanceof Error ? reason.message : "Repository job rejected" });
  }
});

app.get("/api/jobs", async (_request, response) => response.json(await listJobs()));

app.get("/api/jobs/:jobId", async (request, response) => {
  const job = await getJob(request.params.jobId);
  if (!job) {
    response.status(404).json({ error: "Job not found" });
    return;
  }
  response.json(job);
});

app.get("*path", (_request, response) => {
  response.sendFile(path.resolve("dist", "index.html"));
});

app.listen(port, () => {
  console.log(`manwall API listening on http://localhost:${port}`);
});
