import crypto from "node:crypto";
import assert from "node:assert/strict";
import { runGuardianScan } from "./guardian.js";
import { analyzeSource } from "./sourceScanner.js";
import { createRepositoryJob, validateRepository } from "./repositoryScanner.js";
import { shouldScanGitHubEvent, verifyGitHubWebhookSignature } from "./github.js";
import { runAiWorkflow } from "./ai.js";
import { normalizeFoundryResult, normalizeSlitherResult } from "./containerRunner.js";

const report = await runGuardianScan();
assert.equal(report.target.chainId, 5003);
assert.equal(report.verdict.exploitConfirmed, true);
assert.equal(report.verdict.patchVerified, true);
assert.equal(report.agents.length, 7);
assert.equal(report.agents.every((agent) => agent.status === "passed"), true);
assert.match(report.attestation.evidenceHash, /^0x[a-f0-9]{64}$/);

const triage = analyzeSource("RealInput.sol", `
pragma solidity ^0.8.24;
contract RealInput {
  mapping(address => uint256) balances;
  function withdraw() external {
    uint256 amount = balances[msg.sender];
    (bool sent,) = msg.sender.call{value: amount}("");
    require(sent);
    balances[msg.sender] = 0;
  }
}`);
assert.equal(triage.compilation.passed, true);
assert.equal(triage.findings.some((finding) => finding.detector === "REENTRANCY-CEI"), true);
assert.equal(triage.proofStatus, "unverified");
assert.equal(validateRepository("https://github.com/example/protocol"), "https://github.com/example/protocol.git");
assert.throws(() => validateRepository("https://example.com/protocol"));
assert.equal(createRepositoryJob("https://github.com/example/protocol").status, "queued");
assert.equal(normalizeSlitherResult({
  code: 255,
  stdout: JSON.stringify({ success: true, results: { detectors: [{ check: "reentrancy-eth" }] } }),
  stderr: ""
}).findings, 1);
assert.equal(normalizeFoundryResult({
  code: 1,
  stdout: "Suite result: FAILED. 2 tests passed, 1 failed, 0 skipped",
  stderr: ""
}).findings, 1);

const webhookBody = Buffer.from(JSON.stringify({ action: "opened", repository: { html_url: "https://github.com/example/protocol" } }));
const webhookSecret = "secret";
const webhookSignature = `sha256=${crypto.createHmac("sha256", webhookSecret).update(webhookBody).digest("hex")}`;
assert.equal(verifyGitHubWebhookSignature(webhookSecret, webhookBody, webhookSignature), true);
assert.equal(shouldScanGitHubEvent("push", { repository: { html_url: "https://github.com/example/protocol" } }), "https://github.com/example/protocol");
assert.equal(shouldScanGitHubEvent("pull_request", { action: "synchronize", pull_request: { head: { repo: { html_url: "https://github.com/example/protocol" } } } }), "https://github.com/example/protocol");
assert.equal(shouldScanGitHubEvent("deployment", { action: "created", repository: { html_url: "https://github.com/example/protocol" } }), "https://github.com/example/protocol");
assert.equal(shouldScanGitHubEvent("deployment", { action: "deleted", repository: { html_url: "https://github.com/example/protocol" } } as never), null);

const originalFetch = globalThis.fetch;
const originalEnv = {
  AI_PROVIDER: process.env.AI_PROVIDER,
  OPENAI_API_KEY: process.env.OPENAI_API_KEY,
  OPENAI_MODEL: process.env.OPENAI_MODEL,
  AI_MONTHLY_BUDGET_USD: process.env.AI_MONTHLY_BUDGET_USD,
  AI_REQUEST_TOKEN_LIMIT: process.env.AI_REQUEST_TOKEN_LIMIT,
  AI_MAX_OUTPUT_TOKENS: process.env.AI_MAX_OUTPUT_TOKENS,
  DATABASE_URL: process.env.DATABASE_URL
};

try {
  process.env.AI_PROVIDER = "openai";
  process.env.OPENAI_API_KEY = "sk-test";
  process.env.OPENAI_MODEL = "gpt-5.4-mini";
  process.env.AI_MONTHLY_BUDGET_USD = "5";
  process.env.AI_REQUEST_TOKEN_LIMIT = "12000";
  process.env.AI_MAX_OUTPUT_TOKENS = "128";
  delete process.env.DATABASE_URL;
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify({
      choices: [{
        message: {
          content: JSON.stringify({
            summary: "AI summary",
            riskLevel: "high",
            keyObservations: ["Observation 1"],
            recommendedActions: ["Action 1"],
            patchDraft: "PATCH-DRAFT"
          })
        }
      }],
      usage: { prompt_tokens: 20, completion_tokens: 10 }
    })
  }) as never;

  const review = await runAiWorkflow("review", {
    subject: "Review example contract",
    context: "Review this contract for reentrancy and authorization issues.",
    repository: "https://github.com/example/protocol",
    findings: ["Potential reentrancy"],
    source: "contract Example {}"
  }, false);
  assert.equal(review.workflow, "review");
  assert.equal(review.approved, false);
  assert.equal(review.summary, "AI summary");
  assert.equal(review.usage.inputTokens, 20);
  assert.equal(review.usage.outputTokens, 10);

  const patch = await runAiWorkflow("patch", {
    subject: "Draft a remediation patch",
    context: "Patch the reentrancy issue with checks-effects-interactions.",
    source: "contract Example {}",
    approvalNote: "Approved by human reviewer"
  }, true);
  assert.equal(patch.workflow, "patch");
  assert.equal(patch.approved, true);
  assert.equal(patch.patchDraft, "PATCH-DRAFT");
} finally {
  globalThis.fetch = originalFetch;
  process.env.AI_PROVIDER = originalEnv.AI_PROVIDER;
  process.env.OPENAI_API_KEY = originalEnv.OPENAI_API_KEY;
  process.env.OPENAI_MODEL = originalEnv.OPENAI_MODEL;
  process.env.AI_MONTHLY_BUDGET_USD = originalEnv.AI_MONTHLY_BUDGET_USD;
  process.env.AI_REQUEST_TOKEN_LIMIT = originalEnv.AI_REQUEST_TOKEN_LIMIT;
  process.env.AI_MAX_OUTPUT_TOKENS = originalEnv.AI_MAX_OUTPUT_TOKENS;
  process.env.DATABASE_URL = originalEnv.DATABASE_URL;
}

console.log(`PASS ${report.scanId}: verified proof, source triage, and repository job validation`);
