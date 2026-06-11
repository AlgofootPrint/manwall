import crypto from "node:crypto";
import type { Request } from "express";
import { databaseClient } from "./infrastructure.js";

export interface Actor {
  id: string;
  login: string;
  authenticated: boolean;
}

function sessionToken(request: Request) {
  const bearer = request.header("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1];
  const cookie = request.header("cookie")?.split(";").map((value) => value.trim()).find((value) => value.startsWith("manwall_session="))?.split("=")[1];
  return bearer ?? cookie;
}

const hash = (value: string) => crypto.createHash("sha256").update(value).digest("hex");

export function normalizeRepositoryName(repository: string) {
  return repository
    .trim()
    .replace(/^https:\/\/github\.com\//i, "")
    .replace(/\.git$/i, "")
    .replace(/^\/+|\/+$/g, "");
}

export function monitoredRepositories() {
  const configured = [
    process.env.GITHUB_REPOSITORY,
    ...(process.env.MANTLE_MONITORED_REPOSITORIES ?? "")
      .split(/[,\n]/)
      .map((value) => value.trim())
      .filter(Boolean)
  ].filter(Boolean) as string[];
  return Array.from(new Set(configured.map((repository) => normalizeRepositoryName(repository).toLowerCase())));
}

export async function actorFromRequest(request: Request): Promise<Actor> {
  const adminKey = request.header("x-manwall-admin-key");
  if (process.env.MANWALL_ADMIN_KEY && adminKey === process.env.MANWALL_ADMIN_KEY) {
    return { id: "admin", login: "admin", authenticated: true };
  }
  const token = sessionToken(request);
  const client = databaseClient();
  if (!token || !client) return { id: "anonymous", login: "anonymous", authenticated: false };
  const result = await client.query(
    "SELECT github_id, login FROM auth_sessions WHERE id_hash = $1 AND expires_at > now()",
    [hash(token)]
  );
  const row = result.rows[0];
  return row ? { id: row.github_id, login: row.login, authenticated: true } : { id: "anonymous", login: "anonymous", authenticated: false };
}

export async function repositoryAuthorized(actor: Actor, repository: string) {
  if (actor.login === "admin") return true;
  const normalized = normalizeRepositoryName(repository);
  if (monitoredRepositories().includes(normalized.toLowerCase())) return true;
  const client = databaseClient();
  if (!client) return false;
  const approved = await client.query(
    `SELECT 1
     FROM telegram_approvals
     WHERE action = 'repository.scan'
       AND status IN ('approved', 'consumed')
       AND lower(regexp_replace(regexp_replace(coalesce(payload->>'repository', ''), '^https://github\\.com/', '', 'i'), '\\.git$', '', 'i')) = lower($1)
     LIMIT 1`,
    [normalized]
  );
  if (approved.rows[0]) return true;
  if (!actor.authenticated) return false;
  const result = await client.query(
    `SELECT 1 FROM authorized_repositories ar
     JOIN team_members tm ON tm.team_id = ar.team_id
     WHERE tm.github_id = $1 AND lower(ar.repository) = lower($2) LIMIT 1`,
    [actor.id, normalized]
  );
  return Boolean(result.rows[0]);
}

export function githubLogin() {
  if (!process.env.GITHUB_OAUTH_CLIENT_ID || !process.env.GITHUB_OAUTH_CALLBACK_URL) throw new Error("GitHub OAuth is not configured.");
  const state = crypto.randomBytes(24).toString("base64url");
  return {
    state,
    url: `https://github.com/login/oauth/authorize?client_id=${encodeURIComponent(process.env.GITHUB_OAUTH_CLIENT_ID)}&redirect_uri=${encodeURIComponent(process.env.GITHUB_OAUTH_CALLBACK_URL)}&scope=read:user&state=${state}`
  };
}

export function safeOAuthReturnTarget(value: unknown) {
  if (typeof value !== "string" || !value.startsWith("/") || value.startsWith("//")) return "/";
  try {
    const url = new URL(value, "https://manwall.local");
    if (url.origin !== "https://manwall.local" || url.pathname !== "/") return "/";
    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return "/";
  }
}

export function verifyGithubOAuthState(request: Request, state: string) {
  const cookie = request.header("cookie")?.split(";").map((value) => value.trim()).find((value) => value.startsWith("manwall_oauth_state="))?.split("=")[1];
  if (!cookie || cookie.length !== state.length) return false;
  return crypto.timingSafeEqual(Buffer.from(cookie), Buffer.from(state));
}

export async function completeGithubLogin(code: string) {
  if (!process.env.GITHUB_OAUTH_CLIENT_ID || !process.env.GITHUB_OAUTH_CLIENT_SECRET) throw new Error("GitHub OAuth is not configured.");
  const tokenResponse = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify({ client_id: process.env.GITHUB_OAUTH_CLIENT_ID, client_secret: process.env.GITHUB_OAUTH_CLIENT_SECRET, code })
  });
  const tokenBody = await tokenResponse.json() as { access_token?: string; error_description?: string };
  if (!tokenBody.access_token) throw new Error(tokenBody.error_description ?? "GitHub OAuth exchange failed.");
  const userResponse = await fetch("https://api.github.com/user", {
    headers: { authorization: `Bearer ${tokenBody.access_token}`, accept: "application/vnd.github+json", "user-agent": "manwall" }
  });
  const user = await userResponse.json() as { id?: number; login?: string; avatar_url?: string };
  if (!user.id || !user.login) throw new Error("GitHub OAuth user lookup failed.");
  const token = crypto.randomBytes(32).toString("base64url");
  const client = databaseClient();
  if (!client) throw new Error("Database is required for authentication.");
  await client.query(
    `INSERT INTO users (github_id, login, avatar_url) VALUES ($1, $2, $3)
     ON CONFLICT (github_id) DO UPDATE SET login = EXCLUDED.login, avatar_url = EXCLUDED.avatar_url, updated_at = now()`,
    [String(user.id), user.login, user.avatar_url ?? null]
  );
  await client.query(
    "INSERT INTO auth_sessions (id_hash, github_id, login, avatar_url, expires_at) VALUES ($1, $2, $3, $4, now() + interval '7 days')",
    [hash(token), String(user.id), user.login, user.avatar_url ?? null]
  );
  return { token, user: { id: String(user.id), login: user.login, avatarUrl: user.avatar_url } };
}
