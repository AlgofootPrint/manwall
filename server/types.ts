export type AgentStatus = "queued" | "running" | "passed" | "failed";

export interface AgentResult {
  id: string;
  name: string;
  role: string;
  status: AgentStatus;
  summary: string;
  evidence: string[];
  durationMs: number;
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
  };
  attestation: {
    evidenceHash: string;
    identityURI: string;
    registryMode: "local-proof" | "mantle-sepolia";
    transactionHash?: string;
  };
}
