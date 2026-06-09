CREATE TABLE IF NOT EXISTS scan_jobs (
  id text PRIMARY KEY,
  type text NOT NULL,
  status text NOT NULL,
  repository text NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  error text,
  result jsonb,
  attempts integer NOT NULL DEFAULT 0,
  max_attempts integer NOT NULL DEFAULT 3
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

CREATE TABLE IF NOT EXISTS ai_audit_logs (
  id bigserial PRIMARY KEY,
  created_at timestamptz NOT NULL DEFAULT now(),
  workflow text NOT NULL,
  model text NOT NULL,
  approved boolean NOT NULL DEFAULT false,
  status text NOT NULL,
  request_hash text NOT NULL,
  request_summary text NOT NULL,
  response_hash text,
  response_summary text,
  input_tokens integer NOT NULL DEFAULT 0,
  output_tokens integer NOT NULL DEFAULT 0,
  estimated_cost_usd numeric(12, 6) NOT NULL DEFAULT 0,
  error text
);

CREATE TABLE IF NOT EXISTS operation_audit_logs (
  id bigserial PRIMARY KEY,
  created_at timestamptz NOT NULL DEFAULT now(),
  actor text NOT NULL,
  action text NOT NULL,
  subject text NOT NULL,
  status text NOT NULL,
  detail jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE TABLE IF NOT EXISTS telegram_approvals (
  id text PRIMARY KEY,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  decided_at timestamptz,
  consumed_at timestamptz,
  action text NOT NULL,
  subject text NOT NULL,
  payload_hash text NOT NULL,
  payload jsonb,
  requested_by text NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  decided_by text,
  telegram_message_id text
);

CREATE TABLE IF NOT EXISTS auth_sessions (
  id_hash text PRIMARY KEY,
  github_id text NOT NULL,
  login text NOT NULL,
  avatar_url text,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
  github_id text PRIMARY KEY,
  login text NOT NULL UNIQUE,
  avatar_url text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS teams (
  id bigserial PRIMARY KEY,
  slug text NOT NULL UNIQUE,
  name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS team_members (
  team_id bigint NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  github_id text NOT NULL REFERENCES users(github_id) ON DELETE CASCADE,
  role text NOT NULL DEFAULT 'member',
  PRIMARY KEY (team_id, github_id)
);

CREATE TABLE IF NOT EXISTS authorized_repositories (
  id bigserial PRIMARY KEY,
  team_id bigint NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  repository text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (team_id, repository)
);

CREATE TABLE IF NOT EXISTS repository_monitor_state (
  repository text PRIMARY KEY,
  default_branch_sha text NOT NULL,
  pull_request_marker text NOT NULL,
  deployment_marker text NOT NULL,
  checked_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS attestations (
  scan_id text PRIMARY KEY,
  created_at timestamptz NOT NULL DEFAULT now(),
  actor text NOT NULL,
  registry_address text NOT NULL,
  transaction_hash text NOT NULL,
  receipt jsonb NOT NULL
);

CREATE INDEX IF NOT EXISTS scan_jobs_updated_at_idx ON scan_jobs (updated_at DESC);
CREATE INDEX IF NOT EXISTS scan_jobs_repository_created_at_idx ON scan_jobs (repository, created_at DESC);
CREATE INDEX IF NOT EXISTS scan_reports_created_at_idx ON scan_reports (created_at DESC);
CREATE INDEX IF NOT EXISTS evidence_artifacts_scan_id_idx ON evidence_artifacts (scan_id);
CREATE INDEX IF NOT EXISTS ai_audit_logs_created_at_idx ON ai_audit_logs (created_at DESC);
CREATE INDEX IF NOT EXISTS ai_audit_logs_workflow_idx ON ai_audit_logs (workflow, created_at DESC);
CREATE INDEX IF NOT EXISTS operation_audit_logs_created_at_idx ON operation_audit_logs (created_at DESC);
CREATE INDEX IF NOT EXISTS auth_sessions_expires_at_idx ON auth_sessions (expires_at);
CREATE INDEX IF NOT EXISTS telegram_approvals_status_expires_at_idx ON telegram_approvals (status, expires_at);
CREATE INDEX IF NOT EXISTS repository_monitor_state_checked_at_idx ON repository_monitor_state (checked_at DESC);
