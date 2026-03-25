import * as vscode from "vscode";
import * as cp from "child_process";

export const SCHEME = "agent-review-git";

/**
 * Builds a URI for the agent-review-git scheme that can be resolved
 * by the GitContentProvider via `git show <ref>:<path>`.
 */
export function buildGitUri(
  relativePath: string,
  ref: string,
  gitRoot: string
): vscode.Uri {
  return vscode.Uri.from({
    scheme: SCHEME,
    path: `/${relativePath}`,
    query: `ref=${encodeURIComponent(ref)}&root=${encodeURIComponent(gitRoot)}`,
  });
}

/**
 * Provides virtual document content by running `git show <ref>:<path>`
 * in the appropriate repository root directory.
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
    const root = queryMap["root"] || "";
    // Remove leading slash added by Uri.from
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

  clearCache(): void {
    this.cache.clear();
  }
}
