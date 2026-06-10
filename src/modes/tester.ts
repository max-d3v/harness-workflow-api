import { queryAgentReadOnly, queryAgentTask, resolvePath, type AgentCli, type AgentOptions } from "../agent.ts";
import { resolveProviderDefaults } from "../config.ts";
import { log, logModel } from "../logging.ts";
import {
  // getCurrentBranch,
  getPRInfo,
  getPRDiff,
  getPRDiffStat,
  commentOnPR,
  // resolvePRHeadBranchCwd,
} from "../git.ts";
import {
  beginPullRequestRun,
  isSupersededPullRequestRun,
  pullRequestRunKindLabel,
} from "../pr-run-controller.ts";
import type { McpServerConfig } from "@anthropic-ai/claude-agent-sdk";
import { promisify } from "node:util";
import treeKill from "tree-kill";
import { $ } from "bun";
import { imageServer } from "../tools/screenshot-upload.ts";

const githubEnv = process.env.MAX_TRAZO_GITHUB_TOKEN
if (!githubEnv) throw Error("No github token provided.")

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

const MCP_SERVERS: Record<string, McpServerConfig> = {
  playwright: {
    command: "npx",
    args: ["-y", "@playwright/mcp@latest", "--headless", "--isolated"],
  },
  imageUploader: imageServer,
  github: {
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-github"],
    env: {
      GITHUB_PERSONAL_ACCESS_TOKEN: githubEnv
    }
  }
};
const MCP_TOOLS_ALLOWED = ["mcp__playwright", "mcp__imageUploader", "mcp__github__add_issue_comment"];

const SERVER_INITIATOR_SYSTEM_PROMPT = `
You start a project's dev server so another agent can drive it in a browser.
You will receive the diff stat (list of changed files) from the PR under test.
Use it to detect which apps or services are needed to run to test the affected changes.
Be aware for apps that need multiple things to run, like a db + app. so always check root dev commands first.


Steps:
1. Read the diff stat to determine which part of the project changed.
2. Detect the package manager (bun.lockb→bun, pnpm-lock.yaml→pnpm, yarn.lock→yarn, else npm) and install dependencies.
3. Find the right dev script.
4. Start everything DETACHED so it survives after you exit:
   nohup <pkgmgr> run dev > /tmp/devserver.log 2>&1 & echo $!
   then run \`disown\`.
5. Poll /tmp/devserver.log until the server prints a local URL and is reachable (curl -sf). Give up after ~30s.

Output ONLY a final fenced json block, nothing after it:
\`\`\`json
{ "url": "http://localhost:3000", "pids": [12345], "port": 3000 }
\`\`\`
"pids" = every PID in the server's process tree you can identify. If the server will not come up, set "url" to null and explain briefly before the json block.`;


const SERVER_INITIATOR_SYSTEM_PROMPT_CODEX = `
You start the minimum necessary dev server(s) for a project so another agent can drive the app in a browser.

You will receive a PR diff stat. Use it to decide which app(s) or services are affected.

General rules:
- Prefer existing project instructions in README or package scripts.
- In monorepos, prefer a root script that starts the affected app and required local services together.
- If a root script named dev:app, dev:web, dev:local, app:dev, start:app, or similar clearly targets the affected app, use that instead of plain dev.
- Use plain dev only when no more specific suitable script exists.
- Do not start unrelated apps if a narrower project script exists.
- Detect package manager in this order:
  bun.lock or bun.lockb -> bun
  pnpm-lock.yaml -> pnpm
  yarn.lock -> yarn
  package-lock.json -> npm
  otherwise npm
- Install dependencies only if node_modules is missing or the package manager clearly requires it.
- Do not rerun the chosen command in foreground.


Steps:
1. Read the diff stat and inspect package.json files plus project docs to choose the right dev command.
2. Determine the working directory for the command. Prefer repo root for monorepo root scripts.
3. Start the command detached so it survives after you exit.
   Use a unique log path, e.g. /tmp/devserver-$RANDOM.log.
   Prefer:
   nohup sh -lc '<COMMAND>' > "$LOG" 2>&1 & echo $!
   Then run:
   disown || true
4. Poll the log for a local URL such as http://localhost:<port> or http://127.0.0.1:<port>.
5. If no URL is printed, infer likely ports from the command/framework/config, then try common ports: 3000, 3001, 5173, 4173, 8080, 8000.
6. Use curl -sf against the discovered URL until it responds or until about 30 seconds have passed.
7. Identify the root PID and any child PIDs you can find with pgrep -P recursively.

Output ONLY a final fenced json block, nothing after it:
\`\`\`json
{ "url": "http://localhost:3000", "pids": [12345], "port": 3000 }
\`\`\`
"pids" = every PID in the server's process tree you can identify. If the server will not come up, set "url" to null and explain briefly before the json block.`;


const TESTER_SYSTEM_PROMPT = `
You are a senior QA analyst doing end-to-end testing of a running web application.

You will receive a git diff from a pull request and a base URL where the app is running.
Your scope is the diff. Before touching the browser, read the
full diff and list (for yourself) the concrete user-facing behaviors it changes:
the specific screens, forms, flows, or data the changed lines actually run in.

Use your browser tools to exercise those behaviors:
- Test the exact behavior the diff introduces or changes, via the real UI path
  that hits the changed code.
- Test a regression ONLY when you can trace a direct code path from the diff to
  it (e.g. the diff renames a table/column that another screen reads or writes).
  State that link explicitly in the comment.
- Edge cases (empty/invalid input, error states) are in scope only for the
  inputs and flows the diff touches.

## Report as you go — do NOT write a final summary

Work through the app one functional area at a time. The moment you finish
exercising a section — whether it works correctly OR you found a problem —
report it immediately as its own PR comment, then move on. Do not batch
findings. Do not save anything for the end.

For EVERY section you exercise, in this exact order:
1. Take a screenshot of the relevant state (the working result, or the point
   of failure).
2. Upload that screenshot with your screenshot upload tool to get the
   github markdown image string.
3. add a issue comment in the given PR. for that section using your add issue comment tool, embedding
   the uploaded image markdown in the body.

Comment body for a WORKING section:
- ✅ What you tested and the steps you took.
- Confirmation it behaved as expected.
- The uploaded screenshot.

Comment body for a BROKEN section:
- ❌ Short title of the problem.
- Exact, numbered steps to reproduce.
- Expected vs. actual behavior.
- A likely cause or fix.
- The uploaded screenshot at the point of failure.

Keep each comment scoped to a single section so it stays readable on the PR.
Skip praise and filler — every comment should carry a screenshot and a
concrete result.

You have READ-ONLY repo access (Read/Glob/Grep) for context only — do not attempt to edit code.
Your final text response is not posted anywhere; it is only an internal log of which sections you covered.`;

interface DevServer {
  url: string;
  pids: number[];
  port?: number;
}

function parseJsonBlock(text: string): any {
  const fenced = text.match(/```json\s*([\s\S]*?)```/i);
  const candidate = fenced?.[1] ?? text.slice(text.lastIndexOf("{"));
  return JSON.parse(candidate.trim());
}

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
  const { result } = await queryAgentTask({
    prompt: `Start the dev server for the project

## Changed files (diff stat)
\`\`\`
${diffStat}
\`\`\``,
    project,
    cwd: project,
    cli: defaults.provider,
    agentMode: "qa_dev_server",
    systemPrompt: SERVER_INITIATOR_SYSTEM_PROMPT,
    model: defaults.model,
    effort: defaults.effort,
    maxTurns: 30,
    loadProjectSettings: true,
    logLabel: "codeTest:dev-server",
    abortController: opts.abortController,
  });

  logModel("codeTest:dev-server", defaults.provider, `dev-server agent result:\n${result}`);

  let parsed: { url: string | null; pids?: number[]; port?: number };
  try {
    parsed = parseJsonBlock(result);
  } catch {
    throw new Error(`Could not parse dev-server output:\n${result}`);
  }
  if (!parsed.url) throw new Error(`Dev server failed to start:\n${result}`);

  return { url: parsed.url, pids: parsed.pids ?? [], port: parsed.port };
}

const killTree = promisify(
  treeKill as (pid: number, signal: string, cb: (err?: Error) => void) => void,
);

async function pidsOnPort(port: number): Promise<number[]> {
  const cmd =
    process.platform === "win32"
      ? $`powershell -NoProfile -Command "(Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue).OwningProcess"`
      : $`lsof -ti tcp:${port} -sTCP:LISTEN`;
  const out = await cmd.nothrow().text();
  return [...new Set(out.split(/\s+/).map(Number).filter((n) => n > 0))];
}

async function killDevServer(server: DevServer): Promise<void> {
  const targets = new Set<number>(server.pids.filter((n) => n > 0));
  if (server.port) {
    try {
      for (const pid of await pidsOnPort(server.port)) targets.add(pid);
    } catch { }
  }
  if (targets.size === 0) {
    log("codeTest", "No PID or port to stop the dev server with");
    return;
  }

  for (const pid of targets) await killTree(pid, "SIGTERM").catch(() => { });
  await new Promise((r) => setTimeout(r, 3000));
  for (const pid of targets) await killTree(pid, "SIGKILL").catch(() => { });
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

  let server: DevServer | null = null;
  let cleanupPRHeadBranchCwd: () => Promise<void> = async () => {};
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

    const prHeadBranchCwd = project;
    // const initialBranch = await getCurrentBranch(project);
    // const prHeadBranchContext = await resolvePRHeadBranchCwd({
    //   cwd: project,
    //   initialBranch,
    //   pullRequest: prInfo,
    // });
    // cleanupPRHeadBranchCwd = prHeadBranchContext.cleanup;
    // const { prHeadBranchCwd } = prHeadBranchContext;
    throwIfCancelled();

    let testUrl: string;
    if (input.url) {
      testUrl = input.url;
    } else {
      server = await startDevServer(prHeadBranchCwd, stat, { ...input, abortController: run.controller });
      testUrl = server.url;
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
    const { result, sessionId, model, totalTokens, usage, totalCostUsd } = await queryAgentReadOnly({
      prompt,
      project: prHeadBranchCwd,
      cwd: prHeadBranchCwd,
      cli: defaults.provider,
      agentMode: "qa_tester",
      systemPrompt: TESTER_SYSTEM_PROMPT,
      mcpServers: MCP_SERVERS,
      allowedTools: MCP_TOOLS_ALLOWED,
      model: defaults.model,
      effort: defaults.effort,
      maxTurns: 210,
      loadProjectSettings: true,
      logLabel: "codeTest:tester",
      abortController: run.controller,
    });
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
    if (server) await killDevServer(server);
    await cleanupPRHeadBranchCwd().catch((cleanupErr) =>
      log("codeTest", "failed to clean up PR head branch worktree:", cleanupErr),
    );
    run.finish();
  }
}
