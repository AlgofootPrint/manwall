import crypto from "node:crypto";
import { monitoredRepositories, normalizeRepositoryName } from "./auth.js";
import { runAiWorkflow } from "./ai.js";
import { databaseClient, writeOperationAudit } from "./infrastructure.js";
import { recentRepositoryJobCount } from "./infrastructure.js";
import { createRemediationPullRequest } from "./github.js";
import { getJob, saveJob, type ScanJob, type ToolResult } from "./jobStore.js";
import { answerTelegramCallback, sendTelegramApproval, sendTelegramChatMessage, sendTelegramMessage, updateTelegramApprovalMessage } from "./notifications.js";
import { createRepositoryJob } from "./repositoryScanner.js";
import { analyzeSource } from "./sourceScanner.js";
import { scanWallet } from "./walletScanner.js";

export type TelegramApprovalAction = "ai.patch" | "github.remediation-pr";
export type TelegramApprovalStatus = "pending" | "approved" | "rejected" | "consumed" | "expired";

export interface TelegramApproval {
  id: string;
  action: TelegramApprovalAction;
  subject: string;
  payloadHash: string;
  requestedBy: string;
  status: TelegramApprovalStatus;
  createdAt: string;
  expiresAt: string;
  decidedAt?: string;
  decidedBy?: string;
  consumedAt?: string;
  telegramMessageId?: string;
}

const memory = new Map<string, TelegramApproval>();
const memoryPayloads = new Map<string, unknown>();
type TelegramInputMode = "wallet" | "scan" | "status" | "ai" | "analyze";
const pendingInputs = new Map<string, { mode: TelegramInputMode; expiresAt: number }>();
const telegramMenu = {
  keyboard: [
    [{ text: "Scan Wallet" }, { text: "Scan Repository" }],
    [{ text: "Check Scan Status" }, { text: "AI Review" }],
    [{ text: "Analyze Contract" }, { text: "Help" }]
  ],
  resize_keyboard: true,
  is_persistent: true,
  input_field_placeholder: "Choose a Manwall action"
};

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function telegramApprovalPayloadHash(action: TelegramApprovalAction, payload: unknown) {
  return crypto.createHash("sha256").update(`${action}\n${canonical(payload)}`).digest("hex");
}

function fromRow(row: any): TelegramApproval {
  return {
    id: row.id,
    action: row.action,
    subject: row.subject,
    payloadHash: row.payload_hash,
    requestedBy: row.requested_by,
    status: row.status,
    createdAt: row.created_at.toISOString(),
    expiresAt: row.expires_at.toISOString(),
    decidedAt: row.decided_at?.toISOString(),
    decidedBy: row.decided_by ?? undefined,
    consumedAt: row.consumed_at?.toISOString(),
    telegramMessageId: row.telegram_message_id ?? undefined
  };
}

export async function getTelegramApproval(id: string) {
  const client = databaseClient();
  if (!client) return memory.get(id) ?? null;
  const result = await client.query("SELECT * FROM telegram_approvals WHERE id = $1", [id]);
  return result.rows[0] ? fromRow(result.rows[0]) : null;
}

async function getTelegramApprovalPayload(id: string) {
  const client = databaseClient();
  if (!client) return memoryPayloads.get(id);
  const result = await client.query("SELECT payload FROM telegram_approvals WHERE id = $1", [id]);
  return result.rows[0]?.payload;
}

async function setMessageId(id: string, messageId: string) {
  const client = databaseClient();
  if (client) await client.query("UPDATE telegram_approvals SET telegram_message_id = $2 WHERE id = $1", [id, messageId]);
  else {
    const approval = memory.get(id);
    if (approval) memory.set(id, { ...approval, telegramMessageId: messageId });
  }
}

export async function createTelegramApproval(action: TelegramApprovalAction, subject: string, payload: unknown, requestedBy: string) {
  if (!process.env.TELEGRAM_APPROVER_USER_IDS) throw new Error("TELEGRAM_APPROVER_USER_IDS is not configured.");
  const now = new Date();
  const expiresAt = new Date(now.getTime() + Number(process.env.TELEGRAM_APPROVAL_TTL_SECONDS ?? 900) * 1000);
  const approval: TelegramApproval = {
    id: crypto.randomUUID(),
    action,
    subject,
    payloadHash: telegramApprovalPayloadHash(action, payload),
    requestedBy,
    status: "pending",
    createdAt: now.toISOString(),
    expiresAt: expiresAt.toISOString()
  };
  const client = databaseClient();
  if (client) {
    await client.query(
      `INSERT INTO telegram_approvals (id, expires_at, action, subject, payload_hash, payload, requested_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [approval.id, approval.expiresAt, action, subject, approval.payloadHash, payload, requestedBy]
    );
  } else {
    memory.set(approval.id, approval);
    memoryPayloads.set(approval.id, payload);
  }
  const messageId = await sendTelegramApproval({ id: approval.id, action, subject, requestedBy, expiresAt: approval.expiresAt });
  await setMessageId(approval.id, messageId);
  await writeOperationAudit(requestedBy, "telegram-approval.request", subject, "pending", { approvalId: approval.id, action });
  return { ...approval, telegramMessageId: messageId };
}

function allowedApprover(userId: string) {
  return (process.env.TELEGRAM_APPROVER_USER_IDS ?? "").split(",").map((value) => value.trim()).filter(Boolean).includes(userId);
}

function authorizedTelegramUser(chatId: string, userId: string) {
  return chatId === String(process.env.TELEGRAM_CHAT_ID) || allowedApprover(userId);
}

export function verifyTelegramWebhookSecret(value: string | undefined) {
  const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
  return Boolean(secret && value && secret.length === value.length && crypto.timingSafeEqual(Buffer.from(secret), Buffer.from(value)));
}

export async function decideTelegramApproval(id: string, decision: "approved" | "rejected", userId: string, chatId: string) {
  if (chatId !== String(process.env.TELEGRAM_CHAT_ID)) throw new Error("Telegram approval came from an unauthorized chat.");
  if (!allowedApprover(userId)) throw new Error("Telegram user is not authorized to approve Manwall actions.");
  const approval = await getTelegramApproval(id);
  if (!approval) throw new Error("Approval request not found.");
  if (approval.status !== "pending") throw new Error(`Approval request is already ${approval.status}.`);
  if (new Date(approval.expiresAt).getTime() <= Date.now()) decision = "rejected";
  const decidedAt = new Date().toISOString();
  const nextStatus = new Date(approval.expiresAt).getTime() <= Date.now() ? "expired" : decision;
  const client = databaseClient();
  if (client) {
    const result = await client.query(
      "UPDATE telegram_approvals SET status = $2, decided_at = $3, decided_by = $4 WHERE id = $1 AND status = 'pending' RETURNING id",
      [id, nextStatus, decidedAt, userId]
    );
    if (!result.rows[0]) throw new Error("Approval request has already been decided.");
  } else memory.set(id, { ...approval, status: nextStatus, decidedAt, decidedBy: userId });
  await writeOperationAudit(`telegram:${userId}`, "telegram-approval.decide", approval.subject, nextStatus, { approvalId: id, action: approval.action });
  await updateTelegramApprovalMessage(approval.telegramMessageId ?? "", `Manwall approval ${nextStatus}: ${approval.action} / ${approval.subject}`);
  return { ...approval, status: nextStatus, decidedAt, decidedBy: userId };
}

export async function consumeTelegramApproval(id: string, action: TelegramApprovalAction, payload: unknown) {
  const approval = await getTelegramApproval(id);
  if (!approval) throw new Error("Telegram approval request not found.");
  if (approval.action !== action || approval.payloadHash !== telegramApprovalPayloadHash(action, payload)) {
    throw new Error("Telegram approval does not match this exact action payload.");
  }
  if (approval.status !== "approved") throw new Error(`Telegram approval is ${approval.status}.`);
  if (new Date(approval.expiresAt).getTime() <= Date.now()) throw new Error("Telegram approval has expired.");
  const consumedAt = new Date().toISOString();
  const client = databaseClient();
  if (client) {
    const result = await client.query(
      "UPDATE telegram_approvals SET status = 'consumed', consumed_at = $2 WHERE id = $1 AND status = 'approved' RETURNING id",
      [id, consumedAt]
    );
    if (!result.rows[0]) throw new Error("Telegram approval has already been consumed.");
  } else memory.set(id, { ...approval, status: "consumed", consumedAt });
  await writeOperationAudit(`telegram:${approval.decidedBy ?? "unknown"}`, "telegram-approval.consume", approval.subject, "consumed", { approvalId: id, action });
  return { ...approval, status: "consumed" as const, consumedAt };
}

export async function handleTelegramCallback(update: any) {
  const query = update?.callback_query;
  const match = String(query?.data ?? "").match(/^ma:([ar]):([0-9a-f-]{36})$/i);
  if (!query?.id || !match) return { handled: false };
  const decision = match[1] === "a" ? "approved" : "rejected";
  const result = await decideTelegramApproval(match[2], decision, String(query.from?.id ?? ""), String(query.message?.chat?.id ?? ""));
  await answerTelegramCallback(String(query.id), `Approval ${result.status}`);
  if (result.status === "approved" && result.requestedBy.startsWith("telegram:") && result.action === "github.remediation-pr") {
    const payload = await getTelegramApprovalPayload(result.id) as Parameters<typeof createRemediationPullRequest>[0] | undefined;
    if (!payload) throw new Error("Telegram PR payload is unavailable.");
    await consumeTelegramApproval(result.id, result.action, payload);
    const pr = await createRemediationPullRequest(payload);
    await writeOperationAudit(result.requestedBy, "github.remediation-pr", payload.repository, "ok", { branch: payload.branch, url: pr.html_url });
    await sendTelegramMessage(`Draft PR created: ${String(pr.html_url ?? "")}`);
    return { handled: true, approval: result, pullRequest: pr };
  }
  return { handled: true, approval: result };
}

export function parseTelegramPrCommand(text: string, userId: string, username = "") {
  const match = text.trim().match(/^\/pr(?:@\w+)?\s+([^|]{3,120})\s*\|\s*(.{10,1000})$/is);
  if (!match) return null;
  const repository = process.env.GITHUB_REPOSITORY;
  if (!repository) throw new Error("GITHUB_REPOSITORY is not configured.");
  const title = match[1].trim();
  const description = match[2].trim();
  const stamp = Date.now();
  return {
    repository,
    branch: `manwall/telegram-${stamp}-${crypto.randomBytes(3).toString("hex")}`,
    title,
    body: `${description}\n\nRequested from Telegram by @${username || userId}.`,
    files: [{
      path: `docs/telegram/${stamp}.md`,
      content: `# ${title}\n\n${description}\n\nRequested from Telegram by @${username || userId}.\n`
    }]
  };
}

const helpMessage = [
  "Choose an action using the buttons below.",
  "",
  "Scan Wallet: paste a 0x wallet address.",
  "Scan Repository: paste a monitored GitHub repository URL.",
  "Check Scan Status: paste a Manwall job ID.",
  "AI Review: paste a completed job ID. Authorized approvers only.",
  "Analyze Contract: paste Solidity source code.",
  "",
  "Repository scans run in the isolated VPS worker. Contract analysis is heuristic source triage, not a confirmed exploit proof. Slash commands remain available as a fallback."
].join("\n");

const buttonModes: Record<string, { mode: TelegramInputMode; prompt: string }> = {
  "Scan Wallet": { mode: "wallet", prompt: "Paste the 0x wallet address you want Manwall to scan." },
  "Scan Repository": { mode: "scan", prompt: "Paste a monitored public GitHub repository URL." },
  "Check Scan Status": { mode: "status", prompt: "Paste the Manwall job ID, for example JOB-A454E472." },
  "AI Review": { mode: "ai", prompt: "Paste the completed Manwall job ID to review with AI." },
  "Analyze Contract": { mode: "analyze", prompt: "Paste the Solidity contract source code." }
};

function pendingInputKey(chatId: string, userId: string) {
  return `${chatId}:${userId}`;
}

function setPendingInput(chatId: string, userId: string, mode: TelegramInputMode) {
  pendingInputs.set(pendingInputKey(chatId, userId), { mode, expiresAt: Date.now() + 10 * 60_000 });
}

function consumePendingInput(chatId: string, userId: string) {
  const key = pendingInputKey(chatId, userId);
  const pending = pendingInputs.get(key);
  pendingInputs.delete(key);
  return pending && pending.expiresAt > Date.now() ? pending.mode : undefined;
}

function asCommand(mode: TelegramInputMode, input: string) {
  const command = mode === "wallet" ? "wallet" : mode === "scan" ? "scan" : mode === "status" ? "status" : mode === "ai" ? "ai" : "analyze";
  return `/${command} ${input}`;
}

function commandArgument(text: string, command: string) {
  return text.trim().match(new RegExp(`^/${command}(?:@\\w+)?(?:\\s+([\\s\\S]+))?$`, "i"))?.[1]?.trim() ?? "";
}

function walletSummary(result: Awaited<ReturnType<typeof scanWallet>>) {
  const issues = result.issues.slice(0, 5).map((issue) => `- ${issue.severity.toUpperCase()}: ${issue.title}`);
  return [
    `Wallet scan: ${result.wallet}`,
    `Network: ${result.network.name} (${result.network.chainId})`,
    `Status: ${result.summary}`,
    `Balance: ${result.nativeBalanceMnt} MNT`,
    `Account: ${result.accountType}; transactions: ${result.transactionCount}`,
    `Allowances checked: ${result.allowances.length}`,
    issues.length ? `Issues:\n${issues.join("\n")}` : "Issues: none detected"
  ].join("\n");
}

function toolLabel(tool?: ToolResult) {
  if (!tool) return "not reported";
  if (tool.status === "blocked") return `blocked by isolation: ${tool.summary}`;
  return `${tool.status}: ${tool.summary}`;
}

function jobSummary(job: ScanJob) {
  if (!job.result) return `${job.id} / ${job.status}\n${job.repository}${job.error ? `\nError: ${job.error}` : ""}`;
  return [
    `${job.id} / ${job.status}`,
    job.repository,
    `Commit: ${job.result.commit}`,
    `Files: ${job.result.filesScanned}; security findings: ${job.result.findings}`,
    `Slither: ${toolLabel(job.result.tools?.slither)}`,
    `Foundry: ${toolLabel(job.result.tools?.foundry)}`
  ].join("\n");
}

function analysisSummary(result: ReturnType<typeof analyzeSource>) {
  const findings = result.findings.slice(0, 8).map((finding) => `- ${finding.severity.toUpperCase()} L${finding.line}: ${finding.title}`);
  return [
    `Contract analysis: ${result.target.name}`,
    `Compilation: ${result.compilation.passed ? "passed" : "failed"}`,
    `Heuristic findings: ${result.findings.length}`,
    `Mantle gas suggestions: ${result.gasOptimizations.length}`,
    findings.length ? `Top findings:\n${findings.join("\n")}` : "Top findings: none",
    `Evidence hash: ${result.evidenceHash}`
  ].join("\n");
}

async function handleTelegramCommand(text: string, chatId: string, userId: string) {
  const reply = (message: string) => sendTelegramChatMessage(chatId, message);
  if (/^\/(?:start|help)(?:@\w+)?$/i.test(text.trim()) || text.trim() === "Help") {
    await sendTelegramChatMessage(chatId, helpMessage, telegramMenu);
    return { handled: true, command: "help" };
  }
  const button = buttonModes[text.trim()];
  if (button) {
    if (button.mode === "ai" && !allowedApprover(userId)) throw new Error("AI review is limited to authorized Telegram approvers.");
    setPendingInput(chatId, userId, button.mode);
    await sendTelegramChatMessage(chatId, button.prompt, telegramMenu);
    return { handled: true, command: `${button.mode}-prompt` };
  }

  const walletAddress = text.trim().match(/^0x[a-fA-F0-9]{40}$/)?.[0] ?? commandArgument(text, "wallet");
  if (walletAddress) {
    if (!/^0x[a-fA-F0-9]{40}$/.test(walletAddress)) throw new Error("Wallet command requires a valid 0x address.");
    await reply("Scanning wallet posture on Mantle Sepolia...");
    await reply(walletSummary(await scanWallet(walletAddress)));
    return { handled: true, command: "wallet" };
  }

  const repository = commandArgument(text, "scan");
  if (repository) {
    const job = createRepositoryJob(repository);
    if (!allowedApprover(userId) && !monitoredRepositories().includes(normalizeRepositoryName(job.repository).toLowerCase())) {
      throw new Error("This repository is not monitored. Ask an authorized Telegram approver to submit the public repository scan.");
    }
    if (await recentRepositoryJobCount(job.repository) >= Number(process.env.REPOSITORY_JOBS_PER_HOUR ?? 5)) {
      throw new Error("Repository hourly scan quota reached.");
    }
    await saveJob(job);
    await reply(`Repository scan queued.\n${job.id}\nUse /status ${job.id}`);
    return { handled: true, command: "scan", job };
  }

  const statusId = commandArgument(text, "status").toUpperCase();
  if (statusId) {
    const job = await getJob(statusId);
    if (!job) throw new Error("Repository scan job not found.");
    await reply(jobSummary(job));
    return { handled: true, command: "status", job };
  }

  const aiJobId = commandArgument(text, "ai").toUpperCase();
  if (aiJobId) {
    if (!allowedApprover(userId)) throw new Error("AI review is limited to authorized Telegram approvers.");
    const job = await getJob(aiJobId);
    if (!job?.result || job.status !== "completed") throw new Error("AI review requires a completed repository scan.");
    await reply(`Running AI security review for ${job.id}...`);
    const findings = job.result.reports.flatMap((report: any) => report.findings ?? []).slice(0, 30).map((finding: any) => `${finding.severity}: ${finding.title} at line ${finding.line}`);
    const result = await runAiWorkflow("review", {
      subject: `Review repository scan ${job.id}`,
      repository: job.repository,
      context: jobSummary(job),
      findings
    }, false);
    await reply([
      `AI review: ${job.id}`,
      `Model: ${result.model}; risk: ${result.riskLevel}`,
      result.summary,
      ...result.recommendedActions.slice(0, 5).map((action) => `- ${action}`)
    ].join("\n"));
    return { handled: true, command: "ai", jobId: job.id };
  }

  const source = commandArgument(text, "analyze");
  if (source || text.trim().match(/^\/analyze(?:@\w+)?$/i)) {
    if (source.length < 20) throw new Error("Send Solidity source after /analyze. Example: /analyze pragma solidity ^0.8.20; contract Example {}");
    await reply("Running static Solidity analysis...");
    await reply(analysisSummary(analyzeSource("TelegramSubmission.sol", source)));
    return { handled: true, command: "analyze" };
  }
  return null;
}

export async function handleTelegramUpdate(update: any) {
  if (update?.callback_query) return handleTelegramCallback(update);
  const message = update?.message;
  const chatId = String(message?.chat?.id ?? "");
  const userId = String(message?.from?.id ?? "");
  if (!message?.text || !authorizedTelegramUser(chatId, userId)) return { handled: false };
  let text = String(message.text);
  const isButton = Boolean(buttonModes[text.trim()]) || text.trim() === "Help";
  if (!isButton && !text.trim().startsWith("/")) {
    const mode = consumePendingInput(chatId, userId);
    if (mode) text = asCommand(mode, text);
  }
  try {
    const command = await handleTelegramCommand(text, chatId, userId);
    if (command) return command;
  } catch (reason) {
    const error = reason instanceof Error ? reason.message : "Telegram command failed.";
    await sendTelegramChatMessage(chatId, `Manwall command failed: ${error}`);
    return { handled: true, command: "error", error };
  }
  if (text.trim().match(/^\/pr(?:@\w+)?(?:\s.*)?$/is) && !parseTelegramPrCommand(text, userId, String(message.from?.username ?? ""))) {
    await sendTelegramChatMessage(chatId, "PR request format:\n/pr Title | Description\n\nExample:\n/pr Document wallet scanning | Explain how the wallet scan workflow works.");
    return { handled: true, command: "pr-help" };
  }
  const payload = parseTelegramPrCommand(text, userId, String(message.from?.username ?? ""));
  if (!payload) return { handled: false };
  const approval = await createTelegramApproval("github.remediation-pr", payload.repository, payload, `telegram:${userId}`);
  await sendTelegramChatMessage(chatId, `PR request received. Approval ID: ${approval.id}`);
  return { handled: true, command: "pr", approval };
}
