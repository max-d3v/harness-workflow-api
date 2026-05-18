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
  /** When set, every streamed message ("round") is logged with this prefix. */
  logLabel?: string;
  /** When provided, aborting this controller cancels the running query. */
  abortController?: AbortController;
}



export interface TokenUsage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
}

export interface AgentResult {
  result: string;
  sessionId?: string;
  prUrl?: string;
  branch?: string;
  /** input + output + cache creation + cache read tokens for the run. */
  totalTokens?: number;
  usage?: TokenUsage;
  /** Cumulative USD cost reported by the SDK for the run. */
  totalCostUsd?: number;
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
    ...(opts.abortController && { abortController: opts.abortController }),
  };
}

function extractSessionId(message: any): string | undefined {
  if (message?.type === "system" && message?.subtype === "init") {
    return message.session_id ?? message.data?.session_id;
  }
}

function clip(s: string, n = 1500): string {
  s = s.replace(/\s+/g, " ").trim();
  return s.length > n ? `${s.slice(0, n)}…(+${s.length - n} chars)` : s;
}

function summarizeMessage(msg: any): string | undefined {
  switch (msg?.type) {
    case "system":
      return `system/${msg.subtype ?? "?"}`;
    case "assistant": {
      const parts: string[] = [];
      for (const b of msg.message?.content ?? []) {
        if (b.type === "text" && b.text?.trim()) parts.push(`text: ${clip(b.text)}`);
        else if (b.type === "thinking" && b.thinking?.trim())
          parts.push(`thinking: ${clip(b.thinking, 500)}`);
        else if (b.type === "tool_use")
          parts.push(`tool_use ${b.name}(${clip(JSON.stringify(b.input ?? {}), 500)})`);
      }
      return `assistant → ${parts.join(" | ") || "(empty)"}`;
    }
    case "user": {
      const parts: string[] = [];
      for (const b of msg.message?.content ?? []) {
        if (b.type !== "tool_result") continue;
        const c = b.content;
        const text =
          typeof c === "string"
            ? c
            : Array.isArray(c)
              ? c
                  .map((x: any) => (x?.type === "image" ? "[image omitted]" : x?.text ?? ""))
                  .join(" ")
              : "";
        parts.push(`tool_result${b.is_error ? "(error)" : ""}: ${clip(text)}`);
      }
      return parts.length ? `user ← ${parts.join(" | ")}` : undefined;
    }
    default:
      return undefined;
  }
}

async function collectQuery(
  prompt: string,
  options: ReturnType<typeof buildSdkOptions>,
  logLabel?: string,
): Promise<{
  result: string;
  sessionId?: string;
  totalTokens?: number;
  usage?: TokenUsage;
  totalCostUsd?: number;
}> {
  let result = "";
  let sessionId: string | undefined;
  let usage: TokenUsage | undefined;
  let totalTokens: number | undefined;
  let totalCostUsd: number | undefined;
  let round = 0;

  for await (const msg of query({ prompt, options })) {
    sessionId ??= extractSessionId(msg);
    if (logLabel) {
      const summary = summarizeMessage(msg);
      if (summary) console.log(`[${logLabel}] round ${++round}: ${summary}`);
    }
    // The final "result" message (success or error) carries cumulative usage.
    if ((msg as any).type === "result" && (msg as any).usage) {
      const u = (msg as any).usage;
      usage = {
        input_tokens: u.input_tokens ?? 0,
        output_tokens: u.output_tokens ?? 0,
        cache_creation_input_tokens: u.cache_creation_input_tokens ?? 0,
        cache_read_input_tokens: u.cache_read_input_tokens ?? 0,
      };
      totalTokens =
        usage.input_tokens +
        usage.output_tokens +
        usage.cache_creation_input_tokens +
        usage.cache_read_input_tokens;
    }
    if ((msg as any).type === "result" && typeof (msg as any).total_cost_usd === "number") {
      totalCostUsd = (msg as any).total_cost_usd;
    }
    if ("result" in msg) result = (msg as any).result;
  }

  return { result, sessionId, totalTokens, usage, totalCostUsd };
}

export async function queryAgent(opts: AgentOptions): Promise<AgentResult> {
  const project = resolvePath(opts.project);
  const ctx = await createWorktree(project, opts.originBranch);

  try {
    const { result, sessionId, totalTokens, usage, totalCostUsd } = await collectQuery(
      opts.prompt,
      buildSdkOptions(opts, ctx.worktreePath),
      opts.logLabel,
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

    return { result, sessionId, prUrl, branch: ctx.branch, totalTokens, usage, totalCostUsd };
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
    opts.logLabel,
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
