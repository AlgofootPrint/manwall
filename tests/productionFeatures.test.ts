import { afterEach, describe, expect, it } from "vitest";
import { Wallet } from "ethers";
import { attestationApprovalMessage, authorizeAttestationPublication, verifyAttestationApproval } from "../server/approval.js";
import { githubLogin, monitoredRepositories, repositoryAuthorized, safeOAuthReturnTarget, verifyGithubOAuthState } from "../server/auth.js";
import { publishAttestation } from "../server/attestation.js";
import { createRemediationPullRequest, getGitHubRepositorySnapshot, shouldScanGitHubEvent } from "../server/github.js";
import { sendTelegram } from "../server/notifications.js";
import { consumeTelegramApproval, createTelegramApproval, decideTelegramApproval, handleTelegramUpdate, parseTelegramPrCommand, verifyTelegramWebhookSecret } from "../server/telegramApprovals.js";

const originalFetch = globalThis.fetch;
const originalEnv = { ...process.env };

afterEach(() => {
  globalThis.fetch = originalFetch;
  process.env = { ...originalEnv };
});

describe("production approval foundations", () => {
  it("authorizes only the configured repository for authenticated users", async () => {
    process.env.GITHUB_REPOSITORY = "AlgofootPrint/manwall";
    delete process.env.DATABASE_URL;
    expect(await repositoryAuthorized({ id: "1", login: "user", authenticated: true }, "https://github.com/AlgofootPrint/manwall.git")).toBe(true);
    expect(await repositoryAuthorized({ id: "1", login: "user", authenticated: true }, "other/repository")).toBe(false);
  });

  it("supports multiple monitored Mantle repositories", async () => {
    process.env.GITHUB_REPOSITORY = "AlgofootPrint/manwall";
    process.env.MANTLE_MONITORED_REPOSITORIES = "mantle-lsp/contracts, merchant-moe/moe-core, pendle-finance/pendle-core-v2-public, mantlenetworkio/mantle";
    delete process.env.DATABASE_URL;
    expect(monitoredRepositories()).toEqual([
      "algofootprint/manwall",
      "mantle-lsp/contracts",
      "merchant-moe/moe-core",
      "pendle-finance/pendle-core-v2-public",
      "mantlenetworkio/mantle"
    ]);
    expect(await repositoryAuthorized({ id: "1", login: "user", authenticated: true }, "https://github.com/merchant-moe/moe-core.git")).toBe(true);
  });

  it("scans created deployment events without duplicating deployment status changes", () => {
    const repository = { html_url: "https://github.com/mantle-lsp/contracts" };
    expect(shouldScanGitHubEvent("deployment", { action: "created", repository })).toBe(repository.html_url);
    expect(shouldScanGitHubEvent("deployment_status", { action: "created", repository })).toBeNull();
  });

  it("builds read-only polling markers for external repositories", async () => {
    process.env.GITHUB_TOKEN = "test";
    globalThis.fetch = async (input) => {
      const url = String(input);
      if (url.endsWith("/repos/mantle-lsp/contracts")) return Response.json({ default_branch: "main" });
      if (url.includes("/commits?")) return Response.json([{ sha: "commit-1" }]);
      if (url.includes("/pulls?")) return Response.json([{ id: 12, updated_at: "2026-06-09T00:00:00Z", head: { sha: "pr-1" } }]);
      if (url.includes("/deployments?")) return Response.json([{ id: 34, updated_at: "2026-06-09T01:00:00Z", sha: "deploy-1" }]);
      return Response.json({}, { status: 404 });
    };
    expect(await getGitHubRepositorySnapshot("mantle-lsp/contracts")).toEqual({
      repository: "mantle-lsp/contracts",
      defaultBranchSha: "commit-1",
      pullRequestMarker: "12:2026-06-09T00:00:00Z:pr-1",
      deploymentMarker: "34:2026-06-09T01:00:00Z:deploy-1"
    });
  });

  it("verifies wallet-signed attestation approval messages", async () => {
    process.env.ATTESTATION_REGISTRY_ADDRESS = "0x0000000000000000000000000000000000000001";
    const wallet = Wallet.createRandom();
    const payload = {
      scanId: "SCAN-1",
      subject: "0x0000000000000000000000000000000000000002",
      evidenceHash: `0x${"1".repeat(64)}`,
      evidenceURI: "manwall://reports/SCAN-1",
      severity: 4,
      remediated: true
    };
    const signature = await wallet.signMessage(attestationApprovalMessage(payload));
    expect(attestationApprovalMessage(payload)).toContain("gas payer: Manwall publisher wallet");
    expect(verifyAttestationApproval(payload, { address: wallet.address, signature })).toBe(true);
    expect(verifyAttestationApproval(payload, { address: Wallet.createRandom().address, signature })).toBe(false);
    expect(verifyAttestationApproval({ ...payload, evidenceURI: "manwall://reports/OTHER" }, { address: wallet.address, signature })).toBe(false);
    expect(verifyAttestationApproval(payload, { address: wallet.address, signature: "0x1234" })).toBe(false);
    process.env.ATTESTATION_REGISTRY_ADDRESS = "0x0000000000000000000000000000000000000003";
    expect(verifyAttestationApproval(payload, { address: wallet.address, signature })).toBe(false);
    process.env.ATTESTATION_REGISTRY_ADDRESS = "0x0000000000000000000000000000000000000001";
    expect(authorizeAttestationPublication(payload, { address: wallet.address, signature })).toEqual({
      actor: wallet.address,
      method: "wallet-signature"
    });
  });

  it("requires wallet approval in production even when demo approval is explicit", () => {
    process.env.NODE_ENV = "production";
    process.env.ALLOW_DEMO_ATTESTATION_APPROVAL = "true";
    process.env.ATTESTATION_REGISTRY_ADDRESS = "0x0000000000000000000000000000000000000001";
    const payload = {
      scanId: "SCAN-1",
      subject: "0x0000000000000000000000000000000000000002",
      evidenceHash: `0x${"1".repeat(64)}`,
      evidenceURI: "manwall://reports/SCAN-1",
      severity: 4,
      remediated: true
    };
    expect(() => authorizeAttestationPublication(payload, undefined, true)).toThrow("valid wallet signature");
  });

  it("allows the demo attestation path only when explicitly enabled outside production", () => {
    process.env.NODE_ENV = "development";
    process.env.ALLOW_DEMO_ATTESTATION_APPROVAL = "true";
    process.env.ATTESTATION_REGISTRY_ADDRESS = "0x0000000000000000000000000000000000000001";
    const payload = {
      scanId: "SCAN-1",
      subject: "0x0000000000000000000000000000000000000002",
      evidenceHash: `0x${"1".repeat(64)}`,
      evidenceURI: "manwall://reports/SCAN-1",
      severity: 4,
      remediated: true
    };
    expect(authorizeAttestationPublication(payload, undefined, true).method).toBe("demo-approval");
  });

  it("creates a draft remediation PR through bounded GitHub API operations", async () => {
    process.env.GITHUB_TOKEN = "test";
    const calls: string[] = [];
    globalThis.fetch = async (input, init) => {
      const url = String(input);
      calls.push(`${init?.method ?? "GET"} ${url}`);
      if (url.endsWith("/git/ref/heads/main")) return Response.json({ object: { sha: "abc" } });
      if (url.endsWith("/pulls")) return Response.json({ html_url: "https://github.com/example/repo/pull/1" });
      if (url.endsWith("/repos/example/repo")) return Response.json({ default_branch: "main" });
      return Response.json({});
    };
    const result = await createRemediationPullRequest({
      repository: "example/repo",
      branch: "manwall/fix-1",
      title: "Security remediation",
      body: "Approved security remediation.",
      files: [{ path: "src/Fix.sol", content: "contract Fix {}" }]
    });
    expect(result.html_url).toContain("/pull/1");
    expect(calls.some((call) => call.startsWith("POST") && call.endsWith("/git/refs"))).toBe(true);
    expect(calls.some((call) => call.startsWith("PUT") && call.includes("/contents/src/Fix.sol"))).toBe(true);
  });

  it("keeps credential-dependent actions disabled by default", async () => {
    delete process.env.TELEGRAM_BOT_TOKEN;
    delete process.env.MANTLE_PRIVATE_KEY;
    expect((await sendTelegram("test", "message")).sent).toBe(false);
    await expect(publishAttestation({
      scanId: "SCAN-1",
      subject: "0x0000000000000000000000000000000000000001",
      evidenceHash: `0x${"1".repeat(64)}`,
      severity: 1,
      remediated: false,
      evidenceURI: "s3://evidence/test",
      actor: "tester"
    })).rejects.toThrow("not configured");
  });

  it("requires matching GitHub OAuth state", () => {
    process.env.GITHUB_OAUTH_CLIENT_ID = "client";
    process.env.GITHUB_OAUTH_CALLBACK_URL = "https://example.com/callback";
    const login = githubLogin();
    const request = { header: (name: string) => name === "cookie" ? `manwall_oauth_state=${login.state}` : undefined } as never;
    expect(verifyGithubOAuthState(request, login.state)).toBe(true);
    expect(verifyGithubOAuthState(request, `${login.state}x`)).toBe(false);
  });

  it("allows only internal OAuth return targets", () => {
    expect(safeOAuthReturnTarget("/#repository")).toBe("/#repository");
    expect(safeOAuthReturnTarget("/#workbench")).toBe("/#workbench");
    expect(safeOAuthReturnTarget("https://evil.example")).toBe("/");
    expect(safeOAuthReturnTarget("//evil.example")).toBe("/");
    expect(safeOAuthReturnTarget("/admin")).toBe("/");
  });

  it("binds Telegram approval to one exact payload and consumes it once", async () => {
    delete process.env.DATABASE_URL;
    process.env.TELEGRAM_BOT_TOKEN = "test-bot";
    process.env.TELEGRAM_CHAT_ID = "-100123";
    process.env.TELEGRAM_WEBHOOK_SECRET = "telegram-secret";
    process.env.TELEGRAM_APPROVER_USER_IDS = "42,84";
    globalThis.fetch = async () => Response.json({ ok: true, result: { message_id: 7 } });

    const payload = { repository: "example/repo", branch: "manwall/fix-1" };
    const approval = await createTelegramApproval("github.remediation-pr", "example/repo", payload, "reviewer");
    expect(verifyTelegramWebhookSecret("telegram-secret")).toBe(true);
    await expect(decideTelegramApproval(approval.id, "approved", "99", "-100123")).rejects.toThrow("not authorized");
    await decideTelegramApproval(approval.id, "approved", "42", "-100123");
    await expect(consumeTelegramApproval(approval.id, "github.remediation-pr", { ...payload, branch: "manwall/other" })).rejects.toThrow("does not match");
    expect((await consumeTelegramApproval(approval.id, "github.remediation-pr", payload)).status).toBe("consumed");
    await expect(consumeTelegramApproval(approval.id, "github.remediation-pr", payload)).rejects.toThrow("consumed");
  });

  it("creates a constrained documentation-only PR payload from Telegram commands", () => {
    process.env.GITHUB_REPOSITORY = "AlgofootPrint/manwall";
    const payload = parseTelegramPrCommand("/pr Document approval flow | Explain how Telegram approval works.", "42", "reviewer");
    expect(payload?.repository).toBe("AlgofootPrint/manwall");
    expect(payload?.branch).toMatch(/^manwall\/telegram-/);
    expect(payload?.files).toHaveLength(1);
    expect(payload?.files[0].path).toMatch(/^docs\/telegram\/\d+\.md$/);
    expect(parseTelegramPrCommand("/pr missing description", "42")).toBeNull();
  });

  it("responds with instructions when the Telegram PR command is incomplete", async () => {
    delete process.env.DATABASE_URL;
    process.env.TELEGRAM_BOT_TOKEN = "test-bot";
    process.env.TELEGRAM_CHAT_ID = "-100123";
    globalThis.fetch = async () => Response.json({ ok: true, result: { message_id: 8 } });
    const result = await handleTelegramUpdate({
      message: { text: "/pr", chat: { id: "-100123" }, from: { id: "42", username: "reviewer" } }
    });
    expect(result).toEqual({ handled: true, command: "pr-help" });
  });

  it("runs contract analysis from an authorized Telegram chat", async () => {
    delete process.env.DATABASE_URL;
    process.env.TELEGRAM_BOT_TOKEN = "test-bot";
    process.env.TELEGRAM_CHAT_ID = "-100123";
    const messages: string[] = [];
    globalThis.fetch = async (_input, init) => {
      messages.push(String(JSON.parse(String(init?.body)).text ?? ""));
      return Response.json({ ok: true, result: { message_id: 9 } });
    };
    const result = await handleTelegramUpdate({
      message: {
        text: "/analyze pragma solidity ^0.8.20; contract Example { function value() external pure returns (uint256) { return 1; } }",
        chat: { id: "-100123" },
        from: { id: "7", username: "developer" }
      }
    });
    expect(result).toEqual({ handled: true, command: "analyze" });
    expect(messages.some((message) => message.includes("Contract analysis: TelegramSubmission.sol"))).toBe(true);
  });

  it("queues monitored repository scans and reports their status from Telegram", async () => {
    delete process.env.DATABASE_URL;
    process.env.TELEGRAM_BOT_TOKEN = "test-bot";
    process.env.TELEGRAM_CHAT_ID = "-100123";
    process.env.MANTLE_MONITORED_REPOSITORIES = "merchant-moe/moe-core";
    globalThis.fetch = async () => Response.json({ ok: true, result: { message_id: 10 } });
    const scan = await handleTelegramUpdate({
      message: { text: "/scan https://github.com/merchant-moe/moe-core", chat: { id: "-100123" }, from: { id: "7" } }
    }) as any;
    expect(scan.command).toBe("scan");
    expect(scan.job.status).toBe("queued");
    const status = await handleTelegramUpdate({
      message: { text: `/status ${scan.job.id}`, chat: { id: "-100123" }, from: { id: "7" } }
    }) as any;
    expect(status.command).toBe("status");
    expect(status.job.id).toBe(scan.job.id);
  });

  it("limits Telegram AI review to authorized approvers", async () => {
    delete process.env.DATABASE_URL;
    process.env.TELEGRAM_BOT_TOKEN = "test-bot";
    process.env.TELEGRAM_CHAT_ID = "-100123";
    process.env.TELEGRAM_APPROVER_USER_IDS = "42";
    globalThis.fetch = async () => Response.json({ ok: true, result: { message_id: 11 } });
    const result = await handleTelegramUpdate({
      message: { text: "/ai JOB-UNKNOWN", chat: { id: "-100123" }, from: { id: "7" } }
    }) as any;
    expect(result.command).toBe("error");
    expect(result.error).toContain("authorized Telegram approvers");
  });

  it("shows a persistent button menu and guides contract analysis input", async () => {
    delete process.env.DATABASE_URL;
    process.env.TELEGRAM_BOT_TOKEN = "test-bot";
    process.env.TELEGRAM_CHAT_ID = "-100123";
    const requests: any[] = [];
    globalThis.fetch = async (_input, init) => {
      requests.push(JSON.parse(String(init?.body)));
      return Response.json({ ok: true, result: { message_id: 12 } });
    };

    const help = await handleTelegramUpdate({
      message: { text: "/help", chat: { id: "-100123" }, from: { id: "7" } }
    });
    const prompt = await handleTelegramUpdate({
      message: { text: "Analyze Contract", chat: { id: "-100123" }, from: { id: "7" } }
    });
    const analysis = await handleTelegramUpdate({
      message: {
        text: "pragma solidity ^0.8.20; contract ButtonExample { function value() external pure returns (uint256) { return 1; } }",
        chat: { id: "-100123" },
        from: { id: "7" }
      }
    });

    expect(help).toEqual({ handled: true, command: "help" });
    expect(prompt).toEqual({ handled: true, command: "analyze-prompt" });
    expect(analysis).toEqual({ handled: true, command: "analyze" });
    expect(requests[0].reply_markup.is_persistent).toBe(true);
    expect(requests[0].reply_markup.keyboard.flat().map((item: any) => item.text)).toContain("Scan Wallet");
  });

  it("keeps guided button input scoped to the user who tapped it", async () => {
    delete process.env.DATABASE_URL;
    process.env.TELEGRAM_BOT_TOKEN = "test-bot";
    process.env.TELEGRAM_CHAT_ID = "-100123";
    globalThis.fetch = async () => Response.json({ ok: true, result: { message_id: 13 } });

    await handleTelegramUpdate({
      message: { text: "Check Scan Status", chat: { id: "-100123" }, from: { id: "7" } }
    });
    const otherUser = await handleTelegramUpdate({
      message: { text: "JOB-NOT-MINE", chat: { id: "-100123" }, from: { id: "8" } }
    });
    const initiatingUser = await handleTelegramUpdate({
      message: { text: "JOB-UNKNOWN", chat: { id: "-100123" }, from: { id: "7" } }
    }) as any;

    expect(otherUser).toEqual({ handled: false });
    expect(initiatingUser.command).toBe("error");
    expect(initiatingUser.error).toContain("not found");
  });
});
