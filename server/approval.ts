import { getAddress, verifyMessage } from "ethers";

export interface AttestationApprovalPayload {
  scanId: string;
  subject: string;
  evidenceHash: string;
  evidenceURI: string;
  severity: number;
  remediated: boolean;
}

export function attestationApprovalMessage(payload: AttestationApprovalPayload) {
  if (!process.env.ATTESTATION_REGISTRY_ADDRESS) {
    throw new Error("Mantle attestation registry is not configured.");
  }
  return [
    "manwall attestation approval",
    `scan: ${payload.scanId}`,
    `subject: ${getAddress(payload.subject)}`,
    `evidence: ${payload.evidenceHash}`,
    `evidenceURI: ${payload.evidenceURI}`,
    `severity: ${payload.severity}`,
    `remediated: ${payload.remediated}`,
    "network: Mantle Sepolia (5003)",
    `registry: ${getAddress(process.env.ATTESTATION_REGISTRY_ADDRESS)}`,
    "gas payer: Manwall publisher wallet",
    "This signature authorizes Manwall to publish this exact validation evidence on-chain."
  ].join("\n");
}

export function verifyAttestationApproval(payload: AttestationApprovalPayload, approval: { address: string; signature: string }) {
  try {
    const recovered = verifyMessage(attestationApprovalMessage(payload), approval.signature);
    return getAddress(recovered) === getAddress(approval.address);
  } catch {
    return false;
  }
}

export function authorizeAttestationPublication(
  payload: AttestationApprovalPayload,
  walletApproval: { address: string; signature: string } | undefined,
  explicitDemoApproval = false
) {
  if (walletApproval && verifyAttestationApproval(payload, walletApproval)) {
    return { actor: getAddress(walletApproval.address), method: "wallet-signature" as const };
  }
  const demoAllowed = process.env.NODE_ENV !== "production"
    && process.env.ALLOW_DEMO_ATTESTATION_APPROVAL === "true"
    && explicitDemoApproval;
  if (demoAllowed) return { actor: "demo", method: "demo-approval" as const };
  throw new Error("A valid wallet signature is required to publish an attestation.");
}
