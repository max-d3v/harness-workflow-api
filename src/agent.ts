import { query } from "@anthropic-ai/claude-agent-sdk";
import type { McpServerConfig } from "@anthropic-ai/claude-agent-sdk";
import { Codex, type ModelReasoningEffort, type SandboxMode, type ThreadEvent } from "@openai/codex-sdk";
import { createWorktree, commitAndPush, openPR } from "./git.js";
import { homedir } from "os";
import path from "path";
import { resolveProviderDefaults } from "./config.js";

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
  cli?: AgentCli;
  provider?: AgentCli;
  systemPrompt?: string;
  agentMode?: AgentMode;
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

export type AgentCli = "claude" | "codex";
export type AgentMode = "prompt" | "code_review" | "qa_dev_server" | "qa_tester";

export interface TokenUsage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
  reasoning_output_tokens?: number;
}

export interface AgentResult {
  result: string;
  sessionId?: string;
  prUrl?: string;
  branch?: string;
  /** Model the SDK actually ran with for this query. */
  model?: string;
  /** Sum of reported token counters for the run. */
  totalTokens?: number;
  usage?: TokenUsage;
  /** Cumulative USD cost reported by the SDK for the run. */
  totalCostUsd?: number;
}

const DEFAULTS = {
  maxTurns: 30,
};

const CLAUDE_CODE_PRESET = { type: "preset" as const, preset: "claude_code" as const };

const AGENT_MODE_ACCESS: Record<
  AgentMode,
  {
    claudeTools: AgentOptions["tools"];
    codexSandboxMode: SandboxMode;
  }
> = {
  prompt: {
    claudeTools: CLAUDE_CODE_PRESET,
    codexSandboxMode: "danger-full-access",
  },
  code_review: {
    claudeTools: ["Read", "Glob", "Grep"],
    codexSandboxMode: "read-only",
  },
  qa_dev_server: {
    claudeTools: ["Bash", "Read", "Glob", "Grep"],
    codexSandboxMode: "danger-full-access",
  },
  qa_tester: {
    claudeTools: ["Read", "Glob", "Grep"],
    codexSandboxMode: "read-only",
  },
};

function resolveAgentCli(opts: Pick<AgentOptions, "cli" | "provider">): AgentCli {
  return opts.cli ?? opts.provider ?? "claude";
}

function resolveAgentMode(opts: Pick<AgentOptions, "agentMode">): AgentMode {
  return opts.agentMode ?? "prompt";
}

function claudeToolsFor(opts: Pick<AgentOptions, "agentMode" | "tools">): AgentOptions["tools"] {
  return opts.tools ?? AGENT_MODE_ACCESS[resolveAgentMode(opts)].claudeTools;
}

function codexSandboxFor(opts: Pick<AgentOptions, "agentMode">): SandboxMode {
  return AGENT_MODE_ACCESS[resolveAgentMode(opts)].codexSandboxMode;
}

function buildSdkOptions(opts: AgentOptions, cwd: string) {
  return {
    tools: claudeToolsFor(opts),
    permissionMode: "bypassPermissions" as const,
    allowDangerouslySkipPermissions: true,
    model: opts.model,
    thinking: { type: "adaptive" as const },
    effort: opts.effort,
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

function buildCodexPrompt(prompt: string, systemPrompt?: string): string {
  if (!systemPrompt) return prompt;
  return `${systemPrompt}

${prompt}`;
}

function codexReasoningEffortFor(effort?: AgentOptions["effort"]): ModelReasoningEffort | undefined {
  if (effort === "max") return "xhigh";
  return effort;
}

function summarizeCodexEvent(event: ThreadEvent): string | undefined {
  switch (event.type) {
    case "thread.started":
      return `thread ${event.thread_id}`;
    case "turn.started":
      return "turn started";
    case "turn.completed":
      return "turn completed";
    case "turn.failed":
      return `turn failed: ${clip(event.error.message, 500)}`;
    case "error":
      return `error: ${clip(event.message, 500)}`;
    case "item.started":
    case "item.updated":
    case "item.completed": {
      const prefix = event.type.replace("item.", "");
      const item = event.item;
      switch (item.type) {
        case "agent_message":
          return `${prefix} agent_message: ${clip(item.text)}`;
        case "reasoning":
          return `${prefix} reasoning: ${clip(item.text, 500)}`;
        case "command_execution":
          return `${prefix} command ${item.status}: ${clip(item.command, 500)}`;
        case "file_change":
          return `${prefix} file_change ${item.status}: ${item.changes.map((change) => `${change.kind} ${change.path}`).join(", ")}`;
        case "mcp_tool_call":
          return `${prefix} mcp ${item.server}.${item.tool} ${item.status}`;
        case "web_search":
          return `${prefix} web_search: ${clip(item.query, 500)}`;
        case "todo_list":
          return `${prefix} todo_list ${item.items.filter((todo) => todo.completed).length}/${item.items.length}`;
        case "error":
          return `${prefix} error: ${clip(item.message, 500)}`;
      }
    }
  }
}

async function collectCodexSdk(
  prompt: string,
  opts: AgentOptions,
  cwd: string,
): Promise<{
  result: string;
  sessionId?: string;
  model?: string;
  totalTokens?: number;
  usage?: TokenUsage;
  totalCostUsd?: number;
}> {
  const codex = new Codex();
  const thread = codex.startThread({
    workingDirectory: cwd,
    model: opts.model,
    sandboxMode: codexSandboxFor(opts),
    approvalPolicy: "never",
    modelReasoningEffort: codexReasoningEffortFor(opts.effort),
    skipGitRepoCheck: true,
  });
  const { events } = await thread.runStreamed(buildCodexPrompt(prompt, opts.systemPrompt), {
    signal: opts.abortController?.signal,
  });

  let result = "";
  let usage: TokenUsage | undefined;
  let totalTokens: number | undefined;

  for await (const event of events) {
    if (opts.logLabel) {
      const summary = summarizeCodexEvent(event);
      if (summary) console.log(`[${opts.logLabel}] codex: ${summary}`);
    }
    if (event.type === "turn.failed") {
      throw new Error(event.error.message);
    }
    if (event.type === "error") {
      throw new Error(event.message);
    }
    if (event.type === "item.completed" && event.item.type === "agent_message") {
      result = event.item.text;
    }
    if (event.type === "turn.completed") {
      usage = {
        input_tokens: event.usage.input_tokens,
        output_tokens: event.usage.output_tokens,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: event.usage.cached_input_tokens,
        reasoning_output_tokens: event.usage.reasoning_output_tokens,
      };
      totalTokens =
        usage.input_tokens +
        usage.output_tokens +
        usage.cache_creation_input_tokens +
        usage.cache_read_input_tokens +
        (usage.reasoning_output_tokens ?? 0);
    }
  }

  return { result: result.trim(), sessionId: thread.id ?? undefined, model: opts.model, usage, totalTokens };
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

function extractModel(message: any): string | undefined {
  if (message?.type === "system" && message?.subtype === "init") {
    return message.model ?? message.data?.model;
  }
  if (message?.type === "assistant") {
    return message.message?.model;
  }
  if (message?.type === "result") {
    return message.model ?? message.modelId;
  }
}

async function collectQuery(
  prompt: string,
  options: ReturnType<typeof buildSdkOptions>,
  logLabel?: string,
): Promise<{
  result: string;
  sessionId?: string;
  model?: string;
  totalTokens?: number;
  usage?: TokenUsage;
  totalCostUsd?: number;
}> {
  let result = "";
  let sessionId: string | undefined;
  let model: string | undefined;
  let usage: TokenUsage | undefined;
  let totalTokens: number | undefined;
  let totalCostUsd: number | undefined;
  let round = 0;

  for await (const msg of query({ prompt, options })) {
    sessionId ??= extractSessionId(msg);
    model ??= extractModel(msg);
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

  model ??= options.model;
  return { result, sessionId, model, totalTokens, usage, totalCostUsd };
}

async function collectAgent(
  opts: AgentOptions,
  cwd: string,
): Promise<{
  result: string;
  sessionId?: string;
  model?: string;
  totalTokens?: number;
  usage?: TokenUsage;
  totalCostUsd?: number;
}> {
  if (resolveAgentCli(opts) === "codex") {
    if (opts.mcpServers) {
      console.warn(
        "[agent] Codex SDK does not receive per-run MCP server config; using local Codex configuration.",
      );
    }
    return collectCodexSdk(opts.prompt, opts, cwd);
  }

  return collectQuery(opts.prompt, buildSdkOptions(opts, cwd), opts.logLabel);
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
        console.error("[openPR] Failed to create PR:", err);
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

async function runNoPRAgent(opts: NoPRAgentOptions): Promise<Omit<AgentResult, "prUrl" | "branch">> {
  return collectAgent(
    { ...opts, originBranch: opts.originBranch ?? "main" } as AgentOptions,
    opts.cwd ?? resolvePath(opts.project),
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
 * starting or killing a dev server. The caller controls permissions via
 * `opts.agentMode`.
 */
export async function queryAgentTask(
  opts: NoPRAgentOptions & { cwd?: string },
): Promise<Omit<AgentResult, "prUrl" | "branch">> {
  return runNoPRAgent(opts);
}
