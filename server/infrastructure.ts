import crypto from "node:crypto";
import { HeadBucketCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import pg from "pg";
import type { ScanJob } from "./jobStore.js";

const { Pool } = pg;
let pool: pg.Pool | null = null;
let s3: S3Client | null = null;

function database() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) return null;
  pool ??= new Pool({ connectionString: databaseUrl });
  return pool;
}

export function databaseClient() {
  return database();
}

function objectStore() {
  const s3Bucket = process.env.S3_BUCKET;
  if (!s3Bucket || !process.env.S3_ACCESS_KEY_ID || !process.env.S3_SECRET_ACCESS_KEY) return null;
  s3 ??= new S3Client({
    endpoint: process.env.S3_ENDPOINT || undefined,
    region: process.env.S3_REGION ?? "us-east-1",
    forcePathStyle: process.env.S3_FORCE_PATH_STYLE === "true",
    credentials: {
      accessKeyId: process.env.S3_ACCESS_KEY_ID,
      secretAccessKey: process.env.S3_SECRET_ACCESS_KEY
    }
  });
  return s3;
}

export async function saveJobRecord(job: ScanJob) {
  const client = database();
  if (client) {
    await client.query(
      `INSERT INTO scan_jobs (id, type, status, repository, created_at, updated_at, error, result)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (id) DO UPDATE SET
         status = EXCLUDED.status,
         updated_at = EXCLUDED.updated_at,
         error = EXCLUDED.error,
         result = EXCLUDED.result`,
      [job.id, job.type, job.status, job.repository, job.createdAt, job.updatedAt, job.error ?? null, job.result ?? null]
    );
  }

  if (!["completed", "failed"].includes(job.status)) return;
  const store = objectStore();
  const bucket = process.env.S3_BUCKET;
  if (!store || !bucket) return;
  const body = JSON.stringify(job, null, 2);
  const sha256 = crypto.createHash("sha256").update(body).digest("hex");
  const objectKey = `jobs/${job.id}.json`;
  await store.send(new PutObjectCommand({
    Bucket: bucket,
    Key: objectKey,
    Body: body,
    ContentType: "application/json",
    Metadata: { sha256 }
  }));
  if (client) {
    await client.query(
      `INSERT INTO evidence_artifacts (scan_id, object_key, sha256, content_type, size_bytes)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (object_key) DO UPDATE SET sha256 = EXCLUDED.sha256, size_bytes = EXCLUDED.size_bytes`,
      [job.id, objectKey, sha256, "application/json", Buffer.byteLength(body)]
    );
  }
}

export async function getJobRecord(id: string): Promise<ScanJob | null> {
  const client = database();
  if (!client) return null;
  const result = await client.query("SELECT * FROM scan_jobs WHERE id = $1", [id]);
  const row = result.rows[0];
  return row ? {
    id: row.id,
    type: row.type,
    status: row.status,
    repository: row.repository,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    attempts: Number(row.attempts ?? 0),
    maxAttempts: Number(row.max_attempts ?? 3),
    error: row.error ?? undefined,
    result: row.result ?? undefined
  } : null;
}

export async function listJobRecords(): Promise<ScanJob[] | null> {
  const client = database();
  if (!client) return null;
  const result = await client.query("SELECT id FROM scan_jobs ORDER BY updated_at DESC LIMIT 25");
  return Promise.all(result.rows.map((row) => getJobRecord(row.id))) as Promise<ScanJob[]>;
}

export async function repositoryWorkerStatus() {
  const client = database();
  if (!client) return { active: false, detail: "No shared job database is configured.", tools: { slither: false, foundry: false } };
  const result = await client.query(`
    SELECT status, updated_at, result
    FROM scan_jobs
    WHERE status IN ('running', 'completed')
      AND updated_at > now() - interval '30 minutes'
    ORDER BY updated_at DESC
    LIMIT 1
  `);
  const row = result.rows[0];
  if (!row) return { active: false, detail: "No repository worker activity was recorded in the last 30 minutes.", tools: { slither: false, foundry: false } };
  const tools = row.result?.tools ?? {};
  return {
    active: true,
    detail: `Repository worker ${row.status}; last activity ${row.updated_at.toISOString()}.`,
    tools: { slither: Boolean(tools.slither), foundry: Boolean(tools.foundry) }
  };
}

export async function claimNextJobRecord(): Promise<ScanJob | null> {
  const client = database();
  if (!client) return null;
  const result = await client.query(`
    UPDATE scan_jobs
    SET status = 'running', updated_at = now(), attempts = attempts + 1
    WHERE id = (
      SELECT id
      FROM scan_jobs
      WHERE status = 'queued' AND attempts < max_attempts
      ORDER BY created_at
      FOR UPDATE SKIP LOCKED
      LIMIT 1
    )
    RETURNING *
  `);
  const row = result.rows[0];
  return row ? {
    id: row.id,
    type: row.type,
    status: row.status,
    repository: row.repository,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    attempts: Number(row.attempts ?? 0),
    maxAttempts: Number(row.max_attempts ?? 3),
    error: row.error ?? undefined,
    result: row.result ?? undefined
  } : null;
}

export async function saveReportRecord(report: { scanId: string; createdAt?: string; completedAt?: string }) {
  const client = database();
  const createdAt = report.createdAt ?? report.completedAt ?? new Date().toISOString();
  if (client) {
    await client.query(
      `INSERT INTO scan_reports (scan_id, created_at, report)
       VALUES ($1, $2, $3)
       ON CONFLICT (scan_id) DO UPDATE SET created_at = EXCLUDED.created_at, report = EXCLUDED.report`,
      [report.scanId, createdAt, report]
    );
  }

  const store = objectStore();
  const s3Bucket = process.env.S3_BUCKET;
  if (!store || !s3Bucket) return;
  const body = JSON.stringify(report, null, 2);
  const sha256 = crypto.createHash("sha256").update(body).digest("hex");
  const objectKey = `reports/${report.scanId}.json`;
  await store.send(new PutObjectCommand({
    Bucket: s3Bucket,
    Key: objectKey,
    Body: body,
    ContentType: "application/json",
    Metadata: { sha256 }
  }));
  if (client) {
    await client.query(
      `INSERT INTO evidence_artifacts (scan_id, object_key, sha256, content_type, size_bytes)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (object_key) DO UPDATE SET sha256 = EXCLUDED.sha256, size_bytes = EXCLUDED.size_bytes`,
      [report.scanId, objectKey, sha256, "application/json", Buffer.byteLength(body)]
    );
  }
}

export async function infrastructureStatus() {
  const client = database();
  const store = objectStore();
  const bucket = process.env.S3_BUCKET;
  let databaseReady = false;
  let objectStoreReady = false;
  try {
    if (client) {
      await client.query("SELECT 1");
      databaseReady = true;
    }
  } catch {}
  try {
    if (store && bucket) {
      await store.send(new HeadBucketCommand({ Bucket: bucket }));
      objectStoreReady = true;
    }
  } catch {}
  return { databaseReady, objectStoreReady };
}

export async function getReportRecord(scanId: string) {
  const client = database();
  if (!client) return null;
  const result = await client.query("SELECT report FROM scan_reports WHERE scan_id = $1", [scanId]);
  return result.rows[0]?.report ?? null;
}

export async function listReportRecords() {
  const client = database();
  if (!client) return null;
  const result = await client.query("SELECT report FROM scan_reports ORDER BY created_at DESC LIMIT 25");
  return result.rows.map((row) => row.report);
}

export interface AiAuditLogRecord {
  id?: number;
  createdAt?: string;
  workflow: "review" | "patch";
  model: string;
  approved: boolean;
  status: "ok" | "blocked" | "error";
  requestHash: string;
  requestSummary: string;
  responseHash?: string;
  responseSummary?: string;
  inputTokens: number;
  outputTokens: number;
  estimatedCostUsd: number;
  error?: string;
}

export async function saveAiAuditRecord(record: AiAuditLogRecord) {
  const client = database();
  if (!client) return;
  await client.query(
    `INSERT INTO ai_audit_logs (
       created_at, workflow, model, approved, status, request_hash, request_summary,
       response_hash, response_summary, input_tokens, output_tokens, estimated_cost_usd, error
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
    [
      record.createdAt ?? new Date().toISOString(),
      record.workflow,
      record.model,
      record.approved,
      record.status,
      record.requestHash,
      record.requestSummary,
      record.responseHash ?? null,
      record.responseSummary ?? null,
      record.inputTokens,
      record.outputTokens,
      record.estimatedCostUsd,
      record.error ?? null
    ]
  );
}

export async function listAiAuditRecords() {
  const client = database();
  if (!client) return null;
  const result = await client.query("SELECT * FROM ai_audit_logs ORDER BY created_at DESC LIMIT 25");
  return result.rows.map((row) => ({
    id: row.id,
    createdAt: row.created_at.toISOString(),
    workflow: row.workflow,
    model: row.model,
    approved: row.approved,
    status: row.status,
    requestHash: row.request_hash,
    requestSummary: row.request_summary,
    responseHash: row.response_hash ?? undefined,
    responseSummary: row.response_summary ?? undefined,
    inputTokens: Number(row.input_tokens ?? 0),
    outputTokens: Number(row.output_tokens ?? 0),
    estimatedCostUsd: Number(row.estimated_cost_usd ?? 0),
    error: row.error ?? undefined
  })) as AiAuditLogRecord[];
}

export async function monthlyAiUsage(monthKey: string) {
  const client = database();
  if (!client) return null;
  const result = await client.query(
    `SELECT
       COALESCE(SUM(estimated_cost_usd), 0) AS spent_usd,
       COALESCE(COUNT(*), 0) AS request_count
     FROM ai_audit_logs
     WHERE to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM') = $1`,
    [monthKey]
  );
  const row = result.rows[0] ?? { spent_usd: 0, request_count: 0 };
  return { spentUsd: Number(row.spent_usd ?? 0), requestCount: Number(row.request_count ?? 0) };
}

export async function recentRepositoryJobCount(repository: string, sinceMinutes = 60) {
  const client = database();
  if (!client) return 0;
  const result = await client.query(
    "SELECT count(*) AS count FROM scan_jobs WHERE repository = $1 AND created_at > now() - ($2 * interval '1 minute')",
    [repository, sinceMinutes]
  );
  return Number(result.rows[0]?.count ?? 0);
}

export interface RepositoryMonitorState {
  repository: string;
  defaultBranchSha: string;
  pullRequestMarker: string;
  deploymentMarker: string;
  checkedAt: string;
}

export async function getRepositoryMonitorState(repository: string): Promise<RepositoryMonitorState | null> {
  const client = database();
  if (!client) return null;
  const result = await client.query("SELECT * FROM repository_monitor_state WHERE repository = $1", [repository]);
  const row = result.rows[0];
  return row ? {
    repository: row.repository,
    defaultBranchSha: row.default_branch_sha,
    pullRequestMarker: row.pull_request_marker,
    deploymentMarker: row.deployment_marker,
    checkedAt: row.checked_at.toISOString()
  } : null;
}

export async function saveRepositoryMonitorState(state: Omit<RepositoryMonitorState, "checkedAt">) {
  const client = database();
  if (!client) throw new Error("DATABASE_URL is required for repository monitoring.");
  await client.query(
    `INSERT INTO repository_monitor_state
       (repository, default_branch_sha, pull_request_marker, deployment_marker, checked_at)
     VALUES ($1, $2, $3, $4, now())
     ON CONFLICT (repository) DO UPDATE SET
       default_branch_sha = EXCLUDED.default_branch_sha,
       pull_request_marker = EXCLUDED.pull_request_marker,
       deployment_marker = EXCLUDED.deployment_marker,
       checked_at = now()`,
    [state.repository, state.defaultBranchSha, state.pullRequestMarker, state.deploymentMarker]
  );
}

export async function writeOperationAudit(actor: string, action: string, subject: string, status: string, detail: unknown = {}) {
  const client = database();
  if (!client) return;
  await client.query(
    "INSERT INTO operation_audit_logs (actor, action, subject, status, detail) VALUES ($1, $2, $3, $4, $5)",
    [actor, action, subject, status, detail]
  );
}

export async function listOperationAudits() {
  const client = database();
  if (!client) return [];
  try {
    const result = await client.query("SELECT * FROM operation_audit_logs ORDER BY created_at DESC LIMIT 100");
    return result.rows;
  } catch {
    return [];
  }
}

export async function saveAttestationRecord(record: { scanId: string; actor: string; registryAddress: string; transactionHash: string; receipt: unknown }) {
  const client = database();
  if (!client) return;
  await client.query(
    `INSERT INTO attestations (scan_id, actor, registry_address, transaction_hash, receipt)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (scan_id) DO UPDATE SET actor = EXCLUDED.actor, registry_address = EXCLUDED.registry_address,
       transaction_hash = EXCLUDED.transaction_hash, receipt = EXCLUDED.receipt`,
    [record.scanId, record.actor, record.registryAddress, record.transactionHash, record.receipt]
  );
}

export async function configureTeamAuthorization(input: { slug: string; name: string; githubId: string; repository: string; role: string }) {
  const client = database();
  if (!client) throw new Error("Database is required.");
  await client.query("BEGIN");
  try {
    const team = await client.query(
      `INSERT INTO teams (slug, name) VALUES ($1, $2)
       ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name RETURNING id`,
      [input.slug, input.name]
    );
    const teamId = team.rows[0].id;
    await client.query(
      `INSERT INTO team_members (team_id, github_id, role) VALUES ($1, $2, $3)
       ON CONFLICT (team_id, github_id) DO UPDATE SET role = EXCLUDED.role`,
      [teamId, input.githubId, input.role]
    );
    await client.query(
      `INSERT INTO authorized_repositories (team_id, repository) VALUES ($1, $2)
       ON CONFLICT (team_id, repository) DO NOTHING`,
      [teamId, input.repository]
    );
    await client.query("COMMIT");
    return { teamId, ...input };
  } catch (reason) {
    await client.query("ROLLBACK");
    throw reason;
  }
}
