# Agent Review — Review File Format

Generate a JSON review file that the **agent-reviews** VSCode extension can display as inline comments.

## Output Location

Save the file to `.reviews/` at the workspace root. Create the directory if it doesn't exist.

## File Naming

**Format:** `<repo-slug>-pr-<number>-review-comments.json`

Derive the repo slug from the `pr.repo` field:
1. Take the part after `/` (e.g., `acme/backend-api` → `backend-api`)
2. Lowercase
3. Replace non-alphanumeric characters with hyphens

| `pr.repo` | File name |
|-----------|-----------|
| `acme/backend-api` | `backend-api-pr-142-review-comments.json` |
| `acme/frontend_app` | `frontend-app-pr-58-review-comments.json` |
| `org/my.service` | `my-service-pr-99-review-comments.json` |

## Schema

### Root Object

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `pr` | object | yes | Pull request metadata |
| `author` | object | no | Default author for all comments |
| `summary` | object | yes | Review summary |
| `comments` | array | yes | Inline review comments |

### `pr` Object

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `repo` | string | yes | GitHub repo in `org/repo` format |
| `number` | integer | yes | PR number |
| `title` | string | yes | PR title |
| `base` | string | yes | Base branch (e.g., `main`) |
| `head` | string | yes | Head branch |

### `summary` Object

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `verdict` | string | yes | `APPROVE`, `REQUEST_CHANGES`, or `COMMENT` |
| `overview` | string | yes | One-paragraph summary |
| `strengths` | string[] | yes | Positive aspects (can be empty `[]`) |

### `comments[]` Object

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `path` | string | yes | File path relative to repo root |
| `line` | integer | yes | 1-based line number |
| `side` | string | yes | `RIGHT` (new/modified code) or `LEFT` (deleted code) |
| `severity` | string | yes | See severity levels below |
| `body` | string | yes | Comment text (Markdown supported) |
| `timestamp` | string | no | ISO 8601 timestamp |
| `author` | object | no | Per-comment author override |

### `author` Object

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | string | yes | Display name |
| `iconUrl` | string | no | URL to avatar image |

## Severity Levels

| Value | Meaning |
|-------|---------|
| `blocking` | Must fix before merge — bugs, security issues, data loss |
| `important` | Should fix — correctness, performance, maintainability concerns |
| `suggestion` | Alternative approach worth considering |
| `nit` | Minor/style observation, not blocking |
| `praise` | Positive feedback on well-written code |
| `learning` | Educational context, no action needed |

## Verdict Values

| Value | When to use |
|-------|-------------|
| `APPROVE` | Code is ready to merge |
| `REQUEST_CHANGES` | Has blocking or important issues |
| `COMMENT` | Observations without a strong stance |

## Side Values

- **`RIGHT`** — comment on new/added/modified code (use this for most comments)
- **`LEFT`** — comment on deleted code only

## Path Resolution (Monorepos)

Comment `path` should be relative to the **reviewed repository root** (matching GitHub PR diff paths). For monorepos with git submodules, the extension resolves paths via `.gitmodules` automatically.

## Minimal Template

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

## Full Template

```json
{
  "pr": {
    "repo": "org/repo-name",
    "number": 142,
    "title": "Fix: descriptive PR title",
    "base": "main",
    "head": "fix/branch-name"
  },
  "author": {
    "name": "Code Review Agent",
    "iconUrl": "https://example.com/avatar.png"
  },
  "summary": {
    "verdict": "REQUEST_CHANGES",
    "overview": "One paragraph summary of the review findings.",
    "strengths": [
      "First strength noted",
      "Second strength noted"
    ]
  },
  "comments": [
    {
      "path": "src/handlers/users.ts",
      "line": 42,
      "side": "RIGHT",
      "severity": "blocking",
      "body": "Description of the issue and suggested fix.",
      "timestamp": "2026-03-25T10:30:00Z",
      "author": {
        "name": "Specific Agent Name"
      }
    },
    {
      "path": "src/handlers/users.ts",
      "line": 89,
      "side": "RIGHT",
      "severity": "praise",
      "body": "Good use of early returns here."
    }
  ]
}
```
