CREATE TABLE IF NOT EXISTS scan_jobs (
  id text PRIMARY KEY,
  type text NOT NULL,
  status text NOT NULL,
  repository text NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  error text,
  result jsonb
);

CREATE TABLE IF NOT EXISTS scan_reports (
  scan_id text PRIMARY KEY,
  created_at timestamptz NOT NULL DEFAULT now(),
  report jsonb NOT NULL
);

CREATE TABLE IF NOT EXISTS evidence_artifacts (
  id bigserial PRIMARY KEY,
  scan_id text NOT NULL,
  object_key text NOT NULL UNIQUE,
  sha256 text NOT NULL,
  content_type text NOT NULL,
  size_bytes bigint NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS scan_jobs_updated_at_idx ON scan_jobs (updated_at DESC);
CREATE INDEX IF NOT EXISTS scan_reports_created_at_idx ON scan_reports (created_at DESC);
CREATE INDEX IF NOT EXISTS evidence_artifacts_scan_id_idx ON evidence_artifacts (scan_id);
