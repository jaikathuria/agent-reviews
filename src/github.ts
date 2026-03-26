import * as vscode from "vscode";
import { exec, spawn } from "child_process";
import { promisify } from "util";

import { ReviewFile, ReviewComment } from "./parser";

const execAsync = promisify(exec);

/**
 * Pipes JSON to `gh api` via stdin using spawn (no shell escaping needed).
 * Returns parsed stdout.
 */
function ghApiStdin(args: string[], jsonPayload: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn("gh", ["api", ...args, "--input", "-"], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (d: Buffer) => { stdout += d.toString(); });
    proc.stderr.on("data", (d: Buffer) => { stderr += d.toString(); });
    proc.on("close", (code: number | null) => {
      if (code !== 0) {
        reject(new Error(stderr || `gh exited with code ${code}`));
      } else {
        resolve(stdout);
      }
    });
    proc.on("error", reject);
    proc.stdin.write(jsonPayload);
    proc.stdin.end();
  });
}

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

  const payload = JSON.stringify({
    commit_id: commitId,
    body,
    event,
    comments,
  });

  await ghApiStdin([`repos/${repo}/pulls/${prNumber}/reviews`], payload);
}

/**
 * Gets the GraphQL node ID for a pull request.
 */
export async function getPRNodeId(
  repo: string,
  prNumber: number
): Promise<string> {
  const [owner, name] = repo.split("/");
  const payload = JSON.stringify({
    query: `query($owner: String!, $name: String!, $pr: Int!) {
      repository(owner: $owner, name: $name) { pullRequest(number: $pr) { id } }
    }`,
    variables: { owner, name, pr: prNumber },
  });
  const stdout = await ghApiStdin(["graphql"], payload);
  const data = JSON.parse(stdout);
  return data.data.repository.pullRequest.id;
}

/**
 * Creates a pending review on GitHub with a single comment.
 * Returns the review node ID and the created comment's database ID.
 */
function formatCommentBody(comment: ReviewComment): string {
  return `**[${comment.severity.toUpperCase()}]** ${comment.body}`;
}

export async function createPendingReview(
  prNodeId: string,
  comment: ReviewComment
): Promise<{ reviewId: string; githubCommentId: number }> {
  const body = formatCommentBody(comment);
  const thread = {
    path: comment.path,
    line: comment.line,
    side: comment.side || "RIGHT",
    body,
  };
  const payload = JSON.stringify({
    query: `mutation($input: AddPullRequestReviewInput!) {
      addPullRequestReview(input: $input) {
        pullRequestReview {
          id
          comments(first: 1) {
            nodes { databaseId }
          }
        }
      }
    }`,
    variables: {
      input: {
        pullRequestId: prNodeId,
        threads: [thread],
      },
    },
  });
  const stdout = await ghApiStdin(["graphql"], payload);
  const data = JSON.parse(stdout);
  const review = data.data.addPullRequestReview.pullRequestReview;
  return {
    reviewId: review.id,
    githubCommentId: review.comments.nodes[0].databaseId,
  };
}

/**
 * Adds a comment to an existing pending review on GitHub.
 * Returns the created comment's database ID.
 */
export async function addCommentToPendingReview(
  reviewNodeId: string,
  comment: ReviewComment
): Promise<number> {
  const body = formatCommentBody(comment);
  const payload = JSON.stringify({
    query: `mutation($input: AddPullRequestReviewThreadInput!) {
      addPullRequestReviewThread(input: $input) {
        thread {
          comments(first: 1) {
            nodes { databaseId }
          }
        }
      }
    }`,
    variables: {
      input: {
        pullRequestReviewId: reviewNodeId,
        path: comment.path,
        line: comment.line,
        side: comment.side || "RIGHT",
        body,
      },
    },
  });
  const stdout = await ghApiStdin(["graphql"], payload);
  const data = JSON.parse(stdout);
  return data.data.addPullRequestReviewThread.thread.comments.nodes[0].databaseId;
}

export interface GitHubComment {
  id: number;
  path: string;
  line: number;
  side: string;
  body: string;
  author: string;
  authorAvatarUrl: string;
  createdAt: string;
}

/**
 * Fetches all review comments on a PR from GitHub.
 */
export async function fetchPRReviewComments(
  repo: string,
  prNumber: number
): Promise<GitHubComment[]> {
  const { stdout } = await execAsync(
    `gh api repos/${repo}/pulls/${prNumber}/comments --paginate`,
    { maxBuffer: 10 * 1024 * 1024 }
  );
  const raw = JSON.parse(stdout);
  return (raw as any[]).map((c: any) => ({
    id: c.id,
    path: c.path,
    line: c.line || c.original_line,
    side: c.side || "RIGHT",
    body: c.body,
    author: c.user?.login || "unknown",
    authorAvatarUrl: c.user?.avatar_url || "",
    createdAt: c.created_at,
  }));
}

export type Verdict = "APPROVE" | "REQUEST_CHANGES" | "COMMENT";

/**
 * Creates and immediately submits a review with no inline comments (verdict + body only).
 */
export async function submitVerdictOnly(
  prNodeId: string,
  verdict: Verdict,
  body?: string
): Promise<void> {
  const payload = JSON.stringify({
    query: `mutation($input: AddPullRequestReviewInput!) {
      addPullRequestReview(input: $input) {
        pullRequestReview { id }
      }
    }`,
    variables: {
      input: {
        pullRequestId: prNodeId,
        event: verdict,
        ...(body ? { body } : {}),
      },
    },
  });
  await ghApiStdin(["graphql"], payload);
}

/**
 * Submits a pending review with a verdict.
 */
export async function submitPendingReview(
  reviewNodeId: string,
  verdict: Verdict,
  body?: string
): Promise<void> {
  const payload = JSON.stringify({
    query: `mutation($input: SubmitPullRequestReviewInput!) {
      submitPullRequestReview(input: $input) {
        pullRequestReview { state }
      }
    }`,
    variables: {
      input: {
        pullRequestReviewId: reviewNodeId,
        event: verdict,
        ...(body ? { body } : {}),
      },
    },
  });
  await ghApiStdin(["graphql"], payload);
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
