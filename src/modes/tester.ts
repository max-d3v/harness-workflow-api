import {
  queryAgentInLocalCheckout,
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
  getOrCreatePRHeadBranchCwd,
} from "../git.ts";
import {
  beginPullRequestRun,
  isSupersededPullRequestRun,
} from "../pr-run-controller.ts";
import type { McpServerConfig } from "@anthropic-ai/claude-agent-sdk";
import { promisify } from "node:util";
import { spawn } from "node:child_process";
import { z } from "zod";
import treeKill from "tree-kill";
import { imageServer } from "../tools/screenshot-upload.ts";
import { parseJsonBlock } from "../lib/output-parser.ts";
import { resolveTesterSystemPrompt } from "../providers/index.ts";

const githubEnv = process.env.GITHUB_TOKEN_USER;

interface CodeTestInput {
  // Repo path (worktree or local checkout). Required: the PR diff/comment
  // need a real git checkout, and it's where the dev server boots when no
  // `url` is given.
  project: string;
  pr: string | number;
  url?: string;
  focus?: string;
  loginInstructions?: string;
  cli?: AgentCli;
  provider?: AgentCli;
  model?: string;
  serverModel?: string;
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

const SERVER_INITIATOR_SYSTEM_PROMPT = `
You identify the exact dev-server command(s) this harness should execute so another agent can drive the app in a browser.
You will receive the diff stat (list of changed files) from the PR under test.
Use it to detect which parts of the system need to run together.

Rules:
- Prefer existing project instructions/commands in README or package scripts.
- In monorepos, prefer a root script that starts services together.
- If a root script named dev:app, dev:web, dev:local, app:dev, start:app, or similar clearly targets the affected app, use that instead of plain dev.
- Use plain dev only when no more specific suitable script exists.
- Detect package manager in this order:
  bun.lock or bun.lockb -> bun
  pnpm-lock.yaml -> pnpm
  yarn.lock -> yarn
  package-lock.json -> npm
  otherwise npm
- Do not include dependency install commands.
- Do not run commands, install dependencies, open ports, curl URLs, or start a server yourself. Your only job is to return the command plan.
- Use shell command strings exactly as they should be executed by \`sh -lc\`.
- Set \`url\` to the expected local app URL. Set \`ports\` too when ports are knowable from scripts, config, docs, or framework defaults.
- Commands always run from the repository cwd provided in the request. Do not include cwd or env fields.

Output ONLY a final fenced json block, nothing before or after it:
\`\`\`json
{
  "commands": [
    { "name": "web", "command": "bun run dev:app" }
  ],
  "url": "http://localhost:3000",
  "ports": [3000]
}
\`\`\`
"commands" should contain only long-running processes that should be killed after testing.`;




interface DevServer {
  id: string;
  cwd: string;
  commands: string[];
  url: string;
  pids: number[];
  ports?: number[];
}

const portSchema = z.number().int().positive().max(65535);

const devServerCommandPlanSchema = z.object({
  commands: z.array(z.object({
    name: z.string().optional(),
    command: z.string().trim().min(1),
  }).strict()).nonempty(),
  url: z.string().trim().min(1),
  ports: z.array(portSchema).nonempty().optional(),
}).strict();

type DevServerCommandPlan = z.infer<typeof devServerCommandPlanSchema>;

const activeDevServers = new Map<string, DevServer>();
let nextDevServerId = 1;


async function startDevServer(
  project: string,
  diffStat: string,
  opts: Pick<CodeTestInput, "cli" | "provider" | "serverModel" | "effort"> & {
    abortController: AbortController;
  },
): Promise<DevServer> {
  const defaults = resolveProviderDefaults("qa_dev_server", {
    ...opts,
    model: opts.serverModel,
  });
  const prompt = `Return the dev-server command plan for the project

## Changed files (diff stat)
\`\`\`
${diffStat}
\`\`\``


  const { result } = await queryAgentInLocalCheckout({
    prompt,
    project,
    cwd: project,
    cli: defaults.provider,
    agentMode: "qa_dev_server",
    access: "read-only",
    systemPrompt: SERVER_INITIATOR_SYSTEM_PROMPT,
    model: defaults.model,
    effort: defaults.effort,
    maxTurns: 30,
    loadProjectSettings: true,
    logLabel: "codeTest:dev-server",
    abortController: opts.abortController,
  });

  logModel("codeTest:dev-server", defaults.provider, `dev-server agent result:\n${result}`);

  let plan: DevServerCommandPlan;
  try {
    plan = devServerCommandPlanSchema.parse(parseJsonBlock(result));
  } catch {
    throw new Error(`Could not parse dev-server command plan:\n${result}`);
  }

  return launchDevServer(project, plan);
}

function launchDevServer(cwd: string, plan: DevServerCommandPlan): DevServer {
  const id = `dev-server-${nextDevServerId++}`;
  const commands = plan.commands.map((command) => command.name ?? command.command);
  const server: DevServer = { id, cwd, commands, url: plan.url, pids: [], ports: plan.ports };
  registerDevServer(server);

  for (const command of plan.commands) {
    const child = spawn("sh", ["-lc", command.command], {
      cwd,
      detached: true,
      stdio: "ignore",
    });
    if (child.pid) server.pids.push(child.pid);
    child.unref();
    log("codeTest:dev-server", `started "${command.name ?? command.command}" pid=${child.pid ?? "?"}`);
  }

  return server;
}

const killTree = promisify(
  treeKill as (pid: number, signal: string, cb: (err?: Error) => void) => void,
);

function registerDevServer(server: DevServer): void {
  activeDevServers.set(server.id, server);
}

function unregisterDevServer(server: DevServer): void {
  activeDevServers.delete(server.id);
}

export async function killActiveDevServers(reason: string): Promise<void> {
  const servers = [...activeDevServers.values()];
  if (servers.length === 0) return;

  log(
    "codeTest:dev-server",
    `${reason}: stopping ${servers.length} active dev server${servers.length === 1 ? "" : "s"}`,
  );
  await Promise.all(servers.map((server) => killDevServer(server)));
}

async function killDevServer(server: DevServer): Promise<void> {
  const targets = new Set<number>(server.pids.filter((n) => n > 0));
  if (targets.size === 0) {
    log("codeTest", "No PID to stop the dev server with");
    unregisterDevServer(server);
    return;
  }

  try {
    for (const pid of targets) await killTree(pid, "SIGTERM").catch(() => { });
    await new Promise((r) => setTimeout(r, 3000));
    for (const pid of targets) await killTree(pid, "SIGKILL").catch(() => { });
  } finally {
    unregisterDevServer(server);
  }
}

export async function codeTest(input: CodeTestInput, controller: AbortController) {
  if (!input.project) throw new Error("Missing required field: project");
  if (!input.pr) throw new Error("Missing required field: pr");

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

  
  let cleanupPRHeadBranchCwd: () => Promise<void> = async () => {};
  const throwIfCancelled = () => {
    if (run.signal.aborted) {
      throw run.signal.reason ?? new Error("Automated QA cancelled");
    }
  };
  let devServer: DevServer | null = null;

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
    const prHeadBranchContext = await getOrCreatePRHeadBranchCwd({
      cwd: project,
      initialBranch,
      pullRequest: prInfo,
    });
    cleanupPRHeadBranchCwd = prHeadBranchContext.cleanup;
    const { prHeadBranchCwd } = prHeadBranchContext;
    throwIfCancelled();


    let testUrl: string;
    
    if (input.url) {
      testUrl = input.url;
    } else {
      devServer = await startDevServer(prHeadBranchCwd, stat, { ...input, abortController: run.controller });
      testUrl = devServer.url;
    }
    throwIfCancelled();

    const { loginInstructions } = input
    const loginInstructionsPrompt = `If you need to login into the app, use the following instructions: ${loginInstructions}`
    const focus = input.focus ? `\nFocus area: ${input.focus}` : "";
    const prompt = `Repository: ${prInfo.owner}/${prInfo.repo}
PR #${prInfo.number}: "${prInfo.title}" (${prInfo.headBranch} → ${prInfo.baseBranch}).
The app is running at: ${testUrl}${focus}
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
    const cleanupResolvedPRHeadBranchCwd = cleanupPRHeadBranchCwd;
    cleanupPRHeadBranchCwd = async () => {
      try {
        await testerRun.cleanup();
      } finally {
        await cleanupResolvedPRHeadBranchCwd();
      }
    };
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
    if (devServer) await killDevServer(devServer);
    await cleanupPRHeadBranchCwd().catch((cleanupErr) =>
      log("codeTest", "failed to clean up PR head branch worktree:", cleanupErr),
    );
    run.finish();
  }
}
