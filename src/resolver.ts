import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import { exec } from "child_process";
import { promisify } from "util";

const execAsync = promisify(exec);

interface SubmoduleMap {
  [repoSlug: string]: string; // e.g. "acme/backend-api" -> "services/backend"
}

/**
 * Extracts org/repo slug from a git URL.
 * Handles both SSH (git@github.com:org/repo.git) and HTTPS (https://github.com/org/repo.git).
 */
function normalizeGitUrl(url: string): string | undefined {
  // SSH: git@github.com:org/repo.git
  const sshMatch = url.match(/:([^/]+\/[^/]+?)(?:\.git)?$/);
  if (sshMatch) {
    return sshMatch[1];
  }
  // HTTPS: https://github.com/org/repo.git
  const httpsMatch = url.match(/\/([^/]+\/[^/]+?)(?:\.git)?$/);
  if (httpsMatch) {
    return httpsMatch[1];
  }
  return undefined;
}

/**
 * Returns the owner/repo slug for the workspace's own git remote origin.
 * Returns undefined if git is not available or the remote is not set.
 */
export async function getMainRepoSlug(workspaceRoot: string): Promise<string | undefined> {
  try {
    const { stdout } = await execAsync("git remote get-url origin", { cwd: workspaceRoot });
    return normalizeGitUrl(stdout.trim());
  } catch {
    return undefined;
  }
}

/**
 * Parses .gitmodules to build a map of repo slug -> local submodule path.
 */
export function parseGitmodules(workspaceRoot: string): SubmoduleMap {
  const gitmodulesPath = path.join(workspaceRoot, ".gitmodules");
  const map: SubmoduleMap = {};

  try {
    const content = fs.readFileSync(gitmodulesPath, "utf-8");
    const lines = content.split("\n");

    let currentPath: string | undefined;
    let currentUrl: string | undefined;

    for (const line of lines) {
      const trimmed = line.trim();

      if (trimmed.startsWith("[submodule")) {
        // Save previous entry if complete
        if (currentPath && currentUrl) {
          const slug = normalizeGitUrl(currentUrl);
          if (slug) {
            map[slug] = currentPath;
          }
        }
        currentPath = undefined;
        currentUrl = undefined;
      }

      const pathMatch = trimmed.match(/^path\s*=\s*(.+)$/);
      if (pathMatch) {
        currentPath = pathMatch[1].trim();
      }

      const urlMatch = trimmed.match(/^url\s*=\s*(.+)$/);
      if (urlMatch) {
        currentUrl = urlMatch[1].trim();
      }
    }

    // Don't forget the last entry
    if (currentPath && currentUrl) {
      const slug = normalizeGitUrl(currentUrl);
      if (slug) {
        map[slug] = currentPath;
      }
    }
  } catch {
    // No .gitmodules or unreadable — return empty map
  }

  return map;
}

/**
 * Resolves a comment's relative path to a workspace URI.
 * Tries: submodule path (via .gitmodules), then workspace root directly.
 */
export function resolveCommentUri(
  workspaceRoot: string,
  submoduleMap: SubmoduleMap,
  repoSlug: string,
  relativePath: string
): vscode.Uri | undefined {
  // Try submodule path first
  const submodulePath = submoduleMap[repoSlug];
  if (submodulePath) {
    const fullPath = path.join(workspaceRoot, submodulePath, relativePath);
    if (fs.existsSync(fullPath)) {
      return vscode.Uri.file(fullPath);
    }
  }

  // Fallback: try directly from workspace root
  const directPath = path.join(workspaceRoot, relativePath);
  if (fs.existsSync(directPath)) {
    return vscode.Uri.file(directPath);
  }

  return undefined;
}

/**
 * Returns the filesystem path where `git show` should be executed.
 * For submodule repos, this is the submodule directory; otherwise the workspace root.
 */
export function resolveGitRoot(
  workspaceRoot: string,
  submoduleMap: SubmoduleMap,
  repoSlug: string
): string {
  const submodulePath = submoduleMap[repoSlug];
  if (submodulePath) {
    return path.join(workspaceRoot, submodulePath);
  }
  return workspaceRoot;
}
