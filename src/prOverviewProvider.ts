import * as vscode from "vscode";
import { exec } from "child_process";
import { promisify } from "util";
import { ReviewCommentController } from "./comments";
import { Severity, ReviewComment } from "./parser";

const execAsync = promisify(exec);

type OverviewNodeType = "section" | "separator" | "repo-reviewed" | "repo-pending" | "pr-reviewed" | "pr-pending" | "error";

interface PendingPR {
  number: number;
  title: string;
  author: string;
  repo: string;
  createdAt: string;
}

export class PROverviewItem extends vscode.TreeItem {
  prUrl?: string;

  constructor(
    label: string,
    collapsibleState: vscode.TreeItemCollapsibleState,
    public readonly nodeType: OverviewNodeType,
    public readonly repoName?: string,
    public readonly reviewFilePath?: string,
    public readonly prNumber?: number,
  ) {
    super(label, collapsibleState);
  }
}

const SEVERITY_ORDER: Severity[] = [
  "blocking", "important", "suggestion", "nit", "praise", "learning",
];

function buildSeveritySummary(comments: ReviewComment[]): string {
  const counts: Partial<Record<Severity, number>> = {};
  for (const c of comments) {
    counts[c.severity] = (counts[c.severity] ?? 0) + 1;
  }
  return SEVERITY_ORDER
    .filter((s) => (counts[s] ?? 0) > 0)
    .map((s) => `${counts[s]} ${s}`)
    .join(" · ");
}

function relativeAge(createdAt: string): string {
  const diffMs = Date.now() - new Date(createdAt).getTime();
  const diffMins = Math.floor(diffMs / 60000);
  if (diffMins < 60) {
    return `${diffMins}m ago`;
  }
  const diffHours = Math.floor(diffMins / 60);
  if (diffHours < 24) {
    return `${diffHours}h ago`;
  }
  const diffDays = Math.floor(diffHours / 24);
  return `${diffDays}d ago`;
}

export class PROverviewProvider implements vscode.TreeDataProvider<PROverviewItem> {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<PROverviewItem | undefined | void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private controllers: Map<string, ReviewCommentController> = new Map();
  private pendingPRs: PendingPR[] = [];
  private pendingError: string | undefined;
  private pendingFetched = false;
  private workspaceRepos: Set<string> = new Set();

  setWorkspaceRepos(repos: Set<string>): void {
    this.workspaceRepos = repos;
  }

  updateReviews(controllers: Map<string, ReviewCommentController>): void {
    this.controllers = controllers;
    this._onDidChangeTreeData.fire();
  }

  async refresh(): Promise<void> {
    await this.fetchPendingPRs();
  }

  async fetchPendingPRsIfNeeded(): Promise<void> {
    if (!this.pendingFetched) {
      await this.fetchPendingPRs();
    }
  }

  private async fetchPendingPRs(): Promise<void> {
    this.pendingError = undefined;
    try {
      const { stdout } = await execAsync(
        "gh search prs --review-requested=@me --state=open --json number,title,author,repository,createdAt --limit 50"
      );
      const raw = JSON.parse(stdout) as Array<{
        number: number;
        title: string;
        author: { login: string };
        repository: { nameWithOwner: string };
        createdAt: string;
      }>;
      const filtered = this.workspaceRepos.size > 0
        ? raw.filter((item) => this.workspaceRepos.has(item.repository.nameWithOwner))
        : raw;
      this.pendingPRs = filtered.map((item) => ({
        number: item.number,
        title: item.title,
        author: item.author.login,
        repo: item.repository.nameWithOwner,
        createdAt: item.createdAt,
      }));
      this.pendingFetched = true;
    } catch (err: unknown) {
      this.pendingError = err instanceof Error ? err.message : String(err);
      this.pendingPRs = [];
    }
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element: PROverviewItem): vscode.TreeItem {
    return element;
  }

  getChildren(element?: PROverviewItem): PROverviewItem[] {
    if (!element) {
      return this.getRootItems();
    }
    if (element.nodeType === "section") {
      if (element.label === "Reviewed") {
        return this.getReviewedRepoItems();
      }
      return this.getPendingRepoItems();
    }
    if (element.nodeType === "repo-reviewed" && element.repoName) {
      return this.getReviewedPRItems(element.repoName);
    }
    if (element.nodeType === "repo-pending" && element.repoName) {
      return this.getPendingPRItems(element.repoName);
    }
    return [];
  }

  private getRootItems(): PROverviewItem[] {
    const reviewed = new PROverviewItem(
      "Reviewed",
      vscode.TreeItemCollapsibleState.Expanded,
      "section"
    );
    reviewed.iconPath = new vscode.ThemeIcon("check-all");

    const separator = new PROverviewItem(
      " ",
      vscode.TreeItemCollapsibleState.None,
      "separator"
    );

    const pending = new PROverviewItem(
      "Pending Review",
      vscode.TreeItemCollapsibleState.Expanded,
      "section"
    );
    pending.iconPath = new vscode.ThemeIcon("git-pull-request");

    return [reviewed, separator, pending];
  }

  private getReviewedRepoItems(): PROverviewItem[] {
    const byRepo = new Map<string, number>();
    for (const ctrl of this.controllers.values()) {
      const review = ctrl.getReview();
      if (!review) {
        continue;
      }
      byRepo.set(review.pr.repo, (byRepo.get(review.pr.repo) ?? 0) + 1);
    }

    if (byRepo.size === 0) {
      const empty = new PROverviewItem(
        "No reviews loaded",
        vscode.TreeItemCollapsibleState.None,
        "section"
      );
      empty.description = "Place a review JSON in .reviews/ to get started";
      return [empty];
    }

    return Array.from(byRepo.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([repo, count]) => {
        const item = new PROverviewItem(
          repo,
          vscode.TreeItemCollapsibleState.Expanded,
          "repo-reviewed",
          repo
        );
        item.description = `${count} PR${count !== 1 ? "s" : ""}`;
        item.iconPath = new vscode.ThemeIcon("repo");
        return item;
      });
  }

  private getReviewedPRItems(repoName: string): PROverviewItem[] {
    const items: { item: PROverviewItem; prNumber: number }[] = [];

    for (const [filePath, ctrl] of this.controllers) {
      const review = ctrl.getReview();
      if (!review || review.pr.repo !== repoName) {
        continue;
      }

      const treeItem = new PROverviewItem(
        `#${review.pr.number} — ${review.pr.title}`,
        vscode.TreeItemCollapsibleState.None,
        "pr-reviewed",
        repoName,
        filePath
      );

      const verdict = review.summary.verdict;
      if (verdict === "APPROVE") {
        treeItem.iconPath = new vscode.ThemeIcon("check", new vscode.ThemeColor("charts.green"));
      } else if (verdict === "REQUEST_CHANGES") {
        treeItem.iconPath = new vscode.ThemeIcon("request-changes", new vscode.ThemeColor("charts.red"));
      } else {
        treeItem.iconPath = new vscode.ThemeIcon("comment");
      }

      const author = review.author?.name ?? "";
      const severitySummary = buildSeveritySummary(review.comments);
      treeItem.description = [author, severitySummary].filter(Boolean).join(" · ");
      treeItem.tooltip = review.summary.overview;
      treeItem.contextValue = "reviewedPR";
      treeItem.prUrl = `https://github.com/${review.pr.repo}/pull/${review.pr.number}`;

      items.push({ item: treeItem, prNumber: review.pr.number });
    }

    items.sort((a, b) => a.prNumber - b.prNumber);
    return items.map((i) => i.item);
  }

  private getPendingRepoItems(): PROverviewItem[] {
    if (this.pendingError) {
      const errItem = new PROverviewItem(
        "Failed to load — click to retry",
        vscode.TreeItemCollapsibleState.None,
        "error"
      );
      errItem.iconPath = new vscode.ThemeIcon("warning");
      errItem.tooltip = this.pendingError;
      errItem.command = { command: "agentReview.refreshPROverview", title: "Retry" };
      return [errItem];
    }

    if (!this.pendingFetched) {
      const loading = new PROverviewItem(
        "Loading...",
        vscode.TreeItemCollapsibleState.None,
        "section"
      );
      loading.iconPath = new vscode.ThemeIcon("loading~spin");
      return [loading];
    }

    if (this.pendingPRs.length === 0) {
      const empty = new PROverviewItem(
        "No pending review requests",
        vscode.TreeItemCollapsibleState.None,
        "section"
      );
      empty.iconPath = new vscode.ThemeIcon("check");
      return [empty];
    }

    const byRepo = new Map<string, number>();
    for (const pr of this.pendingPRs) {
      byRepo.set(pr.repo, (byRepo.get(pr.repo) ?? 0) + 1);
    }

    return Array.from(byRepo.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([repo, count]) => {
        const item = new PROverviewItem(
          repo,
          vscode.TreeItemCollapsibleState.Expanded,
          "repo-pending",
          repo
        );
        item.description = `${count} PR${count !== 1 ? "s" : ""}`;
        item.iconPath = new vscode.ThemeIcon("repo");
        return item;
      });
  }

  private getPendingPRItems(repoName: string): PROverviewItem[] {
    return this.pendingPRs
      .filter((pr) => pr.repo === repoName)
      .sort((a, b) => a.number - b.number)
      .map((pr) => {
        const item = new PROverviewItem(
          `#${pr.number} — ${pr.title}`,
          vscode.TreeItemCollapsibleState.None,
          "pr-pending",
          repoName,
          undefined,
          pr.number
        );
        item.iconPath = new vscode.ThemeIcon("git-pull-request");
        item.description = `${pr.author} · ${relativeAge(pr.createdAt)}`;
        item.tooltip = `${pr.title}\nby ${pr.author} · opened ${relativeAge(pr.createdAt)}`;
        item.contextValue = "pendingPR";
        item.prUrl = `https://github.com/${pr.repo}/pull/${pr.number}`;
        return item;
      });
  }
}
