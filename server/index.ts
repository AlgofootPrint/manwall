import "dotenv/config";
import cors from "cors";
import express from "express";
import type { Request } from "express";
import path from "node:path";
import { z } from "zod";
import { getReport, listReports, saveReport } from "./reportStore.js";
import { analyzeSource } from "./sourceScanner.js";
import type { ScanReport } from "./types.js";
import { getCapabilities } from "./capabilities.js";
import { createRepositoryJob, runRepositoryScan } from "./repositoryScanner.js";
import { getJob, listJobs, saveJob } from "./jobStore.js";
import { configureTeamAuthorization, infrastructureStatus, listOperationAudits, recentRepositoryJobCount, writeOperationAudit } from "./infrastructure.js";
import { acceptGitHubWebhook, createRemediationPullRequest, getGitHubRepositoryAccess, verifyGitHubWebhookSignature } from "./github.js";
import { getAiStatus, listAiAuditLogs, runAiWorkflow } from "./ai.js";
import { actorFromRequest, completeGithubLogin, githubLogin, monitoredRepositories, normalizeRepositoryName, repositoryAuthorized, safeOAuthReturnTarget, verifyGithubOAuthState } from "./auth.js";
import { configureTelegramWebhook, sendTelegram } from "./notifications.js";
import { publishAttestation } from "./attestation.js";
import { attestationApprovalMessage, authorizeAttestationPublication } from "./approval.js";
import { scanWallet } from "./walletScanner.js";
import { consumeTelegramApproval, createTelegramApproval, getTelegramApproval, handleTelegramUpdate, verifyTelegramWebhookSecret } from "./telegramApprovals.js";
import { pollExternalRepositories } from "./repositoryMonitor.js";

declare global {
  namespace Express {
    interface Request {
      rawBody?: Buffer;
    }
  }
}

const app = express();
const port = Number(process.env.PORT ?? 8787);
const inlineRepositoryJobs = process.env.INLINE_REPOSITORY_JOBS ?? (process.env.NODE_ENV === "production" ? "false" : "true");
const repositoryMonitorIntervalMs = Number(process.env.GITHUB_MONITOR_POLL_INTERVAL_MS ?? (process.env.NODE_ENV === "production" ? 300_000 : 0));
let latest: ScanReport | null = null;
let activeScan: Promise<ScanReport> | null = null;
let activeRepositoryPoll: Promise<unknown> | null = null;

function appReturnUrl(returnTo: string) {
  const configured = process.env.MANWALL_APP_URL?.trim();
  return configured ? new URL(returnTo, configured).toString() : returnTo;
}

function authCookieSecurity() {
  return process.env.NODE_ENV === "production" || process.env.GITHUB_OAUTH_CALLBACK_URL?.startsWith("https:")
    ? "; Secure"
    : "";
}

app.use(cors());
app.use(express.json({
  limit: "1mb",
  verify: (request, _response, buffer) => {
    (request as Request & { rawBody?: Buffer }).rawBody = Buffer.from(buffer);
  }
}));
app.use(express.static(path.resolve("dist")));

app.get("/api/health", (_request, response) => {
  response.json({ ok: true, service: "manwall", network: "Mantle Sepolia", chainId: 5003 });
});

app.get("/api/ready", async (_request, response) => {
  const status = await infrastructureStatus();
  response.status(status.databaseReady && status.objectStoreReady ? 200 : 503).json(status);
});

app.get("/api/capabilities", async (_request, response) => response.json(await getCapabilities()));

const walletScanRequest = z.object({
  address: z.string().regex(/^0x[a-fA-F0-9]{40}$/)
});

app.post("/api/wallet/scan", async (request, response) => {
  const parsed = walletScanRequest.safeParse(request.body);
  if (!parsed.success) {
    response.status(400).json({ error: "Invalid wallet scan request.", details: parsed.error.flatten() });
    return;
  }
  try {
    response.json(await scanWallet(parsed.data.address));
  } catch (reason) {
    response.status(400).json({ error: reason instanceof Error ? reason.message : "Wallet scan failed" });
  }
});

app.get("/api/auth/me", async (request, response) => response.json(await actorFromRequest(request)));

app.get("/api/auth/github", (request, response) => {
  try {
    const login = githubLogin();
    const returnTo = safeOAuthReturnTarget(request.query.returnTo);
    const secure = authCookieSecurity();
    response.setHeader("set-cookie", [
      `manwall_oauth_state=${login.state}; HttpOnly${secure}; SameSite=Lax; Path=/api/auth; Max-Age=600`,
      `manwall_oauth_return=${encodeURIComponent(returnTo)}; HttpOnly${secure}; SameSite=Lax; Path=/api/auth; Max-Age=600`
    ]);
    response.redirect(login.url);
  } catch (reason) {
    response.status(503).json({ error: reason instanceof Error ? reason.message : "GitHub OAuth unavailable" });
  }
});

app.get("/api/auth/github/callback", async (request, response) => {
  try {
    const code = z.string().min(1).parse(request.query.code);
    const state = z.string().min(1).parse(request.query.state);
    if (!verifyGithubOAuthState(request, state)) {
      response.status(403).json({ error: "Invalid OAuth state." });
      return;
    }
    const session = await completeGithubLogin(code);
    const returnCookie = request.header("cookie")?.split(";").map((value) => value.trim()).find((value) => value.startsWith("manwall_oauth_return="))?.split("=")[1];
    const returnTo = safeOAuthReturnTarget(returnCookie ? decodeURIComponent(returnCookie) : "/");
    const secure = authCookieSecurity();
    response.setHeader("set-cookie", [
      `manwall_session=${session.token}; HttpOnly${secure}; SameSite=Lax; Path=/; Max-Age=604800`,
      `manwall_oauth_state=; HttpOnly${secure}; SameSite=Lax; Path=/api/auth; Max-Age=0`,
      `manwall_oauth_return=; HttpOnly${secure}; SameSite=Lax; Path=/api/auth; Max-Age=0`
    ]);
    response.redirect(appReturnUrl(returnTo));
  } catch (reason) {
    response.status(400).json({ error: reason instanceof Error ? reason.message : "GitHub OAuth failed" });
  }
});

app.get("/api/github/status", async (_request, response) => {
  const access = await getGitHubRepositoryAccess();
  response.json({
    configuredRepository: process.env.GITHUB_REPOSITORY ?? "",
    tokenConfigured: Boolean(process.env.GITHUB_TOKEN),
    webhookSecretConfigured: Boolean(process.env.GITHUB_WEBHOOK_SECRET),
    ...access
  });
});

app.get("/api/monitoring/repositories", (_request, response) => {
  response.json({
    repositories: monitoredRepositories(),
    detail: "These repositories are allowed for unauthenticated webhook monitoring. Authenticated teams can authorize additional repositories."
  });
});

app.get("/api/ai/status", async (request, response) => {
  const actor = await actorFromRequest(request);
  if (!actor.authenticated) return void response.status(401).json({ error: "Authentication required." });
  response.json(await getAiStatus());
});

app.get("/api/ai/audit", async (request, response) => {
  const actor = await actorFromRequest(request);
  if (actor.login !== "admin") return void response.status(403).json({ error: "Admin key required." });
  response.json(await listAiAuditLogs());
});

app.get("/api/operations/audit", async (request, response) => {
  const actor = await actorFromRequest(request);
  if (!actor.authenticated) return void response.status(401).json({ error: "Authentication required." });
  response.json(await listOperationAudits());
});

app.post("/api/admin/repository-monitor/poll", async (request, response) => {
  const actor = await actorFromRequest(request);
  if (actor.login !== "admin") return void response.status(403).json({ error: "Admin key required." });
  if (activeRepositoryPoll) return void response.status(409).json({ error: "Repository monitor poll is already running." });
  activeRepositoryPoll = pollExternalRepositories().finally(() => { activeRepositoryPoll = null; });
  response.json(await activeRepositoryPoll);
});

const telegramApprovalRequest = z.object({
  action: z.enum(["ai.patch", "github.remediation-pr"]),
  subject: z.string().min(3).max(300),
  payload: z.unknown()
});

app.post("/api/approvals/telegram", async (request, response) => {
  const actor = await actorFromRequest(request);
  if (!actor.authenticated) return void response.status(401).json({ error: "Authentication required." });
  const parsed = telegramApprovalRequest.safeParse(request.body);
  if (!parsed.success) return void response.status(400).json({ error: "Invalid Telegram approval request.", details: parsed.error.flatten() });
  try {
    response.status(202).json(await createTelegramApproval(parsed.data.action, parsed.data.subject, parsed.data.payload, actor.login));
  } catch (reason) {
    response.status(400).json({ error: reason instanceof Error ? reason.message : "Telegram approval request failed." });
  }
});

app.get("/api/approvals/telegram/:approvalId", async (request, response) => {
  const actor = await actorFromRequest(request);
  if (!actor.authenticated) return void response.status(401).json({ error: "Authentication required." });
  const approval = await getTelegramApproval(request.params.approvalId);
  if (!approval) return void response.status(404).json({ error: "Telegram approval request not found." });
  response.json(approval);
});

app.post("/api/telegram/webhook", async (request, response) => {
  if (!verifyTelegramWebhookSecret(request.header("x-telegram-bot-api-secret-token") ?? undefined)) {
    return void response.status(401).json({ error: "Invalid Telegram webhook secret." });
  }
  try {
    response.json(await handleTelegramUpdate(request.body));
  } catch (reason) {
    response.status(400).json({ error: reason instanceof Error ? reason.message : "Telegram callback failed." });
  }
});

app.post("/api/admin/telegram/webhook", async (request, response) => {
  const actor = await actorFromRequest(request);
  if (actor.login !== "admin") return void response.status(403).json({ error: "Admin key required." });
  const url = z.string().url().parse(request.body?.url ?? process.env.TELEGRAM_WEBHOOK_URL);
  response.json(await configureTelegramWebhook(url));
});

const teamAuthorizationRequest = z.object({
  slug: z.string().regex(/^[a-z0-9-]+$/).max(80),
  name: z.string().min(2).max(120),
  githubId: z.string().regex(/^\d+$/),
  repository: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),
  role: z.enum(["member", "maintainer", "admin"]).default("member")
});

app.post("/api/admin/team-authorization", async (request, response) => {
  const actor = await actorFromRequest(request);
  if (actor.login !== "admin") return void response.status(403).json({ error: "Admin key required." });
  const parsed = teamAuthorizationRequest.safeParse(request.body);
  if (!parsed.success) return void response.status(400).json({ error: "Invalid team authorization request.", details: parsed.error.flatten() });
  const configured = await configureTeamAuthorization(parsed.data);
  await writeOperationAudit(actor.login, "authorization.configure", parsed.data.repository, "ok", configured);
  response.status(201).json(configured);
});

app.post("/api/github/webhook", async (request, response) => {
  const secret = process.env.GITHUB_WEBHOOK_SECRET;
  if (!secret) {
    response.status(503).json({ error: "GITHUB_WEBHOOK_SECRET is not configured." });
    return;
  }

  const signature = request.header("x-hub-signature-256") ?? undefined;
  const event = request.header("x-github-event") ?? "";
  const delivery = request.header("x-github-delivery") ?? "";
  const rawBody = (request as Request & { rawBody?: Buffer }).rawBody;
  if (!rawBody || !verifyGitHubWebhookSignature(secret, rawBody, signature)) {
    response.status(401).json({ error: "Invalid GitHub webhook signature." });
    return;
  }

  const payload = request.body;
  const acceptance = await acceptGitHubWebhook(event, payload);
  if (!acceptance.accepted || !acceptance.repository) {
    response.status(202).json({ accepted: false, event, delivery, repository: acceptance.repository ?? "" });
    return;
  }

  const job = createRepositoryJob(acceptance.repository);
  if (!monitoredRepositories().includes(normalizeRepositoryName(job.repository).toLowerCase())) {
    response.status(202).json({ accepted: false, event, delivery, repository: job.repository, detail: "Repository is not in the monitored allowlist." });
    return;
  }
  const recent = await recentRepositoryJobCount(job.repository);
  if (recent >= Number(process.env.REPOSITORY_JOBS_PER_HOUR ?? 5)) {
    response.status(429).json({ error: "Repository hourly scan quota reached." });
    return;
  }
  await saveJob(job);
  if (inlineRepositoryJobs === "true") void runRepositoryScan(job);
  response.status(202).json({
    accepted: true,
    event,
    delivery,
    repository: acceptance.repository,
    jobId: job.id
  });
});

const remediationRequest = z.object({
  approved: z.literal(true).optional(),
  telegramApprovalId: z.string().uuid().optional(),
  repository: z.string().min(3).max(300),
  branch: z.string().regex(/^manwall\/[A-Za-z0-9._/-]+$/).max(150),
  title: z.string().min(3).max(200),
  body: z.string().min(10).max(10_000),
  files: z.array(z.object({
    path: z.string().min(1).max(300).refine((value) => !value.includes("..")),
    content: z.string().max(500_000)
  })).min(1).max(20)
});

app.post("/api/github/remediation-pr", async (request, response) => {
  const actor = await actorFromRequest(request);
  if (!actor.authenticated) return void response.status(401).json({ error: "Authentication required." });
  const parsed = remediationRequest.safeParse(request.body);
  if (!parsed.success) return void response.status(403).json({ error: "Valid remediation files and approval are required.", details: parsed.error.flatten() });
  if (!await repositoryAuthorized(actor, parsed.data.repository)) return void response.status(403).json({ error: "Repository is not authorized for this user." });
  try {
    const actionPayload = {
      repository: parsed.data.repository,
      branch: parsed.data.branch,
      title: parsed.data.title,
      body: parsed.data.body,
      files: parsed.data.files
    };
    if (parsed.data.telegramApprovalId) {
      await consumeTelegramApproval(parsed.data.telegramApprovalId, "github.remediation-pr", actionPayload);
    } else if (parsed.data.approved !== true) {
      return void response.status(403).json({ error: "Explicit or Telegram approval is required." });
    }
    const result = await createRemediationPullRequest(parsed.data);
    await writeOperationAudit(actor.login, "github.remediation-pr", parsed.data.repository, "ok", { branch: parsed.data.branch, url: result.html_url });
    await sendTelegram("github.remediation-pr", `${actor.login} created draft remediation PR for ${parsed.data.repository}`).catch(() => {});
    response.status(201).json(result);
  } catch (reason) {
    await writeOperationAudit(actor.login, "github.remediation-pr", parsed.data.repository, "error", { error: reason instanceof Error ? reason.message : "unknown" });
    response.status(400).json({ error: reason instanceof Error ? reason.message : "Remediation PR failed" });
  }
});

const attestationRequest = z.object({
  approved: z.literal(true).optional(),
  scanId: z.string().min(3).max(100),
  subject: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
  evidenceHash: z.string().regex(/^0x[a-fA-F0-9]{64}$/),
  severity: z.number().int().min(0).max(4),
  remediated: z.boolean(),
  evidenceURI: z.string().min(3).max(500),
  walletApproval: z.object({
    address: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
    signature: z.string().regex(/^0x[a-fA-F0-9]+$/)
  }).optional()
});

app.post("/api/attestations/approval-message", (request, response) => {
  const parsed = attestationRequest.omit({ approved: true, walletApproval: true }).safeParse(request.body);
  if (!parsed.success) return void response.status(400).json({ error: "Invalid attestation approval request.", details: parsed.error.flatten() });
  try {
    response.json({ message: attestationApprovalMessage(parsed.data) });
  } catch (reason) {
    response.status(503).json({ error: reason instanceof Error ? reason.message : "Attestation approval is unavailable." });
  }
});

app.post("/api/attestations/publish", async (request, response) => {
  const parsed = attestationRequest.safeParse(request.body);
  if (!parsed.success) return void response.status(403).json({ error: "Valid attestation data and wallet approval are required.", details: parsed.error.flatten() });
  const attestation = {
    scanId: parsed.data.scanId,
    subject: parsed.data.subject,
    evidenceHash: parsed.data.evidenceHash,
    severity: parsed.data.severity,
    remediated: parsed.data.remediated,
    evidenceURI: parsed.data.evidenceURI
  };
  try {
    const approval = authorizeAttestationPublication(attestation, parsed.data.walletApproval, parsed.data.approved);
    response.status(201).json(await publishAttestation({ ...attestation, actor: approval.actor }));
  } catch (reason) {
    const message = reason instanceof Error ? reason.message : "Attestation failed";
    response.status(message.includes("wallet signature") ? 403 : 400).json({ error: message });
  }
});

app.post("/api/notifications/test", async (request, response) => {
  const actor = await actorFromRequest(request);
  if (!actor.authenticated) return void response.status(401).json({ error: "Authentication required." });
  response.json(await sendTelegram("test", `Test requested by ${actor.login}`));
});

const aiReviewRequest = z.object({
  subject: z.string().trim().min(3).max(200),
  context: z.string().trim().min(20).max(50_000),
  repository: z.string().trim().max(300).optional(),
  source: z.string().trim().max(500_000).optional(),
  findings: z.array(z.string().trim().max(500)).max(30).optional(),
  approvalNote: z.string().trim().max(1000).optional()
});

app.post("/api/ai/review", async (request, response) => {
  const actor = await actorFromRequest(request);
  if (!actor.authenticated) return void response.status(401).json({ error: "Authentication required." });
  const parsed = aiReviewRequest.safeParse(request.body);
  if (!parsed.success) {
    response.status(400).json({ error: "Invalid AI review request", details: parsed.error.flatten() });
    return;
  }
  if (parsed.data.repository && !await repositoryAuthorized(actor, parsed.data.repository)) {
    return void response.status(403).json({ error: "Repository is not authorized for this user." });
  }
  try {
    response.json(await runAiWorkflow("review", parsed.data, false));
  } catch (reason) {
    response.status(400).json({ error: reason instanceof Error ? reason.message : "AI review failed" });
  }
});

const aiPatchRequest = aiReviewRequest.extend({
  approved: z.literal(true).optional(),
  telegramApprovalId: z.string().uuid().optional()
});

app.post("/api/ai/patch", async (request, response) => {
  const actor = await actorFromRequest(request);
  if (!actor.authenticated) return void response.status(401).json({ error: "Authentication required." });
  const parsed = aiPatchRequest.safeParse(request.body);
  if (!parsed.success) {
    response.status(403).json({
      error: "AI patch generation requires explicit approval.",
      details: parsed.error.flatten()
    });
    return;
  }
  if (parsed.data.repository && !await repositoryAuthorized(actor, parsed.data.repository)) {
    return void response.status(403).json({ error: "Repository is not authorized for this user." });
  }
  try {
    const actionPayload = {
      subject: parsed.data.subject,
      context: parsed.data.context,
      repository: parsed.data.repository,
      source: parsed.data.source,
      findings: parsed.data.findings,
      approvalNote: parsed.data.approvalNote
    };
    if (parsed.data.telegramApprovalId) {
      await consumeTelegramApproval(parsed.data.telegramApprovalId, "ai.patch", actionPayload);
    } else if (parsed.data.approved !== true) {
      return void response.status(403).json({ error: "Explicit or Telegram approval is required." });
    }
    response.json(await runAiWorkflow("patch", parsed.data, true));
  } catch (reason) {
    response.status(400).json({ error: reason instanceof Error ? reason.message : "AI patch generation failed" });
  }
});

app.get("/api/report", (_request, response) => {
  response.json(latest);
});

app.post("/api/scan", async (_request, response) => {
  if (process.env.NODE_ENV === "production" && process.env.ENABLE_CONTROLLED_PROOF_DEMO !== "true") {
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

app.post("/api/scan/source", async (request, response) => {
  const parsed = sourceRequest.safeParse(request.body);
  if (!parsed.success) {
    response.status(400).json({ error: "Valid Solidity source is required for a source-specific proof.", details: parsed.error.flatten() });
    return;
  }
  try {
    const { runSourceReentrancyProof } = await import("./sourceProof.js");
    const report = await runSourceReentrancyProof(parsed.data.name, parsed.data.source);
    latest = report;
    await saveReport(report);
    response.json(report);
  } catch (reason) {
    response.status(422).json({ error: reason instanceof Error ? reason.message : "Source-specific proof could not be executed." });
  }
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

const repositoryRequest = z.object({
  repository: z.string().url().max(300).optional(),
  repositories: z.array(z.string().url().max(300)).min(1).max(20).optional()
}).refine((value) => Boolean(value.repository || value.repositories?.length), {
  message: "Provide repository or repositories."
});

app.post("/api/jobs/repository", async (request, response) => {
  const parsed = repositoryRequest.safeParse(request.body);
  if (!parsed.success) {
    response.status(400).json({ error: "Invalid repository request", details: parsed.error.flatten() });
    return;
  }
  try {
    const actor = await actorFromRequest(request);
    const repositories = parsed.data.repositories ?? [parsed.data.repository!];
    const jobs = [];
    for (const repository of repositories) {
      const job = createRepositoryJob(repository);
      if (process.env.NODE_ENV === "production") {
        if (!await repositoryAuthorized(actor, job.repository)) {
          response.status(403).json({ error: "Authentication and repository authorization are required." });
          return;
        }
      }
      const recent = await recentRepositoryJobCount(job.repository);
      if (recent >= Number(process.env.REPOSITORY_JOBS_PER_HOUR ?? 5)) {
        response.status(429).json({ error: "Repository hourly scan quota reached." });
        return;
      }
      await saveJob(job);
      if (inlineRepositoryJobs === "true") void runRepositoryScan(job);
      jobs.push(job);
    }
    response.status(202).json(parsed.data.repositories ? { jobs } : jobs[0]);
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
  if (repositoryMonitorIntervalMs > 0 && process.env.GITHUB_MONITOR_ENABLED !== "false") {
    const poll = () => {
      if (!activeRepositoryPoll) {
        activeRepositoryPoll = pollExternalRepositories()
          .catch((reason) => console.error("repository monitor error", reason))
          .finally(() => { activeRepositoryPoll = null; });
      }
    };
    setTimeout(poll, 10_000).unref();
    setInterval(poll, repositoryMonitorIntervalMs).unref();
    console.log(`external repository monitor enabled; interval=${repositoryMonitorIntervalMs}ms`);
  }
});
