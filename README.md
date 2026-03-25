# Agent Review — VSCode Extension

Displays AI-generated code review comments inline in VSCode, using the native Comments API. Works alongside the GitHub Pull Requests extension.

## How it works

1. A code review tool (e.g., Claude Code's `/code-review-excellence` skill) generates a JSON file with review comments
2. The JSON file is placed in `.reviews/` at the workspace root
3. This extension picks it up and shows comments inline at the correct file and line

## Setup

### Build the extension

```bash
cd ~/Documents/smallcase/agent-reviews
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

Place a review file matching `pr-*-review-comments.json` in your project's `.reviews/` directory. The extension activates automatically and loads comments inline.

### Commands

- **Agent Review: Load Review File...** — open a file picker to load any review JSON
- **Agent Review: Reload Comments** — refresh from the current review file
- **Agent Review: Clear All Comments** — remove all inline comments

### Inline comment actions

Each comment has action icons in its title bar:

- **Edit** (pencil) — switch to editing mode, then Save/Cancel
- **Change Severity** (tag) — pick a new severity from a dropdown
- **Delete** (trash) — remove the comment

All changes persist back to the JSON file automatically.

### File watching

The extension watches `.reviews/` for changes. When a review file is created or updated, comments auto-refresh.

## Review JSON format

```json
{
  "pr": {
    "repo": "org/repo-name",
    "number": 58,
    "title": "PR title",
    "base": "main",
    "head": "fix/branch-name"
  },
  "author": {
    "name": "Claude Opus 4",
    "iconUrl": "https://example.com/claude-avatar.png"
  },
  "summary": {
    "verdict": "APPROVE | COMMENT | REQUEST_CHANGES",
    "overview": "Summary of the review",
    "strengths": ["What was done well"]
  },
  "comments": [
    {
      "path": "relative/path/to/file.go",
      "line": 42,
      "side": "RIGHT",
      "severity": "blocking",
      "body": "Markdown comment text",
      "timestamp": "2026-03-25T10:30:00Z",
      "author": {
        "name": "Claude Opus 4",
        "iconUrl": "https://example.com/claude-avatar.png"
      }
    }
  ]
}
```

### Severity levels

| Severity | Icon | Meaning |
|----------|------|---------|
| `blocking` | Red circle | Must fix before merge |
| `important` | Orange triangle | Should fix, discuss if disagree |
| `suggestion` | Blue lightbulb | Alternative approach to consider |
| `nit` | Green info | Nice to have, not blocking |
| `praise` | Purple star | Good work |
| `learning` | Teal book | Educational, no action needed |

### Author information

The `author` field identifies which agent generated the review. It can be set at two levels:

- **Top-level `author`** — default for all comments in the review
- **Per-comment `author`** — overrides the top-level for that specific comment

If neither is set, the display name defaults to "Agent Review" with a severity-colored icon.

| Field | Type | Description |
|-------|------|-------------|
| `name` | string | Display name (e.g., "Claude Opus 4", "GPT-4o") |
| `iconUrl` | string (optional) | URL to an avatar image |

### Path resolution

For monorepos with git submodules, the extension parses `.gitmodules` to resolve `pr.repo` (e.g., `smallcase/las-be-distribution`) to the correct local submodule path (e.g., `distribution/`). Comment paths are then resolved relative to that submodule.
