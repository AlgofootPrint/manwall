import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { analyzeSource } from "./sourceScanner.js";
import type { ToolResult } from "./jobStore.js";

const maxFiles = 250;
const maxSourceBytes = 500_000;
const maxToolOutputBytes = 100_000;

interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

function truncate(value: string) {
  return Buffer.byteLength(value) <= maxToolOutputBytes
    ? value.trim()
    : `${value.slice(0, maxToolOutputBytes)}\n[output truncated]`;
}

function run(command: string, args: string[], cwd?: string): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      shell: false,
      env: { ...process.env, HOME: process.env.HOME ?? os.tmpdir() }
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (data) => { stdout += String(data); });
    child.stderr.on("data", (data) => { stderr += String(data); });
    child.once("error", reject);
    child.once("exit", (code) => {
      resolve({ code: code ?? 1, stdout: stdout.trim(), stderr: stderr.trim() });
    });
  });
}

function solidityFiles(root: string) {
  const files: string[] = [];
  const visit = (directory: string) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if ([".git", "node_modules", "lib", "out", "cache", "artifacts"].includes(entry.name)) continue;
      const fullPath = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(fullPath);
      else if (entry.isFile() && entry.name.endsWith(".sol")) files.push(fullPath);
      if (files.length > maxFiles) throw new Error(`Repository exceeds the ${maxFiles} Solidity file limit.`);
    }
  };
  visit(root);
  return files;
}

async function clone(repository: string) {
  const result = await run("git", ["clone", "--depth", "1", "--filter=blob:none", "--recurse-submodules", "--shallow-submodules", repository, "/workspace/repository"]);
  if (result.code !== 0) throw new Error(result.stderr || `git clone exited with ${result.code}`);
}

export function normalizeSlitherResult(result: CommandResult): ToolResult {
  try {
    const parsed = JSON.parse(result.stdout) as {
      success?: boolean;
      error?: string;
      results?: { detectors?: unknown[] };
    };
    const findings = parsed.results?.detectors?.length ?? 0;
    return {
      status: parsed.success === false ? "failed" : "passed",
      findings,
      summary: findings
        ? `Slither reported ${findings} finding${findings === 1 ? "" : "s"}.`
        : parsed.success === false
          ? `Slither failed: ${parsed.error ?? "unknown error"}`
          : "Slither completed without findings.",
      output: truncate(result.stdout || result.stderr)
    };
  } catch {
    return {
      status: "failed",
      findings: 0,
      summary: `Slither exited with code ${result.code} without valid JSON output.`,
      output: truncate(result.stdout || result.stderr)
    };
  }
}

export function normalizeFoundryResult(result: CommandResult): ToolResult {
  const output = [result.stdout, result.stderr].filter(Boolean).join("\n");
  if (/SIGKILL|signal:\s*9|out of memory/i.test(output)) {
    return {
      status: "failed",
      findings: 0,
      summary: "Foundry could not run because the isolated runner reached its resource limit.",
      output: truncate(output)
    };
  }
  if (/binaries\.soliditylang\.org|failed to lookup address|could not resolve host/i.test(output)) {
    return {
      status: "failed",
      findings: 0,
      summary: "Foundry could not run because the repository compiler was not available offline.",
      output: truncate(output)
    };
  }
  const match = output.match(/(\d+)\s+tests?\s+passed[;,]\s+(\d+)\s+failed/i);
  const failed = Number(match?.[2] ?? (result.code === 0 ? 0 : 1));
  return {
    status: result.code === 0 ? "passed" : "failed",
    findings: failed,
    summary: result.code === 0
      ? "Foundry tests completed successfully."
      : `Foundry tests failed with ${failed} failing test${failed === 1 ? "" : "s"}.`,
    output: truncate(output)
  };
}

export function normalizeCompilationResult(result: CommandResult, engine: "forge" | "solc"): ToolResult {
  const output = [result.stdout, result.stderr].filter(Boolean).join("\n");
  if (/SIGKILL|signal:\s*9|out of memory/i.test(output)) {
    return {
      status: "failed",
      findings: 0,
      summary: `Project compilation with ${engine} reached the isolated runner resource limit.`,
      output: truncate(output)
    };
  }
  return {
    status: result.code === 0 ? "passed" : "failed",
    findings: 0,
    summary: result.code === 0
      ? `Project compilation passed with ${engine}.`
      : `Project compilation failed with ${engine}.`,
    output: truncate(output)
  };
}

async function runSlither(root: string): Promise<ToolResult> {
  const compiler = projectCompiler(root);
  return normalizeSlitherResult(await run("slither", [root, ...(compiler ? ["--solc", compiler] : []), "--json", "-"], root));
}

function projectCompiler(root: string) {
  const config = path.join(root, "foundry.toml");
  if (!fs.existsSync(config)) return undefined;
  const version = fs.readFileSync(config, "utf8").match(/^\s*solc_version\s*=\s*["']([^"']+)["']/m)?.[1];
  if (!version) return undefined;
  const bundled = `/opt/solc/${version}/solc`;
  return fs.existsSync(bundled) ? bundled : undefined;
}

async function runProjectCompilation(root: string, files: string[]): Promise<ToolResult> {
  if (!files.length) return { status: "skipped", findings: 0, summary: "No Solidity files were found.", output: "" };
  if (fs.existsSync(path.join(root, "foundry.toml"))) {
    const compiler = projectCompiler(root);
    return normalizeCompilationResult(await run("forge", ["build", ...(compiler ? ["--use", compiler] : [])], root), "forge");
  }
  const relativeFiles = files.map((file) => path.relative(root, file));
  return normalizeCompilationResult(
    await run("solc", ["--base-path", root, "--include-path", root, "--bin", ...relativeFiles], root),
    "solc"
  );
}

async function runFoundry(root: string): Promise<ToolResult> {
  if (!fs.existsSync(path.join(root, "foundry.toml"))) {
    return { status: "skipped", findings: 0, summary: "No foundry.toml was found.", output: "" };
  }
  const compiler = projectCompiler(root);
  return normalizeFoundryResult(await run("forge", ["test", ...(compiler ? ["--use", compiler] : [])], root));
}

async function scan() {
  const sourceRoot = "/workspace/repository";
  const root = path.join(os.tmpdir(), "repository");
  const excludedCopyDirectories = new Set([".git", "node_modules", "out", "cache", "artifacts"]);
  fs.cpSync(sourceRoot, root, {
    recursive: true,
    filter: (source) => source === sourceRoot || !excludedCopyDirectories.has(path.basename(source))
  });
  const commitResult = await run("git", ["-c", `safe.directory=${sourceRoot}`, "rev-parse", "HEAD"], sourceRoot);
  if (commitResult.code !== 0) throw new Error(commitResult.stderr || "Unable to resolve repository commit.");
  const files = solidityFiles(root);
  const reports = files.map((file) => {
    const source = fs.readFileSync(file, "utf8");
    if (Buffer.byteLength(source) > maxSourceBytes) throw new Error(`${path.basename(file)} exceeds source size limit.`);
    return analyzeSource(path.relative(root, file).replaceAll("\\", "/"), source);
  });
  const compilation = await runProjectCompilation(root, files);
  const slither = await runSlither(root);
  const foundry = await runFoundry(root);
  const heuristicFindings = reports.reduce((total, report) => total + report.findings.length, 0);
  const securityFindings = heuristicFindings + slither.findings;
  console.log(JSON.stringify({
    commit: commitResult.stdout,
    filesScanned: files.length,
    findings: securityFindings,
    summary: {
      securityFindings,
      gasOptimizations: reports.reduce((total, report) => total + report.gasOptimizations.length, 0),
      compilationFailures: compilation.status === "failed" ? 1 : 0,
      toolFailures: [compilation, slither, foundry].filter((tool) => tool.status === "failed").length
    },
    reports,
    tools: { compilation, slither, foundry }
  }));
}

async function main() {
  const [mode, value] = process.argv.slice(2);
  if (mode === "clone" && value) await clone(value);
  else if (mode === "scan") await scan();
  else throw new Error("Expected clone <repository> or scan.");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
