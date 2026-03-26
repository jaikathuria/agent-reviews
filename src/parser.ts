import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";

export type Severity =
  | "blocking"
  | "important"
  | "suggestion"
  | "nit"
  | "praise"
  | "learning";

export interface ReviewAuthor {
  name: string;
  iconUrl?: string; // URL or relative path to an avatar image
}

export interface ReviewComment {
  id?: string;       // Local UUID, assigned on first parse
  githubId?: number; // GitHub comment database ID, set after posting
  path: string;
  line: number;
  side: "LEFT" | "RIGHT";
  severity: Severity;
  body: string;
  timestamp?: string; // ISO 8601, optional — when the review was generated
  author?: ReviewAuthor; // Per-comment author; falls back to pr.author if absent
  status?: "posting" | "posted"; // undefined = local (not yet posted)
}

export interface ReviewFile {
  pr: {
    repo: string;
    number: number;
    title: string;
    base: string;
    head: string;
  };
  author?: ReviewAuthor; // Default author for all comments (agent identity)
  summary: {
    verdict: string;
    overview: string;
    strengths: string[];
  };
  comments: ReviewComment[];
  pendingReviewId?: string;   // GraphQL node ID of the pending review on GitHub
  prNodeId?: string;          // GraphQL node ID of the PR (cached after first lookup)
}

export async function parseReviewFile(filePath: string): Promise<ReviewFile> {
  const content = await fs.promises.readFile(filePath, "utf-8");
  const data = JSON.parse(content);

  if (!data.pr || !data.comments || !Array.isArray(data.comments)) {
    throw new Error(
      `Invalid review file: missing 'pr' or 'comments' array in ${filePath}`
    );
  }

  // Filter out malformed comments instead of failing the whole load
  data.comments = data.comments.filter((comment: Record<string, unknown>) => {
    if (!comment.path || typeof comment.line !== "number" || !comment.body) {
      console.warn(
        `[agent-review] Skipping malformed comment in ${filePath}:`,
        JSON.stringify(comment).slice(0, 100)
      );
      return false;
    }
    return true;
  });

  // Assign stable UUIDs to comments that don't have one
  let needsSave = false;
  for (const comment of data.comments) {
    if (!comment.id) {
      comment.id = crypto.randomUUID();
      needsSave = true;
    }
  }
  if (needsSave) {
    await fs.promises.writeFile(filePath, JSON.stringify(data, null, 2), "utf-8");
  }

  return data as ReviewFile;
}

export async function saveReviewFile(
  filePath: string,
  review: ReviewFile
): Promise<void> {
  await fs.promises.writeFile(filePath, JSON.stringify(review, null, 2), "utf-8");
}

export function getRepoSlug(repo: string): string {
  const repoName = repo.includes("/") ? repo.split("/").pop()! : repo;
  return repoName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

const REVIEW_FILENAME = /^[a-z0-9]+-(?:[a-z0-9]+-)*pr-\d+-review-comments\.json$/;

export function isReviewFilename(filename: string): boolean {
  return REVIEW_FILENAME.test(filename);
}

export async function findReviewFiles(
  reviewsDir: string
): Promise<string[]> {
  try {
    const entries = await fs.promises.readdir(reviewsDir);
    return entries
      .filter((f) => isReviewFilename(f))
      .map((f) => path.join(reviewsDir, f));
  } catch {
    return [];
  }
}
