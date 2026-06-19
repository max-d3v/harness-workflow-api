import path from "node:path";
import React, { useEffect, useState } from "react";
import { Box, Text, render, useApp } from "ink";
import {
  DEFAULT_TELEMETRY_FILE,
  filterRunsBySince,
  parseDurationMs,
  readRunRecords,
  summarizeRuns,
  type GitHubUserSummary,
  type ModeSummary,
  type ProviderModelSummary,
  type RunRecord,
} from "./telemetry.ts";

const DEFAULT_INTERVAL_MS = 5_000;
const DEFAULT_SINCE_MS = 24 * 60 * 60 * 1000;

interface DashboardOptions {
  file: string;
  intervalMs: number;
  sinceMs?: number;
  once: boolean;
}

interface DashboardViewProps {
  records: RunRecord[];
  file: string;
  sinceLabel: string;
  now: Date;
  intervalMs?: number;
  showFooter?: boolean;
}

interface TableColumn {
  key: string;
  header: string;
  width: number;
  align?: "left" | "right";
  color?: string;
}

interface TableRow {
  [key: string]: string;
}

function usage(): string {
  return `Usage: bun run dashboard [options]

Options:
  --interval <seconds>  Refresh interval for live watch mode (default: 5)
  --since <duration>    Time window to show, such as 30m, 6h, or 7d (default: 24h)
  --all                 Show all recorded runs
  --file <path>         Read a custom telemetry JSONL file
  --once                Render once and exit
  -h, --help            Show this help message`;
}

function takeValue(argv: string[], index: number, flag: string): string {
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`Missing value for ${flag}`);
  }
  return value;
}

export function parseDashboardArgs(argv: string[]): DashboardOptions {
  let file = DEFAULT_TELEMETRY_FILE;
  let intervalMs = DEFAULT_INTERVAL_MS;
  let sinceMs: number | undefined = DEFAULT_SINCE_MS;
  let once = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case "--interval": {
        const seconds = Number(takeValue(argv, i, arg));
        if (!Number.isFinite(seconds) || seconds <= 0) {
          throw new Error("--interval must be a positive number of seconds");
        }
        intervalMs = seconds * 1000;
        i += 1;
        break;
      }
      case "--since": {
        sinceMs = parseDurationMs(takeValue(argv, i, arg));
        i += 1;
        break;
      }
      case "--all":
        sinceMs = undefined;
        break;
      case "--file":
        file = path.resolve(takeValue(argv, i, arg));
        i += 1;
        break;
      case "--once":
        once = true;
        break;
      case "-h":
      case "--help":
        process.stdout.write(`${usage()}\n`);
        process.exit(0);
      default:
        throw new Error(`Unknown option: ${arg}`);
    }
  }

  return { file, intervalMs, sinceMs, once };
}

function formatInteger(value: number): string {
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(value);
}

function formatTokens(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
  return formatInteger(value);
}

function formatCost(value: number): string {
  if (value === 0) return "$0.00";
  if (value < 0.01) return `$${value.toFixed(4)}`;
  return `$${value.toFixed(2)}`;
}

function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "0s";
  const totalSeconds = Math.round(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

function clip(value: string, width: number): string {
  if (value.length <= width) return value;
  if (width <= 3) return value.slice(0, width);
  return `${value.slice(0, width - 3)}...`;
}

function cellText(value: string, column: TableColumn): string {
  const clipped = clip(value, column.width);
  return column.align === "right"
    ? clipped.padStart(column.width)
    : clipped.padEnd(column.width);
}

function sinceLabel(options: DashboardOptions): string {
  if (typeof options.sinceMs !== "number") return "all time";
  return `last ${formatDuration(options.sinceMs)}`;
}

function relativePath(file: string): string {
  const relative = path.relative(process.cwd(), file);
  if (!relative.startsWith("..") && !path.isAbsolute(relative)) return relative || ".";
  return file;
}

function modeRows(modes: ModeSummary[]): TableRow[] {
  return modes.map((mode) => ({
    mode: mode.mode,
    runs: formatInteger(mode.runs),
    ok: formatInteger(mode.successes),
    fail: formatInteger(mode.failures),
    stop: formatInteger(mode.stopped),
    cncl: formatInteger(mode.cancelled),
    tokens: formatTokens(mode.totalTokens),
    cost: formatCost(mode.totalCostUsd),
    median: formatDuration(mode.medianDurationMs),
    total: formatDuration(mode.totalDurationMs),
  }));
}

function providerRows(providerModels: ProviderModelSummary[]): TableRow[] {
  return providerModels.slice(0, 8).map((entry) => ({
    provider: entry.provider,
    model: entry.model,
    runs: formatInteger(entry.runs),
    tokens: formatTokens(entry.totalTokens),
    cost: formatCost(entry.totalCostUsd),
    median: formatDuration(entry.medianDurationMs),
  }));
}

function userSourceLabel(source: string): string {
  if (source === "pr_author") return "pr";
  if (source === "comment_author") return "comment";
  if (source === "review_author") return "review";
  return source;
}

function modeLabel(mode: string): string {
  if (mode === "code-review") return "review";
  if (mode === "code-test") return "qa";
  if (mode === "review-executor") return "executor";
  return mode;
}

function githubUserRows(users: GitHubUserSummary[]): TableRow[] {
  return users.slice(0, 10).map((entry) => ({
    user: entry.user,
    trigger: entry.sources.map(userSourceLabel).join(","),
    modes: entry.modes.map(modeLabel).join(","),
    runs: formatInteger(entry.runs),
    ok: formatInteger(entry.successes),
    fail: formatInteger(entry.failures),
    tokens: formatTokens(entry.totalTokens),
    cost: formatCost(entry.totalCostUsd),
    median: formatDuration(entry.medianDurationMs),
  }));
}

function health(summary: ReturnType<typeof summarizeRuns>) {
  if (summary.failures > 0) return { label: "ATTENTION", color: "red" };
  if (summary.cancelled > 0 || summary.stopped > 0) return { label: "INTERRUPTED", color: "yellow" };
  return { label: "CLEAN", color: "green" };
}

function Section(props: { title: string; children: React.ReactNode }) {
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text bold>{props.title.toUpperCase()}</Text>
      <Box flexDirection="column">
        {props.children}
      </Box>
    </Box>
  );
}

function MetricStrip(props: { items: Array<[string, string]> }) {
  return (
    <Box flexDirection="row" flexWrap="wrap">
      {props.items.map(([label, value]) => (
        <Box key={label} marginRight={4}>
          <Text dimColor>{label}</Text>
          <Text> {value}</Text>
        </Box>
      ))}
    </Box>
  );
}

function DataTable(props: {
  columns: TableColumn[];
  rows: TableRow[];
  empty: string;
}) {
  if (props.rows.length === 0) {
    return <Text dimColor>{props.empty}</Text>;
  }

  const header = props.columns
    .map((column) => cellText(column.header, column))
    .join("  ");
  const divider = props.columns
    .map((column) => "-".repeat(column.width))
    .join("  ");
  const rows = props.rows.map((row) =>
    props.columns
      .map((column) => cellText(row[column.key] ?? "", column))
      .join("  "),
  );

  return <Text>{[header, divider, ...rows].join("\n")}</Text>;
}

function RecentFailures(props: { records: RunRecord[] }) {
  if (props.records.length === 0) {
    return <Text dimColor>none</Text>;
  }

  return (
    <Box flexDirection="column">
      {props.records.map((record) => {
        const header = [
          new Date(record.endedAt).toLocaleString(),
          record.mode,
          `${record.provider ?? "unknown"}/${record.model ?? "unknown"}`,
          formatDuration(record.durationMs),
        ].join("  ");
        const error = (record.error ?? "(no error)").replace(/\s+/g, " ").trim();
        return (
          <Box key={record.id} flexDirection="column" marginBottom={1}>
            <Text color="red">{header}</Text>
            <Text>{`  ${clip(error, 112)}`}</Text>
          </Box>
        );
      })}
    </Box>
  );
}

export function DashboardView(props: DashboardViewProps) {
  const summary = summarizeRuns(props.records);
  const status = health(summary);

  return (
    <Box flexDirection="column">
      <Text bold color="cyan">CLAUDE HARNESS</Text>
      <Box>
        <Text color={status.color} bold>{status.label}</Text>
        <Text>{`  ${formatInteger(summary.runs)} runs tracked in this window  |  ${props.sinceLabel}  |  updated ${props.now.toLocaleTimeString()}`}</Text>
      </Box>
      <Text dimColor>{relativePath(props.file)}</Text>

      <Section title="Overview">
        <MetricStrip
          items={[
            ["Runs", formatInteger(summary.runs)],
            ["Success", formatInteger(summary.successes)],
            ["Failed", formatInteger(summary.failures)],
            ["Stopped", formatInteger(summary.stopped)],
            ["Cancelled", formatInteger(summary.cancelled)],
            ["Tokens", formatTokens(summary.totalTokens)],
            ["Cost", formatCost(summary.totalCostUsd)],
            ["Median", formatDuration(summary.medianDurationMs)],
            ["Total time", formatDuration(summary.totalDurationMs)],
          ]}
        />
      </Section>

      <Section title="By Mode">
        <DataTable
          empty="no runs recorded"
          columns={[
            { key: "mode", header: "Mode", width: 15 },
            { key: "runs", header: "Run", width: 3, align: "right" },
            { key: "ok", header: "OK", width: 2, align: "right", color: "green" },
            { key: "fail", header: "F", width: 3, align: "right", color: "red" },
            { key: "stop", header: "St", width: 3, align: "right", color: "yellow" },
            { key: "cncl", header: "Cx", width: 3, align: "right", color: "yellow" },
            { key: "tokens", header: "Tok", width: 6, align: "right" },
            { key: "cost", header: "Cost", width: 7, align: "right" },
            { key: "median", header: "Med", width: 6, align: "right" },
            { key: "total", header: "Sum", width: 6, align: "right" },
          ]}
          rows={modeRows(summary.byMode)}
        />
      </Section>

      <Section title="By Provider / Model">
        <DataTable
          empty="no provider/model data"
          columns={[
            { key: "provider", header: "Provider", width: 9 },
            { key: "model", header: "Model", width: 24 },
            { key: "runs", header: "Runs", width: 4, align: "right" },
            { key: "tokens", header: "Tokens", width: 7, align: "right" },
            { key: "cost", header: "Cost", width: 7, align: "right" },
            { key: "median", header: "Median", width: 8, align: "right" },
          ]}
          rows={providerRows(summary.byProviderModel)}
        />
      </Section>

      <Section title="By GitHub User">
        <DataTable
          empty="no GitHub user data yet"
          columns={[
            { key: "user", header: "User", width: 15 },
            { key: "trigger", header: "Trigger", width: 9 },
            { key: "modes", header: "Modes", width: 14 },
            { key: "runs", header: "Run", width: 3, align: "right" },
            { key: "ok", header: "OK", width: 2, align: "right", color: "green" },
            { key: "fail", header: "F", width: 2, align: "right", color: "red" },
            { key: "tokens", header: "Tok", width: 6, align: "right" },
            { key: "cost", header: "Cost", width: 7, align: "right" },
            { key: "median", header: "Med", width: 6, align: "right" },
          ]}
          rows={githubUserRows(summary.byGitHubUser)}
        />
      </Section>

      <Section title="Recent Failures">
        <RecentFailures records={summary.recentFailures} />
      </Section>

      <Box marginTop={1}>
        <Text dimColor>Cost prefers provider-reported USD, then local model-price estimates.</Text>
      </Box>
      {props.showFooter && props.intervalMs ? (
        <Text dimColor>{`Refreshes every ${formatDuration(props.intervalMs)}. Press Ctrl-C to exit.`}</Text>
      ) : null}
    </Box>
  );
}

async function loadRecords(options: DashboardOptions): Promise<RunRecord[]> {
  const records = await readRunRecords(options.file);
  if (typeof options.sinceMs !== "number") return records;
  return filterRunsBySince(records, options.sinceMs);
}

function DashboardApp(props: { options: DashboardOptions; initialRecords?: RunRecord[] }) {
  const { exit } = useApp();
  const [records, setRecords] = useState<RunRecord[]>(props.initialRecords ?? []);
  const [now, setNow] = useState(() => new Date());
  const [error, setError] = useState<string | undefined>();

  useEffect(() => {
    let active = true;

    const refresh = async () => {
      try {
        const nextRecords = await loadRecords(props.options);
        if (!active) return;
        setRecords(nextRecords);
        setNow(new Date());
        setError(undefined);
      } catch (err) {
        if (!active) return;
        setError(err instanceof Error ? err.message : String(err));
      }
    };

    void refresh();
    if (props.options.once) return () => {
      active = false;
    };

    const timer = setInterval(refresh, props.options.intervalMs);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [props.options]);

  useEffect(() => {
    if (!props.options.once) return;
    const timer = setTimeout(exit, 25);
    return () => clearTimeout(timer);
  }, [exit, props.options.once, records, error]);

  if (error) {
    return (
      <Box flexDirection="column">
        <Text color="red" bold>Dashboard failed</Text>
        <Text>{error}</Text>
      </Box>
    );
  }

  return (
    <DashboardView
      records={records}
      file={props.options.file}
      sinceLabel={sinceLabel(props.options)}
      now={now}
      intervalMs={props.options.intervalMs}
      showFooter={!props.options.once}
    />
  );
}

async function main(): Promise<void> {
  const options = parseDashboardArgs(process.argv.slice(2));
  const initialRecords = await loadRecords(options);
  const app = render(<DashboardApp options={options} initialRecords={initialRecords} />);
  await app.waitUntilExit();
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
