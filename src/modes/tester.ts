import { queryAgentReadOnly, queryAgentTask, resolvePath } from "../agent.js";
import { getPRInfo, getPRDiff, getPRDiffStat, commentOnPR } from "../git.js";
import type { McpServerConfig } from "@anthropic-ai/claude-agent-sdk";
import { promisify } from "node:util";
import treeKill from "tree-kill";
import { $ } from "bun";


interface CodeTestInput {
  // Repo path (worktree or local checkout). Required: the PR diff/comment
  // need a real git checkout, and it's where the dev server boots when no
  // `url` is given.
  project: string;
  pr: string | number;
  url?: string;
  focus?: string;
}

const TESTER_TOOLS = ["Read", "Glob", "Grep"];
const SERVER_AGENT_TOOLS = ["Bash", "Read", "Glob", "Grep"];

const PLAYWRIGHT_MCP: Record<string, McpServerConfig> = {
  playwright: {
    command: "npx",
    args: ["-y", "@playwright/mcp@latest", "--headless", "--isolated"],
  },
};
const PLAYWRIGHT_ALLOWED = ["mcp__playwright"];

const SERVER_INITIATOR_SYSTEM_PROMPT = `You start a project's dev server so another agent can drive it in a browser.

Steps:
1. Detect the package manager (bun.lockb→bun, pnpm-lock.yaml→pnpm, yarn.lock→yarn, else npm) and install dependencies.
2. Find the dev script (package.json "dev", else "start").
3. Start it DETACHED so it survives after you exit:
   nohup <pkgmgr> run dev > /tmp/devserver.log 2>&1 & echo $!
   then run \`disown\`.
4. Poll /tmp/devserver.log until the server prints a local URL and is reachable (curl -sf). Give up after ~90s.

Output ONLY a final fenced json block, nothing after it:
\`\`\`json
{ "url": "http://localhost:3000", "pids": [12345], "port": 3000 }
\`\`\`
"pids" = every PID in the server's process tree you can identify. If the server will not come up, set "url" to null and explain briefly before the json block.`;

const TESTER_SYSTEM_PROMPT = `You are a senior QA analyst doing end-to-end testing of a running web application.

You will receive a git diff from a pull request and a base URL where the app is running.
Use the Playwright browser tools to exercise the app:
- Test what the diff introduces or changes.
- Test areas the diff could plausibly affect (regressions).
- Probe edge cases that could slip through (empty/invalid input, auth boundaries, navigation, error states).

For each problem you find:
- Take a screenshot at the point of failure and reference it.
- Give exact, numbered steps to reproduce.
- State expected vs. actual behavior.
- Suggest a likely cause or fix.

You have READ-ONLY repo access (Read/Glob/Grep) for context only — do not attempt to edit code.
Format the result as a structured markdown comment suitable for posting on the PR.
Lead with the most impactful findings, skip praise. If you found no issues, say so briefly and list what you exercised.`;

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

async function startDevServer(project: string): Promise<DevServer> {
  const { result } = await queryAgentTask({
    prompt: `Start the dev server for the project in this directory: ${project}`,
    project,
    cwd: project,
    systemPrompt: SERVER_INITIATOR_SYSTEM_PROMPT,
    tools: SERVER_AGENT_TOOLS,
    model: "claude-sonnet-4-6",
    effort: "high",
    maxTurns: 30,
    loadProjectSettings: true,
  });

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

// No agent: we already know the PIDs/port, so killing is deterministic.
// tree-kill walks and kills the whole process tree — dev servers spawn
// children (npm→node→vite) that orphan if only the parent is killed — and
// is cross-OS (taskkill /T on Windows, recursive ps on POSIX). The port
// sweep is a fallback for when the captured PID was a wrapper, not the
// process actually bound to the port.
async function killDevServer(server: DevServer): Promise<void> {
  const targets = new Set<number>(server.pids.filter((n) => n > 0));
  if (server.port) {
    try {
      for (const pid of await pidsOnPort(server.port)) targets.add(pid);
    } catch {}
  }
  if (targets.size === 0) {
    console.error("[codeTest] No PID or port to stop the dev server with");
    return;
  }

  for (const pid of targets) await killTree(pid, "SIGTERM").catch(() => {});
  await new Promise((r) => setTimeout(r, 3000));
  for (const pid of targets) await killTree(pid, "SIGKILL").catch(() => {});
}

export async function codeTest(input: CodeTestInput) {
  if (!input.project) throw new Error("Missing required field: project");
  if (!input.pr) throw new Error("Missing required field: pr");

  const project = resolvePath(input.project);

  const [prInfo, diff, stat] = await Promise.all([
    getPRInfo(project, input.pr),
    getPRDiff(project, input.pr),
    getPRDiffStat(project, input.pr),
  ]);

  if (!diff) {
    return { result: "No changes found in PR", prUrl: prInfo.url };
  }

  let server: DevServer | null = null;
  let testUrl: string;
  if (input.url) {
    testUrl = input.url;
  } else {
    server = await startDevServer(project);
    testUrl = server.url;
  }

  try {
    const focus = input.focus ? `\nFocus area: ${input.focus}` : "";
    const prompt = `Test PR #${prInfo.number}: "${prInfo.title}" (${prInfo.headBranch} → ${prInfo.baseBranch}).
The app is running at: ${testUrl}${focus}

## Diff stat
\`\`\`
${stat}
\`\`\`

## Full diff
\`\`\`diff
${diff}
\`\`\``;

    const { result, sessionId } = await queryAgentReadOnly({
      prompt,
      project,
      systemPrompt: TESTER_SYSTEM_PROMPT,
      tools: TESTER_TOOLS,
      mcpServers: PLAYWRIGHT_MCP,
      allowedTools: PLAYWRIGHT_ALLOWED,
      model: "claude-sonnet-4-6",
      effort: "high",
      maxTurns: 40,
      loadProjectSettings: true,
    });

    await commentOnPR(project, input.pr, result);

    return { result, sessionId, prUrl: prInfo.url, prNumber: prInfo.number };
  } finally {
    if (server) await killDevServer(server);
  }
}
