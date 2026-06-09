import express from "express";
import type { Request, Response } from "express";
import { queryAgent, type AgentOptions } from "./agent.ts";
import { MODES } from "./modes/index.ts";
import { log } from "./logging.ts";

const app = express();
app.use(express.json());

const PORT = Number(process.env.PORT) || 3000;

function abortOnCancelledRequest(req: Request, res: Response, controller: AbortController): void {
  const reason = new Error("Request cancelled by client");
  const abort = () => {
    if (!controller.signal.aborted) {
      controller.abort(reason);
    }
  };

  req.once("aborted", abort);
  res.once("close", () => {
    if (!res.writableFinished) abort();
  });
}

app.get("/health", (_req: Request, res: Response) => {
  res.json({ status: "ok", runtime: "bun", functions: Object.keys(MODES) });
});

app.post("/prompt", async (req: Request, res: Response) => {
  const body = req.body as AgentOptions;
  if (!body.prompt || typeof body.prompt !== "string") {
    res.status(400).json({ error: "Missing required field: prompt" });
    return;
  }
  if (!body.project || typeof body.project !== "string") {
    res.status(400).json({ error: "Missing required field: project" });
    return;
  }
  if (!body.originBranch || typeof body.originBranch !== "string") {
    res.status(400).json({ error: "Missing required field: originBranch" });
    return;
  }

  const ac = new AbortController();
  abortOnCancelledRequest(req, res, ac);
  log(
    "POST /prompt",
    `request started: provider=${body.cli ?? body.provider ?? "claude"} project=${body.project} originBranch=${body.originBranch}`,
  );

  try {
    const result = await queryAgent({ ...body, abortController: ac });
    log(
      "POST /prompt",
      `request succeeded: branch=${result.branch ?? "(none)"} prUrl=${result.prUrl ?? "(skipped)"}`,
    );
    res.json(result);
  } catch (err: any) {
    if (ac.signal.aborted) {
      console.log("[POST /prompt] Request cancelled");
      if (!res.headersSent) res.status(499).json({ error: "Request cancelled" });
      return;
    }
    log("POST /prompt", "request failed:", err);
    res.status(500).json({ error: err.message ?? "Internal server error" });
  }
});

app.post("/mode/:name", async (req: Request, res: Response) => {
  const modeName = req.params.name;
  const fn = MODES[modeName as keyof typeof MODES];
  if (!fn) {
    res.status(404).json({ error: `Unknown function: ${modeName}` });
    return;
  }

  const ac = new AbortController();
  abortOnCancelledRequest(req, res, ac);
  log(`POST /mode/${modeName}`, "request started");

  try {
    const result = await fn(req.body, ac);
    log(`POST /mode/${modeName}`, "request succeeded");
    res.json(result);
  } catch (err: any) {
    if (ac.signal.aborted) {
      console.log(`[POST /mode/${modeName}] Request cancelled`);
      if (!res.headersSent) res.status(499).json({ error: "Request cancelled" });
      return;
    }
    log(`POST /mode/${modeName}`, "request failed:", err);
    res.status(500).json({ error: err.message ?? "Internal server error" });
  }
});

app.listen(PORT, () => {
  console.log(`
  Claude Harness API — http://localhost:${PORT}
  Auth: Claude CLI OAuth or Codex CLI | Runtime: Bun ${Bun.version}

  POST /prompt       Run agent in worktree → commit → push → PR
  POST /mode/:name   Specific mode (${Object.keys(MODES).join(", ")})
  GET  /health       Status
  `);
});
