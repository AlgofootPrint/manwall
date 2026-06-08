import "dotenv/config";
import { claimNextJobRecord } from "./infrastructure.js";
import { runRepositoryScan } from "./repositoryScanner.js";

const pollIntervalMs = Number(process.env.WORKER_POLL_INTERVAL_MS ?? 2_000);
let stopping = false;

process.on("SIGINT", () => { stopping = true; });
process.on("SIGTERM", () => { stopping = true; });

console.log("manwall worker started");
while (!stopping) {
  const job = await claimNextJobRecord();
  if (job) {
    console.log(`running ${job.id}`);
    await runRepositoryScan(job);
    console.log(`${job.id} ${job.status}`);
    continue;
  }
  await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
}
console.log("manwall worker stopped");
