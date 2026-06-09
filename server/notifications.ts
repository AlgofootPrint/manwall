const recent = new Map<string, number>();

function configured() {
  return Boolean(process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID);
}

async function telegramRequest(method: string, body: Record<string, unknown>) {
  if (!configured()) throw new Error("Telegram is not configured.");
  const response = await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  const result = await response.json().catch(() => ({})) as { ok?: boolean; description?: string; result?: { message_id?: number } };
  if (!response.ok || !result.ok) throw new Error(result.description ?? `Telegram ${method} failed with HTTP ${response.status}`);
  return result;
}

export async function sendTelegram(event: string, message: string) {
  if (!configured()) return { sent: false, detail: "Telegram is not configured." };
  const key = `${event}:${message}`;
  const now = Date.now();
  const windowMs = Number(process.env.TELEGRAM_RATE_LIMIT_MS ?? 60_000);
  if (now - (recent.get(key) ?? 0) < windowMs) return { sent: false, detail: "Rate limited." };
  recent.set(key, now);

  const retries = Number(process.env.TELEGRAM_RETRIES ?? 3);
  let error = "";
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      await telegramRequest("sendMessage", { chat_id: process.env.TELEGRAM_CHAT_ID, text: `[${event}] ${message}` });
      return { sent: true, detail: "Telegram notification sent." };
    } catch (reason) {
      error = reason instanceof Error ? reason.message : "Telegram request failed.";
    }
    await new Promise((resolve) => setTimeout(resolve, attempt * 500));
  }
  throw new Error(error);
}

export async function sendTelegramMessage(message: string) {
  return sendTelegramChatMessage(String(process.env.TELEGRAM_CHAT_ID), message);
}

export async function sendTelegramChatMessage(chatId: string, message: string) {
  const result = await telegramRequest("sendMessage", { chat_id: chatId, text: message.slice(0, 4096) });
  return String(result.result?.message_id ?? "");
}

export async function sendTelegramApproval(input: { id: string; action: string; subject: string; requestedBy: string; expiresAt: string }) {
  const result = await telegramRequest("sendMessage", {
    chat_id: process.env.TELEGRAM_CHAT_ID,
    text: [
      "Manwall approval required",
      `Action: ${input.action}`,
      `Subject: ${input.subject}`,
      `Requested by: ${input.requestedBy}`,
      `Expires: ${input.expiresAt}`,
      `Approval ID: ${input.id}`
    ].join("\n"),
    reply_markup: {
      inline_keyboard: [[
        { text: "Approve", callback_data: `ma:a:${input.id}` },
        { text: "Reject", callback_data: `ma:r:${input.id}` }
      ]]
    }
  });
  return String(result.result?.message_id ?? "");
}

export async function answerTelegramCallback(callbackQueryId: string, text: string) {
  await telegramRequest("answerCallbackQuery", { callback_query_id: callbackQueryId, text, show_alert: false });
}

export async function updateTelegramApprovalMessage(messageId: string, text: string) {
  if (!messageId) return;
  await telegramRequest("editMessageReplyMarkup", {
    chat_id: process.env.TELEGRAM_CHAT_ID,
    message_id: Number(messageId),
    reply_markup: { inline_keyboard: [] }
  }).catch(() => undefined);
  await telegramRequest("sendMessage", { chat_id: process.env.TELEGRAM_CHAT_ID, text }).catch(() => undefined);
}

export async function configureTelegramWebhook(url: string) {
  await telegramRequest("setMyCommands", {
    commands: [
      { command: "help", description: "Show Manwall bot commands" },
      { command: "wallet", description: "Scan a Mantle wallet address" },
      { command: "scan", description: "Queue a monitored repository scan" },
      { command: "status", description: "Check a repository scan job" },
      { command: "ai", description: "Run approver-only AI review" },
      { command: "analyze", description: "Analyze pasted Solidity source" },
      { command: "pr", description: "Request a draft documentation PR" }
    ]
  });
  return telegramRequest("setWebhook", {
    url,
    secret_token: process.env.TELEGRAM_WEBHOOK_SECRET,
    allowed_updates: ["message", "callback_query"],
    drop_pending_updates: false
  });
}
