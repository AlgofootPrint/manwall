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

export interface SourceAnalysis {
  scanId: string;
  mode: "source-triage";
  proofStatus: "unverified";
  createdAt: string;
  target: { name: string; sourceHash: string };
  compilation: { passed: boolean; contracts: string[]; errors: string[] };
  findings: SourceFinding[];
  evidenceHash: string;
}

const lineOf = (source: string, index: number) => source.slice(0, index).split("\n").length;

function finding(
  source: string,
  match: RegExpExecArray,
  details: Omit<SourceFinding, "id" | "line" | "evidence" | "proofStatus">
): SourceFinding {
  return {
    id: crypto.randomUUID(),
    line: lineOf(source, match.index),
    evidence: match[0].trim().replace(/\s+/g, " ").slice(0, 180),
    proofStatus: "heuristic-only",
    ...details
  };
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

  const scanId = `SRC-${crypto.randomBytes(4).toString("hex").toUpperCase()}`;
  const evidencePayload = JSON.stringify({ name, sourceHash: keccak256(toUtf8Bytes(source)), errors, contracts, findings });
  return {
    scanId,
    mode: "source-triage",
    proofStatus: "unverified",
    createdAt: new Date().toISOString(),
    target: { name, sourceHash: keccak256(toUtf8Bytes(source)) },
    compilation: { passed: errors.length === 0, contracts, errors },
    findings,
    evidenceHash: keccak256(toUtf8Bytes(evidencePayload))
  };
}
