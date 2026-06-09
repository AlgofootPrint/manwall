const base = process.env.MANWALL_BASE_URL ?? "http://localhost:8787";
const payload = {
  scanId: "POLICY-CHECK-NO-PUBLISH",
  subject: "0x0000000000000000000000000000000000000001",
  evidenceHash: `0x${"1".repeat(64)}`,
  severity: 1,
  remediated: false,
  evidenceURI: "manwall://policy-check"
};

const approvalMessageResponse = await fetch(`${base}/api/attestations/approval-message`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(payload)
});
if (!approvalMessageResponse.ok) {
  throw new Error(`Approval message endpoint returned HTTP ${approvalMessageResponse.status}.`);
}
const approvalMessage = await approvalMessageResponse.json();
if (!String(approvalMessage.message).includes("network: Mantle Sepolia (5003)")) {
  throw new Error("Approval message is not bound to Mantle Sepolia.");
}
if (!String(approvalMessage.message).includes("registry: 0x")) {
  throw new Error("Approval message is not bound to an attestation registry.");
}

const bypassResponse = await fetch(`${base}/api/attestations/publish`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ ...payload, approved: true })
});
const bypassBody = await bypassResponse.json().catch(() => ({}));
if (bypassResponse.status !== 403 || !String(bypassBody.error).includes("valid wallet signature")) {
  throw new Error(`Production demo bypass was not rejected by wallet-only policy: HTTP ${bypassResponse.status} ${JSON.stringify(bypassBody)}`);
}

console.log("attestation approval message is registry-bound and approved:true is rejected without a wallet signature");
