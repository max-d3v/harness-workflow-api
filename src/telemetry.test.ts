import { describe, expect, test } from "bun:test";
import React from "react";
import { render } from "ink-testing-library";
import { DashboardView } from "./dashboard.tsx";
import {
  classifyRunStatus,
  filterRunsBySince,
  getRunMetadata,
  median,
  parseDurationMs,
  parseRunRecord,
  summarizeRuns,
  withRunMetadata,
  type RunRecord,
} from "./telemetry.ts";

function run(overrides: Partial<RunRecord> = {}): RunRecord {
  return {
    id: "run-1",
    mode: "prompt",
    provider: "claude",
    model: "claude-opus-4-6",
    status: "success",
    startedAt: "2026-06-19T12:00:00.000Z",
    endedAt: "2026-06-19T12:00:01.000Z",
    durationMs: 1000,
    totalTokens: 100,
    costUsd: 0.1,
    costSource: "reported",
    ...overrides,
  };
}

describe("telemetry parsing", () => {
  test("ignores malformed and incomplete JSONL records", () => {
    expect(parseRunRecord("not json")).toBeUndefined();
    expect(parseRunRecord(JSON.stringify({ id: "missing-fields" }))).toBeUndefined();
    expect(parseRunRecord(JSON.stringify(run()))).toEqual(run());
  });
});

describe("telemetry status classification", () => {
  test("classifies stopped success results separately", () => {
    expect(classifyRunStatus("success", { stopped: true })).toBe("stopped");
    expect(classifyRunStatus("success", { result: "ok" })).toBe("success");
    expect(classifyRunStatus("failed", { stopped: true })).toBe("failed");
  });

  test("stores run metadata without making it part of response JSON", () => {
    const result = withRunMetadata(
      { result: "ok" },
      { githubUser: "alice", githubUserSource: "pr_author" },
    );

    expect(getRunMetadata(result)).toEqual({ githubUser: "alice", githubUserSource: "pr_author" });
    expect(JSON.stringify(result)).toBe('{"result":"ok"}');
  });
});

describe("telemetry aggregation", () => {
  test("sums counts, tokens, costs, and durations", () => {
    const summary = summarizeRuns([
      run(),
      run({
        id: "run-2",
        mode: "code-review",
        status: "failed",
        durationMs: 3000,
        totalTokens: 0,
        costUsd: 0,
        error: "boom",
      }),
      run({
        id: "run-3",
        mode: "code-review",
        status: "stopped",
        durationMs: 5000,
        totalTokens: 200,
        costUsd: 0.2,
      }),
      run({
        id: "run-4",
        mode: "code-test",
        status: "cancelled",
        durationMs: 7000,
        totalTokens: 50,
        costUsd: 0,
        githubUser: "alice",
        githubUserSource: "pr_author",
      }),
      run({
        id: "run-5",
        mode: "review-executor",
        status: "success",
        durationMs: 9000,
        totalTokens: 70,
        costUsd: 0.05,
        githubUser: "bob",
        githubUserSource: "comment_author",
      }),
    ]);

    expect(summary.runs).toBe(5);
    expect(summary.successes).toBe(2);
    expect(summary.failures).toBe(1);
    expect(summary.stopped).toBe(1);
    expect(summary.cancelled).toBe(1);
    expect(summary.totalTokens).toBe(420);
    expect(summary.totalCostUsd).toBeCloseTo(0.35);
    expect(summary.medianDurationMs).toBe(5000);
    expect(summary.totalDurationMs).toBe(25_000);
    expect(summary.byMode.map((entry) => entry.mode)).toEqual(["prompt", "code-review", "code-test", "review-executor"]);
    expect(summary.byGitHubUser.map((entry) => ({
      user: entry.user,
      sources: entry.sources,
      modes: entry.modes,
      runs: entry.runs,
    }))).toEqual([
      { user: "bob", sources: ["comment_author"], modes: ["review-executor"], runs: 1 },
      { user: "alice", sources: ["pr_author"], modes: ["code-test"], runs: 1 },
    ]);
    expect(summary.recentFailures).toHaveLength(1);
  });

  test("calculates medians and filters by since", () => {
    expect(median([])).toBe(0);
    expect(median([9, 1, 5])).toBe(5);
    expect(median([9, 1, 5, 7])).toBe(6);

    const records = [
      run({ id: "old", startedAt: "2026-06-19T10:00:00.000Z" }),
      run({ id: "new", startedAt: "2026-06-19T11:30:00.000Z" }),
    ];
    const filtered = filterRunsBySince(records, parseDurationMs("1h"), Date.parse("2026-06-19T12:00:00.000Z"));
    expect(filtered.map((record) => record.id)).toEqual(["new"]);
  });
});

describe("dashboard rendering", () => {
  test("renders empty history", () => {
    const rendered = render(
      React.createElement(DashboardView, {
        records: [],
        file: "/tmp/runs.jsonl",
        sinceLabel: "last 24h",
        now: new Date("2026-06-19T12:00:00.000Z"),
      }),
    );
    const frame = rendered.lastFrame() ?? "";

    expect(frame).toContain("CLAUDE HARNESS");
    expect(frame).toContain("no runs recorded");
    expect(frame).toContain("none");
  });

  test("renders mixed runs with failure details", () => {
    const rendered = render(
      React.createElement(DashboardView, {
        records: [
          run(),
          run({
            id: "run-2",
            mode: "review-executor",
            status: "failed",
            error: "Review executor failed loudly",
            githubUser: "commenter",
            githubUserSource: "review_author",
          }),
        ],
        file: "/tmp/runs.jsonl",
        sinceLabel: "all time",
        now: new Date("2026-06-19T12:00:00.000Z"),
      }),
    );
    const frame = rendered.lastFrame() ?? "";

    expect(frame).toContain("ATTENTION");
    expect(frame).toContain("2 runs tracked");
    expect(frame).toContain("BY GITHUB USER");
    expect(frame).toContain("commenter");
    expect(frame).toContain("review");
    expect(frame).toContain("review-executor");
    expect(frame).toContain("Review executor failed loudly");
  });
});
