import * as vscode from "vscode";
import * as cp from "child_process";

export const SCHEME = "agent-review-git";

/**
 * Builds a URI that fetches content from the GitHub API via `gh`.
 * Used for the base side of the diff when the GH PR extension can't serve it.
 */
export function buildGitHubApiUri(
  relativePath: string,
  commitSha: string,
  repo: string,
  absolutePath: string
): vscode.Uri {
  return vscode.Uri.from({
    scheme: SCHEME,
    path: absolutePath,
    query: `ref=${encodeURIComponent(commitSha)}&repo=${encodeURIComponent(repo)}&path=${encodeURIComponent(relativePath)}`,
  });
}

/**
 * Extracts the relative path and repo from an agent-review-git GitHub API URI.
 */
export function parseGitHubApiUri(uri: vscode.Uri): { path: string; repo: string } | undefined {
  if (uri.scheme !== SCHEME) {
    return undefined;
  }
  const pathMatch = uri.query.match(/(?:^|&)path=([^&]+)/);
  const repoMatch = uri.query.match(/(?:^|&)repo=([^&]+)/);
  if (pathMatch && repoMatch) {
    return {
      path: decodeURIComponent(pathMatch[1]),
      repo: decodeURIComponent(repoMatch[1]),
    };
  }
  return undefined;
}

/**
 * Provides virtual document content.
 * Supports two modes based on query params:
 * - `repo` + `ref` + `path`: fetches from GitHub API via `gh api`
 * - `root` + `ref`: fetches locally via `git show`
 */
export class GitContentProvider implements vscode.TextDocumentContentProvider {
  private cache = new Map<string, string>();

  provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    const key = uri.toString();
    const cached = this.cache.get(key);
    if (cached !== undefined) {
      return Promise.resolve(cached);
    }

    const queryMap: Record<string, string> = {};
    for (const pair of uri.query.split("&")) {
      const [k, v] = pair.split("=");
      if (k && v) {
        queryMap[k] = decodeURIComponent(v);
      }
    }

    const ref = queryMap["ref"] || "";
    const repo = queryMap["repo"] || "";
    const filePath = queryMap["path"] || "";
    const root = queryMap["root"] || "";

    // GitHub API mode: fetch via `gh api`
    if (repo && ref && filePath) {
      return this.fetchFromGitHub(key, repo, ref, filePath);
    }

    // Local git mode: fetch via `git show`
    const relativePath = uri.path.startsWith("/") ? uri.path.slice(1) : uri.path;
    if (!ref || !root || !relativePath) {
      return Promise.resolve("");
    }

    return new Promise<string>((resolve) => {
      cp.execFile(
        "git",
        ["show", `${ref}:${relativePath}`],
        { cwd: root, maxBuffer: 10 * 1024 * 1024, timeout: 5000 },
        (err: Error | null, stdout: string) => {
          const content = err ? "" : stdout;
          this.cache.set(key, content);
          resolve(content);
        }
      );
    });
  }

  private fetchFromGitHub(cacheKey: string, repo: string, ref: string, filePath: string): Promise<string> {
    return new Promise<string>((resolve) => {
      cp.execFile(
        "gh",
        ["api", `repos/${repo}/contents/${filePath}?ref=${ref}`, "-H", "Accept: application/vnd.github.raw"],
        { maxBuffer: 10 * 1024 * 1024, timeout: 15000 },
        (err: Error | null, stdout: string) => {
          const content = err ? "" : stdout;
          this.cache.set(cacheKey, content);
          resolve(content);
        }
      );
    });
  }

  clearCache(): void {
    this.cache.clear();
  }
}
