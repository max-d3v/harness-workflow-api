import { query } from "@anthropic-ai/claude-agent-sdk";
import { logModel, log } from "../logging.ts";
import type { AgentAccess, AgentMode, AgentOptions, AgentRunResult, TokenUsage } from "../agent-types.ts";
import { DEFAULT_MAX_TURNS } from "../agent-types.ts";

const CLAUDE_CODE_PRESET = { type: "preset" as const, preset: "claude_code" as const };

const CLAUDE_TOOLS_BY_ACCESS: Record<AgentAccess, AgentOptions["tools"]> = {
  "all-access": CLAUDE_CODE_PRESET,
  "read-only": ["Read", "Glob", "Grep"],
};

function resolveAgentMode(opts: Pick<AgentOptions, "agentMode">): AgentMode {
  return opts.agentMode ?? "prompt";
}

function defaultAccessForMode(mode: AgentMode): AgentAccess {
  return mode === "prompt" ? "all-access" : "read-only";
}

function claudeToolsFor(opts: Pick<AgentOptions, "access" | "agentMode" | "tools">): AgentOptions["tools"] {
  if (opts.tools) return opts.tools;
  if (opts.access) return CLAUDE_TOOLS_BY_ACCESS[opts.access];
  return CLAUDE_TOOLS_BY_ACCESS[defaultAccessForMode(resolveAgentMode(opts))];
}

function buildSdkOptions(opts: AgentOptions, cwd: string) {
  return {
    tools: claudeToolsFor(opts),
    permissionMode: "bypassPermissions" as const,
    allowDangerouslySkipPermissions: true,
    model: opts.model,
    thinking: { type: "adaptive" as const },
    effort: opts.effort,
    maxTurns: opts.maxTurns ?? DEFAULT_MAX_TURNS,
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
          parts.push(`thinking: ${clip(b.thinking, 1000)}`);
        else if (b.type === "tool_use")
          parts.push(`tool_use ${b.name}(${clip(JSON.stringify(b.input ?? {}), 500)})`);
      }
      return `assistant -> ${parts.join(" | ") || "(empty)"}`;
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
      return parts.length ? `user <- ${parts.join(" | ")}` : undefined;
    }
    default:
      return undefined;
  }
}

function isGithubCommentToolName(name: unknown): boolean {
  return typeof name === "string" && name.includes("github") && name.includes("add_issue_comment");
}

function summarizeGithubCommentInput(input: unknown): string {
  if (!input || typeof input !== "object") return "";
  const record = input as Record<string, unknown>;
  const owner = typeof record.owner === "string" ? record.owner : undefined;
  const repo = typeof record.repo === "string" ? record.repo : undefined;
  const issueNumber =
    typeof record.issue_number === "number" || typeof record.issue_number === "string"
      ? record.issue_number
      : undefined;
  const body = typeof record.body === "string" ? record.body : "";
  const target = owner && repo && issueNumber ? `${owner}/${repo}#${issueNumber}` : undefined;
  return `${target ? `target=${target} ` : ""}chars=${body.length}`;
}

function logGithubCommentToolEvents(
  msg: any,
  pendingGithubCommentToolIds: Set<string>,
  logLabel?: string,
): void {
  const scope = logLabel ?? "claude";
  for (const block of msg?.message?.content ?? []) {
    if (block?.type === "tool_use" && isGithubCommentToolName(block.name)) {
      if (typeof block.id === "string") pendingGithubCommentToolIds.add(block.id);
      log(scope, `PR comment requested via MCP: ${summarizeGithubCommentInput(block.input)}`);
    }
    if (block?.type === "tool_result" && pendingGithubCommentToolIds.has(block.tool_use_id)) {
      pendingGithubCommentToolIds.delete(block.tool_use_id);
      const status = block.is_error ? "failed" : "posted";
      log(scope, `PR comment ${status} via MCP`);
    }
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

export async function collectClaudeSdk(opts: AgentOptions, cwd: string): Promise<AgentRunResult> {
  let result = "";
  let sessionId: string | undefined;
  let model: string | undefined;
  let usage: TokenUsage | undefined;
  let totalTokens: number | undefined;
  let totalCostUsd: number | undefined;
  let round = 0;
  const pendingGithubCommentToolIds = new Set<string>();

  for await (const msg of query({ prompt: opts.prompt, options: buildSdkOptions(opts, cwd) })) {
    sessionId ??= extractSessionId(msg);
    model ??= extractModel(msg);
    logGithubCommentToolEvents(msg, pendingGithubCommentToolIds, opts.logLabel);

    const summary = summarizeMessage(msg);
    if (summary) {
      round += 1;
      logModel(opts.logLabel, "claude", `round ${round}: ${summary}`);
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

  model ??= opts.model;
  return { result, sessionId, model, totalTokens, usage, totalCostUsd };
}
