import type { McpServerConfig } from "@anthropic-ai/claude-agent-sdk";

export type AgentCli = "claude" | "codex";
export type AgentMode = "prompt" | "code_review" | "qa_dev_server" | "qa_tester";

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
  /** When set, streamed model actions are logged with this prefix. */
  logLabel?: string;
  /** When provided, aborting this controller cancels the running query. */
  abortController: AbortController;
}

export interface TokenUsage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
  reasoning_output_tokens?: number;
}

export interface AgentRunResult {
  result: string;
  sessionId?: string;
  /** Model the SDK actually ran with for this query. */
  model?: string;
  /** Sum of reported token counters for the run. */
  totalTokens?: number;
  usage?: TokenUsage;
  /** Cumulative USD cost reported by the SDK for the run. */
  totalCostUsd?: number;
}

export interface AgentResult extends AgentRunResult {
  prUrl?: string;
  branch?: string;
}

export const DEFAULT_MAX_TURNS = 30;
