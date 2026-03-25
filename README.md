# Agent Review — VSCode Extension

Displays AI-generated code review comments inline in VSCode, using the native Comments API. Works alongside the GitHub Pull Requests extension.

## How it works

1. An AI agent generates a JSON file with review comments
2. The JSON file is placed in `.reviews/` at the workspace root
3. This extension picks it up and shows comments inline at the correct file and line

## Setup

### Build the extension

```bash
cd agent-reviews
npm install
npm run compile
```

### Install in VSCode

```bash
# From the extension directory
npx @vscode/vsce package
code --install-extension agent-review-0.1.0.vsix
```

Or for development: open this folder in VSCode and press F5 to launch the Extension Development Host.

### Prepare your project

Add a `.reviews/` directory to your project and gitignore it:

```bash
mkdir -p .reviews
echo '.reviews/' >> .gitignore
```

## Usage

### Automatic loading

Place a review file matching `<repo-slug>-pr-<number>-review-comments.json` in your project's `.reviews/` directory. The extension activates automatically and loads comments inline.

### Commands

- **Agent Review: Load Review File...** — open a file picker to load any review JSON
- **Agent Review: Reload Comments** — refresh from the current review file
- **Agent Review: Clear All Comments** — remove all inline comments
- **Agent Review: Generate Agent Instructions** — create an instructions file for AI agents in your project (supports CLAUDE.md, Cursor rules, Copilot instructions, or custom path)

### Inline comment actions

Each comment has action icons in its title bar:

- **Edit** (pencil) — switch to editing mode, then Save/Cancel
- **Change Severity** (tag) — pick a new severity from a dropdown
- **Delete** (trash) — remove the comment

All changes persist back to the JSON file automatically.

### File watching

The extension watches `.reviews/` for changes. When a review file is created or updated, comments auto-refresh.

## Review JSON Schema

A formal JSON Schema 2020-12 definition is available at [`schema.json`](schema.json). For IDE autocomplete and validation, add to your review JSON:

```json
{ "$schema": "./path/to/agent-reviews/schema.json", ... }
```

### File naming

Files should be named `<repo-slug>-pr-<number>-review-comments.json` and placed in `.reviews/` at the workspace root. The repo slug is derived from `pr.repo` (the part after `/`, lowercased, special characters replaced with hyphens).

| `pr.repo` | File name |
|-----------|-----------|
| `acme/backend-api` | `backend-api-pr-58-review-comments.json` |
| `acme/frontend_app` | `frontend-app-pr-123-review-comments.json` |

### Full example

```json
{
  "pr": {
    "repo": "acme/backend-api",
    "number": 142,
    "title": "Fix: validate user input before processing",
    "base": "main",
    "head": "fix/input-validation"
  },
  "author": {
    "name": "Claude Opus 4",
    "iconUrl": "https://example.com/agent-avatar.png"
  },
  "summary": {
    "verdict": "REQUEST_CHANGES",
    "overview": "Input validation is added but missing edge cases for empty strings and negative values.",
    "strengths": [
      "Good test coverage for the happy path",
      "Clean separation of validation logic from handler"
    ]
  },
  "comments": [
    {
      "path": "src/handlers/users.ts",
      "line": 42,
      "side": "RIGHT",
      "severity": "blocking",
      "body": "This will throw if `req.body` is undefined. Should we add a guard before accessing `name`?",
      "timestamp": "2026-03-25T10:30:00Z"
    },
    {
      "path": "src/handlers/users.ts",
      "line": 87,
      "side": "RIGHT",
      "severity": "suggestion",
      "body": "Consider extracting this into a validation helper — the same pattern appears in three handlers.",
      "timestamp": "2026-03-25T10:30:00Z",
      "author": {
        "name": "GPT-4o",
        "iconUrl": "https://example.com/other-agent-avatar.png"
      }
    }
  ]
}
```

### Top-level fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `pr` | object | yes | Pull request metadata |
| `pr.repo` | string | yes | GitHub repo in `org/repo` format (e.g., `acme/backend-api`) |
| `pr.number` | number | yes | PR number |
| `pr.title` | string | yes | PR title |
| `pr.base` | string | yes | Base branch (e.g., `main`) |
| `pr.head` | string | yes | Head branch (e.g., `fix/loan-amount-update`) |
| `author` | object | no | Default author for all comments (see [Author](#author)) |
| `summary` | object | yes | Review summary |
| `summary.verdict` | string | yes | One of: `APPROVE`, `REQUEST_CHANGES`, `COMMENT` |
| `summary.overview` | string | yes | One-paragraph summary of the review |
| `summary.strengths` | string[] | yes | List of things done well (can be empty array) |
| `comments` | array | yes | Review comments (see [Comment](#comment)) |

### Comment

Each entry in the `comments` array represents one inline review comment.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `path` | string | yes | File path relative to the repo root (e.g., `src/handlers/users.ts`) |
| `line` | number | yes | Line number in the file (1-based) |
| `side` | string | yes | `RIGHT` (new code) or `LEFT` (old/deleted code) |
| `severity` | string | yes | One of: `blocking`, `important`, `suggestion`, `nit`, `praise`, `learning` |
| `body` | string | yes | Comment text in Markdown |
| `timestamp` | string | no | ISO 8601 timestamp (e.g., `2026-03-25T10:30:00Z`). Falls back to file modification time if absent |
| `author` | object | no | Per-comment author override (see [Author](#author)) |

### Author

Identifies which agent generated the review or a specific comment.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | string | yes | Display name (e.g., `Claude Opus 4`, `GPT-4o`, `Gemini 2.5 Pro`) |
| `iconUrl` | string | no | URL to an avatar image |

**Resolution order:** per-comment `author` > top-level `author` > fallback ("Agent Review" with severity icon).

### Severity levels

| Value | Icon | Meaning | Displayed as |
|-------|------|---------|-------------|
| `blocking` | Red circle | Must fix before merge | Expanded, unresolved |
| `important` | Orange triangle | Should fix, discuss if disagree | Expanded, unresolved |
| `suggestion` | Blue lightbulb | Alternative approach to consider | Collapsed |
| `nit` | Green info | Nice to have, not blocking | Collapsed |
| `praise` | Purple star | Good work, keep it up | Collapsed |
| `learning` | Teal book | Educational, no action needed | Collapsed |

### Verdict mapping

When posting to GitHub via the `Post Review to GitHub` command:

| Verdict | GitHub event | Effect |
|---------|-------------|--------|
| `APPROVE` | `APPROVE` | Approves the PR |
| `REQUEST_CHANGES` | `REQUEST_CHANGES` | Requests changes |
| `COMMENT` | `COMMENT` | Neutral review comment |

### Path resolution for monorepos

For monorepos with git submodules, the extension parses `.gitmodules` at the workspace root to resolve `pr.repo` to the correct local submodule path. For example:

- `pr.repo = "acme/backend-api"` + `.gitmodules` maps it to `services/backend/`
- Comment `path = "src/handlers/users.ts"`
- Resolved to: `services/backend/src/handlers/users.ts`

If `.gitmodules` is absent or the repo isn't a submodule, paths are resolved directly from the workspace root.

### Validation rules

The extension applies these rules when loading a review file:

- `pr` and `comments` array must be present — file is rejected otherwise
- Comments missing `path`, `line`, or `body` are silently skipped (other comments still load)
- Comments referencing files that don't exist locally are skipped with a count shown in the info message
- `severity` defaults to `nit` styling if an unrecognized value is used

## For AI Agents

This section explains how to set up AI coding assistants (Claude Code, Cursor, Copilot, etc.) to generate review files that this extension can display.

### Quick reference

| Item | Value |
|------|-------|
| File location | `.reviews/` directory at workspace root |
| File naming | `<repo-slug>-pr-<number>-review-comments.json` |
| Schema | [`schema.json`](schema.json) (JSON Schema 2020-12) |
| Full format spec | [`agent-instructions.md`](agent-instructions.md) |

### Setup

Run the command **Agent Review: Generate Agent Instructions** from the Command Palette. It will ask where to place the instructions in your project:

- **CLAUDE.md** (append) — for Claude Code
- **.cursor/rules/** (create) — for Cursor
- **.github/copilot-instructions.md** (append) — for GitHub Copilot
- **Custom path** — save anywhere

Alternatively, copy [`agent-instructions.md`](agent-instructions.md) from this repository into your project manually.

### Multi-repo workspaces

For monorepos with submodules, the repo-slug prefix prevents PR number collisions:

```
my-monorepo/
├── .reviews/
│   ├── auth-service-pr-58-review-comments.json
│   ├── payments-api-pr-58-review-comments.json
│   └── web-frontend-pr-123-review-comments.json
├── services/
│   ├── auth/       # submodule: acme/auth-service
│   └── payments/   # submodule: acme/payments-api
└── apps/
    └── web/        # submodule: acme/web-frontend
```

The extension resolves comment `path` fields via `.gitmodules`. A comment with `"path": "src/auth.ts"` in `auth-service-pr-58-review-comments.json` resolves to `services/auth/src/auth.ts`.

### Minimal valid review

```json
{
  "pr": {
    "repo": "org/repo-name",
    "number": 123,
    "title": "PR title",
    "base": "main",
    "head": "feature-branch"
  },
  "summary": {
    "verdict": "COMMENT",
    "overview": "Brief summary of the review.",
    "strengths": []
  },
  "comments": [
    {
      "path": "src/file.ts",
      "line": 42,
      "side": "RIGHT",
      "severity": "suggestion",
      "body": "Comment text in Markdown."
    }
  ]
}
```
