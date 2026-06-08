import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { analyzeSource } from "./sourceScanner.js";

const maxFiles = 250;
const maxSourceBytes = 500_000;

function run(command: string, args: string[], cwd?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, shell: false });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (data) => { stdout += String(data); });
    child.stderr.on("data", (data) => { stderr += String(data); });
    child.once("error", reject);
    child.once("exit", (code) => {
      code === 0 ? resolve(stdout.trim()) : reject(new Error(stderr.trim() || `${command} exited with ${code}`));
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
  await run("git", ["clone", "--depth", "1", "--filter=blob:none", repository, "/workspace/repository"]);
}

async function scan() {
  const root = "/workspace/repository";
  const commit = await run("git", ["rev-parse", "HEAD"], root);
  const files = solidityFiles(root);
  const reports = files.map((file) => {
    const source = fs.readFileSync(file, "utf8");
    if (Buffer.byteLength(source) > maxSourceBytes) throw new Error(`${path.basename(file)} exceeds source size limit.`);
    return analyzeSource(path.relative(root, file).replaceAll("\\", "/"), source);
  });
  console.log(JSON.stringify({
    commit,
    filesScanned: files.length,
    findings: reports.reduce((total, report) => total + report.findings.length, 0),
    reports
  }));
}

const [mode, value] = process.argv.slice(2);
if (mode === "clone" && value) await clone(value);
else if (mode === "scan") await scan();
else throw new Error("Expected clone <repository> or scan.");
