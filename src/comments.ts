import * as vscode from "vscode";

import * as cp from "child_process";

import { ReviewAuthor, ReviewComment, ReviewFile, Severity, saveReviewFile } from "./parser";
import { resolveCommentUri } from "./resolver";
import { getIconUri } from "./icons";
import { buildGitHubApiUri } from "./diffProvider";

interface SubmoduleMap {
  [repoSlug: string]: string;
}

/**
 * Extends vscode.Comment with a back-reference to the source ReviewComment index
 * and the review file path for routing mutations to the correct controller.
 */
export interface AgentReviewComment extends vscode.Comment {
  commentIndex: number;
  threadRef?: vscode.CommentThread;
  reviewFilePath?: string;
}

export interface CommentedFileInfo {
  relativePath: string;
  fileUri: vscode.Uri;
}

export interface NavigationEntry {
  path: string;
  line: number;
  side: "LEFT" | "RIGHT";
  reviewFilePath?: string;
}

export class ReviewCommentController {
  private controller: vscode.CommentController;
  private threads: vscode.CommentThread[] = [];

  // In-memory state for persistence
  private review: ReviewFile | undefined;
  private reviewFilePath: string | undefined;
  // Flag to suppress file watcher reloads during our own writes
  public isSaving = false;
  private workspaceRoot: string | undefined;
  private submoduleMap: SubmoduleMap = {};
  private extensionUri: vscode.Uri | undefined;
  private fallbackTimestamp: Date | undefined;
  private gitRoot: string | undefined;

  // Lookup map for grouping comments by file path
  private commentsByPath = new Map<string, {
    left: { comment: ReviewComment; index: number }[];
    right: { comment: ReviewComment; index: number }[];
  }>();

  // Track URIs that already have threads to avoid duplicates
  private attachedUris = new Set<string>();

  // Cached list of files with comments for navigation/diff opening
  private commentedFiles: CommentedFileInfo[] = [];

  // Cached PR commit SHAs (fetched from GitHub API once per review load)
  private prCommits: { baseCommit: string; headCommit: string } | undefined;

  constructor(controllerId: string, label: string) {
    this.controller = vscode.comments.createCommentController(
      controllerId,
      label
    );
  }

  getReviewFilePath(): string | undefined {
    return this.reviewFilePath;
  }

  async loadReview(
    review: ReviewFile,
    workspaceRoot: string,
    submoduleMap: SubmoduleMap,
    extensionUri: vscode.Uri,
    fallbackTimestamp?: Date,
    reviewFilePath?: string,
    gitRoot?: string
  ): Promise<{ loaded: number; skipped: number }> {
    this.clearAll();
    this.prCommits = undefined;

    this.review = review;
    this.reviewFilePath = reviewFilePath;
    this.workspaceRoot = workspaceRoot;
    this.submoduleMap = submoduleMap;
    this.extensionUri = extensionUri;
    this.fallbackTimestamp = fallbackTimestamp;
    this.gitRoot = gitRoot;

    // Fetch PR commits from GitHub API for attaching comments to diff URIs
    await this.fetchPRCommits();

    const result = this.rebuildThreads();

    // Pre-warm content cache in the background so diffs open instantly on click
    this.preWarmContentCache();

    return result;
  }

  // --- Mutation methods ---

  async deleteComment(comment: AgentReviewComment): Promise<void> {
    if (!this.review || !this.reviewFilePath) {
      return;
    }

    this.review.comments.splice(comment.commentIndex, 1);
    await this.persistAndRebuild();
  }

  async updateCommentBody(
    comment: AgentReviewComment,
    newBody: string
  ): Promise<void> {
    if (!this.review || !this.reviewFilePath) {
      return;
    }

    const source = this.review.comments[comment.commentIndex];
    if (source) {
      source.body = newBody;
    }
    await this.persistAndRebuild();
  }

  async updateCommentSeverity(
    comment: AgentReviewComment,
    newSeverity: Severity
  ): Promise<void> {
    if (!this.review || !this.reviewFilePath) {
      return;
    }

    const source = this.review.comments[comment.commentIndex];
    if (source) {
      source.severity = newSeverity;
    }
    await this.persistAndRebuild();
  }

  setCommentEditing(comment: AgentReviewComment, thread?: vscode.CommentThread): void {
    const t = thread || comment.threadRef;
    if (!t) {
      return;
    }
    comment.mode = vscode.CommentMode.Editing;
    comment.contextValue = "agentReviewEditing";
    t.comments = [...t.comments];
  }

  cancelEdit(comment: AgentReviewComment, thread?: vscode.CommentThread): void {
    const t = thread || comment.threadRef;
    if (!t || !this.review) {
      return;
    }
    const source = this.review.comments[comment.commentIndex];
    if (source) {
      comment.body = new vscode.MarkdownString(source.body);
    }
    comment.mode = vscode.CommentMode.Preview;
    comment.contextValue = "agentReview";
    t.comments = [...t.comments];
  }

  getReview(): ReviewFile | undefined {
    return this.review;
  }

  clearAll(): void {
    for (const thread of this.threads) {
      thread.dispose();
    }
    this.threads = [];
    this.commentsByPath.clear();
    this.attachedUris.clear();
    this.commentedFiles = [];
  }

  dispose(): void {
    this.clearAll();
    this.controller.dispose();
  }

  // --- Diff & navigation methods ---

  /**
   * Returns the smallest comment line number for a given file path.
   * Used as a fallback when the editor selection can't be trusted.
   */
  getFirstCommentLine(relativePath: string): number | undefined {
    const sides = this.commentsByPath.get(relativePath);
    if (!sides) {
      return undefined;
    }
    let minLine: number | undefined;
    for (const entry of [...sides.right, ...sides.left]) {
      if (minLine === undefined || entry.comment.line < minLine) {
        minLine = entry.comment.line;
      }
    }
    return minLine;
  }

  matchesRepo(repo: string): boolean {
    return this.review?.pr.repo === repo;
  }

  hasCommentsForPath(relativePath: string): boolean {
    return this.commentsByPath.has(relativePath);
  }

  getRelativePath(uri: vscode.Uri): string | undefined {
    if (!this.workspaceRoot || uri.scheme !== "file") {
      return undefined;
    }
    const filePath = uri.fsPath;
    if (!filePath.startsWith(this.workspaceRoot)) {
      return undefined;
    }
    let rel = filePath.slice(this.workspaceRoot.length);
    if (rel.startsWith("/") || rel.startsWith("\\")) {
      rel = rel.slice(1);
    }
    if (this.review) {
      const submodulePath = this.submoduleMap[this.review.pr.repo];
      if (submodulePath && rel.startsWith(submodulePath)) {
        rel = rel.slice(submodulePath.length);
        if (rel.startsWith("/") || rel.startsWith("\\")) {
          rel = rel.slice(1);
        }
      }
    }
    return rel;
  }

  /**
   * Opens a diff view for the given relative file path.
   * Both sides fetched from GitHub API. Comments are already attached
   * to the same URIs during rebuildThreads, so they appear in the diff.
   */
  async openDiffForFile(relativePath: string, line?: number): Promise<void> {
    if (!this.review || !this.workspaceRoot || !this.gitRoot || !this.prCommits) {
      return;
    }

    const fileUri = resolveCommentUri(
      this.workspaceRoot,
      this.submoduleMap,
      this.review.pr.repo,
      relativePath
    );
    if (!fileUri) {
      return;
    }

    const options: vscode.TextDocumentShowOptions = {};
    if (line) {
      options.selection = new vscode.Range(
        Math.max(0, line - 1), 0,
        Math.max(0, line - 1), 0
      );
    }

    const title = `${relativePath} (PR #${this.review.pr.number})`;

    try {
      const absolutePath = fileUri.fsPath;
      const repo = this.review.pr.repo;
      const baseUri = buildGitHubApiUri(relativePath, this.prCommits.baseCommit, repo, absolutePath);
      const headUri = buildGitHubApiUri(relativePath, this.prCommits.headCommit, repo, absolutePath);

      await Promise.all([
        vscode.workspace.openTextDocument(baseUri),
        vscode.workspace.openTextDocument(headUri),
      ]);

      await vscode.commands.executeCommand("vscode.diff", baseUri, headUri, title, options);
    } catch {
      // Cannot show diff
    }
  }

  getCommentedFiles(): CommentedFileInfo[] {
    return this.commentedFiles;
  }

  getNavigationList(): NavigationEntry[] {
    if (!this.review || !this.workspaceRoot || !this.gitRoot) {
      return [];
    }

    const entries: NavigationEntry[] = [];
    for (const [relativePath, sides] of this.commentsByPath) {
      for (const entry of sides.right) {
        entries.push({
          path: relativePath,
          line: entry.comment.line,
          side: "RIGHT",
          reviewFilePath: this.reviewFilePath,
        });
      }
      for (const entry of sides.left) {
        entries.push({
          path: relativePath,
          line: entry.comment.line,
          side: "LEFT",
          reviewFilePath: this.reviewFilePath,
        });
      }
    }

    return entries;
  }

  // --- Private helpers ---

  /**
   * Pre-fetch content for all commented files from GitHub API in background.
   * This warms the GitContentProvider cache so diffs open instantly on click.
   */
  private preWarmContentCache(): void {
    if (!this.prCommits || !this.review || !this.workspaceRoot) {
      return;
    }

    const commits = this.prCommits;
    const repo = this.review.pr.repo;
    const uris: vscode.Uri[] = [];

    for (const file of this.commentedFiles) {
      const absolutePath = file.fileUri.fsPath;
      uris.push(buildGitHubApiUri(file.relativePath, commits.headCommit, repo, absolutePath));
      uris.push(buildGitHubApiUri(file.relativePath, commits.baseCommit, repo, absolutePath));
    }

    // Fire-and-forget: fetch all in parallel
    Promise.allSettled(
      uris.map((uri) => vscode.workspace.openTextDocument(uri))
    ).catch(() => {
      // Ignore errors — cache warming is best-effort
    });
  }

  /**
   * Fetch PR commit SHAs from GitHub API via `gh` CLI. Caches the result.
   */
  private fetchPRCommits(): Promise<{ baseCommit: string; headCommit: string } | undefined> {
    if (this.prCommits) {
      return Promise.resolve(this.prCommits);
    }
    if (!this.review) {
      return Promise.resolve(undefined);
    }
    const { repo, number: prNumber } = this.review.pr;
    return new Promise<{ baseCommit: string; headCommit: string } | undefined>((resolve) => {
      cp.execFile(
        "gh",
        ["api", `repos/${repo}/pulls/${prNumber}`, "--jq", "{baseCommit: .base.sha, headCommit: .head.sha}"],
        { timeout: 10000 },
        (err: Error | null, stdout: string) => {
          if (err) {
            resolve(undefined);
          } else {
            try {
              this.prCommits = JSON.parse(stdout.trim());
              resolve(this.prCommits);
            } catch {
              resolve(undefined);
            }
          }
        }
      );
    });
  }

  private async persistAndRebuild(): Promise<void> {
    if (this.review && this.reviewFilePath) {
      this.isSaving = true;
      await saveReviewFile(this.reviewFilePath, this.review);
      setTimeout(() => {
        this.isSaving = false;
      }, 1000);
    }
    this.rebuildThreads();
  }

  private rebuildThreads(): { loaded: number; skipped: number } {
    for (const thread of this.threads) {
      thread.dispose();
    }
    this.threads = [];
    this.commentsByPath.clear();
    this.attachedUris.clear();
    this.commentedFiles = [];

    if (!this.review || !this.workspaceRoot || !this.extensionUri) {
      return { loaded: 0, skipped: 0 };
    }

    // Build commentsByPath lookup map
    for (let i = 0; i < this.review.comments.length; i++) {
      const c = this.review.comments[i];
      const side = c.side || "RIGHT";
      let pathEntry = this.commentsByPath.get(c.path);
      if (!pathEntry) {
        pathEntry = { left: [], right: [] };
        this.commentsByPath.set(c.path, pathEntry);
      }
      const entry = { comment: c, index: i };
      if (side === "LEFT") {
        pathEntry.left.push(entry);
      } else {
        pathEntry.right.push(entry);
      }
    }

    let loaded = 0;
    let skipped = 0;

    for (const [relativePath, sides] of this.commentsByPath) {
      const fileUri = resolveCommentUri(
        this.workspaceRoot,
        this.submoduleMap,
        this.review.pr.repo,
        relativePath
      );

      if (!fileUri) {
        console.warn(
          `[agent-review] Could not resolve path: ${relativePath} (repo: ${this.review.pr.repo})`
        );
        skipped += sides.left.length + sides.right.length;
        continue;
      }

      this.commentedFiles.push({ relativePath, fileUri });

      // Attach threads to GitHub API URIs (matching what openDiffForFile uses)
      if (this.prCommits) {
        const absolutePath = fileUri.fsPath;
        const repo = this.review.pr.repo;

        if (sides.right.length > 0) {
          const headUri = buildGitHubApiUri(relativePath, this.prCommits.headCommit, repo, absolutePath);
          this.createThreadsForEntries(sides.right, headUri);
          loaded += sides.right.length;
        }

        if (sides.left.length > 0) {
          const baseUri = buildGitHubApiUri(relativePath, this.prCommits.baseCommit, repo, absolutePath);
          this.createThreadsForEntries(sides.left, baseUri);
          loaded += sides.left.length;
        }
      } else {
        // No PR commits available — attach to file: URIs as fallback
        if (sides.right.length > 0) {
          this.createThreadsForEntries(sides.right, fileUri);
          loaded += sides.right.length;
        }
        skipped += sides.left.length;
      }
    }

    return { loaded, skipped };
  }

  private createThreadsForEntries(
    entries: { comment: ReviewComment; index: number }[],
    uri: vscode.Uri
  ): void {
    const byLine = new Map<number, { comment: ReviewComment; index: number }[]>();
    for (const entry of entries) {
      const key = entry.comment.line;
      const existing = byLine.get(key);
      if (existing) {
        existing.push(entry);
      } else {
        byLine.set(key, [entry]);
      }
    }

    for (const [line, lineEntries] of byLine) {
      const threadKey = `${uri.toString()}:${line}`;
      if (this.attachedUris.has(threadKey)) {
        continue;
      }
      this.attachedUris.add(threadKey);

      const range = new vscode.Range(Math.max(0, line - 1), 0, Math.max(0, line - 1), 0);
      const vsComments = this.buildVsComments(lineEntries);

      const thread = this.controller.createCommentThread(uri, range, vsComments);
      thread.canReply = false;
      thread.contextValue = "agentReviewThread";

      for (const vc of vsComments) {
        vc.threadRef = thread;
      }

      const author = lineEntries[0].comment.author || this.review?.author;
      if (author?.name) {
        thread.label = author.name;
      }

      thread.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded;

      this.threads.push(thread);
    }
  }

  private buildVsComments(
    entries: { comment: ReviewComment; index: number }[]
  ): AgentReviewComment[] {
    return entries.map((entry) => {
      const c = entry.comment;
      const authorInfo = this.resolveAuthor(c, this.extensionUri!);
      const agentComment: AgentReviewComment = {
        author: authorInfo,
        body: new vscode.MarkdownString(c.body),
        mode: vscode.CommentMode.Preview,
        label: c.severity.toUpperCase(),
        contextValue: "agentReview",
        commentIndex: entry.index,
        reviewFilePath: this.reviewFilePath,
      };
      const ts = c.timestamp
        ? new Date(c.timestamp)
        : this.fallbackTimestamp;
      if (ts) {
        agentComment.timestamp = ts;
      }
      return agentComment;
    });
  }

  private resolveAuthor(
    comment: ReviewComment,
    extensionUri: vscode.Uri
  ): vscode.CommentAuthorInformation {
    const author: ReviewAuthor | undefined =
      comment.author || this.review?.author;

    const name = "";
    const iconPath = author?.iconUrl
      ? vscode.Uri.parse(author.iconUrl)
      : getIconUri(comment.severity, extensionUri);

    return { name, iconPath };
  }
}
