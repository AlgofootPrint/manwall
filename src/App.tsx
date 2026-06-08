import { useEffect, useState } from "react";
import {
  ArrowDown, ArrowRight, Check, ChevronRight, CircleDot, ExternalLink,
  Fingerprint, GitBranch, GitPullRequest, Play, ShieldCheck, Terminal, Wallet
} from "lucide-react";
import { useWallet } from "./useWallet";
import { TextScramble } from "./components/ui/text-scramble";
import { AetherNetwork } from "./components/ui/aether-network";


type Agent = {
  id: string; name: string; role: string; status: string; summary: string; evidence: string[]; durationMs: number;
};
type Report = {
  scanId: string;
  target: { address: string };
  verdict: { vulnerability: string; exploitConfirmed: boolean; patchVerified: boolean; fundsAtRisk: string };
  agents: Agent[];
  gas: { deltaPercent: string };
  attestation: { evidenceHash: string; identityURI: string; transactionHash?: string };
};
type SourceFinding = {
  id: string; title: string; severity: string; confidence: string; line: number;
  evidence: string; remediation: string;
};
type SourceAnalysis = {
  scanId: string; proofStatus: string; evidenceHash: string;
  compilation: { passed: boolean; contracts: string[]; errors: string[] };
  findings: SourceFinding[];
};
type Capability = { id: string; name: string; status: "ready" | "configuration-required" | "unavailable"; detail: string };
type RepositoryJob = {
  id: string; status: "queued" | "running" | "completed" | "failed"; repository: string; error?: string;
  result?: { commit: string; filesScanned: number; findings: number };
};

const sampleSource = `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

contract SubmittedVault {
    mapping(address => uint256) public balances;

    function deposit() external payable {
        balances[msg.sender] += msg.value;
    }

    function withdraw() external {
        uint256 amount = balances[msg.sender];
        (bool sent,) = msg.sender.call{value: amount}("");
        require(sent);
        balances[msg.sender] = 0;
    }
}`;

const fallbackAgents = [
  ["Architecture", "Maps contracts and trust boundaries"],
  ["Attack", "Investigates economic attack surfaces"],
  ["Exploit", "Builds executable proof-of-concepts"],
  ["Patch", "Creates minimal reviewable fixes"],
  ["Verification", "Replays exploits against patches"],
  ["Gas", "Measures remediation overhead"],
  ["Attestation", "Publishes validation evidence"]
];

const short = (value: string) => value.length > 22 ? `${value.slice(0, 11)}...${value.slice(-8)}` : value;

export default function App() {
  const [report, setReport] = useState<Report | null>(null);
  const [analysis, setAnalysis] = useState<SourceAnalysis | null>(null);
  const [mode, setMode] = useState<"source" | "proof">("source");
  const [source, setSource] = useState(sampleSource);
  const [running, setRunning] = useState(false);
  const [selected, setSelected] = useState(0);
  const [error, setError] = useState("");
  const [repository, setRepository] = useState("");
  const [repositoryJob, setRepositoryJob] = useState<RepositoryJob | null>(null);
  const [capabilities, setCapabilities] = useState<Capability[]>([]);
  const wallet = useWallet();

  useEffect(() => {
    fetch("/api/capabilities").then((response) => response.json()).then(setCapabilities).catch(() => undefined);
  }, []);

  useEffect(() => {
    if (!repositoryJob || !["queued", "running"].includes(repositoryJob.status)) return;
    const timer = window.setInterval(() => {
      fetch(`/api/jobs/${repositoryJob.id}`).then((response) => response.json()).then(setRepositoryJob).catch(() => undefined);
    }, 2000);
    return () => window.clearInterval(timer);
  }, [repositoryJob?.id, repositoryJob?.status]);

  async function request(path: string, options?: RequestInit) {
    setRunning(true);
    setError("");
    try {
      const response = await fetch(path, options);
      if (!response.ok) throw new Error("The analysis service rejected this request");
      return await response.json();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Analysis failed");
    } finally {
      setRunning(false);
    }
  }

  async function analyze() {
    const result = await request("/api/analyze", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "SubmittedVault.sol", source })
    });
    if (result) setAnalysis(result);
  }

  async function runProof() {
    const result = await request("/api/scan", { method: "POST" });
    if (result) setReport(result);
  }

  function openVerifiedProof() {
    setMode("proof");
    window.setTimeout(() => document.getElementById("workbench")?.scrollIntoView({ behavior: "smooth" }), 0);
  }

  async function openWalletScan() {
    if (!wallet.account) await wallet.connect();
    window.setTimeout(() => document.getElementById("wallet-approval")?.scrollIntoView({ behavior: "smooth" }), 0);
  }

  async function scanRepository() {
    const result = await request("/api/jobs/repository", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ repository })
    });
    if (result) setRepositoryJob(result);
  }

  const agents: Agent[] = report?.agents ?? fallbackAgents.map(([name, role], index) => ({
    id: String(index), name, role, status: running && index === 0 ? "running" : "queued",
    summary: "Awaiting verified proof run.", evidence: [], durationMs: 0
  }));
  const active = agents[selected] ?? agents[0];

  return (
    <div className="page">
      <header className="nav">
        <a className="brand-lockup" href="#top"><i className="brand-logo" /><span className="wordmark">man<b>wall</b>.</span></a>
        <div className="nav-meta"><i /> Mantle Sepolia <b>5003</b></div>
        <button className={`wallet-button ${wallet.account ? "connected" : ""}`} onClick={wallet.account ? undefined : wallet.connect} disabled={wallet.busy}>
          <Wallet size={14} /> {wallet.account ? short(wallet.account) : "Connect wallet"}
        </button>
        <button className="primary-button" onClick={mode === "source" ? analyze : runProof} disabled={running}>
          {running ? "Working" : mode === "source" ? "Analyze contract" : "Run proof"} <ArrowRight size={15} />
        </button>
      </header>

      <main id="top">
        <section className="hero">
          <AetherNetwork />
          <div className="hero-content">
            <p className="eyebrow hero-eyebrow">Autonomous contract security / Mantle</p>
            <div className="hero-center">
              <h1><em>Security</em> claims<br />need <TextScramble text="proof." /></h1>
              <div className="hero-actions">
                <button className="hero-proof-button" onClick={openVerifiedProof}><Play size={14} /> Run verified proof</button>
                <button className="hero-wallet-button" onClick={openWalletScan} disabled={wallet.busy}><Wallet size={14} /> Free wallet scan</button>
              </div>
            </div>
            <div className="hero-bottom">
              <p>manwall turns contract findings into reproducible evidence, verified fixes, and durable onchain records.</p>
              <a href="#workbench">Open the workbench <ArrowDown size={15} /></a>
            </div>
          </div>
        </section>

        <section className="principles">
          <p className="eyebrow">The operating rule</p>
          <div className="principle-grid">
            <h2>Heuristics suggest.<br /><em>Execution decides.</em></h2>
            <p>Source detectors help teams prioritize risk. manwall only calls a vulnerability confirmed after an exploit runs, and only calls a patch verified after the original exploit fails on replay.</p>
          </div>
        </section>

        <section className="repository-section">
          <div className="section-heading">
            <div><p className="eyebrow">Repository ingestion</p><h2>Scan the codebase,<br />not a pasted fragment.</h2></div>
            <p className="section-copy">Submit a public GitHub repository. manwall clones a shallow snapshot, records its commit, discovers Solidity files, and persists every result as a durable job.</p>
          </div>
          <div className="repository-grid">
            <div className="repository-submit">
              <label htmlFor="repository">Public GitHub repository</label>
              <div><GitBranch size={16} /><input id="repository" value={repository} onChange={(event) => setRepository(event.target.value)} placeholder="https://github.com/owner/repository" /><button onClick={scanRepository} disabled={running || !repository}>Start scan <ArrowRight size={14} /></button></div>
              <p>Only public GitHub HTTPS URLs are accepted. Jobs enforce source-size and Solidity-file limits.</p>
              {repositoryJob && <div className="job-result">
                <span>{repositoryJob.id} / {repositoryJob.status}</span>
                {repositoryJob.result && <strong>{repositoryJob.result.filesScanned} files · {repositoryJob.result.findings} findings · {short(repositoryJob.result.commit)}</strong>}
                {repositoryJob.error && <strong>{repositoryJob.error}</strong>}
              </div>}
            </div>
            <div className="capability-list">
              <div className="column-label"><span>Live</span> Production capability status</div>
              {capabilities.map((capability) => <div key={capability.id}>
                <i className={capability.status} />
                <section><b>{capability.name}</b><small>{capability.detail}</small></section>
                <span>{capability.status}</span>
              </div>)}
            </div>
          </div>
        </section>

        <section className="workbench" id="workbench">
          <div className="section-heading">
            <div><p className="eyebrow">Live workbench</p><h2>Inspect the evidence.</h2></div>
            <div className="mode-switch">
              <button className={mode === "source" ? "active" : ""} onClick={() => setMode("source")}>Source triage</button>
              <button className={mode === "proof" ? "active" : ""} onClick={() => setMode("proof")}>Verified proof</button>
            </div>
          </div>

          {mode === "source" ? (
            <div className="source-grid">
              <div className="source-column">
                <div className="column-label"><span>01</span> Submitted Solidity</div>
                <textarea value={source} onChange={(event) => setSource(event.target.value)} spellCheck={false} />
              </div>
              <div className="result-column">
                <div className="column-label"><span>02</span> Triage result / unverified</div>
                {!analysis ? (
                  <div className="empty-state"><CircleDot size={18} /><h3>No assumptions yet.</h3><p>Run source triage to compile this contract and inspect transparent detectors.</p></div>
                ) : (
                  <>
                    <div className="result-summary">
                      <strong>{analysis.findings.length.toString().padStart(2, "0")}</strong>
                      <div><span>Heuristic findings</span><b>{analysis.compilation.passed ? "Compilation passed" : "Compilation failed"}</b></div>
                    </div>
                    <div className="finding-list">
                      {analysis.findings.map((finding) => <div className="triage-finding" key={finding.id}>
                        <div><span>{finding.severity}</span><span>{finding.confidence} confidence</span><span>line {finding.line}</span></div>
                        <h3>{finding.title}</h3>
                        <code>{finding.evidence}</code>
                        <p>{finding.remediation}</p>
                      </div>)}
                    </div>
                    <p className="disclaimer">Proof status: {analysis.proofStatus}. A source finding is not a confirmed exploit.</p>
                  </>
                )}
              </div>
            </div>
          ) : (
            <div className="proof-area">
              <div className="proof-intro">
                <p className="eyebrow">Controlled verification pipeline</p>
                <h3>{report ? report.verdict.vulnerability : "Run the exploit. Replay the fix."}</h3>
                <p>This demonstration executes a known exploit against a vulnerable vault, applies a known remediation, and replays the attack. It proves the verification system, not arbitrary autonomous remediation.</p>
                <button className="secondary-button" onClick={runProof} disabled={running}><Play size={14} /> {running ? "Running proof" : "Run verified proof"}</button>
              </div>
              <div className="proof-stats">
                <Stat index="01" label="Exploit proof" value={report?.verdict.exploitConfirmed ? "Confirmed" : "Pending"} active={!!report?.verdict.exploitConfirmed} />
                <Stat index="02" label="Patch replay" value={report?.verdict.patchVerified ? "Blocked" : "Pending"} active={!!report?.verdict.patchVerified} />
                <Stat index="03" label="Value demonstrated" value={report?.verdict.fundsAtRisk ?? "Pending"} />
                <Stat index="04" label="Evidence record" value={report ? short(report.attestation.evidenceHash) : "Not published"} active={!!report} />
              </div>
            </div>
          )}
        </section>

        <section className="agents">
          <div className="section-heading">
            <div><p className="eyebrow">Specialist system</p><h2>Seven narrow agents.<br />One evidence standard.</h2></div>
            <p className="section-copy">Each stage has a constrained responsibility. Outputs stay visible, reviewable, and separate from verified facts.</p>
          </div>
          <div className="agent-layout">
            <div className="agent-index">
              {agents.map((agent, index) => <button key={agent.id} className={selected === index ? "active" : ""} onClick={() => setSelected(index)}>
                <span>{String(index + 1).padStart(2, "0")}</span>
                <div><b>{agent.name}</b><small>{agent.role}</small></div>
                <ChevronRight size={14} />
              </button>)}
            </div>
            <div className="agent-output">
              <div className="output-meta"><span>{active.status}</span><span>{active.durationMs ? `${active.durationMs}ms` : "No execution yet"}</span></div>
              <h3>{active.summary}</h3>
              <div className="evidence-list">
                {active.evidence.length ? active.evidence.map((item, index) => <div key={item}><span>{String(index + 1).padStart(2, "0")}</span><code>{item}</code><Check size={13} /></div>) :
                  <div><Terminal size={14} /><code>Run the verified proof to generate executable evidence.</code></div>}
              </div>
            </div>
          </div>
        </section>

        <section className="attestation">
          <p className="eyebrow">Durable validation</p>
          <div className="attestation-grid">
            <h2>A finding can disappear.<br /><span>A proof stays.</span></h2>
            <div>
              <p>Verified results are identity-bound and published as evidence hashes. The detailed report stays offchain; the validation record stays inspectable.</p>
              <div className="record">
                <Record label="Scan" value={report?.scanId ?? "Awaiting proof"} />
                <Record label="Target" value={report ? short(report.target.address) : "Awaiting proof"} />
                <Record label="Identity" value={report?.attestation.identityURI ?? "manwall://mantle/security-engineer/v1"} />
                <Record label="Transaction" value={report ? short(report.attestation.transactionHash ?? "") : "Awaiting proof"} />
                <div className="record-hash"><Fingerprint size={15} /><code>{report?.attestation.evidenceHash ?? "Evidence hash appears after a verified proof run"}</code><ExternalLink size={14} /></div>
              </div>
              <div className="wallet-panel" id="wallet-approval">
                <div className="wallet-heading">
                  <div><p className="eyebrow">Human approval</p><h3>Sign the evidence, not a blank transaction.</h3></div>
                  <Wallet size={20} />
                </div>
                {!wallet.installed ? <p className="wallet-note">Install a MetaMask-compatible wallet to approve verified evidence.</p> :
                  !wallet.account ? <button className="secondary-button" onClick={wallet.connect} disabled={wallet.busy}>Connect wallet <ArrowRight size={14} /></button> :
                    <>
                      <div className="wallet-details">
                        <Record label="Account" value={wallet.account} />
                        <Record label="Balance" value={`${Number(wallet.balance || 0).toFixed(4)} MNT`} />
                        <Record label="Network" value={wallet.onMantleSepolia ? "Mantle Sepolia / 5003" : `Unsupported / ${wallet.chainId}`} />
                        <Record label="Approval" value={wallet.signature ? short(wallet.signature) : "Not signed"} />
                      </div>
                      <div className="wallet-actions">
                        {!wallet.onMantleSepolia && <button className="secondary-button" onClick={wallet.switchToMantle} disabled={wallet.busy}>Switch to Mantle <ArrowRight size={14} /></button>}
                        <button className="secondary-button" onClick={() => report && wallet.signEvidence(report.scanId, report.attestation.evidenceHash)} disabled={wallet.busy || !report || !wallet.onMantleSepolia}>
                          <Fingerprint size={14} /> {wallet.signature ? "Evidence approved" : "Approve evidence"}
                        </button>
                        <button className="text-button" onClick={wallet.disconnect}>Disconnect</button>
                      </div>
                      <p className="wallet-note">Approval uses an EIP-191 message signature. It costs no gas and does not publish an onchain transaction.</p>
                    </>}
                {wallet.error && <p className="wallet-error">{wallet.error}</p>}
              </div>
            </div>
          </div>
        </section>

        {error && <div className="error">{error}. Confirm the manwall API is running.</div>}
      </main>

      <footer>
        <a className="brand-lockup" href="#top"><i className="brand-logo" /><span className="wordmark">man<b>wall</b>.</span></a>
        <p>Evidence-first security for Mantle.</p>
        <span><GitPullRequest size={13} /> ERC-8004 aligned</span>
      </footer>
    </div>
  );
}

function Stat({ index, label, value, active = false }: { index: string; label: string; value: string; active?: boolean }) {
  return <div className={active ? "active" : ""}><span>{index}</span><small>{label}</small><b>{value}</b></div>;
}

function Record({ label, value }: { label: string; value: string }) {
  return <div><span>{label}</span><code>{value}</code></div>;
}
