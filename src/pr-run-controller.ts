export type PullRequestRunKind = "code-review" | "code-test" | "review-executor";

interface ActivePullRequestRun {
  controller: AbortController;
  kind: PullRequestRunKind;
  token: symbol;
  startedAt: Date;
}

export interface PullRequestRun {
  controller: AbortController;
  signal: AbortSignal;
  replacedExisting: boolean;
  replacedKind?: PullRequestRunKind;
  startedAt: Date;
  finish: () => void;
}

export class SupersededPullRequestRunError extends Error {
  constructor(
    readonly previousKind: PullRequestRunKind,
    readonly newKind: PullRequestRunKind,
    readonly newStartedAt: Date,
  ) {
    super(
      `Superseded ${previousKind} run with a newer ${newKind} run started at ${newStartedAt.toISOString()}`,
    );
    this.name = "SupersededPullRequestRunError";
  }
}

const activePullRequestRuns = new Map<string, ActivePullRequestRun>();

function runKey(project: string, pr: string | number): string {
  return `${project}:${String(pr)}`;
}

function abortRequest(controller: AbortController, reason: unknown): void {
  if (!controller.signal.aborted) {
    controller.abort(reason);
  }
}

export function beginPullRequestRun(input: {
  kind: PullRequestRunKind;
  project: string;
  pr: string | number;
  controller: AbortController;
}): PullRequestRun {
  const key = runKey(input.project, input.pr);
  const startedAt = new Date();
  const previous = activePullRequestRuns.get(key);
  const replacedExisting = Boolean(previous && !previous.controller.signal.aborted);
  const replacedKind = replacedExisting ? previous?.kind : undefined;

  if (previous) {
    abortRequest(
      previous.controller,
      new SupersededPullRequestRunError(previous.kind, input.kind, startedAt),
    );
  }

  const { controller } = input;
  const token = Symbol(key);
  const active: ActivePullRequestRun = { controller, kind: input.kind, token, startedAt };

  activePullRequestRuns.set(key, active);

  return {
    controller,
    signal: controller.signal,
    replacedExisting,
    replacedKind,
    startedAt,
    finish: () => {
      if (activePullRequestRuns.get(key)?.token === token) {
        activePullRequestRuns.delete(key);
      }
    },
  };
}

export function isSupersededPullRequestRun(signal: AbortSignal): boolean {
  return signal.aborted && signal.reason instanceof SupersededPullRequestRunError;
}

export function pullRequestRunKindLabel(kind: PullRequestRunKind): string {
  if (kind === "code-test") return "automated QA";
  if (kind === "review-executor") return "review executor";
  return "automated review";
}
