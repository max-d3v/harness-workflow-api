import { appendFile, mkdir, readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import type { AgentRunResult, TokenUsage } from "./agent-types.ts";

export type RunStatus = "success" | "failed" | "cancelled" | "stopped";
export type CostSource = "reported" | "estimated" | "unknown";
export type GitHubUserSource = "pr_author" | "comment_author" | "review_author";

const RUN_METADATA = Symbol("runMetadata");

export interface RunMetadata {
  githubUser?: string | null;
  githubUserSource?: GitHubUserSource;
}

export interface RunRecord {
  id: string;
  mode: string;
  provider?: string;
  model?: string;
  project?: string;
  pr?: string | number;
  githubUser?: string;
  githubUserSource?: GitHubUserSource;
  status: RunStatus;
  startedAt: string;
  endedAt: string;
  durationMs: number;
  totalTokens?: number;
  usage?: TokenUsage;
  costUsd?: number;
  reportedCostUsd?: number;
  estimatedCostUsd?: number;
  costSource: CostSource;
  error?: string;
}

export interface RunTelemetryStart {
  mode: string;
  provider?: string;
  model?: string;
  project?: string;
  pr?: string | number;
  startedAt?: Date;
}

export interface RunTelemetryFinish {
  status: RunStatus;
  result?: unknown;
  error?: unknown;
  provider?: string;
  model?: string;
  project?: string;
  pr?: string | number;
}

export interface ActiveRunTelemetry {
  readonly id: string;
  finish: (finish: RunTelemetryFinish) => Promise<RunRecord>;
}

export interface ModeSummary {
  mode: string;
  runs: number;
  successes: number;
  failures: number;
  stopped: number;
  cancelled: number;
  totalTokens: number;
  totalCostUsd: number;
  medianDurationMs: number;
  totalDurationMs: number;
}

export interface ProviderModelSummary {
  provider: string;
  model: string;
  runs: number;
  totalTokens: number;
  totalCostUsd: number;
  medianDurationMs: number;
}

export interface GitHubUserSummary {
  user: string;
  sources: string[];
  runs: number;
  successes: number;
  failures: number;
  stopped: number;
  cancelled: number;
  totalTokens: number;
  totalCostUsd: number;
  medianDurationMs: number;
  modes: string[];
}

export interface RunDashboardSummary {
  runs: number;
  successes: number;
  failures: number;
  stopped: number;
  cancelled: number;
  totalTokens: number;
  totalCostUsd: number;
  medianDurationMs: number;
  totalDurationMs: number;
  byMode: ModeSummary[];
  byProviderModel: ProviderModelSummary[];
  byGitHubUser: GitHubUserSummary[];
  recentFailures: RunRecord[];
}

interface ModelPricing {
  input: number;
  output: number;
  cacheWrite?: number;
  cacheRead?: number;
  reasoningOutput?: number;
}

export const DEFAULT_TELEMETRY_FILE = process.env.HARNESS_TELEMETRY_FILE
  ? path.resolve(process.env.HARNESS_TELEMETRY_FILE)
  : path.resolve(process.cwd(), "logs/runs.jsonl");

// USD per 1M tokens. Provider-reported costs always win; these are only a dashboard estimate.
const MODEL_PRICING_USD_PER_MILLION_TOKENS: Record<string, ModelPricing> = {
  "claude-opus-4-6": {
    input: 15,
    output: 75,
    cacheWrite: 18.75,
    cacheRead: 1.5,
  },
  "claude-opus-4-7": {
    input: 15,
    output: 75,
    cacheWrite: 18.75,
    cacheRead: 1.5,
  },
  "gpt-5.4": {
    input: 1.25,
    output: 10,
    cacheRead: 0.125,
    reasoningOutput: 10,
  },
  "gpt-5.5": {
    input: 1.25,
    output: 10,
    cacheRead: 0.125,
    reasoningOutput: 10,
  },
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function agentResultFromUnknown(value: unknown): AgentRunResult | undefined {
  if (!isRecord(value)) return undefined;
  return value as unknown as AgentRunResult;
}

export function withRunMetadata<T extends object>(value: T, metadata: RunMetadata): T {
  Object.defineProperty(value, RUN_METADATA, {
    value: metadata,
    enumerable: false,
    configurable: true,
  });
  return value;
}

export function getRunMetadata(value: unknown): RunMetadata | undefined {
  if (!isRecord(value)) return undefined;
  return (value as Record<PropertyKey, unknown>)[RUN_METADATA] as RunMetadata | undefined;
}

export function classifyRunStatus(status: RunStatus, result: unknown): RunStatus {
  if (status !== "success") return status;
  if (isRecord(result) && result.stopped === true) return "stopped";
  return status;
}

function usageTotal(usage: TokenUsage | undefined): number | undefined {
  if (!usage) return undefined;
  return (
    usage.input_tokens +
    usage.output_tokens +
    usage.cache_creation_input_tokens +
    usage.cache_read_input_tokens +
    (usage.reasoning_output_tokens ?? 0)
  );
}

function estimateCostUsd(model: string | undefined, usage: TokenUsage | undefined): number | undefined {
  if (!model || !usage) return undefined;
  const pricing = MODEL_PRICING_USD_PER_MILLION_TOKENS[model];
  if (!pricing) return undefined;

  const cost =
    (usage.input_tokens * pricing.input +
      usage.output_tokens * pricing.output +
      usage.cache_creation_input_tokens * (pricing.cacheWrite ?? pricing.input) +
      usage.cache_read_input_tokens * (pricing.cacheRead ?? pricing.input) +
      (usage.reasoning_output_tokens ?? 0) * (pricing.reasoningOutput ?? pricing.output)) /
    1_000_000;
  return Number(cost.toFixed(6));
}

function resolveCost(input: {
  model?: string;
  usage?: TokenUsage;
  reportedCostUsd?: number;
}): Pick<RunRecord, "costUsd" | "reportedCostUsd" | "estimatedCostUsd" | "costSource"> {
  if (typeof input.reportedCostUsd === "number" && Number.isFinite(input.reportedCostUsd)) {
    return {
      costUsd: input.reportedCostUsd,
      reportedCostUsd: input.reportedCostUsd,
      costSource: "reported",
    };
  }

  const estimatedCostUsd = estimateCostUsd(input.model, input.usage);
  if (typeof estimatedCostUsd === "number") {
    return {
      costUsd: estimatedCostUsd,
      estimatedCostUsd,
      costSource: "estimated",
    };
  }

  return { costSource: "unknown" };
}

function errorSummary(error: unknown): string | undefined {
  if (!error) return undefined;
  if (error instanceof Error) return error.stack ?? error.message;
  return String(error);
}

async function appendRunRecord(record: RunRecord, telemetryFile = DEFAULT_TELEMETRY_FILE): Promise<void> {
  await mkdir(path.dirname(telemetryFile), { recursive: true });
  await appendFile(telemetryFile, `${JSON.stringify(record)}\n`, "utf8");
}

export function startRunTelemetry(start: RunTelemetryStart): ActiveRunTelemetry {
  const id = randomUUID();
  const startedAt = start.startedAt ?? new Date();

  return {
    id,
    finish: async (finish) => {
      const endedAt = new Date();
      const result = agentResultFromUnknown(finish.result);
      const metadata = getRunMetadata(finish.result);
      const status = classifyRunStatus(finish.status, finish.result);
      const model = finish.model ?? result?.model ?? start.model;
      const usage = result?.usage;
      const totalTokens = result?.totalTokens ?? usageTotal(usage);
      const reportedCostUsd = result?.totalCostUsd;
      const cost = resolveCost({ model, usage, reportedCostUsd });
      const error = errorSummary(finish.error);

      const record: RunRecord = {
        id,
        mode: start.mode,
        provider: finish.provider ?? start.provider,
        model,
        project: finish.project ?? start.project,
        pr: finish.pr ?? start.pr,
        ...(metadata?.githubUser && { githubUser: metadata.githubUser }),
        ...(metadata?.githubUserSource && { githubUserSource: metadata.githubUserSource }),
        status,
        startedAt: startedAt.toISOString(),
        endedAt: endedAt.toISOString(),
        durationMs: Math.max(0, endedAt.getTime() - startedAt.getTime()),
        ...(typeof totalTokens === "number" && { totalTokens }),
        ...(usage && { usage }),
        ...cost,
        ...(error && { error }),
      };

      await appendRunRecord(record).catch((err) => {
        console.error("[telemetry] failed to append run record", err);
      });
      return record;
    },
  };
}

export function parseRunRecord(line: string): RunRecord | undefined {
  const trimmed = line.trim();
  if (!trimmed) return undefined;
  try {
    const parsed = JSON.parse(trimmed);
    if (!isRecord(parsed)) return undefined;
    if (
      typeof parsed.id !== "string" ||
      typeof parsed.mode !== "string" ||
      typeof parsed.status !== "string" ||
      typeof parsed.startedAt !== "string" ||
      typeof parsed.endedAt !== "string" ||
      typeof parsed.durationMs !== "number"
    ) {
      return undefined;
    }
    if (!["success", "failed", "cancelled", "stopped"].includes(parsed.status)) {
      return undefined;
    }
    return parsed as unknown as RunRecord;
  } catch {
    return undefined;
  }
}

export async function readRunRecords(telemetryFile = DEFAULT_TELEMETRY_FILE): Promise<RunRecord[]> {
  try {
    const text = await readFile(telemetryFile, "utf8");
    return text
      .split(/\r?\n/)
      .map(parseRunRecord)
      .filter((record): record is RunRecord => Boolean(record));
  } catch (err) {
    if (isRecord(err) && err.code === "ENOENT") return [];
    throw err;
  }
}

export function parseDurationMs(value: string): number {
  const match = value.trim().match(/^(\d+(?:\.\d+)?)(ms|s|m|h|d)?$/i);
  if (!match) throw new Error(`Invalid duration "${value}". Use values like 30m, 6h, 7d, or 120s.`);
  const amount = Number(match[1]);
  const unit = (match[2] ?? "ms").toLowerCase();
  const multiplier =
    unit === "d" ? 86_400_000 :
      unit === "h" ? 3_600_000 :
        unit === "m" ? 60_000 :
          unit === "s" ? 1_000 :
            1;
  return amount * multiplier;
}

export function filterRunsBySince(records: RunRecord[], sinceMs: number, now = Date.now()): RunRecord[] {
  const cutoff = now - sinceMs;
  return records.filter((record) => Date.parse(record.startedAt) >= cutoff);
}

export function median(values: number[]): number {
  const sorted = values.filter((value) => Number.isFinite(value)).sort((a, b) => a - b);
  if (sorted.length === 0) return 0;
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[middle] ?? 0;
  return ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
}

function summarizeRecords(records: RunRecord[]): Omit<ModeSummary, "mode"> {
  return {
    runs: records.length,
    successes: records.filter((record) => record.status === "success").length,
    failures: records.filter((record) => record.status === "failed").length,
    stopped: records.filter((record) => record.status === "stopped").length,
    cancelled: records.filter((record) => record.status === "cancelled").length,
    totalTokens: records.reduce((sum, record) => sum + (record.totalTokens ?? 0), 0),
    totalCostUsd: records.reduce((sum, record) => sum + (record.costUsd ?? 0), 0),
    medianDurationMs: median(records.map((record) => record.durationMs)),
    totalDurationMs: records.reduce((sum, record) => sum + record.durationMs, 0),
  };
}

export function summarizeRuns(records: RunRecord[]): RunDashboardSummary {
  const totals = summarizeRecords(records);
  const modeOrder = ["prompt", "code-review", "code-test", "review-executor"];
  const modes = new Map<string, RunRecord[]>();
  const providerModels = new Map<string, RunRecord[]>();
  const githubUsers = new Map<string, RunRecord[]>();

  for (const record of records) {
    const modeRecords = modes.get(record.mode) ?? [];
    modeRecords.push(record);
    modes.set(record.mode, modeRecords);

    const provider = record.provider ?? "unknown";
    const model = record.model ?? "unknown";
    const key = `${provider}\u0000${model}`;
    const providerModelRecords = providerModels.get(key) ?? [];
    providerModelRecords.push(record);
    providerModels.set(key, providerModelRecords);

    if (record.githubUser) {
      const userRecords = githubUsers.get(record.githubUser) ?? [];
      userRecords.push(record);
      githubUsers.set(record.githubUser, userRecords);
    }
  }

  const byMode = [...modes.entries()]
    .map(([mode, modeRecords]) => ({ mode, ...summarizeRecords(modeRecords) }))
    .sort((a, b) => {
      const aIndex = modeOrder.indexOf(a.mode);
      const bIndex = modeOrder.indexOf(b.mode);
      if (aIndex !== -1 || bIndex !== -1) {
        return (aIndex === -1 ? Number.MAX_SAFE_INTEGER : aIndex) -
          (bIndex === -1 ? Number.MAX_SAFE_INTEGER : bIndex);
      }
      return a.mode.localeCompare(b.mode);
    });

  const byProviderModel = [...providerModels.entries()]
    .map(([key, providerModelRecords]) => {
      const [provider = "unknown", model = "unknown"] = key.split("\u0000");
      return {
        provider,
        model,
        runs: providerModelRecords.length,
        totalTokens: providerModelRecords.reduce((sum, record) => sum + (record.totalTokens ?? 0), 0),
        totalCostUsd: providerModelRecords.reduce((sum, record) => sum + (record.costUsd ?? 0), 0),
        medianDurationMs: median(providerModelRecords.map((record) => record.durationMs)),
      };
    })
    .sort((a, b) => b.runs - a.runs || b.totalTokens - a.totalTokens);

  const byGitHubUser = [...githubUsers.entries()]
    .map(([user, userRecords]) => {
      const userSummary = summarizeRecords(userRecords);
      const sources = [...new Set(userRecords.map((record) => record.githubUserSource).filter(Boolean))]
        .sort() as string[];
      const modesForUser = [...new Set(userRecords.map((record) => record.mode))].sort((a, b) => {
        const aIndex = modeOrder.indexOf(a);
        const bIndex = modeOrder.indexOf(b);
        if (aIndex !== -1 || bIndex !== -1) {
          return (aIndex === -1 ? Number.MAX_SAFE_INTEGER : aIndex) -
            (bIndex === -1 ? Number.MAX_SAFE_INTEGER : bIndex);
        }
        return a.localeCompare(b);
      });
      return {
        user,
        sources,
        modes: modesForUser,
        ...userSummary,
      };
    })
    .sort((a, b) => b.runs - a.runs || b.totalTokens - a.totalTokens || a.user.localeCompare(b.user));

  const recentFailures = records
    .filter((record) => record.status === "failed")
    .sort((a, b) => Date.parse(b.endedAt) - Date.parse(a.endedAt))
    .slice(0, 8);

  return {
    ...totals,
    byMode,
    byProviderModel,
    byGitHubUser,
    recentFailures,
  };
}
