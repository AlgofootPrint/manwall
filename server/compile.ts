import fs from "node:fs";
import path from "node:path";
import solc from "solc";

export interface Artifact {
  abi: any[];
  bytecode: string;
}

export function compileContracts(): Record<string, Artifact> {
  const contractsDir = path.resolve("contracts");
  const sources = Object.fromEntries(
    fs.readdirSync(contractsDir)
      .filter((file) => file.endsWith(".sol"))
      .map((file) => [file, { content: fs.readFileSync(path.join(contractsDir, file), "utf8") }])
  );

  const output = JSON.parse(solc.compile(JSON.stringify({
    language: "Solidity",
    sources,
    settings: {
      optimizer: { enabled: true, runs: 200 },
      evmVersion: "shanghai",
      outputSelection: { "*": { "*": ["abi", "evm.bytecode.object"] } }
    }
  })));

  const errors = (output.errors ?? []).filter((error: { severity: string }) => error.severity === "error");
  if (errors.length) {
    throw new Error(errors.map((error: { formattedMessage: string }) => error.formattedMessage).join("\n"));
  }

  const artifacts: Record<string, Artifact> = {};
  for (const contracts of Object.values(output.contracts) as Array<Record<string, {
    abi: any[];
    evm: { bytecode: { object: string } };
  }>>) {
    for (const [name, contract] of Object.entries(contracts)) {
      if (contract.evm.bytecode.object) {
        artifacts[name] = { abi: contract.abi, bytecode: `0x${contract.evm.bytecode.object}` };
      }
    }
  }
  return artifacts;
}

if (process.argv[1]?.endsWith("compile.ts")) {
  const artifacts = compileContracts();
  console.log(`Compiled ${Object.keys(artifacts).length} contracts: ${Object.keys(artifacts).join(", ")}`);
}
