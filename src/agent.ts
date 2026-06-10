import { createWorktree, commitAndPush, openPR } from "./git.ts";
import { homedir } from "os";
import path from "path";
import { resolveProviderDefaults } from "./config.ts";
import { log } from "./logging.ts";
import { collectAgent } from "./providers/index.ts";
import type { AgentOptions, AgentResult, AgentRunResult } from "./agent-types.ts";

export type {
  AgentCli,
  AgentMode,
  AgentOptions,
  AgentResult,
  AgentRunResult,
  TokenUsage,
} from "./agent-types.ts";

export function resolvePath(p: string): string {
  if (p.startsWith("~/")) return path.join(homedir(), p.slice(2));
  if (p.startsWith("~")) return path.join(homedir(), "..", p.slice(1));
  if (!path.isAbsolute(p)) return path.join(homedir(), p);
  return path.resolve(p);
}

export async function queryAgent(opts: AgentOptions): Promise<AgentResult> {
  const project = resolvePath(opts.project);
  const ctx = await createWorktree(project, opts.originBranch);
  const defaults = resolveProviderDefaults("prompt", opts);
  const agentOpts = {
    ...opts,
    cli: defaults.provider,
    model: defaults.model,
    effort: defaults.effort,
    agentMode: "prompt" as const,
  };

  try {
    const { result, sessionId, model, totalTokens, usage, totalCostUsd } = await collectAgent(
      agentOpts,
      ctx.worktreePath,
    );

    let prUrl: string | undefined;

    if (!opts.skipPR) {
      const title = opts.prTitle ?? `agent: ${opts.prompt.slice(0, 60)}`;
      await commitAndPush(ctx, title);
      try {
        prUrl = await openPR(ctx, title, result.slice(0, 4000));
      } catch (err) {
        log("openPR", "failed to create PR:", err);
      }
    }

    return { result, sessionId, prUrl, branch: ctx.branch, model, totalTokens, usage, totalCostUsd };
  } finally {
    await ctx.cleanup();
  }
}

type NoPRAgentOptions = Omit<AgentOptions, "originBranch"> & {
  originBranch?: string;
  cwd?: string;
};

async function runNoPRAgent(opts: NoPRAgentOptions): Promise<AgentRunResult> {
  return collectAgent(
    { ...opts, originBranch: opts.originBranch ?? "main" } as AgentOptions,
    opts.cwd ?? resolvePath(opts.project),
  );
}

export async function queryAgentReadOnly(opts: NoPRAgentOptions): Promise<AgentRunResult> {
  return runNoPRAgent(opts);
}

/**
 * Non-PR agent that runs directly in `cwd` (defaults to the resolved project).
 * No worktree, no commit/push/PR. The caller controls permissions via
 * `opts.agentMode`.
 */
export async function queryAgentTask(opts: NoPRAgentOptions & { cwd?: string }): Promise<AgentRunResult> {
  return runNoPRAgent(opts);
}
