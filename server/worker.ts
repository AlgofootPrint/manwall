import "dotenv/config";
import { claimNextJobRecord } from "./infrastructure.js";
import { runRepositoryScan } from "./repositoryScanner.js";

const pollIntervalMs = Number(process.env.WORKER_POLL_INTERVAL_MS ?? 2_000);
const concurrency = Math.max(1, Number(process.env.WORKER_CONCURRENCY ?? 1));
let stopping = false;
const active = new Set<Promise<void>>();

process.on("SIGINT", () => { stopping = true; });
process.on("SIGTERM", () => { stopping = true; });

console.log("manwall worker started");
while (!stopping) {
  if (active.size >= concurrency) {
    await Promise.race(active);
    continue;
  }
  const job = await claimNextJobRecord();
  if (job) {
    const task = runRepositoryScan(job)
      .then(() => console.log(`${job.id} ${job.status}`))
      .catch((reason) => console.error(`${job.id} worker error`, reason))
      .finally(() => active.delete(task));
    active.add(task);
    console.log(`running ${job.id}; active=${active.size}/${concurrency}`);
    continue;
  }
  await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
}
await Promise.allSettled(active);
console.log("manwall worker stopped");
