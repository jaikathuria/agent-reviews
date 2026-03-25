import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";

import { parseReviewFile, findReviewFiles, Severity } from "./parser";
import { parseGitmodules } from "./resolver";
import { ReviewCommentController, AgentReviewComment } from "./comments";
import { registerGitHubCommands } from "./github";

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

    const stat = await fs.promises.stat(filePath);
    const fallbackTimestamp = stat.mtime;

    const { loaded, skipped } = controller.loadReview(
      review,
      workspaceRoot,
      submoduleMap,
      extensionUri,
      fallbackTimestamp,
      filePath
    );

    currentFilePath = filePath;

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
  } catch (err: unknown) {
    const errorMessage =
      err instanceof Error ? err.message : String(err);
    vscode.window.showErrorMessage(
      `Agent Review: Failed to load ${filePath}: ${errorMessage}`
    );
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
      if (
        !filename ||
        !filename.startsWith("pr-") ||
        !filename.endsWith("-review-comments.json")
      ) {
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

  // --- GitHub integration ---
  registerGitHubCommands(context, () => controller?.getReview());

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
    vscode.commands.registerCommand("agentReview.clear", () => {
      controller?.clearAll();
      currentFilePath = undefined;
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
          .then((selected) => {
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

export function deactivate(): void {}
