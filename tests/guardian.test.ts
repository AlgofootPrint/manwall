import { describe, expect, it } from "vitest";
import { keccak256, toUtf8Bytes } from "ethers";
import { runGuardianScan } from "../server/guardian.js";

describe("Mantle Guardian proof pipeline", () => {
  it("proves the exploit, verifies the patch, and publishes evidence", async () => {
    const report = await runGuardianScan();
    expect(report.target.chainId).toBe(5003);
    expect(report.verdict.exploitConfirmed).toBe(true);
    expect(report.verdict.patchVerified).toBe(true);
    expect(report.agents).toHaveLength(7);
    expect(report.agents.every((agent) => agent.status === "passed")).toBe(true);
    expect(report.attestation.evidenceHash).toMatch(/^0x[a-f0-9]{64}$/);
    expect(report.gas.mantleAdvice?.length).toBeGreaterThan(0);
    expect(report.gas.mantleFeeEstimate?.chainId).toBe(5003);
    for (const id of ["architecture", "attack", "patch", "attestation"]) {
      expect(report.agents.find((agent) => agent.id === id)?.artifact?.hash).toMatch(/^0x[a-f0-9]{64}$/);
    }
    expect(report.attestation.evidenceHash).toBe(keccak256(toUtf8Bytes(JSON.stringify(report.attestation.manifest))));
  }, 30_000);
});
