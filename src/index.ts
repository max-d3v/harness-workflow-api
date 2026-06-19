import express from "express";
import type { Request, Response } from "express";
import { requireTokenAuth } from "./auth.ts";
import { openPR, queryAgentInNewWorktree, type AgentOptions } from "./agent.ts";
import { resolveProviderDefaults } from "./config.ts";
import { MODES } from "./modes/index.ts";
import { log } from "./logging.ts";
import { startRunTelemetry } from "./telemetry.ts";

const app = express();
app.use(express.json());

const PORT = Number(process.env.PORT) || 3000;

function isClientInputError(err: unknown): err is Error {
  return err instanceof Error
    && (err.message.startsWith("Missing required field:")
      || err.message.startsWith("Invalid QA url:"));
}

app.get("/health", (_req: Request, res: Response) => {
  res.json({ status: "ok", runtime: "bun", functions: Object.keys(MODES) });
});

app.use(requireTokenAuth);

app.post("/prompt", async (req: Request, res: Response) => {
  const body = req.body as AgentOptions;
  const requestedProvider = body.cli ?? body.provider ?? "claude";
  const telemetry = startRunTelemetry({
    mode: "prompt",
    provider: requestedProvider,
    project: typeof body.project === "string" ? body.project : undefined,
  });
  const originBranch = body.originBranch;
  if (!body.prompt || typeof body.prompt !== "string") {
    await telemetry.finish({
      status: "failed",
      error: new Error("Missing required field: prompt"),
    });
    res.status(400).json({ error: "Missing required field: prompt" });
    return;
  }
  if (!body.project || typeof body.project !== "string") {
    await telemetry.finish({
      status: "failed",
      error: new Error("Missing required field: project"),
    });
    res.status(400).json({ error: "Missing required field: project" });
    return;
  }
  if (!originBranch || typeof originBranch !== "string") {
    await telemetry.finish({
      status: "failed",
      error: new Error("Missing required field: originBranch"),
      project: body.project,
    });
    res.status(400).json({ error: "Missing required field: originBranch" });
    return;
  }

  const ac = new AbortController();
  log(
    "POST /prompt",
    `request started: provider=${requestedProvider} project=${body.project} originBranch=${originBranch}`,
  );

  let cleanupWorktree: () => Promise<void> = async () => {};
  try {
    const defaults = resolveProviderDefaults("prompt", body);
    const agentRun = await queryAgentInNewWorktree({
      ...body,
      originBranch,
      cli: defaults.provider,
      model: defaults.model,
      effort: defaults.effort,
      agentMode: "prompt",
      access: body.access ?? "all-access",
      abortController: ac,
    });
    cleanupWorktree = agentRun.cleanup;

    let prUrl: string | undefined;
    if (!body.skipPR) {
      const title = body.prTitle ?? `agent: ${body.prompt.slice(0, 60)}`;
      try {
        prUrl = await openPR(agentRun.worktree, title, agentRun.result.slice(0, 4000));
      } catch (err) {
        log("openPR", "failed to create PR:", err);
      }
    }

    const { cleanup, worktree, cwd, worktreePath, ...result } = agentRun;
    log(
      "POST /prompt",
      `request succeeded: branch=${result.branch ?? "(none)"} prUrl=${prUrl ?? "(skipped)"}`,
    );
    await telemetry.finish({
      status: "success",
      result,
      provider: defaults.provider,
      model: result.model,
      project: body.project,
    });
    res.json({ ...result, prUrl });
  } catch (err: any) {
    if (ac.signal.aborted) {
      log("POST /prompt", "request cancelled");
      await telemetry.finish({
        status: "cancelled",
        error: err,
        project: body.project,
      });
      if (!res.headersSent) res.status(499).json({ error: "Request cancelled" });
      return;
    }
    log("POST /prompt", "request failed:", err);
    await telemetry.finish({
      status: "failed",
      error: err,
      project: body.project,
    });
    res.status(500).json({ error: err.message ?? "Internal server error" });
  } finally {
    await cleanupWorktree().catch((cleanupErr) =>
      log("POST /prompt", "failed to clean up prompt worktree:", cleanupErr),
    );
  }
});

app.post("/mode/:name", async (req: Request, res: Response) => {
  const rawModeName = req.params.name;
  const modeName = Array.isArray(rawModeName) ? (rawModeName[0] ?? "") : (rawModeName ?? "");
  const body = req.body as Partial<AgentOptions> & { pr?: string | number };
  const telemetry = startRunTelemetry({
    mode: modeName,
    provider: body.cli ?? body.provider ?? "claude",
    project: typeof body.project === "string" ? body.project : undefined,
    pr: typeof body.pr === "string" || typeof body.pr === "number" ? body.pr : undefined,
  });
  const fn = MODES[modeName as keyof typeof MODES];
  if (!fn) {
    await telemetry.finish({
      status: "failed",
      error: new Error(`Unknown function: ${modeName}`),
    });
    res.status(404).json({ error: `Unknown function: ${modeName}` });
    return;
  }

  const ac = new AbortController();
  log(`POST /mode/${modeName}`, "request started");

  try {
    const result = await fn(req.body, ac);
    log(`POST /mode/${modeName}`, "request succeeded");
    await telemetry.finish({
      status: "success",
      result,
      project: typeof body.project === "string" ? body.project : undefined,
      pr: typeof body.pr === "string" || typeof body.pr === "number" ? body.pr : undefined,
    });
    res.json(result);
  } catch (err: any) {
    if (ac.signal.aborted) {
      log(`POST /mode/${modeName}`, "request cancelled");
      await telemetry.finish({
        status: "cancelled",
        error: err,
        project: typeof body.project === "string" ? body.project : undefined,
        pr: typeof body.pr === "string" || typeof body.pr === "number" ? body.pr : undefined,
      });
      if (!res.headersSent) res.status(499).json({ error: "Request cancelled" });
      return;
    }
    log(`POST /mode/${modeName}`, "request failed:", err);
    await telemetry.finish({
      status: "failed",
      error: err,
      project: typeof body.project === "string" ? body.project : undefined,
      pr: typeof body.pr === "string" || typeof body.pr === "number" ? body.pr : undefined,
    });
    res.status(isClientInputError(err) ? 400 : 500).json({ error: err.message ?? "Internal server error" });
  }
});

const server = app.listen(PORT, () => {
  console.log(`
  Claude Harness API — http://localhost:${PORT}
  Auth: Bearer token + Claude CLI OAuth or Codex CLI | Runtime: Bun ${Bun.version}

  POST /prompt       Run agent in worktree → commit → push → PR
  POST /mode/:name   Specific mode (${Object.keys(MODES).join(", ")})
  GET  /health       Status
  `);
});

let shutdownInProgress = false;

process.on("SIGINT", () => {
  if (shutdownInProgress) {
    log("shutdown", "received SIGINT while shutdown is already running; exiting");
    process.exit(130);
  }

  shutdownInProgress = true;
  log("shutdown", "received SIGINT; closing server");

  server.close(() => {
    process.exit(130);
  });
});
