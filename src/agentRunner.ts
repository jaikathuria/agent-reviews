import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import { exec } from "child_process";
import { promisify } from "util";
import { getRepoSlug } from "./parser";
import { resolveCommand, AgentContext } from "./agentPresets";
import { PROverviewProvider, PROverviewItem } from "./prOverviewProvider";

const execAsync = promisify(exec);

async function fetchPRBranches(
  repo: string,
  prNumber: number
): Promise<{ base: string; head: string }> {
  const { stdout } = await execAsync(
    `gh pr view ${prNumber} --repo ${repo} --json baseRefName,headRefName`
  );
  const data = JSON.parse(stdout);
  return { base: data.baseRefName, head: data.headRefName };
}

/**
 * Ensure the Claude review agent is set up in the workspace. Returns true when
 * the agent file already existed and the run can proceed, false when the agent
 * was just scaffolded (user should review/edit before re-triggering) or the
 * bundled source is missing.
 */
async function ensureAgentFile(
  extensionPath: string,
  workspaceRoot: string
): Promise<boolean> {
  const targetDir = path.join(workspaceRoot, ".claude", "agents");
  const targetPath = path.join(targetDir, "pr-review.md");

  if (fs.existsSync(targetPath)) {
    return true;
  }

  const sourcePath = path.join(extensionPath, "agents", "pr-review.md");
  if (!fs.existsSync(sourcePath)) {
    vscode.window.showErrorMessage(
      "Agent Review: Bundled agent template is missing. Reinstall the extension or create .claude/agents/pr-review.md manually."
    );
    return false;
  }

  await fs.promises.mkdir(targetDir, { recursive: true });
  await fs.promises.copyFile(sourcePath, targetPath);

  const doc = await vscode.workspace.openTextDocument(targetPath);
  await vscode.window.showTextDocument(doc);
  vscode.window.showInformationMessage(
    "Agent Review: Created .claude/agents/pr-review.md. Review/edit it, then trigger the review again."
  );
  return false;
}

export function registerAgentRunnerCommand(
  context: vscode.ExtensionContext,
  prOverviewProvider: PROverviewProvider
): void {
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "agentReview.triggerAgentReview",
      async (item: PROverviewItem) => {
        const repo = item.repoName;
        const prNumber = item.prNumber;
        if (!repo || prNumber === undefined) {
          vscode.window.showWarningMessage("Agent Review: Could not determine PR details from this item.");
          return;
        }

        // Prevent duplicate runs
        if (prOverviewProvider.isAgentRunning(repo, prNumber)) {
          vscode.window.showWarningMessage(
            `Agent Review: An agent is already reviewing ${repo}#${prNumber}.`
          );
          return;
        }

        const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (!workspaceRoot) {
          vscode.window.showWarningMessage("Agent Review: No workspace folder open.");
          return;
        }

        const config = vscode.workspace.getConfiguration("agentReview");
        const preset = config.get<string>("agent", "claude");
        const customCommand = config.get<string>("agentCommand", "");
        const runIn = config.get<string>("agentRunIn", "terminal");

        const reviewsDir = path.join(workspaceRoot, ".reviews");
        const slug = getRepoSlug(repo);
        const outputFilename = `${slug}-pr-${prNumber}-review-comments.json`;

        // Mark as running
        prOverviewProvider.setAgentRunning(repo, prNumber, true);

        try {
          // Ensure .reviews/ exists
          await fs.promises.mkdir(reviewsDir, { recursive: true });

          // Ensure agent file is in .claude/agents/ for Claude preset
          if (preset === "claude") {
            const agentReady = await ensureAgentFile(context.extensionPath, workspaceRoot);
            if (!agentReady) {
              prOverviewProvider.setAgentRunning(repo, prNumber, false);
              return;
            }
          }

          // Fetch branch info
          const pendingPR = prOverviewProvider.getPendingPR(repo, prNumber);
          const title = pendingPR?.title ?? `PR #${prNumber}`;

          let base: string;
          let head: string;
          try {
            const branches = await fetchPRBranches(repo, prNumber);
            base = branches.base;
            head = branches.head;
          } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            vscode.window.showErrorMessage(
              `Agent Review: Failed to fetch PR branches. Is 'gh' CLI installed and authenticated?\n${msg}`
            );
            prOverviewProvider.setAgentRunning(repo, prNumber, false);
            return;
          }

          const agentCtx: AgentContext = {
            repo,
            number: prNumber,
            title,
            base,
            head,
            reviewsDir,
            outputFilename,
          };

          let command: string;
          try {
            command = resolveCommand(preset, customCommand, agentCtx);
          } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            vscode.window.showErrorMessage(`Agent Review: ${msg}`);
            prOverviewProvider.setAgentRunning(repo, prNumber, false);
            return;
          }

          if (runIn === "background") {
            await runInBackground(command, repo, prNumber, reviewsDir, outputFilename, prOverviewProvider);
          } else {
            runInTerminal(command, repo, prNumber, reviewsDir, outputFilename, prOverviewProvider, context);
          }
        } catch (err: unknown) {
          prOverviewProvider.setAgentRunning(repo, prNumber, false);
          const msg = err instanceof Error ? err.message : String(err);
          vscode.window.showErrorMessage(`Agent Review: ${msg}`);
        }
      }
    )
  );
}

function runInTerminal(
  command: string,
  repo: string,
  prNumber: number,
  reviewsDir: string,
  outputFilename: string,
  provider: PROverviewProvider,
  context: vscode.ExtensionContext
): void {
  const terminal = vscode.window.createTerminal({
    name: `Agent Review: ${repo}#${prNumber}`,
    cwd: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath,
  });
  terminal.show();
  terminal.sendText(command);

  // Watch for the output file to appear (clear running state when it does)
  const watcher = fs.watch(reviewsDir, (_event, filename) => {
    if (filename === outputFilename) {
      watcher.close();
      provider.setAgentRunning(repo, prNumber, false);
      vscode.window.showInformationMessage(
        `Agent Review: Review complete for ${repo}#${prNumber}.`
      );
    }
  });

  // Also clear on terminal close (agent may have failed or user closed it)
  const disposable = vscode.window.onDidCloseTerminal((t) => {
    if (t === terminal) {
      watcher.close();
      provider.setAgentRunning(repo, prNumber, false);
      disposable.dispose();
    }
  });
  context.subscriptions.push(disposable);
}

async function runInBackground(
  command: string,
  repo: string,
  prNumber: number,
  reviewsDir: string,
  outputFilename: string,
  provider: PROverviewProvider
): Promise<void> {
  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: `Agent reviewing ${repo}#${prNumber}...`,
      cancellable: true,
    },
    async (_progress, token) => {
      return new Promise<void>((resolve) => {
        const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        const proc = exec(command, { cwd: cwd ?? undefined }, (err) => {
          provider.setAgentRunning(repo, prNumber, false);
          if (err && !token.isCancellationRequested) {
            vscode.window.showErrorMessage(
              `Agent Review: Agent failed for ${repo}#${prNumber}: ${err.message}`
            );
          } else {
            const outputPath = path.join(reviewsDir, outputFilename);
            setTimeout(() => {
              if (!fs.existsSync(outputPath)) {
                vscode.window.showWarningMessage(
                  `Agent Review: Agent finished but no review file was found at ${outputFilename}.`
                );
              } else {
                vscode.window.showInformationMessage(
                  `Agent Review: Review complete for ${repo}#${prNumber}.`
                );
              }
            }, 2000);
          }
          resolve();
        });

        token.onCancellationRequested(() => {
          proc.kill();
          provider.setAgentRunning(repo, prNumber, false);
          resolve();
        });
      });
    }
  );
}
