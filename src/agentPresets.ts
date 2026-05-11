export interface AgentContext {
  repo: string;
  number: number;
  title: string;
  base: string;
  head: string;
  reviewsDir: string;
  outputFilename: string;
}

type PresetId = "claude" | "codex" | "custom";

const PRESETS: Record<Exclude<PresetId, "custom">, (ctx: AgentContext) => string> = {
  claude: (ctx) =>
    `claude --agent pr-review ` +
    `"Review PR ${ctx.repo}#${ctx.number} (${ctx.head} → ${ctx.base})."`,

  codex: (ctx) =>
    `codex review --base ${ctx.base} ` +
    `"Write the review JSON to ${ctx.reviewsDir}/${ctx.outputFilename} ` +
    `following the format in agent-instructions.md."`,
};

function substituteVariables(template: string, ctx: AgentContext): string {
  return template
    .replace(/\$\{repo\}/g, ctx.repo)
    .replace(/\$\{number\}/g, String(ctx.number))
    .replace(/\$\{title\}/g, ctx.title)
    .replace(/\$\{base\}/g, ctx.base)
    .replace(/\$\{head\}/g, ctx.head)
    .replace(/\$\{reviewsDir\}/g, ctx.reviewsDir)
    .replace(/\$\{outputFilename\}/g, ctx.outputFilename);
}

export function resolveCommand(preset: string, customCommand: string, ctx: AgentContext): string {
  if (preset === "custom") {
    if (!customCommand) {
      throw new Error(
        "agentReview.agentCommand is empty. Set a custom command template in settings, " +
        "or switch agentReview.agent to a built-in preset (claude, codex)."
      );
    }
    return substituteVariables(customCommand, ctx);
  }

  const builder = PRESETS[preset as Exclude<PresetId, "custom">];
  if (!builder) {
    throw new Error(`Unknown agent preset: ${preset}`);
  }
  return builder(ctx);
}
