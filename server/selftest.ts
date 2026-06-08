import assert from "node:assert/strict";
import { runGuardianScan } from "./guardian.js";
import { analyzeSource } from "./sourceScanner.js";
import { createRepositoryJob, validateRepository } from "./repositoryScanner.js";

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

console.log(`PASS ${report.scanId}: verified proof, source triage, and repository job validation`);
