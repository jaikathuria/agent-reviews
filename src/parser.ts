import * as fs from "fs";
import * as path from "path";

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
  path: string;
  line: number;
  side: "LEFT" | "RIGHT";
  severity: Severity;
  body: string;
  timestamp?: string; // ISO 8601, optional — when the review was generated
  author?: ReviewAuthor; // Per-comment author; falls back to pr.author if absent
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
}

export async function parseReviewFile(filePath: string): Promise<ReviewFile> {
  const content = await fs.promises.readFile(filePath, "utf-8");
  const data = JSON.parse(content);

  if (!data.pr || !data.comments || !Array.isArray(data.comments)) {
    throw new Error(
      `Invalid review file: missing 'pr' or 'comments' array in ${filePath}`
    );
  }

  for (const comment of data.comments) {
    if (!comment.path || typeof comment.line !== "number" || !comment.body) {
      throw new Error(
        `Invalid comment in ${filePath}: each comment needs path, line, and body`
      );
    }
  }

  return data as ReviewFile;
}

export async function saveReviewFile(
  filePath: string,
  review: ReviewFile
): Promise<void> {
  await fs.promises.writeFile(filePath, JSON.stringify(review, null, 2), "utf-8");
}

export async function findReviewFiles(
  reviewsDir: string
): Promise<string[]> {
  try {
    const entries = await fs.promises.readdir(reviewsDir);
    return entries
      .filter(
        (f) => f.startsWith("pr-") && f.endsWith("-review-comments.json")
      )
      .map((f) => path.join(reviewsDir, f));
  } catch {
    return [];
  }
}
