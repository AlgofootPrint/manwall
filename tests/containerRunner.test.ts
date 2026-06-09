import { describe, expect, it } from "vitest";
import { normalizeCompilationResult, normalizeFoundryResult, normalizeSlitherResult } from "../server/containerRunner.js";

describe("isolated tool result normalization", () => {
  it("treats Slither findings as a completed analysis", () => {
    const result = normalizeSlitherResult({
      code: 255,
      stdout: JSON.stringify({
        success: true,
        results: { detectors: [{ check: "reentrancy-eth" }, { check: "unchecked-lowlevel" }] }
      }),
      stderr: ""
    });

    expect(result.status).toBe("passed");
    expect(result.findings).toBe(2);
  });

  it("records Foundry failures as findings", () => {
    const result = normalizeFoundryResult({
      code: 1,
      stdout: "Suite result: FAILED. 3 tests passed; 2 failed; 0 skipped",
      stderr: ""
    });

    expect(result.status).toBe("failed");
    expect(result.findings).toBe(2);
  });

  it("reports blocked RPC fork tests without treating them as findings or compiler failures", () => {
    const result = normalizeFoundryResult({
      code: 1,
      stdout: [
        "Suite result: FAILED. 78 tests passed; 5 failed; 0 skipped",
        "[FAIL: vm.createSelectFork: error sending request; failed to lookup address] test_Deploy()",
        "[FAIL: vm.createSelectFork: error sending request; failed to lookup address] test_Upgrade()"
      ].join("\n"),
      stderr: ""
    });

    expect(result.status).toBe("failed");
    expect(result.findings).toBe(0);
    expect(result.summary).toContain("fork-dependent");
    expect(result.summary).not.toContain("compiler");
  });

  it("does not report an unavailable offline compiler as a failed test", () => {
    const result = normalizeFoundryResult({
      code: 1,
      stdout: "",
      stderr: "Error sending request to https://binaries.soliditylang.org/linux-amd64/list.json: failed to lookup address"
    });

    expect(result.status).toBe("failed");
    expect(result.findings).toBe(0);
    expect(result.summary).toContain("compiler");
  });

  it("does not report a resource-killed compiler as a failed test", () => {
    const result = normalizeFoundryResult({ code: 1, stdout: "Error: solc exited with signal: 9 (SIGKILL)", stderr: "" });

    expect(result.status).toBe("failed");
    expect(result.findings).toBe(0);
    expect(result.summary).toContain("resource limit");
  });

  it("records Slither compilation errors as failures", () => {
    const result = normalizeSlitherResult({
      code: 0,
      stdout: JSON.stringify({ success: false, error: "Compilation failed" }),
      stderr: ""
    });

    expect(result.status).toBe("failed");
    expect(result.findings).toBe(0);
  });

  it("accepts Slither JSON written to stderr", () => {
    const result = normalizeSlitherResult({
      code: 0,
      stdout: "",
      stderr: JSON.stringify({ success: true, results: { detectors: [{ check: "reentrancy-eth" }] } })
    });

    expect(result.status).toBe("passed");
    expect(result.findings).toBe(1);
  });

  it("reports project compilation separately from security findings", () => {
    const result = normalizeCompilationResult({ code: 1, stdout: "", stderr: "ParserError" }, "forge");

    expect(result.status).toBe("failed");
    expect(result.findings).toBe(0);
    expect(result.summary).toContain("forge");
  });
});
