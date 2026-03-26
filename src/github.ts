import * as vscode from "vscode";
import { exec } from "child_process";
import { promisify } from "util";

import { ReviewFile } from "./parser";

const execAsync = promisify(exec);

interface GitHubReviewComment {
  path: string;
  line: number;
  side: string;
  body: string;
}

/**
 * Maps our verdict string to the GitHub review event type.
 */
function mapVerdict(verdict: string): string {
  switch (verdict.toUpperCase()) {
    case "APPROVE":
      return "APPROVE";
    case "REQUEST_CHANGES":
      return "REQUEST_CHANGES";
    default:
      return "COMMENT";
  }
}

/**
 * Gets the latest commit SHA on the PR's head branch using gh CLI.
 */
async function getHeadCommit(
  repo: string,
  prNumber: number
): Promise<string> {
  const { stdout } = await execAsync(
    `gh pr view ${prNumber} --repo ${repo} --json headRefOid -q .headRefOid`
  );
  return stdout.trim();
}

/**
 * Posts a review with all comments to the GitHub PR using gh CLI.
 */
export async function postReviewToGitHub(
  review: ReviewFile
): Promise<void> {
  const repo = review.pr.repo;
  const prNumber = review.pr.number;

  // Get the head commit SHA
  const commitId = await getHeadCommit(repo, prNumber);

  // Build the review body from summary
  const body = [
    `## Summary`,
    ``,
    review.summary.overview,
    ``,
    `### Strengths`,
    ...review.summary.strengths.map((s) => `- ${s}`),
  ].join("\n");

  // Build comments array for the review
  const comments: GitHubReviewComment[] = review.comments.map((c) => ({
    path: c.path,
    line: c.line,
    side: c.side || "RIGHT",
    body: c.body,
  }));

  const event = mapVerdict(review.summary.verdict);

  // Build the payload
  const payload = JSON.stringify({
    commit_id: commitId,
    body,
    event,
    comments,
  });

  // Write payload to a temp approach using echo pipe
  const escapedPayload = payload.replace(/'/g, "'\\''");
  await execAsync(
    `echo '${escapedPayload}' | gh api repos/${repo}/pulls/${prNumber}/reviews --input -`
  );
}

/**
 * Registers the postToGitHub command.
 * Accepts a function that returns all loaded reviews for selection.
 */
export function registerGitHubCommands(
  context: vscode.ExtensionContext,
  getReviews: () => Map<string, { review: ReviewFile; filePath: string }>
): void {
  context.subscriptions.push(
    vscode.commands.registerCommand("agentReview.postToGitHub", async () => {
      const allReviews = getReviews();
      if (allReviews.size === 0) {
        vscode.window.showWarningMessage(
          "Agent Review: No review files loaded."
        );
        return;
      }

      // Pick which review to post
      let review: ReviewFile;
      if (allReviews.size === 1) {
        review = allReviews.values().next().value!.review;
      } else {
        const items = Array.from(allReviews.values()).map((entry) => ({
          label: `PR #${entry.review.pr.number}: ${entry.review.pr.title}`,
          description: `${entry.review.pr.repo} (${entry.review.comments.length} comments)`,
          review: entry.review,
        }));
        const selected = await vscode.window.showQuickPick(items, {
          placeHolder: "Select which review to post to GitHub",
        });
        if (!selected) {
          return;
        }
        review = selected.review;
      }

      const confirm = await vscode.window.showWarningMessage(
        `Post ${review.comments.length} comments to PR #${review.pr.number} on ${review.pr.repo}?`,
        { modal: true },
        "Post Review"
      );

      if (confirm !== "Post Review") {
        return;
      }

      try {
        await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title: "Posting review to GitHub...",
            cancellable: false,
          },
          async () => {
            await postReviewToGitHub(review);
          }
        );
        vscode.window.showInformationMessage(
          `Agent Review: Posted ${review.comments.length} comments to PR #${review.pr.number}`
        );
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        vscode.window.showErrorMessage(
          `Agent Review: Failed to post to GitHub: ${msg}`
        );
      }
    })
  );
}
