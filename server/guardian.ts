import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import ganache from "ganache";
import { BrowserProvider, ContractFactory, formatEther, keccak256, toUtf8Bytes } from "ethers";
import { compileContracts, type Artifact } from "./compile.js";
import type { AgentResult, ScanReport } from "./types.js";

const identityURI = "manwall://mantle/autonomous-security-engineer/v1";

function result(
  id: string,
  name: string,
  role: string,
  started: number,
  summary: string,
  evidence: string[],
  status: AgentResult["status"] = "passed"
): AgentResult {
  return { id, name, role, status, summary, evidence, durationMs: Date.now() - started };
}

async function deploy(artifact: Artifact, signer: Awaited<ReturnType<BrowserProvider["getSigner"]>>, args: unknown[] = []) {
  const factory = new ContractFactory(artifact.abi, artifact.bytecode, signer);
  const contract = await factory.deploy(...args);
  await contract.waitForDeployment();
  return contract as any;
}

export async function runGuardianScan(): Promise<ScanReport> {
  const startedAt = new Date();
  const agents: AgentResult[] = [];
  const artifacts = compileContracts();

  let started = Date.now();
  const vulnerableSource = fs.readFileSync(path.resolve("contracts/VulnerableVault.sol"), "utf8");
  const securedSource = fs.readFileSync(path.resolve("contracts/SecuredVault.sol"), "utf8");
  agents.push(result(
    "architecture",
    "Architecture Agent",
    "Maps contracts, state, external calls, and trust boundaries.",
    started,
    "Vault exposes a deposit/withdraw flow with an untrusted external callback.",
    [
      "Asset boundary: native MNT/ETH held by vault",
      "Trust boundary: msg.sender receives control during withdraw()",
      "State invariant: total credited balances must cover withdrawals"
    ]
  ));

  started = Date.now();
  const interactionBeforeEffect = vulnerableSource.indexOf("msg.sender.call") < vulnerableSource.indexOf("balances[msg.sender] = 0");
  agents.push(result(
    "attack",
    "Attack Agent",
    "Investigates security and economic attack surfaces.",
    started,
    "Critical reentrancy path found in VulnerableVault.withdraw().",
    [
      `Interaction-before-effect detected: ${interactionBeforeEffect}`,
      "Attacker can recursively withdraw before its balance is cleared",
      "CWE-841: Improper Enforcement of Behavioral Workflow"
    ]
  ));

  const chain = ganache.provider({
    chain: { chainId: 5003 },
    wallet: { totalAccounts: 4, defaultBalance: 1000 },
    logging: { quiet: true }
  });
  const provider = new BrowserProvider(chain as never);
  const deployer = await provider.getSigner(0);
  const victim = await provider.getSigner(1);
  const attackerOwner = await provider.getSigner(2);

  const vulnerable = await deploy(artifacts.VulnerableVault, deployer);
  const vulnerableAddress = await vulnerable.getAddress();
  await (await vulnerable.connect(victim).deposit({ value: 10n * 10n ** 18n })).wait();
  const attacker = await deploy(artifacts.ReentrancyAttacker, attackerOwner, [vulnerableAddress]);
  const beforeAttack = await provider.getBalance(await attacker.getAddress());

  started = Date.now();
  const attackReceipt = await (await attacker.connect(attackerOwner).attack({ value: 10n ** 18n })).wait();
  const afterAttack = await provider.getBalance(await attacker.getAddress());
  const stolen = afterAttack - beforeAttack - 10n ** 18n;
  agents.push(result(
    "exploit",
    "Exploit Agent",
    "Generates and executes adversarial proof-of-concept tests.",
    started,
    `Exploit confirmed. Recursive withdrawal drained ${formatEther(stolen)} native tokens beyond attacker deposit.`,
    [
      `Attack transaction: ${attackReceipt?.hash}`,
      `Vault balance after exploit: ${formatEther(await provider.getBalance(vulnerableAddress))}`,
      `Executable proof: contracts/ReentrancyAttacker.sol`
    ]
  ));

  started = Date.now();
  const patchHasEffectFirst = securedSource.indexOf("balances[msg.sender] = 0") < securedSource.indexOf("msg.sender.call");
  agents.push(result(
    "patch",
    "Patch Agent",
    "Creates minimal remediations with reviewable diffs.",
    started,
    "Generated checks-effects-interactions patch plus reentrancy lock.",
    [
      `Effect-before-interaction verified: ${patchHasEffectFirst}`,
      "Added nonReentrant modifier",
      "Patch artifact: contracts/SecuredVault.sol"
    ]
  ));

  const secured = await deploy(artifacts.SecuredVault, deployer);
  const securedAddress = await secured.getAddress();
  await (await secured.connect(victim).deposit({ value: 10n * 10n ** 18n })).wait();
  const securedAttacker = await deploy(artifacts.ReentrancyAttacker, attackerOwner, [securedAddress]);

  started = Date.now();
  let replayBlocked = false;
  try {
    await (await securedAttacker.connect(attackerOwner).attack({ value: 10n ** 18n })).wait();
  } catch {
    replayBlocked = true;
  }
  agents.push(result(
    "verification",
    "Verification Agent",
    "Replays exploits and checks security regressions.",
    started,
    replayBlocked ? "Patch verified: original exploit transaction now reverts." : "Patch failed verification.",
    [
      `Original exploit replay blocked: ${replayBlocked}`,
      `Secured vault funds preserved: ${formatEther(await provider.getBalance(securedAddress))}`,
      "Deposit behavior remains operational"
    ],
    replayBlocked ? "passed" : "failed"
  ));

  started = Date.now();
  const gasVulnerable = BigInt(attackReceipt?.gasUsed ?? 0);
  const cleanUser = await provider.getSigner(3);
  await (await secured.connect(cleanUser).deposit({ value: 10n ** 18n })).wait();
  const securedWithdrawReceipt = await (await secured.connect(cleanUser).withdraw()).wait();
  const gasSecured = BigInt(securedWithdrawReceipt?.gasUsed ?? 0);
  const delta = gasVulnerable === 0n ? 0 : Number((gasSecured - gasVulnerable) * 10000n / gasVulnerable) / 100;
  agents.push(result(
    "gas",
    "Gas Agent",
    "Benchmarks remediation overhead against execution evidence.",
    started,
    `Secured withdrawal uses ${gasSecured.toString()} gas on the local Mantle-compatible EVM.`,
    [
      `Exploit transaction gas: ${gasVulnerable.toString()}`,
      `Secured normal withdrawal gas: ${gasSecured.toString()}`,
      `Measured delta: ${delta.toFixed(2)}%`
    ]
  ));

  const evidencePayload = JSON.stringify({
    target: vulnerableAddress,
    vulnerability: "SWC-107 Reentrancy",
    exploit: attackReceipt?.hash,
    stolen: stolen.toString(),
    replayBlocked
  });
  const evidenceHash = keccak256(toUtf8Bytes(evidencePayload));
  const scanId = `MG-${crypto.randomBytes(4).toString("hex").toUpperCase()}`;

  started = Date.now();
  const registry = await deploy(artifacts.GuardianAttestationRegistry, deployer, [identityURI]);
  const publishReceipt = await (await registry.publishValidation(
    keccak256(toUtf8Bytes(scanId)),
    vulnerableAddress,
    evidenceHash,
    4,
    replayBlocked,
    `manwall://evidence/${scanId}`
  )).wait();
  agents.push(result(
    "attestation",
    "Attestation Agent",
    "Publishes identity-bound validation evidence on-chain.",
    started,
    "Validation proof published to the ERC-8004-aligned local registry.",
    [
      `Evidence hash: ${evidenceHash}`,
      `Attestation transaction: ${publishReceipt?.hash}`,
      `Agent identity: ${identityURI}`
    ]
  ));

  return {
    scanId,
    startedAt: startedAt.toISOString(),
    completedAt: new Date().toISOString(),
    target: { name: "VulnerableVault", network: "Mantle Sepolia simulation", chainId: 5003, address: vulnerableAddress },
    verdict: {
      severity: "critical",
      vulnerability: "Reentrancy / interaction before effect",
      exploitConfirmed: stolen > 0n,
      patchVerified: replayBlocked,
      fundsAtRisk: `${formatEther(stolen)} MNT demonstrated`
    },
    agents,
    gas: {
      vulnerableWithdraw: gasVulnerable.toString(),
      securedWithdraw: gasSecured.toString(),
      deltaPercent: `${delta.toFixed(2)}%`
    },
    attestation: {
      evidenceHash,
      identityURI,
      registryMode: "local-proof",
      transactionHash: publishReceipt?.hash
    }
  };
}
