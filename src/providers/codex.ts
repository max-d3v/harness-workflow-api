import {
  Codex,
  type ModelReasoningEffort,
  type ReasoningItem,
  type SandboxMode,
  type ThreadEvent,
} from "@openai/codex-sdk";
import { show_model_actions } from "../config.ts";
import { logModel, log } from "../logging.ts";
import type { AgentMode, AgentOptions, AgentRunResult, TokenUsage } from "../agent-types.ts";

const CODEX_SANDBOX_BY_MODE: Record<AgentMode, SandboxMode> = {
  prompt: "danger-full-access",
  code_review: "read-only",
  qa_dev_server: "read-only",
  qa_tester: "read-only",
};

// OPENAI greedy asses dont let me pass my own mcp and tools into the codex execution... im stuck with the users local configuration (WHICH IS ASSSS FROM A BUTTT)
// Ill need to use skills so the codex model can browse, use gstack browser skill to test ts 

function resolveAgentMode(opts: Pick<AgentOptions, "agentMode">): AgentMode {
  return opts.agentMode ?? "prompt";
}

function codexSandboxFor(opts: Pick<AgentOptions, "agentMode">): SandboxMode {
  return CODEX_SANDBOX_BY_MODE[resolveAgentMode(opts)];
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

function textFromUnknown(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value
      .map(textFromUnknown)
      .filter((text): text is string => Boolean(text?.trim()))
      .join(" ");
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return textFromUnknown(record.text ?? record.summary ?? record.content);
  }
}

function summarizeCodexReasoningItem(item: ReasoningItem): string | undefined {
  const record = item as ReasoningItem & Record<string, unknown>;
  return textFromUnknown(
    record.text ?? record.summary ?? record.raw_reasoning ?? record.reasoning ?? record.content,
  );
}

function clip(s: string, n = 1500): string {
  s = s.replace(/\s+/g, " ").trim();
  return s.length > n ? `${s.slice(0, n)}…(+${s.length - n} chars)` : s;
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
        case "reasoning": {
          const reasoning = summarizeCodexReasoningItem(item);
          return reasoning ? `${prefix} reasoning: ${clip(reasoning, 2000)}` : `${prefix} reasoning`;
        }
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

function logGithubCommentEvent(event: ThreadEvent, logLabel?: string): void {
  switch (event.type) {
    case "item.started":
    case "item.updated":
    case "item.completed": {
      const item = event.item;
      if (item.type !== "mcp_tool_call") return;
      if (item.server !== "github" || item.tool !== "add_issue_comment") return;

      const prefix = event.type.replace("item.", "");
      log(logLabel ?? "codex", `PR comment ${prefix} via MCP: status=${item.status}`);
    }
  }
}

export async function collectCodexSdk(opts: AgentOptions, cwd: string): Promise<AgentRunResult> {
  const codex = new Codex({
    config: {
      show_raw_agent_reasoning: show_model_actions,
    },
  });
  
  const thread = codex.startThread({
    workingDirectory: cwd,
    model: opts.model,
    sandboxMode: codexSandboxFor(opts),
    approvalPolicy: "never",
    modelReasoningEffort: codexReasoningEffortFor(opts.effort),
    skipGitRepoCheck: true,
  });
  const { events } = await thread.runStreamed(buildCodexPrompt(opts.prompt, opts.systemPrompt), {
    signal: opts.abortController.signal,
  });

  let result = "";
  let usage: TokenUsage | undefined;
  let totalTokens: number | undefined;

  for await (const event of events) {
    logGithubCommentEvent(event, opts.logLabel);
    logModel(opts.logLabel, "codex", summarizeCodexEvent(event));
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
