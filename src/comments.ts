import * as vscode from "vscode";

import { ReviewAuthor, ReviewComment, ReviewFile, Severity, saveReviewFile } from "./parser";
import { resolveCommentUri } from "./resolver";
import { getIconUri } from "./icons";

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
    reviewFilePath?: string
  ): { loaded: number; skipped: number } {
    this.clearAll();

    this.review = review;
    this.reviewFilePath = reviewFilePath;
    this.workspaceRoot = workspaceRoot;
    this.submoduleMap = submoduleMap;
    this.extensionUri = extensionUri;
    this.fallbackTimestamp = fallbackTimestamp;

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

  clearAll(): void {
    for (const thread of this.threads) {
      thread.dispose();
    }
    this.threads = [];
  }

  dispose(): void {
    this.clearAll();
    this.controller.dispose();
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

    if (
      !this.review ||
      !this.workspaceRoot ||
      !this.extensionUri
    ) {
      return { loaded: 0, skipped: 0 };
    }

    // Group comments by path:line, preserving original index
    const grouped = new Map<
      string,
      { comment: ReviewComment; index: number }[]
    >();
    for (let i = 0; i < this.review.comments.length; i++) {
      const c = this.review.comments[i];
      const key = `${c.path}:${c.line}`;
      const existing = grouped.get(key);
      if (existing) {
        existing.push({ comment: c, index: i });
      } else {
        grouped.set(key, [{ comment: c, index: i }]);
      }
    }

    let loaded = 0;
    let skipped = 0;

    for (const [, entries] of grouped) {
      const first = entries[0].comment;
      const uri = resolveCommentUri(
        this.workspaceRoot,
        this.submoduleMap,
        this.review.pr.repo,
        first.path
      );

      if (!uri) {
        console.warn(
          `[agent-review] Could not resolve path: ${first.path} (repo: ${this.review.pr.repo})`
        );
        skipped += entries.length;
        continue;
      }

      const line = Math.max(0, first.line - 1);
      const range = new vscode.Range(line, 0, line, 0);

      const vsComments: AgentReviewComment[] = entries.map((entry) => {
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

      const thread = this.controller.createCommentThread(
        uri,
        range,
        vsComments
      );
      thread.canReply = false;
      thread.contextValue = "agentReviewThread";

      // Store thread reference on each comment for use in commands
      for (const vc of vsComments) {
        vc.threadRef = thread;
      }

      // Show author name as thread title
      const author = entries[0].comment.author || this.review?.author;
      if (author?.name) {
        thread.label = author.name;
      }

      const severities = entries.map((e) => e.comment.severity);

      const hasHighSeverity = severities.some(
        (s) => s === "blocking" || s === "important"
      );
      thread.collapsibleState = hasHighSeverity
        ? vscode.CommentThreadCollapsibleState.Expanded
        : vscode.CommentThreadCollapsibleState.Collapsed;

      this.threads.push(thread);
      loaded += entries.length;
    }

    return { loaded, skipped };
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

  private highestSeverity(severities: Severity[]): Severity {
    const priority: Severity[] = [
      "blocking",
      "important",
      "suggestion",
      "nit",
      "praise",
      "learning",
    ];
    for (const level of priority) {
      if (severities.includes(level)) {
        return level;
      }
    }
    return "nit";
  }
}
