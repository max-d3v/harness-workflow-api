import { collectClaudeSdk } from "./claude.ts";
import { collectCodexSdk } from "./codex.ts";
import { log } from "../logging.ts";
import type { AgentCli, AgentOptions, AgentRunResult } from "../agent-types.ts";

export function resolveAgentCli(opts: Pick<AgentOptions, "cli" | "provider">): AgentCli {
  return opts.cli ?? opts.provider ?? "claude";
}

export async function collectAgent(opts: AgentOptions, cwd: string): Promise<AgentRunResult> {
  switch (resolveAgentCli(opts)) {
    case "codex":
      if (opts.mcpServers) {
        log(
          "agent",
          "request warning: Codex SDK does not receive per-run MCP server config; using local Codex configuration.",
        );
      }
      if (opts.allowedTools) {
        log(
          "agent",
          "request warning: Codex SDK does not receive per-run tools; using local Codex configuration.",
        );
      }
      return collectCodexSdk(opts, cwd);
    case "claude":
      return collectClaudeSdk(opts, cwd);
  }
}
