import crypto from "node:crypto";
import { databaseClient, writeOperationAudit } from "./infrastructure.js";
import { createRemediationPullRequest } from "./github.js";
import { answerTelegramCallback, sendTelegramApproval, sendTelegramMessage, updateTelegramApprovalMessage } from "./notifications.js";

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

export async function handleTelegramUpdate(update: any) {
  if (update?.callback_query) return handleTelegramCallback(update);
  const message = update?.message;
  const chatId = String(message?.chat?.id ?? "");
  if (!message?.text || chatId !== String(process.env.TELEGRAM_CHAT_ID)) return { handled: false };
  if (String(message.text).trim().match(/^\/help(?:@\w+)?$/i)) {
    await sendTelegramMessage("Create a draft PR request with:\n/pr Title | Description\n\nAn authorized approver must approve it before Manwall creates the PR.");
    return { handled: true, command: "help" };
  }
  if (String(message.text).trim().match(/^\/pr(?:@\w+)?(?:\s.*)?$/is) && !parseTelegramPrCommand(String(message.text), String(message.from?.id ?? ""), String(message.from?.username ?? ""))) {
    await sendTelegramMessage("PR request format:\n/pr Title | Description\n\nExample:\n/pr Document wallet scanning | Explain how the wallet scan workflow works.");
    return { handled: true, command: "pr-help" };
  }
  const payload = parseTelegramPrCommand(String(message.text), String(message.from?.id ?? ""), String(message.from?.username ?? ""));
  if (!payload) return { handled: false };
  const approval = await createTelegramApproval("github.remediation-pr", payload.repository, payload, `telegram:${String(message.from?.id ?? "")}`);
  await sendTelegramMessage(`PR request received. Approval ID: ${approval.id}`);
  return { handled: true, command: "pr", approval };
}
