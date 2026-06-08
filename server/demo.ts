import { runGuardianScan } from "./guardian.js";

const report = await runGuardianScan();
console.log(JSON.stringify(report, null, 2));
