import { useEffect, useRef, useState } from "react";
import {
  ArrowDown, ArrowRight, Check, ChevronRight, CircleDot, ExternalLink,
  Fingerprint, GitBranch, GitPullRequest, Play, ShieldCheck, Terminal, Wallet
} from "lucide-react";
import { useWallet } from "./useWallet";
import { TextScramble } from "./components/ui/text-scramble";
import { AetherNetwork } from "./components/ui/aether-network";
import { DottedSurface } from "./components/ui/dotted-surface";
import { FallingPattern } from "./components/ui/falling-pattern";


type Agent = {
  id: string; name: string; role: string; status: string; summary: string; evidence: string[]; durationMs: number;
  artifact?: { kind: string; content: string; hash: string };
};
type Report = {
  scanId: string;
  target: { address: string };
  verdict: { vulnerability: string; exploitConfirmed: boolean; patchVerified: boolean; fundsAtRisk: string };
  agents: Agent[];
  gas: {
    deltaPercent: string;
    vulnerableWithdraw?: string;
    securedWithdraw?: string;
    mantleAdvice?: string[];
    mantleFeeEstimate?: {
      status: "live" | "unavailable";
      sampledAt: string;
      blockNumber?: number;
      gasPriceGwei?: string;
      baseFeeGwei?: string;
      vulnerableCostMnt?: string;
      securedCostMnt?: string;
      detail: string;
    };
  };
  attestation: { evidenceHash: string; identityURI: string; transactionHash?: string };
};
type SourceFinding = {
  id: string; title: string; severity: string; confidence: string; line: number;
  evidence: string; remediation: string;
};
type GasOptimization = {
  id: string; title: string; impact: string; confidence: string; line: number;
  evidence: string; recommendation: string; mantleContext: string;
};
type SourceAnalysis = {
  scanId: string; proofStatus: string; evidenceHash: string;
  compilation: { passed: boolean; contracts: string[]; errors: string[] };
  findings: SourceFinding[];
  gasOptimizations?: GasOptimization[];
};
type Capability = { id: string; name: string; status: "ready" | "configuration-required" | "unavailable"; detail: string };
type RepositoryToolResult = {
  status: "passed" | "blocked" | "failed" | "skipped"; findings: number; summary: string; output: string;
};
type RepositoryReport = {
  target: { name: string };
  compilation: { passed: boolean; contracts: string[]; errors: string[] };
  findings: SourceFinding[];
  gasOptimizations: GasOptimization[];
};
type RepositoryJob = {
  id: string; status: "queued" | "running" | "completed" | "failed"; repository: string; updatedAt?: string; error?: string;
  result?: {
    commit: string; filesScanned: number; findings: number;
    summary?: { securityFindings: number; gasOptimizations: number; compilationFailures: number; toolFailures: number };
    reports?: RepositoryReport[];
    tools?: { compilation?: RepositoryToolResult; slither: RepositoryToolResult; foundry: RepositoryToolResult };
  };
};
type TelegramApproval = {
  id: string;
  action: string;
  subject: string;
  status: "pending" | "approved" | "rejected" | "consumed" | "expired";
  expiresAt: string;
};
type AttestationInput = {
  scanId: string;
  subject: string;
  evidenceHash: string;
  severity: number;
  remediated: boolean;
  evidenceURI: string;
};
type WalletScan = {
  wallet: string;
  nativeBalanceMnt: string;
  transactionCount: number;
  accountType: string;
  summary: "review-required" | "caution" | "low-risk";
  issues: Array<{ severity: string; title: string; detail: string; recommendation: string }>;
  allowances: Array<{ token: string; symbol: string; spender: string; allowance: string; balance: string }>;
  scannedAt: string;
};
type Actor = { id: string; login: string; authenticated: boolean };
type AiResult = {
  workflow: "review" | "patch"; model: string; summary: string; riskLevel: string;
  keyObservations: string[]; recommendedActions: string[]; patchDraft?: string;
  usage: { inputTokens: number; outputTokens: number; estimatedCostUsd: number };
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
const repositoryCommitUrl = (repository: string, commit: string) =>
  `${repository.replace(/\.git$/, "")}/commit/${encodeURIComponent(commit)}`;
const dependencyResolutionPattern = /No such file or directory|Source ["'][^"']+["'] not found|File import callback not supported|could not find source|import .* not found|repository dependencies or imports/i;
const toolBlockedByDependencies = (tool?: RepositoryToolResult) =>
  Boolean(tool && tool.status === "failed" && dependencyResolutionPattern.test(`${tool.summary}\n${tool.output}`));
const displayedToolStatus = (tool?: RepositoryToolResult): RepositoryToolResult["status"] | undefined =>
  toolBlockedByDependencies(tool) || (tool?.status === "failed" && /fork-dependent|isolated scans block RPC network access/i.test(tool.summary))
    ? "blocked"
    : tool?.status;
const displayedToolSummary = (tool?: RepositoryToolResult) =>
  toolBlockedByDependencies(tool)
    ? "Repository dependencies or imports were unavailable in the isolated runner."
    : tool?.summary ?? "Not reported.";
const toolStatusLabels: Record<RepositoryToolResult["status"], string> = {
  passed: "Passed",
  blocked: "Blocked by isolation",
  failed: "Failed to complete",
  skipped: "Not applicable"
};
const toolStatusLabel = (status?: RepositoryToolResult["status"]) => status ? toolStatusLabels[status] : "Not reported";
const oauthStateKey = "manwall:oauth-return-state";
const pendingAiKey = "manwall:pending-ai-action";
const parseSessionJson = <T,>(key: string, fallback: T): T => {
  try {
    return JSON.parse(sessionStorage.getItem(key) ?? "") as T;
  } catch {
    sessionStorage.removeItem(key);
    return fallback;
  }
};

export default function App() {
  const [enteredApp, setEnteredApp] = useState(false);
  const [report, setReport] = useState<Report | null>(null);
  const [analysis, setAnalysis] = useState<SourceAnalysis | null>(null);
  const [mode, setMode] = useState<"source" | "proof">("source");
  const [source, setSource] = useState(sampleSource);
  const [sourceName, setSourceName] = useState("SubmittedVault.sol");
  const [running, setRunning] = useState(false);
  const [selected, setSelected] = useState(0);
  const [error, setError] = useState("");
  const [repository, setRepository] = useState("");
  const [repositoryJobs, setRepositoryJobs] = useState<RepositoryJob[]>([]);
  const [repositorySubmitting, setRepositorySubmitting] = useState(false);
  const [repositoryStatus, setRepositoryStatus] = useState("");
  const [capabilities, setCapabilities] = useState<Capability[]>([]);
  const [attestationStatus, setAttestationStatus] = useState("");
  const [attestationTransaction, setAttestationTransaction] = useState("");
  const [attestationPublisher, setAttestationPublisher] = useState("");
  const [walletScan, setWalletScan] = useState<WalletScan | null>(null);
  const [showWalletPrompt, setShowWalletPrompt] = useState(false);
  const [actor, setActor] = useState<Actor>({ id: "anonymous", login: "anonymous", authenticated: false });
  const [aiResults, setAiResults] = useState<Record<string, AiResult>>({});
  const [aiStatus, setAiStatus] = useState<Record<string, string>>({});
  const [returnSection, setReturnSection] = useState("");
  const activeRequests = useRef(0);
  const wallet = useWallet();

  useEffect(() => {
    fetch("/api/capabilities").then((response) => {
      if (!response.ok) throw new Error(`Capabilities request failed with HTTP ${response.status}.`);
      return response.json();
    }).then(setCapabilities).catch(() => undefined);
    fetch("/api/auth/me", { credentials: "include" }).then((response) => {
      if (!response.ok) throw new Error(`Authentication request failed with HTTP ${response.status}.`);
      return response.json();
    }).then((nextActor: Actor) => {
      setActor(nextActor);
      const oauthReturned = new URLSearchParams(window.location.search).get("oauth") === "github";
      const pending = parseSessionJson<{
        workflow: "review"; key: string; payload: Record<string, unknown>;
      } | null>(pendingAiKey, null);
      if (!nextActor.authenticated) {
        if (oauthReturned && pending) {
          const message = "GitHub authorization returned without a usable session. Check the OAuth callback configuration and authorize again.";
          setError(message);
          setAiStatus((current) => ({ ...current, [pending.key]: message }));
          sessionStorage.removeItem(pendingAiKey);
          window.history.replaceState({}, "", `${window.location.pathname}${window.location.hash}`);
        }
        return;
      }
      try {
        if (!pending) return;
        if (oauthReturned) window.history.replaceState({}, "", `${window.location.pathname}${window.location.hash}`);
        window.setTimeout(() => void executeAi(pending.workflow, pending.key, pending.payload), 0);
      } catch {
        sessionStorage.removeItem(pendingAiKey);
      }
    }).catch(() => undefined);
    const target = window.location.hash;
    if (["#repository", "#workbench"].includes(target)) {
      try {
        const saved = JSON.parse(sessionStorage.getItem(oauthStateKey) ?? "{}") as {
          repository?: string; repositoryJobs?: RepositoryJob[]; source?: string; sourceName?: string; analysis?: SourceAnalysis;
        };
        if (saved.repository) setRepository(saved.repository);
        if (saved.repositoryJobs) setRepositoryJobs(saved.repositoryJobs);
        if (saved.source) setSource(saved.source);
        if (saved.sourceName) setSourceName(saved.sourceName);
        if (saved.analysis) setAnalysis(saved.analysis);
        sessionStorage.removeItem(oauthStateKey);
      } catch {
        sessionStorage.removeItem(oauthStateKey);
      }
      setEnteredApp(true);
      setReturnSection(target);
    }
  }, []);

  useEffect(() => {
    if (!enteredApp || !returnSection) return;
    const timer = window.setTimeout(() => {
      document.querySelector(returnSection)?.scrollIntoView({ behavior: "smooth", block: "start" });
      setReturnSection("");
    }, 150);
    return () => window.clearTimeout(timer);
  }, [enteredApp, returnSection, repositoryJobs, analysis]);

  useEffect(() => {
    setAttestationStatus("");
    setAttestationTransaction("");
    setAttestationPublisher("");
  }, [wallet.account, report?.scanId]);

  useEffect(() => {
    if (walletScan && walletScan.wallet.toLowerCase() !== wallet.account.toLowerCase()) setWalletScan(null);
  }, [wallet.account, walletScan]);

  useEffect(() => {
    const activeJobs = repositoryJobs.filter((job) => ["queued", "running"].includes(job.status));
    if (!activeJobs.length) return;
    const timer = window.setInterval(() => {
      void Promise.all(activeJobs.map(async (job) => {
        const response = await fetch(`/api/jobs/${job.id}`);
        const body = await response.json().catch(() => ({})) as RepositoryJob & { error?: string };
        if (response.status === 404) return { ...job, status: "failed" as const, error: "Repository scan job no longer exists." };
        if (!response.ok) throw new Error(body.error ?? `Job status request failed with HTTP ${response.status}.`);
        return body;
      }))
        .then((updates) => {
          setRepositoryJobs((current) => current.map((job) => updates.find((update) => update.id === job.id) ?? job));
          setRepositoryStatus("");
        })
        .catch((reason) => setRepositoryStatus(`Unable to refresh scan status: ${reason instanceof Error ? reason.message : "request failed"}`));
    }, 2000);
    return () => window.clearInterval(timer);
  }, [repositoryJobs]);

  function beginRequest() {
    activeRequests.current += 1;
    setRunning(true);
    setError("");
  }

  function finishRequest() {
    activeRequests.current = Math.max(0, activeRequests.current - 1);
    if (activeRequests.current === 0) setRunning(false);
  }

  async function request(path: string, options?: RequestInit) {
    beginRequest();
    try {
      const response = await fetch(path, options);
      if (!response.ok) {
        const text = await response.text().catch(() => "");
        let detail = text.trim();
        try {
          const parsed = JSON.parse(text) as { error?: string };
          detail = parsed.error ?? detail;
        } catch {}
        throw new Error(detail || `Request failed with HTTP ${response.status}`);
      }
      return await response.json();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Analysis failed");
    } finally {
      finishRequest();
    }
  }

  async function analyze() {
    const result = await request("/api/analyze", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: sourceName.trim(), source })
    });
    if (result) setAnalysis(result);
  }

  async function runProof() {
    const result = analysis
      ? await request("/api/scan/source", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: sourceName.trim(), source })
        })
      : await request("/api/scan", { method: "POST" });
    if (result) setReport(result);
  }

  function openVerifiedProof() {
    setMode("proof");
    window.setTimeout(() => document.getElementById("workbench")?.scrollIntoView({ behavior: "smooth" }), 0);
  }

  function openContractAnalysis() {
    setMode("source");
    window.setTimeout(() => document.getElementById("workbench")?.scrollIntoView({ behavior: "smooth" }), 0);
  }

  async function openWalletScan() {
    const account = wallet.account || await wallet.connect();
    window.setTimeout(() => document.getElementById("wallet-scan")?.scrollIntoView({ behavior: "smooth" }), 0);
    if (account) await runWalletScan(account);
  }

  async function runWalletScan(address = wallet.account) {
    const account = address || await wallet.connect();
    if (!account) return;
    const result = await request("/api/wallet/scan", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ address: account })
    });
    if (result) setWalletScan(result);
  }

  async function scanRepository() {
    const repositories = repository.split(/[\n,]/).map((value) => value.trim()).filter(Boolean);
    setRepositorySubmitting(true);
    setRepositoryStatus(`Submitting ${repositories.length} repository scan${repositories.length === 1 ? "" : "s"}...`);
    try {
      const response = await fetch("/api/jobs/repository", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(repositories.length > 1 ? { repositories } : { repository: repositories[0] })
      });
      const body = await response.json().catch(() => ({})) as RepositoryJob & {
        jobs?: RepositoryJob[];
        approvals?: TelegramApproval[];
        error?: string;
      };
      if (!response.ok) throw new Error(body.error ?? `Repository scan request failed with HTTP ${response.status}.`);
      const jobs = body.jobs ?? (body.id ? [body] : []);
      const approvals = body.approvals ?? [];
      if (jobs.length) setRepositoryJobs(jobs);
      const statusParts = [];
      if (jobs.length) statusParts.push(`${jobs.length} scan job${jobs.length === 1 ? "" : "s"} submitted`);
      if (approvals.length) statusParts.push("Telegram approval requested for this repository");
      setRepositoryStatus(`${statusParts.join("; ")}. ${jobs.length ? "Results will update automatically. " : ""}${approvals.length ? "Awaiting Approval" : ""}`.trim());
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : "Repository scan submission failed.";
      setRepositoryStatus(`Start scan failed: ${message}`);
    } finally {
      setRepositorySubmitting(false);
    }
  }

  function beginAiLogin(target: "#repository" | "#workbench") {
    sessionStorage.setItem(oauthStateKey, JSON.stringify({ repository, repositoryJobs, source, sourceName, analysis }));
    window.location.href = `/api/auth/github?returnTo=${encodeURIComponent(`/?oauth=github${target}`)}`;
  }

  async function runAi(workflow: "review" | "patch", key: string, payload: Record<string, unknown>) {
    const target = payload.repository ? "#repository" : "#workbench";
    if (workflow === "review") {
      sessionStorage.setItem(pendingAiKey, JSON.stringify({ workflow, key, payload }));
      setAiStatus((current) => ({ ...current, [key]: "Requesting fresh GitHub authorization..." }));
      beginAiLogin(target);
      return;
    }
    if (!actor.authenticated) {
      beginAiLogin(target);
      return;
    }
    if (workflow === "patch" && !window.confirm("Approve OpenAI to generate a reviewable patch draft? The patch will not be applied automatically.")) return;
    await executeAi(workflow, key, payload);
  }

  async function executeAi(workflow: "review" | "patch", key: string, payload: Record<string, unknown>) {
    setAiStatus((current) => ({ ...current, [key]: workflow === "review" ? "Running AI security review..." : "Generating approved patch draft..." }));
    beginRequest();
    try {
      const response = await fetch(`/api/ai/${workflow}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify(workflow === "patch" ? { ...payload, approved: true, approvalNote: "Approved from the Manwall review UI." } : payload)
      });
      if (response.status === 401) {
        setActor({ id: "anonymous", login: "anonymous", authenticated: false });
        throw new Error("GitHub authorization completed, but the AI request did not receive a valid session.");
      }
      const body = await response.json().catch(() => ({})) as AiResult & { error?: string };
      if (!response.ok) throw new Error(body.error ?? `AI request failed with HTTP ${response.status}.`);
      setAiResults((current) => ({ ...current, [key]: body }));
      setAiStatus((current) => ({ ...current, [key]: `${workflow === "review" ? "AI review" : "Patch draft"} completed.` }));
      if (workflow === "review") sessionStorage.removeItem(pendingAiKey);
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : "AI request failed.";
      setError(message);
      setAiStatus((current) => ({ ...current, [key]: `AI request failed: ${message}` }));
      if (workflow === "review") sessionStorage.removeItem(pendingAiKey);
    } finally {
      finishRequest();
    }
  }

  function sourceAiPayload() {
    if (!analysis) return {};
    return {
      subject: `Review ${sourceName}`,
      context: `Compilation ${analysis.compilation.passed ? "passed" : "failed"}. Manwall reported ${analysis.findings.length} heuristic security findings and ${analysis.gasOptimizations?.length ?? 0} Mantle gas suggestions. Findings are not confirmed exploits.`,
      source,
      findings: analysis.findings.map((finding) => `${finding.severity}: ${finding.title} at line ${finding.line}. ${finding.evidence}`)
    };
  }

  function repositoryAiPayload(job: RepositoryJob) {
    return {
      subject: `Review repository scan ${job.id}`,
      repository: job.repository,
      context: `Pinned commit ${job.result?.commit}. Scanned ${job.result?.filesScanned ?? 0} Solidity files and reported ${job.result?.findings ?? 0} unconfirmed security findings. Project compilation: ${job.result?.tools?.compilation?.summary ?? "not reported"}. Slither: ${job.result?.tools?.slither.summary ?? "not reported"}. Foundry: ${job.result?.tools?.foundry.summary ?? "not reported"}.`,
      findings: job.result?.reports?.flatMap((item) => item.findings.map((finding) => `${item.target.name}: ${finding.severity} ${finding.title} line ${finding.line}`)).slice(0, 30) ?? []
    };
  }

  function repositoryScanSummary(result: RepositoryJob["result"]) {
    if (!result) return "";
    if (result.filesScanned === 0) return "No Solidity files found";
    const filesLabel = result.filesScanned === 1 ? "1 Solidity file" : `${result.filesScanned} Solidity files`;
    const findingsLabel = result.findings === 1 ? "1 security finding" : `${result.findings} security findings`;
    return `${filesLabel} · ${findingsLabel}`;
  }

  function attestationInput(): AttestationInput | null {
    if (!report) return null;
    return {
      scanId: report.scanId,
      subject: report.target.address,
      evidenceHash: report.attestation.evidenceHash,
      severity: report.verdict.exploitConfirmed ? 4 : 1,
      remediated: report.verdict.patchVerified,
      evidenceURI: `manwall://reports/${report.scanId}`
    };
  }

  async function approveAndPublishAttestation() {
    const attestation = attestationInput();
    if (!attestation) {
      setAttestationStatus("Run the verified proof before approving evidence.");
      return;
    }
    if (!wallet.account) {
      setAttestationStatus("Connect a wallet before approving evidence.");
      return;
    }
    if (!wallet.onMantleSepolia) {
      setAttestationStatus("Switch the connected wallet to Mantle Sepolia before approving evidence.");
      return;
    }
    setAttestationTransaction("");
    setAttestationPublisher("");
    setAttestationStatus("Requesting the exact approval message from Manwall...");
    const messageResponse = await request("/api/attestations/approval-message", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(attestation)
    });
    if (!messageResponse?.message) {
      setAttestationStatus("Unable to create the approval message.");
      return;
    }
    setAttestationStatus("Confirm the evidence signature in your wallet. This does not spend gas.");
    const signature = await wallet.signEvidence(messageResponse.message);
    if (!signature) {
      setAttestationStatus("Evidence approval was not signed.");
      return;
    }
    setAttestationStatus("Wallet signature received. Verifying and publishing on Mantle Sepolia...");
    const published = await request("/api/attestations/publish", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ ...attestation, walletApproval: { address: wallet.account, signature } })
    });
    if (published?.transactionHash) {
      setAttestationTransaction(published.transactionHash);
      setAttestationPublisher(published.publisherAddress ?? "");
      setAttestationStatus(`Published on Mantle Sepolia: ${short(published.transactionHash)}`);
    } else {
      setAttestationStatus("The wallet signature was collected, but publication did not complete.");
    }
  }

  async function disconnectWallet() {
    await wallet.disconnect();
    setWalletScan(null);
    setShowWalletPrompt(false);
  }

  if (!enteredApp) {
    return (
      <div className="landing">
        <AetherNetwork />
        <header className="landing-nav">
          <a className="brand-lockup" href="#" aria-label="Manwall home">
            <i className="brand-logo" />
            <span className="wordmark">man<b>wall</b>.</span>
          </a>
          <span className="landing-nav-title">Autonomous smart contract security</span>
          <span className="landing-network"><i /> Built for Mantle</span>
        </header>

        <main className="landing-main">
          <div className="landing-entry">
            <p className="landing-quote">"Your watch begins here"</p>
            <span>Enter</span>
            <button className="landing-enter" onClick={() => setEnteredApp(true)}>
              The Wall <ArrowRight size={16} />
            </button>
          </div>
        </main>

        <footer className="landing-footer">
          <p>"I am the sword in the darkness. I am the watcher on the walls."</p>
        </footer>
      </div>
    );
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
        <div className="wallet-menu-wrap">
        <button className={`wallet-button ${wallet.account ? "connected" : ""}`} onClick={wallet.account ? () => setShowWalletPrompt((value) => !value) : () => void wallet.connect(true)} disabled={wallet.busy}>
          <Wallet size={14} /> {wallet.account ? short(wallet.account) : "Connect wallet"}
        </button>
        {wallet.account && showWalletPrompt && <div className="wallet-popover">
          <span>Connected wallet</span>
          <code>{wallet.account}</code>
          <button onClick={disconnectWallet} disabled={wallet.busy}>Disconnect wallet</button>
        </div>}
        </div>
        <button className="primary-button" onClick={openContractAnalysis}>
          Analyze contract <ArrowRight size={15} />
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
          <DottedSurface />
          <div className="principles-content">
            <p className="eyebrow">The operating rule</p>
            <div className="principle-grid">
              <h2>Heuristics suggest.<br /><em>Execution decides.</em></h2>
              <p>Source detectors help teams prioritize risk. manwall only calls a vulnerability confirmed after an exploit runs, and only calls a patch verified after the original exploit fails on replay.</p>
            </div>
          </div>
        </section>

        <section className="repository-section" id="repository">
          <div className="section-heading">
            <div><p className="eyebrow">Repository ingestion</p><h2>Scan the codebase,<br />not a pasted fragment.</h2></div>
            <p className="section-copy">Submit a public GitHub repository. manwall clones a shallow snapshot, records its commit, reports whether Solidity files were found, and persists every result as a durable job.</p>
          </div>
          <div className="repository-grid">
            <div className="repository-submit">
              <label htmlFor="repository">Public GitHub repositories</label>
              <div><GitBranch size={16} /><textarea id="repository" value={repository} onChange={(event) => setRepository(event.target.value)} placeholder={"https://github.com/mantle-xyz/example\nhttps://github.com/owner/repository"} /><button onClick={scanRepository} disabled={repositorySubmitting || !repository.trim()}>{repositorySubmitting ? "Submitting scan" : "Start scan"} <ArrowRight size={14} /></button></div>
              <p>Submit one or more public GitHub HTTPS URLs separated by new lines or commas. Production accepts monitored Mantle repos and team-authorized repositories.</p>
              {repositoryStatus && <p className="repository-status">{repositoryStatus}</p>}
              {repositoryJobs.map((repositoryJob) => <div className="job-result" key={repositoryJob.id}>
                <span>{repositoryJob.id} / {repositoryJob.status}</span>
                <b>{repositoryJob.repository.replace(/\.git$/, "")}</b>
                {["queued", "running"].includes(repositoryJob.status) && <strong>{repositoryJob.status === "queued" ? "Waiting for an isolated scan worker." : "Cloning and analyzing the repository in isolation."}</strong>}
                {repositoryJob.result && <>
                  <strong>{repositoryScanSummary(repositoryJob.result)}</strong>
                  <a className="job-commit-link" href={repositoryCommitUrl(repositoryJob.repository, repositoryJob.result.commit)} target="_blank" rel="noreferrer">
                    Pinned commit {short(repositoryJob.result.commit)} <ExternalLink size={11} />
                  </a>
                  <div className="job-metrics">
                    <div><span>Compile failures</span><b>{repositoryJob.result.summary?.compilationFailures ?? repositoryJob.result.reports?.filter((item) => !item.compilation.passed).length ?? 0}</b></div>
                    <div><span>Gas suggestions</span><b>{repositoryJob.result.summary?.gasOptimizations ?? repositoryJob.result.reports?.reduce((total, item) => total + item.gasOptimizations.length, 0) ?? 0}</b></div>
                    <div><span>Slither</span><b>{toolStatusLabel(displayedToolStatus(repositoryJob.result.tools?.slither))}</b></div>
                    <div><span>Foundry</span><b>{toolStatusLabel(displayedToolStatus(repositoryJob.result.tools?.foundry))}</b></div>
                  </div>
                  {repositoryJob.result.tools && <div className="tool-status-explanations">
                    <p><b>Slither: {toolStatusLabel(displayedToolStatus(repositoryJob.result.tools.slither))}.</b> {displayedToolSummary(repositoryJob.result.tools.slither)}</p>
                    <p><b>Foundry: {toolStatusLabel(displayedToolStatus(repositoryJob.result.tools.foundry))}.</b> {displayedToolSummary(repositoryJob.result.tools.foundry)}</p>
                  </div>}
                  <details>
                    <summary>Inspect scan evidence</summary>
                    <div className="job-evidence">
                      {repositoryJob.result.tools && <>
                        {repositoryJob.result.tools.compilation && <p><b>Project compilation:</b> {displayedToolSummary(repositoryJob.result.tools.compilation)}</p>}
                        <p><b>Slither:</b> {displayedToolSummary(repositoryJob.result.tools.slither)}</p>
                        <p><b>Foundry:</b> {displayedToolSummary(repositoryJob.result.tools.foundry)}</p>
                        <details>
                          <summary>Inspect tool command output</summary>
                          {repositoryJob.result.tools.compilation?.output && <pre>Compilation{"\n"}{repositoryJob.result.tools.compilation.output}</pre>}
                          {repositoryJob.result.tools.slither.output && <pre>Slither{"\n"}{repositoryJob.result.tools.slither.output}</pre>}
                          {repositoryJob.result.tools.foundry.output && <pre>Foundry{"\n"}{repositoryJob.result.tools.foundry.output}</pre>}
                        </details>
                      </>}
                      {repositoryJob.result.reports?.map((item) => <div key={item.target.name}>
                        <b>{item.target.name}</b>
                        <small>{item.compilation.passed ? "Compiled" : "Compilation failed"} · {item.findings.length} findings · {item.gasOptimizations.length} gas suggestions</small>
                      </div>)}
                    </div>
                  </details>
                  <div className="ai-actions">
                    <button onClick={() => void runAi("review", repositoryJob.id, repositoryAiPayload(repositoryJob))} disabled={running}>
                      AI review <ArrowRight size={12} />
                    </button>
                    {aiResults[repositoryJob.id]?.workflow === "review" && <button onClick={() => void runAi("patch", repositoryJob.id, repositoryAiPayload(repositoryJob))} disabled={running}>
                      Approve patch draft <ArrowRight size={12} />
                    </button>}
                  </div>
                  {aiStatus[repositoryJob.id] && <p className="ai-action-status">{aiStatus[repositoryJob.id]}</p>}
                  {aiResults[repositoryJob.id] && <AiReview result={aiResults[repositoryJob.id]} />}
                </>}
                {repositoryJob.error && <strong>{repositoryJob.error}</strong>}
              </div>)}
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
            <div className="source-workbench">
              <div className="analysis-toolbar">
                <div>
                  <label htmlFor="source-name">Contract filename</label>
                  <input id="source-name" value={sourceName} onChange={(event) => { setSourceName(event.target.value); setAnalysis(null); }} placeholder="Contract.sol" />
                </div>
                <p>Paste Solidity source, compile it, inspect heuristic security findings, and review Mantle-focused gas suggestions.</p>
                <button className="secondary-button" onClick={analyze} disabled={running || source.trim().length < 20 || !sourceName.trim().endsWith(".sol")}>
                  <Terminal size={14} /> {running ? "Analyzing contract" : "Run contract analysis"}
                </button>
                {error && <p className="analysis-error">{error}</p>}
              </div>
              <div className="source-grid">
              <div className="source-column">
                <div className="column-label"><span>01</span> Submitted Solidity source</div>
                <textarea value={source} onChange={(event) => { setSource(event.target.value); setAnalysis(null); }} placeholder="Paste a complete Solidity contract here..." spellCheck={false} />
              </div>
              <div className="result-column">
                <div className="column-label"><span>02</span> Static analysis / unverified</div>
                {!analysis ? (
                  <div className="empty-state"><CircleDot size={18} /><h3>Ready for source.</h3><p>Run contract analysis to compile the source, inspect transparent security detectors, and receive Mantle gas guidance.</p></div>
                ) : (
                  <>
                    <div className="result-summary">
                      <strong>{analysis.findings.length.toString().padStart(2, "0")}</strong>
                      <div><span>Heuristic findings</span><b>{analysis.compilation.passed ? "Compilation passed" : "Compilation failed"} · {(analysis.gasOptimizations?.length ?? 0)} gas hints</b></div>
                    </div>
                    <div className={`compilation-result ${analysis.compilation.passed ? "passed" : "failed"}`}>
                      <div><Check size={14} /><span>Compilation</span><b>{analysis.compilation.passed ? "Passed" : "Failed"}</b></div>
                      {analysis.compilation.contracts.length > 0 && <p>Contracts: {analysis.compilation.contracts.join(", ")}</p>}
                      {analysis.compilation.errors.map((compilationError) => <pre key={compilationError}>{compilationError}</pre>)}
                    </div>
                    <div className="finding-list">
                      <div className="analysis-group-heading"><span>Security findings</span><b>{analysis.findings.length}</b></div>
                      {analysis.findings.length === 0 && <p className="analysis-clean">No supported heuristic security detectors matched. This is not proof that the contract is secure.</p>}
                      {analysis.findings.map((finding) => <div className="triage-finding" key={finding.id}>
                        <div><span>{finding.severity}</span><span>{finding.confidence} confidence</span><span>line {finding.line}</span></div>
                        <h3>{finding.title}</h3>
                        <code>{finding.evidence}</code>
                        <p><b>Recommended remediation:</b> {finding.remediation}</p>
                      </div>)}
                      <div className="analysis-group-heading"><span>Mantle gas suggestions</span><b>{analysis.gasOptimizations?.length ?? 0}</b></div>
                      {!analysis.gasOptimizations?.length && <p className="analysis-clean">No supported gas optimization patterns matched.</p>}
                      {analysis.gasOptimizations?.map((optimization) => <div className="triage-finding gas-finding" key={optimization.id}>
                        <div><span>{optimization.impact} gas impact</span><span>{optimization.confidence} confidence</span><span>line {optimization.line}</span></div>
                        <h3>{optimization.title}</h3>
                        <code>{optimization.evidence}</code>
                        <p><b>Suggestion:</b> {optimization.recommendation}</p>
                        <p>{optimization.mantleContext}</p>
                      </div>)}
                    </div>
                    <p className="disclaimer">Proof status: {analysis.proofStatus}. Static findings and gas suggestions require human review and are not confirmed exploits.</p>
                    <div className="ai-actions">
                      <button className="secondary-button" onClick={() => void runAi("review", analysis.scanId, sourceAiPayload())} disabled={running}>
                        AI security review <ArrowRight size={13} />
                      </button>
                      {aiResults[analysis.scanId]?.workflow === "review" && <button className="secondary-button" onClick={() => void runAi("patch", analysis.scanId, sourceAiPayload())} disabled={running}>
                        Approve patch draft <ArrowRight size={13} />
                      </button>}
                    </div>
                    {aiStatus[analysis.scanId] && <p className="ai-action-status">{aiStatus[analysis.scanId]}</p>}
                    {!actor.authenticated && <p className="ai-login-note">AI actions require GitHub sign-in and open the authorization page when selected.</p>}
                    {aiResults[analysis.scanId] && <AiReview result={aiResults[analysis.scanId]} />}
                  </>
                )}
              </div>
            </div>
            </div>
          ) : (
            <div className="proof-area">
              <div className="proof-intro">
                <p className="eyebrow">{analysis ? "Source-specific verification pipeline" : "Controlled verification pipeline"}</p>
                <h3>{report ? report.verdict.vulnerability : "Run the exploit. Replay the fix."}</h3>
                <p>{analysis
                  ? "Manwall will attempt a bounded source-specific reentrancy proof against the exact analyzed contract. This requires one deployable contract with payable deposit(), withdraw(), no constructor arguments, and the supported interaction-before-effect pattern."
                  : "No analyzed source is selected. This runs Manwall's predefined vulnerable-vault proof demonstration."}</p>
                <button className="secondary-button" onClick={runProof} disabled={running}><Play size={14} /> {running ? "Running proof" : analysis ? "Run source-specific proof" : "Run demo proof"}</button>
              </div>
              <div className="proof-stats">
                <Stat index="01" label="Exploit proof" value={report?.verdict.exploitConfirmed ? "Confirmed" : "Pending"} active={!!report?.verdict.exploitConfirmed} />
                <Stat index="02" label="Patch replay" value={report?.verdict.patchVerified ? "Blocked" : "Pending"} active={!!report?.verdict.patchVerified} />
                <Stat index="03" label="Value demonstrated" value={report?.verdict.fundsAtRisk ?? "Pending"} />
                <Stat index="04" label="Patch gas delta" value={report?.gas.deltaPercent ?? "Pending"} active={!!report} />
              </div>
              {report?.gas.mantleAdvice?.length ? <div className="gas-advice">
                {report.gas.mantleAdvice.map((item) => <p key={item}>{item}</p>)}
              </div> : null}
              {report?.gas.mantleFeeEstimate ? <div className="mantle-fee-panel">
                <div><span>Live Mantle fee status</span><b>{report.gas.mantleFeeEstimate.status}</b></div>
                <div><span>Sample block</span><b>{report.gas.mantleFeeEstimate.blockNumber ?? "Unavailable"}</b></div>
                <div><span>Gas price</span><b>{report.gas.mantleFeeEstimate.gasPriceGwei ? `${report.gas.mantleFeeEstimate.gasPriceGwei} Gwei` : "Unavailable"}</b></div>
                <div><span>Base fee</span><b>{report.gas.mantleFeeEstimate.baseFeeGwei ? `${report.gas.mantleFeeEstimate.baseFeeGwei} Gwei` : "Unavailable"}</b></div>
                <div><span>Original withdrawal</span><b>{report.gas.mantleFeeEstimate.vulnerableCostMnt ? `${report.gas.mantleFeeEstimate.vulnerableCostMnt} MNT` : "Unavailable"}</b></div>
                <div><span>Patched withdrawal</span><b>{report.gas.mantleFeeEstimate.securedCostMnt ? `${report.gas.mantleFeeEstimate.securedCostMnt} MNT` : "Unavailable"}</b></div>
                <p>{report.gas.mantleFeeEstimate.detail}</p>
              </div> : null}
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
              <div className="output-meta"><span>{active.status}</span><span>{active.durationMs ? `${active.durationMs}ms` : active.status === "passed" ? "Execution recorded" : "No execution yet"}</span></div>
              <h3>{active.summary}</h3>
              <div className="evidence-list">
                {active.evidence.length ? active.evidence.map((item, index) => <div key={item}><span>{String(index + 1).padStart(2, "0")}</span><code>{item}</code><Check size={13} /></div>) :
                  <div><Terminal size={14} /><code>Run the verified proof to generate executable evidence.</code></div>}
              </div>
              {active.artifact && <details className="agent-artifact">
                <summary><span>{active.artifact.kind}</span><code>{short(active.artifact.hash)}</code></summary>
                <pre>{active.artifact.content}</pre>
              </details>}
            </div>
          </div>
        </section>

        <section className="attestation">
          <p className="eyebrow">Durable validation</p>
          <div className="attestation-grid">
            <div className="attestation-statement">
              <FallingPattern />
              <h2>A finding can disappear.<br /><span>A proof stays.</span></h2>
            </div>
            <div>
              <p>Verified results are identity-bound and published as evidence hashes. The detailed report stays offchain; the validation record stays inspectable.</p>
              <div className="record">
                <Record label="Scan" value={report?.scanId ?? "Awaiting proof"} />
                <Record label="Target" value={report ? short(report.target.address) : "Awaiting proof"} />
                <Record label="Identity" value={report?.attestation.identityURI ?? "manwall://mantle/security-engineer/v1"} />
                <Record label="Transaction" value={attestationTransaction ? short(attestationTransaction) : report?.attestation.transactionHash ? short(report.attestation.transactionHash) : "Awaiting publication"} />
                <div className="record-hash">
                  <Fingerprint size={15} />
                  <code>{report?.attestation.evidenceHash ?? "Evidence hash appears after a verified proof run"}</code>
                  {(attestationTransaction || report?.attestation.transactionHash) && <a href={`https://sepolia.mantlescan.xyz/tx/${attestationTransaction || report?.attestation.transactionHash}`} target="_blank" rel="noreferrer" aria-label="View attestation transaction"><ExternalLink size={14} /></a>}
                </div>
              </div>
              <div className="wallet-panel" id="wallet-scan">
                <div className="wallet-heading">
                  <div><p className="eyebrow">Free wallet scan</p><h3>Check wallet posture before signing anything.</h3></div>
                  <ShieldCheck size={20} />
                </div>
                {!wallet.installed ? <p className="wallet-note">Install a MetaMask-compatible wallet to scan Mantle wallet exposure.</p> :
                  !wallet.account ? <button className="secondary-button" onClick={() => void wallet.connect(true)} disabled={wallet.busy}>Connect wallet <ArrowRight size={14} /></button> :
                    <>
                      <div className="wallet-actions">
                        {!wallet.onMantleSepolia && <button className="secondary-button" onClick={wallet.switchToMantle} disabled={wallet.busy}>Switch to Mantle <ArrowRight size={14} /></button>}
                        <button className="secondary-button" onClick={() => void runWalletScan()} disabled={wallet.busy || running}>Run wallet scan <ArrowRight size={14} /></button>
                      </div>
                      {walletScan && <div className="wallet-scan-result">
                        <div className={`wallet-risk ${walletScan.summary}`}>
                          <span>{walletScan.summary}</span>
                          <b>{walletScan.issues.length} issue{walletScan.issues.length === 1 ? "" : "s"} found</b>
                        </div>
                        <div className="wallet-details">
                          <Record label="Wallet" value={walletScan.wallet} />
                          <Record label="Account type" value={walletScan.accountType} />
                          <Record label="MNT balance" value={`${Number(walletScan.nativeBalanceMnt).toFixed(4)} MNT`} />
                          <Record label="Transactions" value={String(walletScan.transactionCount)} />
                          <Record label="Allowances" value={String(walletScan.allowances.length)} />
                        </div>
                        <div className="wallet-issues">
                          {walletScan.issues.map((issue) => <div key={`${issue.title}-${issue.detail}`}>
                            <span>{issue.severity}</span>
                            <h4>{issue.title}</h4>
                            <p>{issue.detail}</p>
                            <p>{issue.recommendation}</p>
                          </div>)}
                        </div>
                      </div>}
                      <p className="wallet-note">The free scan reads public Mantle Sepolia state only. It does not request a signature or transaction.</p>
                    </>}
                {wallet.error && <p className="wallet-error">{wallet.error}</p>}
              </div>
              <div className="wallet-panel" id="wallet-approval">
                <div className="wallet-heading">
                  <div><p className="eyebrow">Human approval</p><h3>Sign the evidence, not a blank transaction.</h3></div>
                  <Wallet size={20} />
                </div>
                {!wallet.installed ? <p className="wallet-note">Install a MetaMask-compatible wallet to approve verified evidence.</p> :
                  !wallet.account ? <button className="secondary-button" onClick={() => void wallet.connect(true)} disabled={wallet.busy}>Connect wallet <ArrowRight size={14} /></button> :
                    <>
                      <div className="wallet-details">
                        <Record label="Account" value={wallet.account} />
                        <Record label="Balance" value={`${Number(wallet.balance || 0).toFixed(4)} MNT`} />
                        <Record label="Network" value={wallet.onMantleSepolia ? "Mantle Sepolia / 5003" : `Unsupported / ${wallet.chainId}`} />
                        <Record label="Approval" value={wallet.signature ? short(wallet.signature) : "Not signed"} />
                        <Record label="Gas payer" value="Manwall publisher wallet" />
                      </div>
                      <div className="wallet-actions">
                        {!wallet.onMantleSepolia && <button className="secondary-button" onClick={wallet.switchToMantle} disabled={wallet.busy}>Switch to Mantle <ArrowRight size={14} /></button>}
                        <button className="secondary-button" onClick={approveAndPublishAttestation} disabled={wallet.busy || running || !report || !wallet.onMantleSepolia}>
                          <Fingerprint size={14} /> {wallet.busy ? "Waiting for wallet" : running ? "Publishing evidence" : "Approve and publish"}
                        </button>
                        <button className="text-button" onClick={wallet.disconnect}>Disconnect</button>
                      </div>
                      <p className="wallet-note">Your wallet signs the exact evidence approval without spending gas. After verification, Manwall's funded publisher wallet pays the Mantle Sepolia gas and submits the public attestation transaction.</p>
                      {attestationStatus && <p className="wallet-note">{attestationStatus}</p>}
                      {attestationPublisher && <p className="wallet-note">Publisher: {attestationPublisher}</p>}
                      {attestationTransaction && <a className="wallet-explorer-link" href={`https://sepolia.mantlescan.xyz/tx/${attestationTransaction}`} target="_blank" rel="noreferrer">View attestation on Mantle explorer <ExternalLink size={13} /></a>}
                    </>}
                {wallet.error && <p className="wallet-error">{wallet.error}</p>}
              </div>
            </div>
          </div>
        </section>

        {error && <div className="error">{error}</div>}
      </main>

      <footer>
        <a className="brand-lockup" href="#top"><i className="brand-logo" /><span className="wordmark">man<b>wall</b>.</span></a>
        <p>Evidence-first security for Mantle.</p>
        <nav className="footer-links" aria-label="Manwall Telegram links">
          <a href="https://t.me/ManwallguardBot" target="_blank" rel="noreferrer">
            Try Manwall on Telegram <ExternalLink size={11} />
          </a>
          <a href="https://t.me/manwall" target="_blank" rel="noreferrer">
            Alerts &amp; approvals <ExternalLink size={11} />
          </a>
        </nav>
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

function AiReview({ result }: { result: AiResult }) {
  return <div className="ai-review">
    <div className="ai-review-heading">
      <span>OpenAI {result.workflow}</span>
      <b>{result.riskLevel} risk · {result.model}</b>
    </div>
    <p>{result.summary}</p>
    {result.keyObservations.length > 0 && <div><strong>Observations</strong>{result.keyObservations.map((item) => <small key={item}>{item}</small>)}</div>}
    {result.recommendedActions.length > 0 && <div><strong>Recommended actions</strong>{result.recommendedActions.map((item) => <small key={item}>{item}</small>)}</div>}
    {result.patchDraft && <details><summary>Inspect approved patch draft</summary><pre>{result.patchDraft}</pre></details>}
    <code>{result.usage.inputTokens} input tokens · {result.usage.outputTokens} output tokens · ${result.usage.estimatedCostUsd.toFixed(6)}</code>
  </div>;
}

