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
  if (!client) return;
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

export async function claimNextJobRecord(): Promise<ScanJob | null> {
  const client = database();
  if (!client) return null;
  const result = await client.query(`
    UPDATE scan_jobs
    SET status = 'running', updated_at = now()
    WHERE id = (
      SELECT id
      FROM scan_jobs
      WHERE status = 'queued'
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
