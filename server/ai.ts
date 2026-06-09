import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { listAiAuditRecords, monthlyAiUsage, saveAiAuditRecord } from "./infrastructure.js";

export type AiWorkflow = "review" | "patch";

export interface AiWorkflowInput {
  subject: string;
  context: string;
  repository?: string;
  source?: string;
  findings?: string[];
  approvalNote?: string;
}

export interface AiWorkflowResult {
  workflow: AiWorkflow;
  model: string;
  approved: boolean;
  summary: string;
  riskLevel: "low" | "medium" | "high" | "critical";
  keyObservations: string[];
  recommendedActions: string[];
  patchDraft?: string;
  usage: {
    inputTokens: number;
    outputTokens: number;
    estimatedCostUsd: number;
  };
  budget: {
    month: string;
    spentUsd: number;
    remainingUsd: number;
    requestCount: number;
    requestLimit: number;
  };
}

interface BudgetConfig {
  model: string;
  budgetUsd: number;
  requestTokenLimit: number;
  monthlyRequestLimit: number;
  maxOutputTokens: number;
}

const modelPricing: Record<string, { input: number; output: number }> = {
  "gpt-5.4-mini": { input: 0.75, output: 4.5 },
  "gpt-5.4": { input: 2.5, output: 15 },
  "gpt-5.5": { input: 5, output: 30 },
  "gpt-5": { input: 1.25, output: 10 }
};

const redactions: Array<[RegExp, string]> = [
  [/sk-[A-Za-z0-9_-]{20,}/g, "[redacted-openai-key]"],
  [/github_pat_[A-Za-z0-9_]+/g, "[redacted-github-token]"],
  [/\bgh[pousr]_[A-Za-z0-9_]+/g, "[redacted-github-token]"],
  [/\b\d{6,}:[A-Za-z0-9_-]{20,}\b/g, "[redacted-telegram-token]"],
  [/0x[a-fA-F0-9]{64}/g, "[redacted-private-key]"]
];

const auditDir = path.resolve("data", "ai-audit");
const safeId = (id: string) => id.replace(/[^A-Z0-9-]/gi, "");

function currentMonthKey() {
  return new Date().toISOString().slice(0, 7);
}

function estimateTokens(text: string) {
  return Math.max(1, Math.ceil(Buffer.byteLength(text, "utf8") / 4));
}

function sanitize(text: string) {
  return redactions.reduce((value, [pattern, replacement]) => value.replace(pattern, replacement), text);
}

function truncate(text: string, limit = 1000) {
  return text.length <= limit ? text : `${text.slice(0, limit)}...`;
}

function pricePerToken(model: string, kind: "input" | "output") {
  const pricing = modelPricing[model] ?? modelPricing["gpt-5.4-mini"];
  return pricing[kind] / 1_000_000;
}

function estimatedCostUsd(model: string, inputTokens: number, outputTokens: number) {
  return (inputTokens * pricePerToken(model, "input")) + (outputTokens * pricePerToken(model, "output"));
}

function budgetConfig(): BudgetConfig {
  return {
    model: process.env.OPENAI_MODEL ?? "gpt-5.4-mini",
    budgetUsd: Number(process.env.AI_MONTHLY_BUDGET_USD ?? 5),
    requestTokenLimit: Number(process.env.AI_REQUEST_TOKEN_LIMIT ?? 12_000),
    monthlyRequestLimit: Number(process.env.AI_MONTHLY_REQUEST_LIMIT ?? 20),
    maxOutputTokens: Number(process.env.AI_MAX_OUTPUT_TOKENS ?? 1_200)
  };
}

function requestSummary(input: AiWorkflowInput) {
  const parts = [
    `subject: ${input.subject}`,
    `context: ${truncate(sanitize(input.context), 700)}`,
    input.repository ? `repository: ${input.repository}` : null,
    input.findings?.length ? `findings: ${input.findings.map((finding) => truncate(sanitize(finding), 120)).join(" | ")}` : null,
    input.source ? `source: ${truncate(sanitize(input.source), 900)}` : null,
    input.approvalNote ? `approvalNote: ${truncate(sanitize(input.approvalNote), 160)}` : null
  ].filter(Boolean);
  return parts.join("\n");
}

function workflowPrompt(workflow: AiWorkflow, input: AiWorkflowInput) {
  const instructions = workflow === "patch"
    ? "Produce a patch draft, but do not claim it is applied. Focus on the minimum safe change and include human review notes."
    : "Produce an analysis review with concrete risks and next steps. Do not invent facts that are not in the provided context.";

  return [
    `You are Manwall's security analyst.`,
    `Workflow: ${workflow}.`,
    instructions,
    "Return strict JSON with the keys: summary, riskLevel, keyObservations, recommendedActions, patchDraft.",
    "Use one of riskLevel: low, medium, high, critical.",
    `Subject: ${input.subject}`,
    `Context:\n${sanitize(input.context)}`,
    input.repository ? `Repository: ${input.repository}` : "",
    input.findings?.length ? `Findings:\n- ${input.findings.map((finding) => sanitize(finding)).join("\n- ")}` : "",
    input.source ? `Source:\n${sanitize(input.source)}` : "",
    input.approvalNote ? `Approval note: ${sanitize(input.approvalNote)}` : ""
  ].filter(Boolean).join("\n\n");
}

function parseJsonResponse(content: string) {
  const trimmed = content.trim();
  const candidate = trimmed.startsWith("```") ? trimmed.replace(/^```(?:json)?/i, "").replace(/```$/i, "").trim() : trimmed;
  try {
    const parsed = JSON.parse(candidate) as Partial<AiWorkflowResult> & Record<string, unknown>;
    return {
      summary: String(parsed.summary ?? candidate),
      riskLevel: (["low", "medium", "high", "critical"].includes(String(parsed.riskLevel)) ? String(parsed.riskLevel) : "medium") as AiWorkflowResult["riskLevel"],
      keyObservations: Array.isArray(parsed.keyObservations) ? parsed.keyObservations.map(String).slice(0, 8) : [],
      recommendedActions: Array.isArray(parsed.recommendedActions) ? parsed.recommendedActions.map(String).slice(0, 8) : [],
      patchDraft: typeof parsed.patchDraft === "string" ? parsed.patchDraft : undefined
    };
  } catch {
    return {
      summary: candidate,
      riskLevel: "medium" as const,
      keyObservations: [],
      recommendedActions: [],
      patchDraft: undefined
    };
  }
}

async function openaiChatCompletion(prompt: string, config: BudgetConfig) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY is not configured.");
  const tokenLimitParameter = config.model.startsWith("gpt-5") ? "max_completion_tokens" : "max_tokens";

  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: config.model,
      temperature: 0.2,
      [tokenLimitParameter]: config.maxOutputTokens,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content: "You write concise, valid JSON and avoid adding any secrets or hidden data."
        },
        {
          role: "user",
          content: prompt
        }
      ]
    })
  });

  const rawText = await response.text();
  if (!response.ok) {
    throw new Error(`OpenAI API request failed with HTTP ${response.status}: ${truncate(sanitize(rawText), 500)}`);
  }
  return JSON.parse(rawText) as {
    choices?: Array<{ message?: { content?: string } }>;
    usage?: { prompt_tokens?: number; completion_tokens?: number; input_tokens?: number; output_tokens?: number };
  };
}

async function budgetSnapshot() {
  const month = currentMonthKey();
  const usage = await monthlyAiUsage(month);
  return {
    month,
    spentUsd: usage?.spentUsd ?? 0,
    requestCount: usage?.requestCount ?? 0
  };
}

function ensureAuditStore() {
  fs.mkdirSync(auditDir, { recursive: true });
}

function saveAuditFile(record: {
  createdAt: string;
  workflow: AiWorkflow;
  model: string;
  approved: boolean;
  status: "ok" | "blocked" | "error";
  requestHash: string;
  requestSummary: string;
  responseHash?: string;
  responseSummary?: string;
  inputTokens: number;
  outputTokens: number;
  estimatedCostUsd: number;
  error?: string;
}) {
  ensureAuditStore();
  const fileName = `${record.createdAt.replace(/[:.]/g, "-")}-${safeId(record.requestHash.slice(0, 12))}.json`;
  fs.writeFileSync(path.join(auditDir, fileName), JSON.stringify(record, null, 2));
}

async function writeAuditLog(record: {
  workflow: AiWorkflow;
  model: string;
  approved: boolean;
  status: "ok" | "blocked" | "error";
  requestHash: string;
  requestSummary: string;
  responseHash?: string;
  responseSummary?: string;
  inputTokens: number;
  outputTokens: number;
  estimatedCostUsd: number;
  error?: string;
}) {
  const stored = {
    createdAt: new Date().toISOString(),
    ...record
  };
  try {
    await saveAiAuditRecord(stored);
  } catch {}
  try {
    saveAuditFile(stored);
  } catch {}
}

export async function getAiStatus() {
  const config = budgetConfig();
  const budget = await budgetSnapshot();
  const ready = process.env.AI_PROVIDER === "openai" && Boolean(process.env.OPENAI_API_KEY);
  return {
    ready,
    provider: process.env.AI_PROVIDER ?? "openai",
    model: config.model,
    detail: ready
      ? `OpenAI configured with ${config.model}; monthly budget ${config.budgetUsd.toFixed(2)} USD.`
      : "Set AI_PROVIDER=openai and OPENAI_API_KEY.",
    budgetUsd: config.budgetUsd,
    requestTokenLimit: config.requestTokenLimit,
    monthlyRequestLimit: config.monthlyRequestLimit,
    spentUsd: budget.spentUsd,
    requestCount: budget.requestCount,
    remainingUsd: Math.max(0, config.budgetUsd - budget.spentUsd)
  };
}

export async function runAiWorkflow(workflow: AiWorkflow, input: AiWorkflowInput, approved: boolean) {
  const config = budgetConfig();
  if (process.env.AI_PROVIDER !== "openai") {
    throw new Error("Only AI_PROVIDER=openai is supported.");
  }
  if (!process.env.OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY is not configured.");
  }
  if (workflow === "patch" && !approved) {
    throw new Error("Approval is required before generating AI patches.");
  }

  const prompt = workflowPrompt(workflow, input);
  const requestHash = crypto.createHash("sha256").update(prompt).digest("hex");
  const requestSummaryValue = truncate(requestSummary(input), 1200);
  const requestTokens = estimateTokens(prompt);
  const budget = await budgetSnapshot();
  const projectedOutputTokens = config.maxOutputTokens;
  const projectedCost = estimatedCostUsd(config.model, requestTokens, projectedOutputTokens);

  if (requestTokens > config.requestTokenLimit) {
    await writeAuditLog({
      workflow,
      model: config.model,
      approved,
      status: "blocked",
      requestHash,
      requestSummary: requestSummaryValue,
      inputTokens: requestTokens,
      outputTokens: 0,
      estimatedCostUsd: 0,
      error: `Estimated input size exceeds the per-request token limit of ${config.requestTokenLimit}.`
    });
    throw new Error(`Estimated input size exceeds the per-request token limit of ${config.requestTokenLimit}.`);
  }

  if (budget.requestCount >= config.monthlyRequestLimit) {
    await writeAuditLog({
      workflow,
      model: config.model,
      approved,
      status: "blocked",
      requestHash,
      requestSummary: requestSummaryValue,
      inputTokens: requestTokens,
      outputTokens: 0,
      estimatedCostUsd: 0,
      error: `Monthly AI request limit of ${config.monthlyRequestLimit} reached.`
    });
    throw new Error(`Monthly AI request limit of ${config.monthlyRequestLimit} reached.`);
  }

  if (budget.spentUsd + projectedCost > config.budgetUsd) {
    await writeAuditLog({
      workflow,
      model: config.model,
      approved,
      status: "blocked",
      requestHash,
      requestSummary: requestSummaryValue,
      inputTokens: requestTokens,
      outputTokens: 0,
      estimatedCostUsd: 0,
      error: `Projected monthly spend would exceed the ${config.budgetUsd.toFixed(2)} USD budget.`
    });
    throw new Error(`Projected monthly spend would exceed the ${config.budgetUsd.toFixed(2)} USD budget.`);
  }

  try {
    const completion = await openaiChatCompletion(prompt, config);
    const content = completion.choices?.[0]?.message?.content ?? "";
    const parsed = parseJsonResponse(content);
    const inputTokens = Number(completion.usage?.prompt_tokens ?? completion.usage?.input_tokens ?? requestTokens);
    const outputTokens = Number(completion.usage?.completion_tokens ?? completion.usage?.output_tokens ?? estimateTokens(content));
    const actualCost = estimatedCostUsd(config.model, inputTokens, outputTokens);

    await writeAuditLog({
      workflow,
      model: config.model,
      approved,
      status: "ok",
      requestHash,
      requestSummary: requestSummaryValue,
      responseHash: crypto.createHash("sha256").update(content).digest("hex"),
      responseSummary: truncate(sanitize(content), 1200),
      inputTokens,
      outputTokens,
      estimatedCostUsd: actualCost
    });

    return {
      workflow,
      model: config.model,
      approved,
      ...parsed,
      usage: {
        inputTokens,
        outputTokens,
        estimatedCostUsd: actualCost
      },
      budget: {
        month: budget.month,
        spentUsd: budget.spentUsd,
        remainingUsd: Math.max(0, config.budgetUsd - budget.spentUsd - actualCost),
        requestCount: budget.requestCount,
        requestLimit: config.monthlyRequestLimit
      }
    } satisfies AiWorkflowResult;
  } catch (reason) {
    await writeAuditLog({
      workflow,
      model: config.model,
      approved,
      status: "error",
      requestHash,
      requestSummary: requestSummaryValue,
      inputTokens: requestTokens,
      outputTokens: 0,
      estimatedCostUsd: 0,
      error: reason instanceof Error ? reason.message : "OpenAI workflow failed."
    });
    throw reason;
  }
}

export async function listAiAuditLogs() {
  try {
    const records = await listAiAuditRecords();
    if (records && records.length) return records;
  } catch {}
  try {
    ensureAuditStore();
    return fs.readdirSync(auditDir)
      .filter((file) => file.endsWith(".json"))
      .map((file) => JSON.parse(fs.readFileSync(path.join(auditDir, file), "utf8")))
      .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  } catch {
    return [];
  }
}
