export type AgentStatus = "queued" | "running" | "passed" | "failed";

export interface AgentResult {
  id: string;
  name: string;
  role: string;
  status: AgentStatus;
  summary: string;
  evidence: string[];
  durationMs: number;
  artifact?: {
    kind: "architecture-manifest" | "attack-plan" | "patch-diff" | "proof-manifest";
    content: string;
    hash: string;
  };
}

export interface ScanReport {
  scanId: string;
  startedAt: string;
  completedAt: string;
  target: {
    name: string;
    network: string;
    chainId: number;
    address: string;
  };
  verdict: {
    severity: "critical";
    vulnerability: string;
    exploitConfirmed: boolean;
    patchVerified: boolean;
    fundsAtRisk: string;
  };
  agents: AgentResult[];
  gas: {
    vulnerableWithdraw: string;
    securedWithdraw: string;
    deltaPercent: string;
    mantleAdvice?: string[];
    mantleFeeEstimate?: import("./mantleGas.js").MantleFeeEstimate;
  };
  attestation: {
    evidenceHash: string;
    identityURI: string;
    registryMode: "local-proof" | "mantle-sepolia";
    transactionHash?: string;
    manifest?: Record<string, unknown>;
  };
}
