import { homedir } from "os";
import path from "path";
import {
  createWorktree,
  getOrCreatePRHeadBranchCwd,
  type PRInfo,
  type PRHeadBranchCwd,
  type WorktreeContext,
} from "./git.ts";
import { log } from "./logging.ts";
import { collectAgent } from "./providers/index.ts";
import type { AgentOptions, AgentRunResult } from "./agent-types.ts";

export { openPR } from "./git.ts";
export type {
  AgentAccess,
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

export type QueryAgentOptions = AgentOptions & {
  cwd?: string;
};

export interface QueryAgentInNewWorktreeResult extends AgentRunResult {
  branch: string;
  cwd: string;
  worktreePath: string;
  worktree: WorktreeContext;
  cleanup: () => Promise<void>;
}

export type QueryAgentInNewWorktreeOptions = QueryAgentOptions & {
  originBranch: string;
  branchPrefix?: string;
};

export interface QueryAgentInPRWorktreeResult extends AgentRunResult, PRHeadBranchCwd {
  cwd: string;
}

export type QueryAgentInPRWorktreeOptions = QueryAgentOptions & {
  pullRequest: PRInfo;
};

export async function queryAgent(opts: QueryAgentOptions): Promise<AgentRunResult> {
  return collectAgent(opts, resolvePath(opts.cwd ?? opts.project));
}

export async function queryAgentInNewWorktree(
  opts: QueryAgentInNewWorktreeOptions,
): Promise<QueryAgentInNewWorktreeResult> {
  const project = resolvePath(opts.project);
  const { branchPrefix, ...agentOpts } = opts;
  const worktree = await createWorktree(project, opts.originBranch, branchPrefix);

  try {
    const result = await queryAgent({
      ...agentOpts,
      project: worktree.worktreePath,
      cwd: worktree.worktreePath,
    });
    return {
      ...result,
      branch: worktree.branch,
      cwd: worktree.worktreePath,
      worktreePath: worktree.worktreePath,
      worktree,
      cleanup: worktree.cleanup,
    };
  } catch (err) {
    await worktree.cleanup().catch((cleanupErr) =>
      log("agent", "failed to clean up new worktree after agent error:", cleanupErr),
    );
    throw err;
  }
}

export async function queryAgentInPRWorktree(
  opts: QueryAgentInPRWorktreeOptions,
): Promise<QueryAgentInPRWorktreeResult> {
  const project = resolvePath(opts.project);
  const { pullRequest, ...agentOpts } = opts;
  const prHeadBranchContext = await getOrCreatePRHeadBranchCwd({
    cwd: project,
    pullRequest,
  });

  try {
    const result = await queryAgent({
      ...agentOpts,
      project: prHeadBranchContext.prHeadBranchCwd,
      cwd: prHeadBranchContext.prHeadBranchCwd,
    });
    return {
      ...result,
      ...prHeadBranchContext,
      cwd: prHeadBranchContext.prHeadBranchCwd,
    };
  } catch (err) {
    await prHeadBranchContext.cleanup().catch((cleanupErr) =>
      log("agent", "failed to clean up PR head branch worktree after agent error:", cleanupErr),
    );
    throw err;
  }
}
