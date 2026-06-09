import { describe, expect, it } from "vitest";
import { keccak256, toUtf8Bytes } from "ethers";
import { runSourceReentrancyProof } from "../server/sourceProof.js";

const vulnerableVault = `
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
contract SubmittedVault {
  mapping(address => uint256) public balances;
  function deposit() external payable { balances[msg.sender] += msg.value; }
  function withdraw() external {
    uint256 amount = balances[msg.sender];
    require(amount > 0, "no balance");
    (bool sent,) = msg.sender.call{value: amount}("");
    require(sent, "transfer failed");
    balances[msg.sender] = 0;
  }
}`;

describe("source-specific verified proof", () => {
  it("executes the attacker against submitted source and verifies the CEI patch", async () => {
    const report = await runSourceReentrancyProof("SubmittedVault.sol", vulnerableVault);

    expect(report.target.name).toBe("SubmittedVault");
    expect(report.verdict.exploitConfirmed).toBe(true);
    expect(report.verdict.patchVerified).toBe(true);
    expect(report.verdict.fundsAtRisk).toContain("MNT demonstrated");
    expect(report.gas.vulnerableWithdraw).not.toBe("not-measured");
    expect(report.gas.securedWithdraw).not.toBe("not-measured");
    expect(report.gas.deltaPercent).toMatch(/%$/);
    expect(report.attestation.evidenceHash).toMatch(/^0x[a-f0-9]{64}$/);
    for (const id of ["architecture", "attack", "patch", "attestation"]) {
      const agent = report.agents.find((item) => item.id === id);
      expect(agent?.artifact?.hash).toMatch(/^0x[a-f0-9]{64}$/);
      expect(agent?.artifact?.content.length).toBeGreaterThan(20);
    }
    expect(report.agents.find((item) => item.id === "patch")?.artifact?.content).toContain("+");
    expect(report.attestation.manifest).toBeDefined();
    expect(report.attestation.evidenceHash).toBe(keccak256(toUtf8Bytes(JSON.stringify(report.attestation.manifest))));
  }, 30_000);

  it("rejects contracts outside the bounded source-proof interface", async () => {
    await expect(runSourceReentrancyProof("Unsupported.sol", "pragma solidity ^0.8.24; contract Unsupported { function ping() external {} }"))
      .rejects.toThrow("supported checks-effects-interactions");
  });
});
