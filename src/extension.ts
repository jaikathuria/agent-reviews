import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";

import { parseReviewFile, findReviewFiles, isReviewFilename, Severity } from "./parser";
import { parseGitmodules, resolveGitRoot } from "./resolver";
import { ReviewCommentController, AgentReviewComment, NavigationEntry } from "./comments";
import { registerGitHubCommands } from "./github";
import { registerGenerateInstructionsCommand } from "./generate-instructions";
import { GitContentProvider, SCHEME, parseGitHubApiUri } from "./diffProvider";

const ALL_SEVERITIES: { label: string; value: Severity }[] = [
  { label: "$(error) Blocking", value: "blocking" },
  { label: "$(warning) Important", value: "important" },
  { label: "$(lightbulb) Suggestion", value: "suggestion" },
  { label: "$(info) Nit", value: "nit" },
  { label: "$(thumbsup) Praise", value: "praise" },
  { label: "$(book) Learning", value: "learning" },
];

// Map of review file path → controller instance
let controllers: Map<string, ReviewCommentController> = new Map();
let fileWatcher: fs.FSWatcher | undefined;
let debounceTimer: ReturnType<typeof setTimeout> | undefined;
let statusBarItem: vscode.StatusBarItem | undefined;
let gitContentProvider: GitContentProvider | undefined;

// Navigation state (merged across all controllers)
let navigationList: NavigationEntry[] = [];
let commentNavIndex = -1;

// Flag to prevent diff-on-click loop when we programmatically open a diff
let isOpeningDiff = false;

function getWorkspaceRoot(): string | undefined {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

function getReviewsDir(): string | undefined {
  const root = getWorkspaceRoot();
  if (!root) {
    return undefined;
  }
  return path.join(root, ".reviews");
}

/**
 * Find the controller that owns a given comment (via reviewFilePath stamp).
 */
function findControllerForComment(comment: AgentReviewComment): ReviewCommentController | undefined {
  if (comment.reviewFilePath) {
    return controllers.get(comment.reviewFilePath);
  }
  return undefined;
}

/**
 * Build the controller label for a review.
 */
function buildControllerLabel(review: import("./parser").ReviewFile, isMultiRepo: boolean): string {
  return isMultiRepo
    ? `${review.pr.repo} PR #${review.pr.number}`
    : `PR #${review.pr.number}`;
}

/**
 * Load all review files from the .reviews/ directory.
 * Uses a two-phase approach: parse all files first to determine labels,
 * then create controllers with the correct labels.
 */
async function loadAllReviews(extensionUri: vscode.Uri): Promise<void> {
  const reviewsDir = getReviewsDir();
  const workspaceRoot = getWorkspaceRoot();
  if (!reviewsDir || !workspaceRoot) {
    return;
  }

  const files = await findReviewFiles(reviewsDir);

  // Dispose all existing controllers (labels may change with multi-repo status)
  for (const ctrl of controllers.values()) {
    ctrl.dispose();
  }
  controllers.clear();

  // Clear content provider cache on reload
  gitContentProvider?.clearCache();

  // Phase 1: Parse all reviews to determine multi-repo status
  const parsed: { filePath: string; review: import("./parser").ReviewFile; stat: fs.Stats }[] = [];
  for (const file of files) {
    try {
      const review = await parseReviewFile(file);
      const stat = await fs.promises.stat(file);
      parsed.push({ filePath: file, review, stat });
    } catch (err: unknown) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      vscode.window.showErrorMessage(
        `Agent Review: Failed to load ${file}: ${errorMessage}`
      );
    }
  }

  const repos = new Set(parsed.map((p) => p.review.pr.repo));
  const isMultiRepo = repos.size > 1;

  // Phase 2: Create controllers with correct labels and load threads
  let totalLoaded = 0;
  let totalSkipped = 0;

  for (const { filePath, review, stat } of parsed) {
    const submoduleMap = parseGitmodules(workspaceRoot);
    const gitRoot = resolveGitRoot(workspaceRoot, submoduleMap, review.pr.repo);
    const basename = path.basename(filePath, ".json");
    const controllerId = `agent-review-${basename}`;
    const label = buildControllerLabel(review, isMultiRepo);

    const ctrl = new ReviewCommentController(controllerId, label);
    controllers.set(filePath, ctrl);

    const result = await ctrl.loadReview(
      review,
      workspaceRoot,
      submoduleMap,
      extensionUri,
      stat.mtime,
      filePath,
      gitRoot
    );

    totalLoaded += result.loaded;
    totalSkipped += result.skipped;
  }

  // Rebuild global navigation
  rebuildGlobalNavigation();

  // Update status bar
  updateStatusBar(totalLoaded, totalSkipped);

  if (files.length === 0) {
    statusBarItem?.hide();
  }
}

/**
 * Merge navigation lists from all controllers.
 */
function rebuildGlobalNavigation(): void {
  navigationList = [];
  for (const ctrl of controllers.values()) {
    navigationList.push(...ctrl.getNavigationList());
  }
  navigationList.sort((a, b) => {
    const pathCmp = a.path.localeCompare(b.path);
    return pathCmp !== 0 ? pathCmp : a.line - b.line;
  });
  commentNavIndex = -1;
}

/**
 * Update status bar with summary across all reviews.
 */
function updateStatusBar(totalLoaded: number, totalSkipped: number): void {
  if (!statusBarItem) {
    return;
  }

  const reviewCount = controllers.size;
  if (reviewCount === 0) {
    statusBarItem.hide();
    return;
  }

  if (reviewCount === 1) {
    // Single review — show PR-specific info
    const ctrl = controllers.values().next().value;
    const review = ctrl?.getReview();
    if (review) {
      const verdictLabel =
        review.summary.verdict === "APPROVE"
          ? "Approved"
          : review.summary.verdict === "REQUEST_CHANGES"
            ? "Changes Requested"
            : review.summary.verdict;
      const icon = review.summary.verdict === "APPROVE" ? "$(check)" : "$(comment-discussion)";
      statusBarItem.text = `${icon} PR #${review.pr.number}: ${verdictLabel} (${totalLoaded})`;
      statusBarItem.tooltip = `${review.pr.title}\nClick to reload`;
    }
  } else {
    // Multiple reviews — show summary
    statusBarItem.text = `$(comment-discussion) ${reviewCount} reviews: ${totalLoaded} comments`;
    statusBarItem.tooltip = "Click to reload all reviews";
    if (totalSkipped > 0) {
      statusBarItem.tooltip += ` (${totalSkipped} skipped)`;
    }
  }
  statusBarItem.show();
}

function watchReviewsDir(
  reviewsDir: string,
  extensionUri: vscode.Uri
): void {
  if (fileWatcher) {
    fileWatcher.close();
  }

  try {
    fileWatcher = fs.watch(reviewsDir, (_event: string, filename: string | null) => {
      if (!filename || !isReviewFilename(filename)) {
        return;
      }

      if (debounceTimer) {
        clearTimeout(debounceTimer);
      }
      debounceTimer = setTimeout(async () => {
        const changedFile = path.join(reviewsDir, filename!);

        // Check if the change was triggered by one of our own saves
        const ctrl = controllers.get(changedFile);
        if (ctrl?.isSaving) {
          return;
        }

        // Reload all reviews (labels may change with added/removed files)
        await loadAllReviews(extensionUri);
      }, 500);
    });
  } catch {
    // .reviews/ dir might not exist yet
  }
}

export function activate(context: vscode.ExtensionContext): void {
  // Register git content provider for diff base content
  gitContentProvider = new GitContentProvider();
  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider(SCHEME, gitContentProvider)
  );

  // Status bar item — clicking reloads comments
  statusBarItem = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Left,
    100
  );
  statusBarItem.command = "agentReview.reload";
  context.subscriptions.push(statusBarItem);

  // --- Diff-on-click: when clicking a comment opens a file, redirect to diff view ---
  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor(async (editor: vscode.TextEditor | undefined) => {
      if (!editor || controllers.size === 0 || isOpeningDiff) {
        return;
      }
      const uri = editor.document.uri;

      let relativePath: string | undefined;
      let matchedCtrl: ReviewCommentController | undefined;

      if (uri.scheme === "file") {
        for (const ctrl of controllers.values()) {
          relativePath = ctrl.getRelativePath(uri);
          if (relativePath && ctrl.hasCommentsForPath(relativePath)) {
            matchedCtrl = ctrl;
            break;
          }
          relativePath = undefined;
        }
      } else if (uri.scheme === SCHEME) {
        const parsed = parseGitHubApiUri(uri);
        if (parsed) {
          relativePath = parsed.path;
          for (const ctrl of controllers.values()) {
            if (ctrl.matchesRepo(parsed.repo) && ctrl.hasCommentsForPath(parsed.path)) {
              matchedCtrl = ctrl;
              break;
            }
          }
        }
      }

      if (matchedCtrl && relativePath) {
        isOpeningDiff = true;
        try {
          let line = editor.selection.active.line + 1;
          // If cursor is at top (line 0), the editor hasn't scrolled to the comment yet.
          // Fall back to the first comment line for this file.
          if (line <= 1) {
            line = matchedCtrl.getFirstCommentLine(relativePath) || 1;
          }
          await matchedCtrl.openDiffForFile(relativePath, line);
        } finally {
          setTimeout(() => {
            isOpeningDiff = false;
          }, 1000);
        }
      }
    })
  );

  // --- GitHub integration ---
  registerGitHubCommands(context, () => {
    const allReviews: Map<string, { review: import("./parser").ReviewFile; filePath: string }> = new Map();
    for (const [filePath, ctrl] of controllers) {
      const review = ctrl.getReview();
      if (review) {
        allReviews.set(filePath, { review, filePath });
      }
    }
    return allReviews;
  });

  // --- Agent instructions ---
  registerGenerateInstructionsCommand(context);

  // --- Commands ---

  context.subscriptions.push(
    vscode.commands.registerCommand("agentReview.reload", () => {
      loadAllReviews(context.extensionUri);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("agentReview.switchReview", async () => {
      // With all reviews loaded, this now lets you jump to a specific PR's files
      if (controllers.size === 0) {
        vscode.window.showWarningMessage("Agent Review: No review files loaded");
        return;
      }
      const items: { label: string; description: string; filePath: string }[] = [];
      for (const [filePath, ctrl] of controllers) {
        const review = ctrl.getReview();
        if (review) {
          items.push({
            label: `PR #${review.pr.number}: ${review.pr.title}`,
            description: review.pr.repo,
            filePath,
          });
        }
      }
      const selected = await vscode.window.showQuickPick(items, {
        placeHolder: "Select a PR review to focus",
      });
      if (selected) {
        const ctrl = controllers.get(selected.filePath);
        if (ctrl) {
          const files = ctrl.getCommentedFiles();
          if (files.length > 0) {
            await ctrl.openDiffForFile(files[0].relativePath);
          }
        }
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("agentReview.clear", () => {
      for (const ctrl of controllers.values()) {
        ctrl.dispose();
      }
      controllers.clear();
      navigationList = [];
      commentNavIndex = -1;
      statusBarItem?.hide();
      vscode.window.showInformationMessage(
        "Agent Review: All comments cleared"
      );
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("agentReview.loadFile", async () => {
      const uris = await vscode.window.showOpenDialog({
        filters: { "Review JSON": ["json"] },
        canSelectMany: false,
        title: "Select review comments JSON file",
      });
      if (uris?.[0]) {
        // Copy the file to .reviews/ if it's not already there, then reload all
        const reviewsDir = getReviewsDir();
        const srcPath = uris[0].fsPath;
        if (reviewsDir && !srcPath.startsWith(reviewsDir)) {
          const destPath = path.join(reviewsDir, path.basename(srcPath));
          await fs.promises.mkdir(reviewsDir, { recursive: true });
          await fs.promises.copyFile(srcPath, destPath);
        }
        await loadAllReviews(context.extensionUri);
      }
    })
  );

  // --- Interactive comment commands ---

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "agentReview.deleteComment",
      async (comment: AgentReviewComment) => {
        const ctrl = findControllerForComment(comment);
        if (!ctrl) {
          return;
        }
        await ctrl.deleteComment(comment);
        rebuildGlobalNavigation();
      }
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "agentReview.editComment",
      (comment: AgentReviewComment, thread?: vscode.CommentThread) => {
        const ctrl = findControllerForComment(comment);
        if (!ctrl) {
          return;
        }
        ctrl.setCommentEditing(comment, thread);
      }
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "agentReview.saveComment",
      async (comment: AgentReviewComment) => {
        const ctrl = findControllerForComment(comment);
        if (!ctrl) {
          return;
        }
        const newBody =
          typeof comment.body === "string"
            ? comment.body
            : comment.body.value;
        await ctrl.updateCommentBody(comment, newBody);
      }
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "agentReview.cancelEdit",
      (comment: AgentReviewComment, thread?: vscode.CommentThread) => {
        const ctrl = findControllerForComment(comment);
        if (!ctrl) {
          return;
        }
        ctrl.cancelEdit(comment, thread);
      }
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "agentReview.changeSeverity",
      async (comment: AgentReviewComment) => {
        const ctrl = findControllerForComment(comment);
        if (!ctrl) {
          return;
        }
        const picked = await vscode.window.showQuickPick(
          ALL_SEVERITIES.map((s) => ({
            label: s.label,
            description: s.value === (comment.label || "").toLowerCase() ? "(current)" : "",
            value: s.value,
          })),
          { placeHolder: "Select new severity" }
        );
        if (picked) {
          await ctrl.updateCommentSeverity(
            comment,
            (picked as { label: string; description: string; value: Severity }).value
          );
        }
      }
    )
  );

  // --- Diff & Navigation commands ---

  context.subscriptions.push(
    vscode.commands.registerCommand("agentReview.openFileDiff", async () => {
      // Merge commented files from all controllers
      const allFiles: { label: string; description: string; relativePath: string; ctrl: ReviewCommentController }[] = [];
      for (const ctrl of controllers.values()) {
        const review = ctrl.getReview();
        const prefix = review ? `PR #${review.pr.number}` : "";
        for (const f of ctrl.getCommentedFiles()) {
          allFiles.push({
            label: f.relativePath,
            description: prefix,
            relativePath: f.relativePath,
            ctrl,
          });
        }
      }
      if (allFiles.length === 0) {
        vscode.window.showWarningMessage("Agent Review: No commented files found");
        return;
      }
      const selected = await vscode.window.showQuickPick(allFiles, {
        placeHolder: "Select file to open diff",
      });
      if (selected) {
        isOpeningDiff = true;
        try {
          await selected.ctrl.openDiffForFile(selected.relativePath);
        } finally {
          setTimeout(() => {
            isOpeningDiff = false;
          }, 1000);
        }
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("agentReview.nextComment", async () => {
      if (navigationList.length === 0) {
        vscode.window.showWarningMessage("Agent Review: No comments to navigate");
        return;
      }
      commentNavIndex = (commentNavIndex + 1) % navigationList.length;
      await navigateToComment(navigationList[commentNavIndex]);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("agentReview.previousComment", async () => {
      if (navigationList.length === 0) {
        vscode.window.showWarningMessage("Agent Review: No comments to navigate");
        return;
      }
      commentNavIndex = commentNavIndex <= 0
        ? navigationList.length - 1
        : commentNavIndex - 1;
      await navigateToComment(navigationList[commentNavIndex]);
    })
  );

  // --- Auto-discover and load all review files ---

  const reviewsDir = getReviewsDir();
  if (reviewsDir) {
    watchReviewsDir(reviewsDir, context.extensionUri);
    loadAllReviews(context.extensionUri);
  }

  // Cleanup
  context.subscriptions.push({
    dispose: () => {
      fileWatcher?.close();
      if (debounceTimer) {
        clearTimeout(debounceTimer);
      }
      for (const ctrl of controllers.values()) {
        ctrl.dispose();
      }
      controllers.clear();
    },
  });
}

/**
 * Navigate to a specific comment: open the diff and reveal the line.
 */
async function navigateToComment(entry: NavigationEntry): Promise<void> {
  // Find the controller for this navigation entry
  let ctrl: ReviewCommentController | undefined;
  if (entry.reviewFilePath) {
    ctrl = controllers.get(entry.reviewFilePath);
  }
  if (!ctrl) {
    // Fallback: find any controller that has comments for this path
    for (const c of controllers.values()) {
      if (c.hasCommentsForPath(entry.path)) {
        ctrl = c;
        break;
      }
    }
  }
  if (!ctrl) {
    return;
  }

  isOpeningDiff = true;
  try {
    await ctrl.openDiffForFile(entry.path, entry.line);
  } finally {
    setTimeout(() => {
      isOpeningDiff = false;
    }, 1000);
  }
}

export function deactivate(): void {}
