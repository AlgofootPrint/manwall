import { Contract, JsonRpcProvider, Wallet, keccak256, toUtf8Bytes } from "ethers";
import { saveAttestationRecord, writeOperationAudit } from "./infrastructure.js";

const abi = ["function publishValidation(bytes32,address,bytes32,uint8,bool,string) external"];

export async function publishAttestation(input: {
  scanId: string;
  subject: string;
  evidenceHash: string;
  severity: number;
  remediated: boolean;
  evidenceURI: string;
  actor: string;
}) {
  if (!process.env.MANTLE_PRIVATE_KEY || !process.env.ATTESTATION_REGISTRY_ADDRESS) {
    throw new Error("Mantle attestation publisher is not configured.");
  }
  const provider = new JsonRpcProvider(process.env.MANTLE_RPC_URL ?? "https://rpc.sepolia.mantle.xyz");
  const signer = new Wallet(process.env.MANTLE_PRIVATE_KEY, provider);
  const publisherAddress = signer.address;
  const registry = new Contract(process.env.ATTESTATION_REGISTRY_ADDRESS, abi, signer);
  const tx = await registry.publishValidation(
    keccak256(toUtf8Bytes(input.scanId)),
    input.subject,
    input.evidenceHash,
    input.severity,
    input.remediated,
    input.evidenceURI
  );
  const receipt = await tx.wait();
  const record = {
    scanId: input.scanId,
    actor: input.actor,
    publisherAddress,
    registryAddress: process.env.ATTESTATION_REGISTRY_ADDRESS,
    transactionHash: tx.hash,
    receipt: receipt?.toJSON?.() ?? receipt
  };
  await saveAttestationRecord(record);
  await writeOperationAudit(input.actor, "attestation.publish", input.scanId, "ok", { transactionHash: tx.hash, publisherAddress });
  return record;
}
