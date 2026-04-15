# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

A VSCode extension that displays AI-generated code review comments inline using the VSCode Comments API. Reviews are JSON files in `.reviews/` that map comments to specific file:line locations with severity levels.

## Build Commands

```bash
npm run compile      # Build TypeScript → out/
npm run watch        # Incremental compilation
npm run package      # Compile + create .vsix for distribution
```

Press F5 in VSCode to launch the Extension Development Host for manual testing. There are no automated tests or linter configured.

## Architecture

```
extension.ts → Entry point. Registers all commands, sets up file watcher on .reviews/,
               manages status bar, orchestrates loading flow.

parser.ts    → Defines core types (ReviewFile, ReviewComment, Severity) and handles
               JSON parsing/validation/persistence. Source of truth for the data model.

comments.ts  → ReviewCommentController wraps vscode.CommentController. Converts parsed
               ReviewComment[] into vscode.CommentThread[]. Handles edit/delete/severity
               mutations and persists changes back through parser.ts saveReviewFile().

resolver.ts  → Resolves comment file paths to workspace URIs. Parses .gitmodules to
               support monorepos where reviewed repos are git submodules.

github.ts    → Posts reviews to GitHub PRs via `gh` CLI. Builds review payload with
               inline comments and maps verdict → GitHub review event.

icons.ts     → Maps Severity → SVG icon filename → extension URI for comment badges.

prOverviewProvider.ts → TreeDataProvider for the Activity Bar sidebar panel. Shows two
               sections: "Reviewed" (PRs from .reviews/ grouped by repo) and "Pending
               Review" (PRs where user is requested reviewer, fetched via gh CLI).
```

**Data flow:** JSON file → `parseReviewFile()` → `ReviewCommentController.loadReview()` → groups comments by path:line into `CommentThread[]` → VSCode renders inline. Mutations flow back: edit/delete → `updateCommentBody()`/`deleteComment()` → `persistAndRebuild()` → `saveReviewFile()` → JSON file. A file watcher reloads on external changes (with `isSaving` flag to prevent loops).

## Key Types (parser.ts)

- **Severity**: `"blocking" | "important" | "suggestion" | "nit" | "praise" | "learning"`
- **ReviewFile**: `{ pr, author?, summary, comments[] }` — root structure of review JSON
- **ReviewComment**: `{ path, line, side, severity, body, timestamp?, author? }`
- **Verdict values**: `"APPROVE" | "REQUEST_CHANGES" | "COMMENT"`

## Review File Format

Files go in `.reviews/` at workspace root, named `<repo-slug>-pr-<number>-review-comments.json`. The extension watches the directory for changes. `getRepoSlug()` and `isReviewFilename()` in `parser.ts` handle naming.

High-severity comments (blocking, important) auto-expand; others collapse.

## Extension Commands & Keybindings

- `Cmd+Shift+R` — Reload comments
- `Cmd+Shift+G` — Post review to GitHub PR (requires `gh` CLI authenticated)
- `Cmd+Shift+W` — Switch between review files

## Monorepo/Submodule Support

`resolver.ts` parses `.gitmodules` to map repo URLs → local submodule paths. Comment `path` fields (relative to the reviewed repo) get prefixed with the submodule directory to resolve to workspace-absolute paths.