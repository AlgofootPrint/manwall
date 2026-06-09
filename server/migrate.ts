import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import pg from "pg";

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required.");
const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
await client.connect();
try {
  await client.query(fs.readFileSync(path.resolve("server", "schema.sql"), "utf8"));
  await client.query("ALTER TABLE scan_jobs ADD COLUMN IF NOT EXISTS attempts integer NOT NULL DEFAULT 0");
  await client.query("ALTER TABLE scan_jobs ADD COLUMN IF NOT EXISTS max_attempts integer NOT NULL DEFAULT 3");
  await client.query("ALTER TABLE telegram_approvals ADD COLUMN IF NOT EXISTS payload jsonb");
  console.log("database migrations applied");
} finally {
  await client.end();
}
