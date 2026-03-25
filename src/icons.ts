import * as vscode from "vscode";

import { Severity } from "./parser";

const iconFiles: Record<Severity, string> = {
  blocking: "blocking.svg",
  important: "important.svg",
  suggestion: "suggestion.svg",
  nit: "nit.svg",
  praise: "praise.svg",
  learning: "learning.svg",
};

export function getIconUri(
  severity: Severity,
  extensionUri: vscode.Uri
): vscode.Uri {
  const file = iconFiles[severity] || "nit.svg";
  return vscode.Uri.joinPath(extensionUri, "icons", file);
}
