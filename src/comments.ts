import * as vscode from "vscode";

import { ReviewAuthor, ReviewComment, ReviewFile, Severity, saveReviewFile } from "./parser";
import { resolveCommentUri } from "./resolver";
import { getIconUri } from "./icons";
import { buildGitUri } from "./diffProvider";

interface SubmoduleMap {
  [repoSlug: string]: string;
}

/**
 * Extends vscode.Comment with a back-reference to the source ReviewComment index.
 * This lets us find and mutate the correct entry in ReviewFile.comments[].
 */
export interface AgentReviewComment extends vscode.Comment {
  commentIndex: number;
  threadRef?: vscode.CommentThread;
}

export interface CommentedFileInfo {
  relativePath: string;
  fileUri: vscode.Uri;
  baseUri: vscode.Uri;
}

export interface NavigationEntry {
  path: string;
  line: number;
  side: "LEFT" | "RIGHT";
  fileUri: vscode.Uri;
  baseUri: vscode.Uri;
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

  // Lookup map for lazy/reactive attachment (PR extension integration)
  private commentsByPath = new Map<string, {
    left: { comment: ReviewComment; index: number }[];
    right: { comment: ReviewComment; index: number }[];
  }>();

  // Track URIs that already have threads to avoid duplicates
  private attachedUris = new Set<string>();

  // Cached list of files with comments for navigation/diff opening
  private commentedFiles: CommentedFileInfo[] = [];

  constructor() {
    this.controller = vscode.comments.createCommentController(
      "agent-review-comments",
      "Agent Review"
    );
  }

  loadReview(
    review: ReviewFile,
    workspaceRoot: string,
    submoduleMap: SubmoduleMap,
    extensionUri: vscode.Uri,
    fallbackTimestamp?: Date,
    reviewFilePath?: string,
    gitRoot?: string
  ): { loaded: number; skipped: number } {
    this.clearAll();

    this.review = review;
    this.reviewFilePath = reviewFilePath;
    this.workspaceRoot = workspaceRoot;
    this.submoduleMap = submoduleMap;
    this.extensionUri = extensionUri;
    this.fallbackTimestamp = fallbackTimestamp;
    this.gitRoot = gitRoot;

    return this.rebuildThreads();
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
    // Trigger UI refresh by reassigning the comments array
    t.comments = [...t.comments];
  }

  cancelEdit(comment: AgentReviewComment, thread?: vscode.CommentThread): void {
    const t = thread || comment.threadRef;
    if (!t || !this.review) {
      return;
    }
    // Restore body from source
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
   * Check if a relative path has review comments (used by diff-on-click).
   */
  hasCommentsForPath(relativePath: string): boolean {
    return this.commentsByPath.has(relativePath);
  }

  /**
   * Get the relative path for a file URI within the workspace.
   */
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
    // Also strip submodule prefix to get the repo-relative path
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
   */
  async openDiffForFile(relativePath: string): Promise<void> {
    if (!this.review || !this.workspaceRoot || !this.gitRoot) {
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

    const baseUri = buildGitUri(relativePath, this.review.pr.base, this.gitRoot);
    const title = `${relativePath} (PR #${this.review.pr.number})`;

    await vscode.commands.executeCommand("vscode.diff", baseUri, fileUri, title);
  }

  /**
   * Returns the list of files that have review comments, with their URIs.
   */
  getCommentedFiles(): CommentedFileInfo[] {
    return this.commentedFiles;
  }

  /**
   * Returns a flat, sorted list of all comments for navigation.
   */
  getNavigationList(): NavigationEntry[] {
    if (!this.review || !this.workspaceRoot || !this.gitRoot) {
      return [];
    }

    const entries: NavigationEntry[] = [];
    for (const [relativePath, sides] of this.commentsByPath) {
      const fileUri = resolveCommentUri(
        this.workspaceRoot,
        this.submoduleMap,
        this.review.pr.repo,
        relativePath
      );
      if (!fileUri) {
        continue;
      }
      const baseUri = buildGitUri(relativePath, this.review.pr.base, this.gitRoot);

      for (const entry of sides.right) {
        entries.push({
          path: relativePath,
          line: entry.comment.line,
          side: "RIGHT",
          fileUri,
          baseUri,
        });
      }
      for (const entry of sides.left) {
        entries.push({
          path: relativePath,
          line: entry.comment.line,
          side: "LEFT",
          fileUri,
          baseUri,
        });
      }
    }

    // Sort by path, then line
    entries.sort((a, b) => {
      const pathCmp = a.path.localeCompare(b.path);
      if (pathCmp !== 0) {
        return pathCmp;
      }
      return a.line - b.line;
    });

    return entries;
  }

  /**
   * Validates that a PR number and repo match the loaded review.
   */
  matchesPR(prNumber?: number, repoSlug?: string): boolean {
    if (!this.review) {
      return false;
    }
    if (prNumber !== undefined && prNumber !== this.review.pr.number) {
      return false;
    }
    if (repoSlug !== undefined && repoSlug !== this.review.pr.repo) {
      return false;
    }
    return true;
  }

  /**
   * Lazily attach comments to a URI (used for PR extension `review:` scheme).
   * Creates threads on the given URI for comments matching the path and side.
   */
  attachCommentsToUri(
    uri: vscode.Uri,
    relativePath: string,
    side: "LEFT" | "RIGHT"
  ): void {
    if (!this.review || !this.extensionUri) {
      return;
    }

    const pathComments = this.commentsByPath.get(relativePath);
    if (!pathComments) {
      return;
    }

    const entries = side === "LEFT" ? pathComments.left : pathComments.right;
    if (entries.length === 0) {
      return;
    }

    // Group entries by line for thread creation
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

      const severities = lineEntries.map((e) => e.comment.severity);
      const hasHighSeverity = severities.some(
        (s) => s === "blocking" || s === "important"
      );
      thread.collapsibleState = hasHighSeverity
        ? vscode.CommentThreadCollapsibleState.Expanded
        : vscode.CommentThreadCollapsibleState.Collapsed;

      this.threads.push(thread);
    }
  }

  // --- Private helpers ---

  private async persistAndRebuild(): Promise<void> {
    if (this.review && this.reviewFilePath) {
      this.isSaving = true;
      await saveReviewFile(this.reviewFilePath, this.review);
      // Keep flag on briefly so the debounced watcher doesn't reload
      setTimeout(() => {
        this.isSaving = false;
      }, 1000);
    }
    this.rebuildThreads();
  }

  private rebuildThreads(): { loaded: number; skipped: number } {
    // Dispose existing threads
    for (const thread of this.threads) {
      thread.dispose();
    }
    this.threads = [];
    this.commentsByPath.clear();
    this.attachedUris.clear();
    this.commentedFiles = [];

    if (
      !this.review ||
      !this.workspaceRoot ||
      !this.extensionUri
    ) {
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

    // Build commented files list and create threads
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

      // Store for navigation/diff opening
      const baseUri = this.gitRoot
        ? buildGitUri(relativePath, this.review.pr.base, this.gitRoot)
        : fileUri;
      this.commentedFiles.push({ relativePath, fileUri, baseUri });

      // Create threads for RIGHT-side comments on file: URIs
      if (sides.right.length > 0) {
        this.createThreadsForEntries(sides.right, fileUri);
        loaded += sides.right.length;
      }

      // Create threads for LEFT-side comments on agent-review-git: URIs
      if (sides.left.length > 0 && this.gitRoot) {
        const leftUri = buildGitUri(relativePath, this.review.pr.base, this.gitRoot);
        this.createThreadsForEntries(sides.left, leftUri);
        loaded += sides.left.length;
      } else {
        skipped += sides.left.length;
      }
    }

    return { loaded, skipped };
  }

  /**
   * Creates comment threads for a set of entries on a given URI,
   * grouped by line number.
   */
  private createThreadsForEntries(
    entries: { comment: ReviewComment; index: number }[],
    uri: vscode.Uri
  ): void {
    // Group by line
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

      const severities = lineEntries.map((e) => e.comment.severity);
      const hasHighSeverity = severities.some(
        (s) => s === "blocking" || s === "important"
      );
      thread.collapsibleState = hasHighSeverity
        ? vscode.CommentThreadCollapsibleState.Expanded
        : vscode.CommentThreadCollapsibleState.Collapsed;

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

  /**
   * Resolves author info: per-comment author > review-level author > fallback.
   * Uses severity icon as default; overrides with author iconUrl if provided.
   */
  private resolveAuthor(
    comment: ReviewComment,
    extensionUri: vscode.Uri
  ): vscode.CommentAuthorInformation {
    const author: ReviewAuthor | undefined =
      comment.author || this.review?.author;

    // Author name is shown on the thread title, not per-comment
    const name = "";
    const iconPath = author?.iconUrl
      ? vscode.Uri.parse(author.iconUrl)
      : getIconUri(comment.severity, extensionUri);

    return { name, iconPath };
  }
}
