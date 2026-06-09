import crypto from "node:crypto";
import solc from "solc";
import { keccak256, toUtf8Bytes } from "ethers";

export interface SourceFinding {
  id: string;
  title: string;
  severity: "critical" | "high" | "medium" | "low";
  confidence: "high" | "medium" | "low";
  line: number;
  detector: string;
  evidence: string;
  remediation: string;
  proofStatus: "heuristic-only";
}

export interface GasOptimization {
  id: string;
  title: string;
  impact: "high" | "medium" | "low";
  confidence: "high" | "medium" | "low";
  line: number;
  detector: string;
  evidence: string;
  recommendation: string;
  mantleContext: string;
}

export interface SourceAnalysis {
  scanId: string;
  mode: "source-triage";
  proofStatus: "unverified";
  createdAt: string;
  target: { name: string; sourceHash: string };
  compilation: { passed: boolean; contracts: string[]; errors: string[] };
  findings: SourceFinding[];
  gasOptimizations: GasOptimization[];
  evidenceHash: string;
}

const lineOf = (source: string, index: number) => source.slice(0, index).split("\n").length;
const stableId = (kind: string, detector: string, line: number, evidence: string) =>
  `${kind}-${crypto.createHash("sha256").update(`${detector}:${line}:${evidence}`).digest("hex").slice(0, 16).toUpperCase()}`;

function finding(
  source: string,
  match: RegExpExecArray,
  details: Omit<SourceFinding, "id" | "line" | "evidence" | "proofStatus">
): SourceFinding {
  const line = lineOf(source, match.index);
  const evidence = match[0].trim().replace(/\s+/g, " ").slice(0, 180);
  return {
    id: stableId("FINDING", details.detector, line, evidence),
    line,
    evidence,
    proofStatus: "heuristic-only",
    ...details
  };
}

function gasOptimization(
  source: string,
  match: RegExpExecArray,
  details: Omit<GasOptimization, "id" | "line" | "evidence">
): GasOptimization {
  const line = lineOf(source, match.index);
  const evidence = match[0].trim().replace(/\s+/g, " ").slice(0, 180);
  return {
    id: stableId("GAS", details.detector, line, evidence),
    line,
    evidence,
    ...details
  };
}

function detectGasOptimizations(source: string) {
  const optimizations: GasOptimization[] = [];

  for (const match of source.matchAll(/\buint256\s+(?:public\s+)?(?:constant\s+)?[A-Za-z_][A-Za-z0-9_]*\s*=/g)) {
    const declaration = match[0];
    if (declaration.includes("constant")) continue;
    optimizations.push(gasOptimization(source, match as RegExpExecArray, {
      title: "State value can likely be constant or immutable",
      impact: "medium",
      confidence: "medium",
      detector: "GAS-CONSTANT-IMMUTABLE",
      recommendation: "Use constant for compile-time values or immutable for constructor-set values to reduce storage reads.",
      mantleContext: "Lower storage access reduces execution gas on Mantle Sepolia and mainnet-compatible EVM execution."
    }));
  }

  for (const match of source.matchAll(/for\s*\([^;]+;\s*[^;]+\.length\s*;[^)]*\)/g)) {
    optimizations.push(gasOptimization(source, match as RegExpExecArray, {
      title: "Loop repeatedly reads dynamic array length",
      impact: "medium",
      confidence: "medium",
      detector: "GAS-CACHE-LENGTH",
      recommendation: "Cache the array length before the loop when the array is not mutated inside the loop.",
      mantleContext: "Caching repeated reads is a safe micro-optimization for Mantle contracts with batch operations."
    }));
  }

  for (const match of source.matchAll(/\+\+|--/g)) {
    const context = source.slice(Math.max(0, match.index - 80), match.index + 80);
    if (!/for\s*\(/.test(context)) continue;
    optimizations.push(gasOptimization(source, match as RegExpExecArray, {
      title: "Loop increment can use unchecked arithmetic",
      impact: "low",
      confidence: "medium",
      detector: "GAS-UNCHECKED-INCREMENT",
      recommendation: "Use unchecked increment in loops where bounds make overflow impossible and tests cover the invariant.",
      mantleContext: "Unchecked increments reduce arithmetic overhead for Mantle contracts, but Manwall flags this only as reviewable guidance."
    }));
  }

  for (const match of source.matchAll(/function\s+[A-Za-z_][A-Za-z0-9_]*\s*\([^)]*(?:memory\s+[A-Za-z_][A-Za-z0-9_]*|[A-Za-z0-9_[\]]+\s+memory\s+[A-Za-z_][A-Za-z0-9_]*)/g)) {
    if (!/\bexternal\b/.test(source.slice(match.index, match.index + 300))) continue;
    optimizations.push(gasOptimization(source, match as RegExpExecArray, {
      title: "External function parameter may use calldata",
      impact: "medium",
      confidence: "medium",
      detector: "GAS-CALLDATA-PARAM",
      recommendation: "Use calldata for external read-only array/string/bytes parameters to avoid unnecessary memory copies.",
      mantleContext: "Calldata parameters reduce execution gas for Mantle-facing entrypoints."
    }));
  }

  for (const match of source.matchAll(/\brequire\s*\([^,;]+,\s*"[^"]{33,}"\s*\)/g)) {
    optimizations.push(gasOptimization(source, match as RegExpExecArray, {
      title: "Long revert string can be custom error",
      impact: "low",
      confidence: "high",
      detector: "GAS-CUSTOM-ERROR",
      recommendation: "Replace long revert strings with custom errors to reduce deployed bytecode and revert cost.",
      mantleContext: "Custom errors keep Mantle deployments smaller and make failure paths cheaper."
    }));
  }

  return optimizations;
}

export function analyzeSource(name: string, source: string): SourceAnalysis {
  const input = {
    language: "Solidity",
    sources: { [name]: { content: source } },
    settings: {
      evmVersion: "shanghai",
      outputSelection: { "*": { "*": ["abi", "evm.bytecode.object"] } }
    }
  };
  const output = JSON.parse(solc.compile(JSON.stringify(input)));
  const errors = (output.errors ?? [])
    .filter((item: { severity: string }) => item.severity === "error")
    .map((item: { formattedMessage: string }) => item.formattedMessage);
  const contracts = Object.keys(output.contracts?.[name] ?? {});
  const findings: SourceFinding[] = [];
  const gasOptimizations = detectGasOptimizations(source);

  const txOrigin = /\btx\.origin\b/g;
  for (const match of source.matchAll(txOrigin)) {
    findings.push(finding(source, match as RegExpExecArray, {
      title: "Authorization depends on tx.origin",
      severity: "high",
      confidence: "high",
      detector: "AUTH-TX-ORIGIN",
      remediation: "Use msg.sender and explicit role or ownership checks."
    }));
  }

  const delegatecall = /\.delegatecall\s*\(/g;
  for (const match of source.matchAll(delegatecall)) {
    findings.push(finding(source, match as RegExpExecArray, {
      title: "Delegatecall requires trust-boundary review",
      severity: "high",
      confidence: "medium",
      detector: "CALL-DELEGATECALL",
      remediation: "Restrict the target, validate implementation code, and test storage-layout invariants."
    }));
  }

  const selfdestruct = /\bselfdestruct\s*\(/g;
  for (const match of source.matchAll(selfdestruct)) {
    findings.push(finding(source, match as RegExpExecArray, {
      title: "Contract contains selfdestruct",
      severity: "medium",
      confidence: "high",
      detector: "LIFECYCLE-SELFDESTRUCT",
      remediation: "Remove selfdestruct or strictly constrain its authorization and lifecycle assumptions."
    }));
  }

  const externalCall = /\.call\s*\{[^}]*value\s*:[^}]+\}\s*\([^)]*\)/g;
  for (const match of source.matchAll(externalCall)) {
    const trailingFunction = source.slice(match.index, match.index + 500);
    if (/balances?\s*\[[^\]]+\]\s*=\s*0/.test(trailingFunction)) {
      findings.push(finding(source, match as RegExpExecArray, {
        title: "Potential reentrancy: value transfer before state update",
        severity: "critical",
        confidence: "high",
        detector: "REENTRANCY-CEI",
        remediation: "Apply checks-effects-interactions and add a reentrancy guard."
      }));
    }
  }

  for (const match of source.matchAll(/(?<![=(,])\b[A-Za-z_][A-Za-z0-9_.\[\]]*\.call(?:\s*\{[^}]*\})?\s*\([^;]*\)\s*;/g)) {
    const statementPrefix = source.slice(Math.max(0, source.lastIndexOf(";", match.index - 1) + 1), match.index);
    if (statementPrefix.includes("=") || /\brequire\s*\($/.test(statementPrefix.trim())) continue;
    findings.push(finding(source, match as RegExpExecArray, {
      title: "Low-level call return value is not checked",
      severity: "high",
      confidence: "high",
      detector: "CALL-UNCHECKED-LOW-LEVEL",
      remediation: "Capture the success value returned by call and revert or handle failure explicitly."
    }));
  }

  for (const match of source.matchAll(/(?<![=(,])\b[A-Za-z_][A-Za-z0-9_.\[\]]*\.send\s*\([^;]*\)\s*;/g)) {
    const statementPrefix = source.slice(Math.max(0, source.lastIndexOf(";", match.index - 1) + 1), match.index);
    if (statementPrefix.includes("=") || /\brequire\s*\($/.test(statementPrefix.trim())) continue;
    findings.push(finding(source, match as RegExpExecArray, {
      title: "Send return value is ignored",
      severity: "medium",
      confidence: "high",
      detector: "CALL-UNCHECKED-SEND",
      remediation: "Check the boolean returned by send or use a withdrawal pattern with explicit failure handling."
    }));
  }

  for (const match of source.matchAll(/\becrecover\s*\(/g)) {
    findings.push(finding(source, match as RegExpExecArray, {
      title: "Raw ecrecover usage requires signature validation review",
      severity: "medium",
      confidence: "medium",
      detector: "CRYPTO-ECRECOVER",
      remediation: "Validate nonzero signers, enforce canonical signatures, include nonce/domain separation, or use a reviewed ECDSA library."
    }));
  }

  for (const match of source.matchAll(/\bblock\.timestamp\b/g)) {
    findings.push(finding(source, match as RegExpExecArray, {
      title: "Logic depends on block timestamp",
      severity: "low",
      confidence: "medium",
      detector: "TIME-BLOCK-TIMESTAMP",
      remediation: "Avoid using timestamps for precise randomness or tight critical boundaries; document acceptable validator influence."
    }));
  }

  const scanId = `SRC-${crypto.randomBytes(4).toString("hex").toUpperCase()}`;
  const evidencePayload = JSON.stringify({ name, sourceHash: keccak256(toUtf8Bytes(source)), errors, contracts, findings, gasOptimizations });
  return {
    scanId,
    mode: "source-triage",
    proofStatus: "unverified",
    createdAt: new Date().toISOString(),
    target: { name, sourceHash: keccak256(toUtf8Bytes(source)) },
    compilation: { passed: errors.length === 0, contracts, errors },
    findings,
    gasOptimizations,
    evidenceHash: keccak256(toUtf8Bytes(evidencePayload))
  };
}
