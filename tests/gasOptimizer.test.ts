import { describe, expect, it } from "vitest";
import { analyzeSource } from "../server/sourceScanner.js";

describe("Mantle gas optimization assistant", () => {
  it("keeps gas optimization hints separate from security findings", () => {
    const report = analyzeSource("Batch.sol", `
      // SPDX-License-Identifier: MIT
      pragma solidity ^0.8.24;

      contract Batch {
        uint256 fee = 1;

        function process(uint256[] memory values) external {
          for (uint256 i = 0; i < values.length; i++) {
            require(values[i] > fee, "value must be greater than the configured fee");
          }
        }
      }
    `);

    expect(report.findings).toHaveLength(0);
    expect(report.gasOptimizations.length).toBeGreaterThanOrEqual(3);
    expect(report.gasOptimizations.map((item) => item.detector)).toContain("GAS-CACHE-LENGTH");
    expect(report.gasOptimizations.every((item) => item.mantleContext.includes("Mantle"))).toBe(true);
  });

  it("returns compilation results, security findings, and recommended remediations", () => {
    const report = analyzeSource("Vault.sol", `
      // SPDX-License-Identifier: MIT
      pragma solidity ^0.8.24;

      contract Vault {
        mapping(address => uint256) balances;
        function withdraw() external {
          uint256 amount = balances[msg.sender];
          (bool sent,) = msg.sender.call{value: amount}("");
          require(sent);
          balances[msg.sender] = 0;
        }
      }
    `);

    expect(report.compilation.passed).toBe(true);
    expect(report.compilation.contracts).toContain("Vault");
    expect(report.findings.map((item) => item.detector)).toContain("REENTRANCY-CEI");
    expect(report.findings[0]?.remediation).toContain("checks-effects-interactions");
  });

  it("returns Solidity compiler errors for invalid source", () => {
    const report = analyzeSource("Broken.sol", "pragma solidity ^0.8.24; contract Broken { function run( external {} }");

    expect(report.compilation.passed).toBe(false);
    expect(report.compilation.errors.length).toBeGreaterThan(0);
  });

  it("produces deterministic evidence for identical source", () => {
    const source = "pragma solidity ^0.8.24; contract Timed { function ready() external view returns (bool) { return block.timestamp > 1; } }";
    const first = analyzeSource("Timed.sol", source);
    const second = analyzeSource("Timed.sol", source);

    expect(first.findings[0]?.detector).toBe("TIME-BLOCK-TIMESTAMP");
    expect(first.findings[0]?.id).toBe(second.findings[0]?.id);
    expect(first.evidenceHash).toBe(second.evidenceHash);
  });

  it("detects ignored low-level call results without flagging checked calls", () => {
    const report = analyzeSource("Calls.sol", `
      pragma solidity ^0.8.24;
      contract Calls {
        function ignored(address target) external { target.call(""); }
        function checked(address target) external {
          (bool success,) = target.call("");
          require(success);
        }
      }
    `);

    expect(report.findings.filter((item) => item.detector === "CALL-UNCHECKED-LOW-LEVEL")).toHaveLength(1);
  });
});
