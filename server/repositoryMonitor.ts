import { monitoredRepositories, normalizeRepositoryName } from "./auth.js";
import { getGitHubRepositorySnapshot } from "./github.js";
import {
  getRepositoryMonitorState,
  repositoryScanQuotaStatus,
  saveRepositoryMonitorState,
  writeOperationAudit
} from "./infrastructure.js";
import { saveJob } from "./jobStore.js";
import { createRepositoryJob } from "./repositoryScanner.js";

export interface RepositoryPollResult {
  repository: string;
  status: "baseline" | "unchanged" | "queued" | "rate-limited" | "failed";
  changed: string[];
  jobId?: string;
  error?: string;
}

export function externallyMonitoredRepositories() {
  const primary = normalizeRepositoryName(process.env.GITHUB_REPOSITORY ?? "").toLowerCase();
  return monitoredRepositories().filter((repository) => repository !== primary);
}

export async function pollRepository(repository: string): Promise<RepositoryPollResult> {
  try {
    const snapshot = await getGitHubRepositorySnapshot(repository);
    const previous = await getRepositoryMonitorState(snapshot.repository);
    const next = {
      repository: snapshot.repository,
      defaultBranchSha: snapshot.defaultBranchSha,
      pullRequestMarker: snapshot.pullRequestMarker,
      deploymentMarker: snapshot.deploymentMarker
    };

    if (!previous) {
      await saveRepositoryMonitorState(next);
      await writeOperationAudit("monitor", "repository.poll", snapshot.repository, "baseline", snapshot);
      return { repository: snapshot.repository, status: "baseline", changed: [] };
    }

    const changed = [
      previous.defaultBranchSha !== snapshot.defaultBranchSha ? "push" : "",
      previous.pullRequestMarker !== snapshot.pullRequestMarker ? "pull_request" : "",
      previous.deploymentMarker !== snapshot.deploymentMarker ? "deployment" : ""
    ].filter(Boolean);

    if (!changed.length) {
      await saveRepositoryMonitorState(next);
      return { repository: snapshot.repository, status: "unchanged", changed };
    }

    const job = createRepositoryJob(`https://github.com/${snapshot.repository}`);
    const quota = await repositoryScanQuotaStatus(job.repository);
    if (!quota.allowed) {
      await writeOperationAudit("monitor", "repository.poll", snapshot.repository, "rate-limited", { changed });
      return { repository: snapshot.repository, status: "rate-limited", changed };
    }

    await saveJob(job);
    await saveRepositoryMonitorState(next);
    await writeOperationAudit("monitor", "repository.poll", snapshot.repository, "queued", { changed, jobId: job.id });
    return { repository: snapshot.repository, status: "queued", changed, jobId: job.id };
  } catch (reason) {
    const error = reason instanceof Error ? reason.message : "Repository monitoring failed.";
    await writeOperationAudit("monitor", "repository.poll", repository, "failed", { error });
    return { repository, status: "failed", changed: [], error };
  }
}

export async function pollExternalRepositories() {
  const results: RepositoryPollResult[] = [];
  for (const repository of externallyMonitoredRepositories()) {
    results.push(await pollRepository(repository));
  }
  return results;
}
