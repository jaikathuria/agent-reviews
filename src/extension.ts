import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";

import { parseReviewFile, findReviewFiles, isReviewFilename, Severity } from "./parser";
import { parseGitmodules, resolveGitRoot } from "./resolver";
import { ReviewCommentController, AgentReviewComment, NavigationEntry } from "./comments";
import { registerGitHubCommands } from "./github";
import { registerGenerateInstructionsCommand } from "./generate-instructions";
import { GitContentProvider, SCHEME } from "./diffProvider";

const ALL_SEVERITIES: { label: string; value: Severity }[] = [
  { label: "$(error) Blocking", value: "blocking" },
  { label: "$(warning) Important", value: "important" },
  { label: "$(lightbulb) Suggestion", value: "suggestion" },
  { label: "$(info) Nit", value: "nit" },
  { label: "$(thumbsup) Praise", value: "praise" },
  { label: "$(book) Learning", value: "learning" },
];

let controller: ReviewCommentController | undefined;
let currentFilePath: string | undefined;
let fileWatcher: fs.FSWatcher | undefined;
let debounceTimer: ReturnType<typeof setTimeout> | undefined;
let statusBarItem: vscode.StatusBarItem | undefined;
let gitContentProvider: GitContentProvider | undefined;

// Navigation state
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

async function loadComments(
  filePath: string,
  extensionUri: vscode.Uri
): Promise<void> {
  if (!controller) {
    return;
  }

  const workspaceRoot = getWorkspaceRoot();
  if (!workspaceRoot) {
    vscode.window.showErrorMessage(
      "Agent Review: No workspace folder open"
    );
    return;
  }

  try {
    const review = await parseReviewFile(filePath);
    const submoduleMap = parseGitmodules(workspaceRoot);
    const gitRoot = resolveGitRoot(workspaceRoot, submoduleMap, review.pr.repo);

    const stat = await fs.promises.stat(filePath);
    const fallbackTimestamp = stat.mtime;

    // Clear content provider cache on reload
    gitContentProvider?.clearCache();

    const { loaded, skipped } = controller.loadReview(
      review,
      workspaceRoot,
      submoduleMap,
      extensionUri,
      fallbackTimestamp,
      filePath,
      gitRoot
    );

    currentFilePath = filePath;

    // Rebuild navigation list
    navigationList = controller.getNavigationList();
    commentNavIndex = -1;

    // Scan currently visible editors for review: scheme (PR extension)
    scanVisibleEditorsForReviewScheme();

    const verdictLabel =
      review.summary.verdict === "APPROVE"
        ? "Approved"
        : review.summary.verdict === "REQUEST_CHANGES"
          ? "Changes Requested"
          : review.summary.verdict;

    let message = `PR #${review.pr.number}: ${review.pr.title} — ${verdictLabel} (${loaded} comments)`;
    if (skipped > 0) {
      message += ` [${skipped} skipped — files not found]`;
    }
    vscode.window.showInformationMessage(message);

    // Update status bar
    if (statusBarItem) {
      const icon = review.summary.verdict === "APPROVE" ? "$(check)" : "$(comment-discussion)";
      statusBarItem.text = `${icon} PR #${review.pr.number}: ${verdictLabel} (${loaded})`;
      statusBarItem.tooltip = `${review.pr.title}\nClick to reload`;
      statusBarItem.show();
    }
  } catch (err: unknown) {
    const errorMessage =
      err instanceof Error ? err.message : String(err);
    vscode.window.showErrorMessage(
      `Agent Review: Failed to load ${filePath}: ${errorMessage}`
    );
  }
}

/**
 * Scan currently visible editors for `review:` scheme (GitHub PR extension)
 * and attach comments to matching URIs.
 */
function scanVisibleEditorsForReviewScheme(): void {
  if (!controller) {
    return;
  }
  for (const editor of vscode.window.visibleTextEditors) {
    handleReviewSchemeEditor(editor.document.uri);
  }
}

/**
 * Handle a `review:` scheme URI from the GitHub PR extension.
 * Parses the query to extract path and side, validates the PR, and attaches comments.
 */
function handleReviewSchemeEditor(uri: vscode.Uri): void {
  if (uri.scheme !== "review" || !controller) {
    return;
  }
  try {
    const params = JSON.parse(uri.query);
    const filePath: string | undefined = params.path;
    const isBase: boolean | undefined = params.isBase;

    if (!filePath) {
      return;
    }

    // Validate this matches our loaded PR (if prNumber is available in params)
    if (params.prNumber !== undefined && !controller.matchesPR(params.prNumber)) {
      return;
    }

    const side = isBase ? "LEFT" : "RIGHT";
    controller.attachCommentsToUri(uri, filePath, side);
  } catch {
    // Not a PR extension review URI or invalid JSON — ignore
  }
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
      debounceTimer = setTimeout(() => {
        // Skip reload if the change was triggered by our own save
        if (controller?.isSaving) {
          return;
        }
        const changedFile = path.join(reviewsDir, filename!);
        if (currentFilePath === changedFile || !currentFilePath) {
          loadComments(changedFile, extensionUri);
        }
      }, 500);
    });
  } catch {
    // .reviews/ dir might not exist yet
  }
}

export function activate(context: vscode.ExtensionContext): void {
  controller = new ReviewCommentController();
  context.subscriptions.push({ dispose: () => controller?.dispose() });

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

  // --- Diff-on-click: intercept file opens from comment clicks ---
  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor(async (editor: vscode.TextEditor | undefined) => {
      if (!editor || !controller || isOpeningDiff) {
        return;
      }
      const uri = editor.document.uri;
      if (uri.scheme === "file") {
        const relativePath = controller.getRelativePath(uri);
        if (relativePath && controller.hasCommentsForPath(relativePath)) {
          isOpeningDiff = true;
          try {
            await controller.openDiffForFile(relativePath);
          } finally {
            // Reset after a short delay to allow the diff editor to settle
            setTimeout(() => {
              isOpeningDiff = false;
            }, 500);
          }
        }
      }
    })
  );

  // --- PR extension integration: listen for review: scheme editors ---
  context.subscriptions.push(
    vscode.window.onDidChangeVisibleTextEditors((editors: readonly vscode.TextEditor[]) => {
      if (!controller) {
        return;
      }
      for (const editor of editors) {
        handleReviewSchemeEditor(editor.document.uri);
      }
    })
  );

  // --- GitHub integration ---
  registerGitHubCommands(context, () => controller?.getReview());

  // --- Agent instructions ---
  registerGenerateInstructionsCommand(context);

  // --- Existing commands ---

  context.subscriptions.push(
    vscode.commands.registerCommand("agentReview.reload", () => {
      if (currentFilePath) {
        loadComments(currentFilePath, context.extensionUri);
      } else {
        vscode.window.showWarningMessage(
          "Agent Review: No review file loaded. Use 'Agent Review: Load Review File...' first."
        );
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("agentReview.switchReview", async () => {
      const reviewsDir = getReviewsDir();
      if (!reviewsDir) {
        vscode.window.showWarningMessage("Agent Review: No workspace folder open");
        return;
      }
      const files = await findReviewFiles(reviewsDir);
      if (files.length === 0) {
        vscode.window.showWarningMessage("Agent Review: No review files found in .reviews/");
        return;
      }
      const selected = await vscode.window.showQuickPick(
        files.map((f) => path.basename(f)),
        { placeHolder: "Select review file to load" }
      );
      if (selected) {
        loadComments(path.join(reviewsDir, selected), context.extensionUri);
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("agentReview.clear", () => {
      controller?.clearAll();
      currentFilePath = undefined;
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
        loadComments(uris[0].fsPath, context.extensionUri);
      }
    })
  );

  // --- Interactive comment commands ---

  // Delete comment
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "agentReview.deleteComment",
      async (comment: AgentReviewComment) => {
        if (!controller) {
          return;
        }
        await controller.deleteComment(comment);
        navigationList = controller.getNavigationList();
        commentNavIndex = -1;
      }
    )
  );

  // Edit comment — switch to editing mode
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "agentReview.editComment",
      (comment: AgentReviewComment, thread?: vscode.CommentThread) => {
        if (!controller) {
          return;
        }
        controller.setCommentEditing(comment, thread);
      }
    )
  );

  // Save edited comment
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "agentReview.saveComment",
      async (comment: AgentReviewComment) => {
        if (!controller) {
          return;
        }
        // comment.body is updated by VSCode's editor when user types
        const newBody =
          typeof comment.body === "string"
            ? comment.body
            : comment.body.value;
        await controller.updateCommentBody(comment, newBody);
      }
    )
  );

  // Cancel edit
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "agentReview.cancelEdit",
      (comment: AgentReviewComment, thread?: vscode.CommentThread) => {
        if (!controller) {
          return;
        }
        controller.cancelEdit(comment, thread);
      }
    )
  );

  // Change severity via QuickPick
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "agentReview.changeSeverity",
      async (comment: AgentReviewComment) => {
        if (!controller) {
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
          await controller.updateCommentSeverity(
            comment,
            (picked as { label: string; description: string; value: Severity }).value
          );
        }
      }
    )
  );

  // --- Diff & Navigation commands ---

  // Open file diff
  context.subscriptions.push(
    vscode.commands.registerCommand("agentReview.openFileDiff", async () => {
      if (!controller) {
        return;
      }
      const files = controller.getCommentedFiles();
      if (files.length === 0) {
        vscode.window.showWarningMessage("Agent Review: No commented files found");
        return;
      }
      const items = files.map((f) => ({
        label: f.relativePath,
        file: f,
      }));
      const selected = await vscode.window.showQuickPick(items, {
        placeHolder: "Select file to open diff",
      });
      if (selected) {
        isOpeningDiff = true;
        try {
          await controller.openDiffForFile(selected.file.relativePath);
        } finally {
          setTimeout(() => {
            isOpeningDiff = false;
          }, 500);
        }
      }
    })
  );

  // Next comment
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

  // Previous comment
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

  // --- Auto-discover review files ---

  const reviewsDir = getReviewsDir();
  if (reviewsDir) {
    watchReviewsDir(reviewsDir, context.extensionUri);

    findReviewFiles(reviewsDir).then((files) => {
      if (files.length === 1) {
        loadComments(files[0], context.extensionUri);
      } else if (files.length > 1) {
        vscode.window
          .showQuickPick(
            files.map((f) => path.basename(f)),
            { placeHolder: "Multiple review files found — select one to load" }
          )
          .then((selected: string | undefined) => {
            if (selected) {
              const fullPath = path.join(reviewsDir, selected);
              loadComments(fullPath, context.extensionUri);
            }
          });
      }
    });
  }

  // Cleanup
  context.subscriptions.push({
    dispose: () => {
      fileWatcher?.close();
      if (debounceTimer) {
        clearTimeout(debounceTimer);
      }
    },
  });
}

/**
 * Navigate to a specific comment: open the diff and reveal the line.
 */
async function navigateToComment(entry: NavigationEntry): Promise<void> {
  if (!controller) {
    return;
  }

  isOpeningDiff = true;
  try {
    await controller.openDiffForFile(entry.path);

    // Reveal the line in the active editor
    const editor = vscode.window.activeTextEditor;
    if (editor) {
      const line = Math.max(0, entry.line - 1);
      const range = new vscode.Range(line, 0, line, 0);
      editor.revealRange(range, vscode.TextEditorRevealType.InCenter);
      editor.selection = new vscode.Selection(range.start, range.start);
    }
  } finally {
    setTimeout(() => {
      isOpeningDiff = false;
    }, 500);
  }
}

export function deactivate(): void {}
