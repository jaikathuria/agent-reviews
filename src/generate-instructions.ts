import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";

function getInstructionsContent(): string {
  return fs.readFileSync(
    path.join(__dirname, "..", "agent-instructions.md"),
    "utf-8"
  );
}

interface PlacementOption {
  label: string;
  description: string;
  getPath: (root: string) => string;
  mode: "create" | "append";
}

const PLACEMENT_OPTIONS: PlacementOption[] = [
  {
    label: "CLAUDE.md (append)",
    description: "Append to CLAUDE.md for Claude Code",
    getPath: (root) => path.join(root, "CLAUDE.md"),
    mode: "append",
  },
  {
    label: ".cursor/rules/agent-review.mdc (create)",
    description: "Create Cursor rules file",
    getPath: (root) => path.join(root, ".cursor", "rules", "agent-review.mdc"),
    mode: "create",
  },
  {
    label: ".github/copilot-instructions.md (append)",
    description: "Append to GitHub Copilot instructions",
    getPath: (root) => path.join(root, ".github", "copilot-instructions.md"),
    mode: "append",
  },
  {
    label: "Custom path...",
    description: "Choose where to save the instructions",
    getPath: () => "",
    mode: "create",
  },
];

export function registerGenerateInstructionsCommand(
  context: vscode.ExtensionContext
): void {
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "agentReview.generateAgentInstructions",
      async () => {
        const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (!workspaceRoot) {
          vscode.window.showWarningMessage("No workspace folder open.");
          return;
        }

        const selected = await vscode.window.showQuickPick(
          PLACEMENT_OPTIONS.map((opt) => ({
            label: opt.label,
            description: opt.description,
          })),
          { placeHolder: "Where should the agent instructions be placed?" }
        );

        if (!selected) {
          return;
        }

        const option = PLACEMENT_OPTIONS.find((o) => o.label === selected.label)!;
        let targetPath: string;

        if (option.getPath(workspaceRoot) === "") {
          const uri = await vscode.window.showSaveDialog({
            defaultUri: vscode.Uri.file(
              path.join(workspaceRoot, "agent-review-instructions.md")
            ),
            filters: { Markdown: ["md", "mdc"] },
          });
          if (!uri) {
            return;
          }
          targetPath = uri.fsPath;
        } else {
          targetPath = option.getPath(workspaceRoot);
        }

        const content = getInstructionsContent();

        try {
          const dir = path.dirname(targetPath);
          await fs.promises.mkdir(dir, { recursive: true });

          if (option.mode === "append" && fs.existsSync(targetPath)) {
            const existing = await fs.promises.readFile(targetPath, "utf-8");
            await fs.promises.writeFile(
              targetPath,
              existing + "\n\n" + content,
              "utf-8"
            );
          } else {
            await fs.promises.writeFile(targetPath, content, "utf-8");
          }

          const doc = await vscode.workspace.openTextDocument(targetPath);
          await vscode.window.showTextDocument(doc);
          vscode.window.showInformationMessage(
            `Agent instructions ${option.mode === "append" ? "appended to" : "created at"} ${path.relative(workspaceRoot, targetPath)}`
          );
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          vscode.window.showErrorMessage(`Failed to write instructions: ${msg}`);
        }
      }
    )
  );
}
