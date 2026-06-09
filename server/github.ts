import crypto from "node:crypto";
import { validateRepository } from "./repositoryScanner.js";

export interface GitHubRepositoryAccess {
  repository: string;
  accessible: boolean;
  pullRequestsReadable: boolean;
  actionsReadable: boolean;
  webhooksReadable: boolean;
  writable: boolean;
  detail: string;
}

export interface GitHubWebhookAcceptance {
  accepted: boolean;
  event: string;
  repository: string;
}

export interface GitHubRepositorySnapshot {
  repository: string;
  defaultBranchSha: string;
  pullRequestMarker: string;
  deploymentMarker: string;
}

function githubRepositoryCoordinates(repository: string) {
  const trimmed = repository.trim();
  const [owner, name] = trimmed.startsWith("http://") || trimmed.startsWith("https://")
    ? (() => {
        const validated = validateRepository(trimmed);
        const url = new URL(validated);
        return url.pathname.replace(/\.git$/, "").split("/").filter(Boolean);
      })()
    : trimmed.replace(/\.git$/, "").split("/").filter(Boolean);
  if (!owner || !name) {
    throw new Error("GitHub repository must be provided as owner/repository or https://github.com/owner/repository.");
  }
  return { owner, name, repository: `${owner}/${name}`, htmlUrl: `https://github.com/${owner}/${name}` };
}

async function githubRequest(repository: string, path: string, init: RequestInit = {}) {
  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    throw new Error("GITHUB_TOKEN is not configured.");
  }
  const { owner, name } = githubRepositoryCoordinates(repository);
  const response = await fetch(`https://api.github.com/repos/${owner}/${name}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "manwall",
      "content-type": "application/json",
      ...init.headers
    }
  });
  return response;
}

async function githubJson(repository: string, path: string, init: RequestInit = {}) {
  const response = await githubRequest(repository, path, init);
  const body = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (!response.ok) throw new Error(`GitHub request ${path} failed with HTTP ${response.status}: ${String(body.message ?? "unknown error")}`);
  return body;
}

export async function createRemediationPullRequest(input: {
  repository: string;
  branch: string;
  title: string;
  body: string;
  files: Array<{ path: string; content: string }>;
}) {
  const repo = await githubJson(input.repository, "");
  const defaultBranch = String(repo.default_branch ?? "main");
  const base = await githubJson(input.repository, `/git/ref/heads/${encodeURIComponent(defaultBranch)}`);
  const sha = String((base.object as { sha?: string } | undefined)?.sha ?? "");
  if (!sha) throw new Error("Unable to resolve the GitHub default branch.");

  await githubJson(input.repository, "/git/refs", {
    method: "POST",
    body: JSON.stringify({ ref: `refs/heads/${input.branch}`, sha })
  });

  for (const file of input.files) {
    const encodedPath = file.path.split("/").map(encodeURIComponent).join("/");
    await githubJson(input.repository, `/contents/${encodedPath}`, {
      method: "PUT",
      body: JSON.stringify({
        message: `security: remediate ${file.path}`,
        branch: input.branch,
        content: Buffer.from(file.content).toString("base64")
      })
    });
  }

  return githubJson(input.repository, "/pulls", {
    method: "POST",
    body: JSON.stringify({ title: input.title, body: input.body, head: input.branch, base: defaultBranch, draft: true })
  });
}

export async function getGitHubRepositoryAccess(repository = process.env.GITHUB_REPOSITORY ?? ""): Promise<GitHubRepositoryAccess> {
  if (!repository) {
    return {
      repository: "",
      accessible: false,
      pullRequestsReadable: false,
      actionsReadable: false,
      webhooksReadable: false,
      writable: false,
      detail: "Set GITHUB_TOKEN and GITHUB_REPOSITORY."
    };
  }

  const { repository: normalized } = githubRepositoryCoordinates(repository);

  try {
    const repositoryResponse = await githubRequest(repository, "");
    if (!repositoryResponse.ok) {
      return {
        repository: normalized,
        accessible: false,
        pullRequestsReadable: false,
        actionsReadable: false,
        webhooksReadable: false,
        writable: false,
        detail: `GitHub repository check failed with HTTP ${repositoryResponse.status}.`
      };
    }

    const repo = await repositoryResponse.json() as { permissions?: { admin?: boolean; push?: boolean; pull?: boolean } };

    const [pullRequestsResponse, actionsResponse, webhooksResponse] = await Promise.all([
      githubRequest(repository, "/pulls?per_page=1"),
      githubRequest(repository, "/actions/runs?per_page=1"),
      githubRequest(repository, "/hooks?per_page=1")
    ]);

    return {
      repository: normalized,
      accessible: true,
      pullRequestsReadable: pullRequestsResponse.ok,
      actionsReadable: actionsResponse.ok,
      webhooksReadable: webhooksResponse.ok,
      writable: Boolean(repo.permissions?.push || repo.permissions?.admin),
      detail: "GitHub token can read the repository and selected permission checks succeeded."
    };
  } catch (reason) {
    return {
      repository: normalized,
      accessible: false,
      pullRequestsReadable: false,
      actionsReadable: false,
      webhooksReadable: false,
      writable: false,
      detail: reason instanceof Error ? reason.message : "GitHub repository check failed."
    };
  }
}

async function githubListMarker(repository: string, path: string, marker: (value: Record<string, unknown>) => string) {
  const response = await githubRequest(repository, path);
  if (!response.ok) return `unavailable:${response.status}`;
  const values = await response.json() as Record<string, unknown>[];
  return values[0] ? marker(values[0]) : "none";
}

export async function getGitHubRepositorySnapshot(repository: string): Promise<GitHubRepositorySnapshot> {
  const coordinates = githubRepositoryCoordinates(repository);
  const repositoryResponse = await githubRequest(repository, "");
  if (!repositoryResponse.ok) throw new Error(`GitHub repository check failed with HTTP ${repositoryResponse.status}.`);
  const details = await repositoryResponse.json() as { default_branch?: string };
  const defaultBranch = details.default_branch ?? "main";
  const [defaultBranchSha, pullRequestMarker, deploymentMarker] = await Promise.all([
    githubListMarker(repository, `/commits?sha=${encodeURIComponent(defaultBranch)}&per_page=1`, (value) => String(value.sha ?? "none")),
    githubListMarker(repository, "/pulls?state=open&sort=updated&direction=desc&per_page=1", (value) => {
      const head = value.head as { sha?: string } | undefined;
      return `${String(value.id ?? "none")}:${String(value.updated_at ?? "none")}:${String(head?.sha ?? "none")}`;
    }),
    githubListMarker(repository, "/deployments?per_page=1", (value) => `${String(value.id ?? "none")}:${String(value.updated_at ?? value.created_at ?? "none")}:${String(value.sha ?? "none")}`)
  ]);
  return {
    repository: coordinates.repository.toLowerCase(),
    defaultBranchSha,
    pullRequestMarker,
    deploymentMarker
  };
}

export function verifyGitHubWebhookSignature(secret: string, rawBody: Buffer, signatureHeader: string | undefined) {
  if (!signatureHeader) return false;
  const expected = `sha256=${crypto.createHmac("sha256", secret).update(rawBody).digest("hex")}`;
  const expectedBuffer = Buffer.from(expected);
  const providedBuffer = Buffer.from(signatureHeader);
  if (expectedBuffer.length !== providedBuffer.length) return false;
  return crypto.timingSafeEqual(expectedBuffer, providedBuffer);
}

export function parseGitHubWebhookRepository(payload: unknown) {
  const repository = payload && typeof payload === "object" ? (payload as { repository?: { html_url?: string; full_name?: string; private?: boolean } }).repository : undefined;
  if (!repository?.html_url && !repository?.full_name) return null;
  const htmlUrl = repository.html_url ?? `https://github.com/${repository.full_name}`;
  if (repository.private) return null;
  return htmlUrl;
}

export function shouldScanGitHubEvent(event: string, payload: unknown) {
  if (event === "push") return parseGitHubWebhookRepository(payload);
  if (event === "deployment") {
    const action = payload && typeof payload === "object" ? (payload as { action?: string }).action : undefined;
    return !action || action === "created" ? parseGitHubWebhookRepository(payload) : null;
  }
  if (event !== "pull_request") return null;
  const pullRequest = payload && typeof payload === "object" ? (payload as { action?: string; pull_request?: { html_url?: string; head?: { repo?: { html_url?: string; private?: boolean } } } }).pull_request : undefined;
  if (!pullRequest) return null;
  const action = payload && typeof payload === "object" ? (payload as { action?: string }).action : undefined;
  if (!["opened", "reopened", "synchronize"].includes(String(action))) return null;
  if (pullRequest.head?.repo?.private) return null;
  return pullRequest.head?.repo?.html_url ?? parseGitHubWebhookRepository(payload);
}

export async function acceptGitHubWebhook(event: string, payload: unknown): Promise<GitHubWebhookAcceptance> {
  const repository = shouldScanGitHubEvent(event, payload);
  if (!repository) {
    return { accepted: false, event, repository: "" };
  }
  return { accepted: true, event, repository };
}
