import { query } from "@anthropic-ai/claude-agent-sdk";
import type { McpServerConfig } from "@anthropic-ai/claude-agent-sdk";
import { createWorktree, commitAndPush, openPR } from "./git.js";
import { homedir } from "os";
import path from "path";

export function resolvePath(p: string): string {
  if (p.startsWith("~/")) return path.join(homedir(), p.slice(2));
  if (p.startsWith("~")) return path.join(homedir(), "..", p.slice(1));
  if (!path.isAbsolute(p)) return path.join(homedir(), p);
  return path.resolve(p);
}

export interface AgentOptions {
  prompt: string;
  project: string;
  originBranch: string;
  systemPrompt?: string;
  tools?: string[] | { type: "preset"; preset: "claude_code" };
  mcpServers?: Record<string, McpServerConfig>;
  allowedTools?: string[];
  model?: string;
  effort?: "low" | "medium" | "high" | "max";
  maxTurns?: number;
  extendedContext?: boolean;
  prTitle?: string;
  skipPR?: boolean;
  loadProjectSettings?: boolean;
}



export interface AgentResult {
  result: string;
  sessionId?: string;
  prUrl?: string;
  branch?: string;
}

const DEFAULTS = {
  model: "claude-opus-4-6",
  effort: "high" as const,
  maxTurns: 10,
  tools: { type: "preset" as const, preset: "claude_code" as const },
};

function buildSdkOptions(opts: AgentOptions, cwd: string) {
  return {
    tools: opts.tools ?? DEFAULTS.tools,
    permissionMode: "bypassPermissions" as const,
    allowDangerouslySkipPermissions: true,
    model: opts.model ?? DEFAULTS.model,
    thinking: { type: "adaptive" as const },
    effort: opts.effort ?? DEFAULTS.effort,
    maxTurns: opts.maxTurns ?? DEFAULTS.maxTurns,
    cwd,
    ...(opts.systemPrompt && { systemPrompt: opts.systemPrompt }),
    ...(opts.mcpServers && { mcpServers: opts.mcpServers }),
    ...(opts.allowedTools && { allowedTools: opts.allowedTools }),
    ...(opts.loadProjectSettings && { settingSources: ["project" as const] }),
    ...(opts.extendedContext && {
      betas: ["context-1m-2025-08-07" as const] satisfies string[],
    }),
  };
}

function extractSessionId(message: any): string | undefined {
  if (message?.type === "system" && message?.subtype === "init") {
    return message.session_id ?? message.data?.session_id;
  }
}

async function collectQuery(
  prompt: string,
  options: ReturnType<typeof buildSdkOptions>,
): Promise<{ result: string; sessionId?: string }> {
  let result = "";
  let sessionId: string | undefined;

  for await (const msg of query({ prompt, options })) {
    sessionId ??= extractSessionId(msg);
    if ("result" in msg) result = (msg as any).result;
  }

  return { result, sessionId };
}

export async function queryAgent(opts: AgentOptions): Promise<AgentResult> {
  const project = resolvePath(opts.project);
  const ctx = await createWorktree(project, opts.originBranch);

  try {
    const { result, sessionId } = await collectQuery(
      opts.prompt,
      buildSdkOptions(opts, ctx.worktreePath),
    );

    let prUrl: string | undefined;

    if (!opts.skipPR) {
      const title = opts.prTitle ?? `agent: ${opts.prompt.slice(0, 60)}`;
      await commitAndPush(ctx, title);
      try {
        prUrl = await openPR(ctx, title, result.slice(0, 4000));
      } catch (err) {
        console.error("[openPR] Failed to create PR:", err);
      }
    }

    return { result, sessionId, prUrl, branch: ctx.branch };
  } finally {
    await ctx.cleanup();
  }
}

type NoPRAgentOptions = Omit<AgentOptions, "originBranch"> & {
  originBranch?: string;
};

async function runNoPRAgent(
  opts: NoPRAgentOptions,
  cwd?: string,
): Promise<Omit<AgentResult, "prUrl" | "branch">> {
  return collectQuery(
    opts.prompt,
    buildSdkOptions(
      { ...opts, originBranch: opts.originBranch ?? "main" } as AgentOptions,
      cwd ?? resolvePath(opts.project),
    ),
  );
}

export async function queryAgentReadOnly(
  opts: NoPRAgentOptions,
): Promise<Omit<AgentResult, "prUrl" | "branch">> {
  return runNoPRAgent(opts);
}

/**
 * Non-PR agent that runs directly in `cwd` (defaults to the resolved project).
 * No worktree, no commit/push/PR. Use for side-effecting Bash tasks such as
 * starting or killing a dev server. The caller controls which tools are
 * granted via `opts.tools`.
 */
export async function queryAgentTask(
  opts: NoPRAgentOptions & { cwd?: string },
): Promise<Omit<AgentResult, "prUrl" | "branch">> {
  return runNoPRAgent(opts, opts.cwd ?? resolvePath(opts.project));
}
