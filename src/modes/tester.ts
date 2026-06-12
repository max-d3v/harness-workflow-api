import {
  queryAgentInPRWorktree,
  resolvePath,
  type AgentCli,
  type AgentOptions,
} from "../agent.ts";
import { resolveProviderDefaults } from "../config.ts";
import { log, logModel } from "../logging.ts";
import {
  getPRInfo,
  getPRDiff,
  getPRDiffStat,
  commentOnPR,
  getCurrentBranch,
} from "../git.ts";
import {
  beginPullRequestRun,
  isSupersededPullRequestRun,
} from "../pr-run-controller.ts";
import type { McpServerConfig } from "@anthropic-ai/claude-agent-sdk";
import { imageServer } from "../tools/screenshot-upload.ts";
import { resolveTesterSystemPrompt } from "../providers/index.ts";

const githubEnv = process.env.GITHUB_TOKEN_USER;

interface CodeTestInput {
  // Repo path (worktree or local checkout). Required because PR diff/comment
  // operations need a real git checkout.
  project: string;
  pr: string | number;
  url?: string;
  urls?: string[];
  focus?: string;
  loginInstructions?: string;
  cli?: AgentCli;
  provider?: AgentCli;
  model?: string;
  effort?: AgentOptions["effort"];
}

function buildMcpServers(): Record<string, McpServerConfig> {
  if (!githubEnv) {
    throw new Error("GITHUB_TOKEN is required for /mode/code-test so the QA agent can post PR comments.");
  }

  return {
    playwright: {
      command: "npx",
      args: ["-y", "@playwright/mcp@latest", "--headless", "--isolated"],
    },
    imageUploader: imageServer,
    github: {
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-github"],
      env: {
        GITHUB_PERSONAL_ACCESS_TOKEN: githubEnv,
      },
    },
  };
}
const MCP_TOOLS_ALLOWED = ["mcp__playwright", "mcp__imageUploader", "mcp__github__add_issue_comment"];

function resolveTargetUrls(input: CodeTestInput): string[] {
  const urls = [
    ...(typeof input.url === "string" ? [input.url] : []),
    ...(Array.isArray(input.urls) ? input.urls : []),
  ]
    .map((url) => url.trim())
    .filter(Boolean);

  const invalidUrl = urls.find((url) => {
    try {
      const parsed = new URL(url);
      return parsed.protocol !== "http:" && parsed.protocol !== "https:";
    } catch {
      return true;
    }
  });

  if (invalidUrl) {
    throw new Error(`Invalid QA url: ${invalidUrl}. Pass absolute http(s) url values.`);
  }
  if (urls.length === 0) {
    throw new Error("Missing required field: url or urls. QA mode requires functional app URL(s).");
  }

  return [...new Set(urls)];
}

export async function codeTest(input: CodeTestInput, controller: AbortController) {
  if (!input.project) throw new Error("Missing required field: project");
  if (!input.pr) throw new Error("Missing required field: pr");
  const testUrls = resolveTargetUrls(input);

  const project = resolvePath(input.project);
  const requestedProvider = input.cli ?? input.provider ?? "claude";
  const run = beginPullRequestRun({
    kind: "code-test",
    project,
    pr: input.pr,
    controller,
  });
  log("codeTest", `request started: testing PR ${input.pr} in ${project}`);
  if (requestedProvider === "codex") {
    log("codeTest", "request warning: automated QA does not currently work with Codex; use Claude for code-test.");
  }

  let cleanupTesterRun: () => Promise<void> = async () => {};
  const throwIfCancelled = () => {
    if (run.signal.aborted) {
      throw run.signal.reason ?? new Error("Automated QA cancelled");
    }
  };
  try {
    const codexWarning =
      requestedProvider === "codex"
        ? `\n\n**Warning:** automated QA does not currently work with Codex. Use Claude for code-test until Codex QA support is fixed.`
        : "";
    const startComment = (run.replacedExisting
      ? `♻️ **New QA Run Started.**\n\nA newer automated QA run was requested for this PR, so the older run was cancelled and this new QA run is starting now.`
      : `🧪 **Automated QA started.**`) + codexWarning;
    await commentOnPR(project, input.pr, startComment).catch((commentErr) =>
      log("codeTest", "failed to post start comment:", commentErr),
    );
    throwIfCancelled();

    const [prInfo, diff, stat] = await Promise.all([
      getPRInfo(project, input.pr),
      getPRDiff(project, input.pr),
      getPRDiffStat(project, input.pr),
    ]);
    throwIfCancelled();

    if (!diff) {
      log("codeTest", `request succeeded: PR #${prInfo.number} has no changes; skipping`);
      return { result: "No changes found in PR", prUrl: prInfo.url };
    }

    const initialBranch = await getCurrentBranch(project);
    throwIfCancelled();

    const { loginInstructions } = input;
    const loginInstructionsPrompt = `If you need to login into the app, use the following instructions: ${loginInstructions}`;
    const focus = input.focus ? `\nFocus area: ${input.focus}` : "";
    const targetUrlsPrompt = testUrls.map((url) => `- ${url}`).join("\n");
    const prompt = `Repository: ${prInfo.owner}/${prInfo.repo}
PR #${prInfo.number}: "${prInfo.title}" (${prInfo.headBranch} → ${prInfo.baseBranch}).
The app is already running at the following URL(s). Use these URLs for browser testing:
${targetUrlsPrompt}${focus}
${loginInstructions ? loginInstructionsPrompt : ""}


## Diff stat
\`\`\`
${stat}
\`\`\`

## Full diff
\`\`\`diff
${diff}
\`\`\`

`;

    const defaults = resolveProviderDefaults("qa", input);
    const testerRun = await queryAgentInPRWorktree({
      prompt,
      project,
      pullRequest: prInfo,
      initialBranch,
      cli: defaults.provider,
      agentMode: "qa_tester",
      access: "read-only",
      systemPrompt: resolveTesterSystemPrompt(defaults.provider),
      mcpServers: buildMcpServers(),
      allowedTools: MCP_TOOLS_ALLOWED,
      model: defaults.model,
      effort: defaults.effort,
      maxTurns: 210,
      loadProjectSettings: true,
      logLabel: "codeTest:tester",
      abortController: run.controller,
    });
    cleanupTesterRun = testerRun.cleanup;
    const { result, sessionId, model, totalTokens, usage, totalCostUsd } = testerRun;
    throwIfCancelled();

    logModel("codeTest:tester", defaults.provider, `tester agent result:\n${result}`);

    await commentOnPR(
      project,
      input.pr,
      `🏁 **Automated testing finished.**\n\nThe tester agent has completed exercising this PR. Individual findings are posted as separate comments above.`,
    ).catch((commentErr) =>
      log("codeTest", "failed to post completion comment:", commentErr),
    );

    log("codeTest", `request succeeded: tested PR #${prInfo.number}`);
    return { result, sessionId, prUrl: prInfo.url, prNumber: prInfo.number, model, totalTokens, usage, totalCostUsd };
  } catch (err) {
    if (isSupersededPullRequestRun(run.signal)) {
      log("codeTest", `request stopped: PR ${input.pr} QA superseded by a newer request`);
      return {
        result: "Automated QA stopped because a newer QA run was requested for this PR.",
        stopped: true,
      };
    }
    if (run.signal.aborted) {
      log("codeTest", `request cancelled: PR ${input.pr} QA cancelled`);
      throw err;
    }

    const message = err instanceof Error ? (err.stack ?? err.message) : String(err);
    log("codeTest", `request failed:\n${message}`);
    await commentOnPR(
      project,
      input.pr,
      `⚠️ **Automated testing failed to complete.**\n\nThe tester agent threw before it could finish exercising this PR, so the findings above (if any) may be incomplete.\n\n\`\`\`\n${message}\n\`\`\``,
    ).catch((commentErr) =>
      log("codeTest", "failed to post error comment:", commentErr),
    );
    throw err;
  } finally {
    await cleanupTesterRun().catch((cleanupErr) =>
      log("codeTest", "failed to clean up PR head branch worktree:", cleanupErr),
    );
    run.finish();
  }
}
