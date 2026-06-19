import {
  queryAgent,
  resolvePath,
  type AgentCli,
  type AgentOptions,
} from "../agent.ts";
import { resolveProviderDefaults } from "../config.ts";
import {
  commentOnPR,
  commitAndPushToPullRequestHead,
  fastForwardPullRequestHeadWorktree,
  getOrCreatePRHeadBranchCwd,
  getPRDiff,
  getPRDiffStat,
  getPRInfo,
  getPullRequestReviewData,
  getWorktreeStatus,
  type PullRequestReviewData,
  type PRInfo,
} from "../git.ts";
import { log, logModel } from "../logging.ts";
import {
  beginPullRequestRun,
  isSupersededPullRequestRun,
} from "../pr-run-controller.ts";

interface ReviewExecutorInput {
  project: string;
  pr: string | number;
  commentId?: string | number;
  comment_id?: string | number;
  reviewId?: string | number;
  review_id?: string | number;
  extraInstructions?: string;
  cli?: AgentCli;
  provider?: AgentCli;
  model?: string;
  effort?: AgentOptions["effort"];
  maxTurns?: number;
}

type ReviewExecutorDecision = "no_findings" | "applicable_changes_applied";

type ReviewDataSelector =
  | { kind: "comment"; commentId: string | number }
  | { kind: "review"; reviewId: string | number };

const REVIEW_EXECUTOR_SYSTEM_PROMPT = `You are a review executor for GitHub pull requests.

You receive the review/comment payload that triggered this run, plus PR context.

Your job:
1. Decide whether the triggering review/comment asks for a concrete change that can be applied to this PR.
2. If the request is applicable, edit the repository files directly to satisfy it.
3. If the request is not applicable, already satisfied, too vague to execute safely, unrelated to the PR, or only asks a question, leave the repository unchanged.
4. Do not comment on GitHub, commit, push, or create branches. The harness handles that after you finish.

Your final response must be exactly one of these two lines:
no findings
applicable changes applied

Do not include markdown, explanation, a summary, a diff, or any extra text in the final response.`;

function normalizeId(id: string | number | undefined): string | number | undefined {
  if (typeof id === "number" && Number.isFinite(id)) return id;
  if (typeof id === "string" && id.trim()) return id.trim();
}

function resolveReviewDataSelector(input: ReviewExecutorInput): ReviewDataSelector {
  const commentId = normalizeId(input.commentId ?? input.comment_id);
  const reviewId = normalizeId(input.reviewId ?? input.review_id);
  if (commentId && reviewId) {
    throw new Error("Pass either commentId or reviewId, not both.");
  }
  if (commentId) return { kind: "comment", commentId };
  if (reviewId) return { kind: "review", reviewId };
  throw new Error("Missing required field: commentId or reviewId");
}

function reviewDataSelectorLabel(selector: ReviewDataSelector): string {
  return selector.kind === "review"
    ? `review ${selector.reviewId}`
    : `comment ${selector.commentId}`;
}

function normalizeDecisionText(text: string): string {
  return text
    .trim()
    .replace(/^["'`]+|["'`]+$/g, "")
    .trim()
    .replace(/\.$/, "")
    .toLowerCase();
}

function parseReviewExecutorDecision(result: string): ReviewExecutorDecision {
  const normalized = normalizeDecisionText(result);
  if (normalized === "no findings") return "no_findings";
  if (normalized === "applicable changes applied") return "applicable_changes_applied";

  const lines = result
    .split(/\r?\n/)
    .map(normalizeDecisionText)
    .filter(Boolean);
  const lastLine = lines.at(-1);
  if (lastLine === "no findings") return "no_findings";
  if (lastLine === "applicable changes applied") return "applicable_changes_applied";

  throw new Error(
    `Review executor returned an invalid final response. Expected "no findings" or "applicable changes applied", got: ${result.trim()}`,
  );
}

function fencedBlock(language: string, body: string): string {
  const fence = body.includes("```") ? "````" : "```";
  return `${fence}${language}
${body}
${fence}`;
}

function buildReviewDataContext(reviewData: PullRequestReviewData): string {
  const details = [
    `Review data kind: ${reviewData.kind}`,
    `Review data ID: ${reviewData.id}`,
    reviewData.authorLogin ? `Author: ${reviewData.authorLogin}` : undefined,
    reviewData.htmlUrl ? `URL: ${reviewData.htmlUrl}` : undefined,
  ].filter(Boolean);

  const reviewComments = reviewData.reviewComments?.length
    ? reviewData.reviewComments
        .map((reviewComment, index) => {
          const reviewCommentDetails = [
            `Inline comment ${index + 1}`,
            `Comment ID: ${reviewComment.id}`,
            reviewComment.authorLogin ? `Author: ${reviewComment.authorLogin}` : undefined,
            reviewComment.htmlUrl ? `URL: ${reviewComment.htmlUrl}` : undefined,
            reviewComment.path ? `Path: ${reviewComment.path}` : undefined,
            typeof reviewComment.line === "number" ? `Line: ${reviewComment.line}` : undefined,
          ].filter(Boolean);
          const reviewCommentDiffHunk = reviewComment.diffHunk
            ? `

${fencedBlock("diff", reviewComment.diffHunk)}`
            : "";
          return `${reviewCommentDetails.join("\n")}

${fencedBlock("markdown", reviewComment.body.trim() || "(empty)")}${reviewCommentDiffHunk}`;
        })
        .join("\n\n")
    : "";
  const reviewCommentsBlock = reviewComments
    ? `

## Inline comments in this review
${reviewComments}`
    : "";

  return `${details.join("\n")}

## Triggering review/comment body
${fencedBlock("markdown", reviewData.body.trim() || "(empty)")}${reviewCommentsBlock}`;
}

function hasReviewDataContent(reviewData: PullRequestReviewData): boolean {
  if (reviewData.body.trim()) return true;
  return reviewData.reviewComments?.some((reviewComment) => reviewComment.body.trim()) ?? false;
}

function buildReviewExecutorPrompt(input: {
  pullRequest: PRInfo;
  reviewData: PullRequestReviewData;
  diff: string;
  stat: string;
  extraInstructions?: string;
}): string {
  const extraInstructions = input.extraInstructions?.trim();
  const extraInstructionsBlock = extraInstructions
    ? `

## Additional instructions
${fencedBlock("text", extraInstructions)}`
    : "";

  return `Repository: ${input.pullRequest.owner}/${input.pullRequest.repo}
PR #${input.pullRequest.number}: "${input.pullRequest.title}" (${input.pullRequest.headBranch} -> ${input.pullRequest.baseBranch})

${buildReviewDataContext(input.reviewData)}${extraInstructionsBlock}

## Diff stat
${fencedBlock("text", input.stat || "(empty)")}

## Full PR diff
${fencedBlock("diff", input.diff || "(empty)")}

Review the triggering review/comment payload, apply any applicable requested change in this worktree, then finish with exactly one allowed final response.`;
}

function buildAppliedComment(reviewData: PullRequestReviewData, pullRequest: PRInfo): string {
  const source = reviewData.htmlUrl ? `\n\nAddressed review item: ${reviewData.htmlUrl}` : "";
  return `✅ **Review changes applied.**

I applied the requested review changes and pushed them to \`${pullRequest.headBranch}\`.${source}`;
}

function clipForComment(message: string, maxLength = 5000): string {
  if (message.length <= maxLength) return message;
  return `${message.slice(0, maxLength)}\n... truncated ${message.length - maxLength} characters ...`;
}

function buildFailureComment(message: string): string {
  return `## ⚠️ Review executor failed

The review executor could not complete the requested changes.

\`\`\`
${clipForComment(message)}
\`\`\``;
}

export async function reviewExecutor(input: ReviewExecutorInput, controller: AbortController) {
  if (!input.project) throw new Error("Missing required field: project");
  if (!input.pr) throw new Error("Missing required field: pr");
  const reviewDataSelector = resolveReviewDataSelector(input);

  const project = resolvePath(input.project);
  const run = beginPullRequestRun({
    kind: "review-executor",
    project,
    pr: input.pr,
    controller,
  });
  log(
    "reviewExecutor",
    `request started: executing PR ${input.pr} ${reviewDataSelectorLabel(reviewDataSelector)} in ${project}`,
  );

  let cleanupPRHeadBranchCwd: () => Promise<void> = async () => {};
  let prHeadBranchCwd: string | null = null;
  let preserveWorktree = false;

  const throwIfCancelled = () => {
    if (run.signal.aborted) {
      throw run.signal.reason ?? new Error("Review executor cancelled without reason.");
    }
  };

  try {
    const [prInfo, diff, stat] = await Promise.all([
      getPRInfo(project, input.pr),
      getPRDiff(project, input.pr),
      getPRDiffStat(project, input.pr),
    ]);
    throwIfCancelled();

    const reviewData = await getPullRequestReviewData(project, prInfo, reviewDataSelector);
    throwIfCancelled();

    if (!hasReviewDataContent(reviewData)) {
      log(
        "reviewExecutor",
        `request succeeded: PR #${prInfo.number} ${reviewDataSelectorLabel(reviewDataSelector)} has no body; skipping`,
      );
      return {
        result: "no findings",
        prUrl: prInfo.url,
        prNumber: prInfo.number,
        reviewDataId: reviewData.id,
        reviewDataKind: reviewData.kind,
        reviewDataUrl: reviewData.htmlUrl,
      };
    }

    const prHeadBranchContext = await getOrCreatePRHeadBranchCwd({
      cwd: project,
      pullRequest: prInfo,
    });
    cleanupPRHeadBranchCwd = prHeadBranchContext.cleanup;
    prHeadBranchCwd = prHeadBranchContext.prHeadBranchCwd;

    const initialStatus = await getWorktreeStatus(prHeadBranchCwd);
    if (initialStatus) {
      preserveWorktree = true;
      throw new Error(
        `PR worktree is not clean before review executor run; refusing to mix existing changes:\n${initialStatus}`,
      );
    }

    await fastForwardPullRequestHeadWorktree(prHeadBranchCwd, prInfo);
    throwIfCancelled();

    const defaults = resolveProviderDefaults("review_executor", input);
    const agentRun = await queryAgent({
      prompt: buildReviewExecutorPrompt({
        pullRequest: prInfo,
        reviewData,
        diff,
        stat,
        extraInstructions: input.extraInstructions,
      }),
      project: prHeadBranchCwd,
      cwd: prHeadBranchCwd,
      cli: defaults.provider,
      agentMode: "review_executor",
      access: "all-access",
      systemPrompt: REVIEW_EXECUTOR_SYSTEM_PROMPT,
      model: defaults.model,
      effort: defaults.effort,
      maxTurns: input.maxTurns ?? 120,
      loadProjectSettings: true,
      logLabel: "reviewExecutor",
      abortController: run.controller,
    });
    throwIfCancelled();

    logModel("reviewExecutor", defaults.provider, `executor agent result:\n${agentRun.result}`);

    const decision = parseReviewExecutorDecision(agentRun.result);
    const finalStatus = await getWorktreeStatus(prHeadBranchCwd);

    if (decision === "no_findings") {
      if (finalStatus) {
        preserveWorktree = true;
        throw new Error(
          `Review executor reported "no findings" but left worktree changes:\n${finalStatus}`,
        );
      }

      log(
        "reviewExecutor",
        `request succeeded: no findings for PR #${prInfo.number} ${reviewDataSelectorLabel(reviewDataSelector)}`,
      );
      return {
        result: "no findings",
        sessionId: agentRun.sessionId,
        prUrl: prInfo.url,
        prNumber: prInfo.number,
        reviewDataId: reviewData.id,
        reviewDataKind: reviewData.kind,
        reviewDataUrl: reviewData.htmlUrl,
        model: agentRun.model,
        totalTokens: agentRun.totalTokens,
        usage: agentRun.usage,
        totalCostUsd: agentRun.totalCostUsd,
      };
    }

    if (!finalStatus) {
      throw new Error(
        'Review executor reported "applicable changes applied" but did not leave any worktree changes.',
      );
    }

    preserveWorktree = true;
    const pushed = await commitAndPushToPullRequestHead({
      cwd: prHeadBranchCwd,
      pullRequest: prInfo,
      message: `Apply PR review item ${reviewData.id}`,
    });
    preserveWorktree = false;
    if (!pushed) {
      throw new Error("Review executor had no changes to commit after reporting applied changes.");
    }

    await commentOnPR(project, input.pr, buildAppliedComment(reviewData, prInfo));

    log(
      "reviewExecutor",
      `request succeeded: applied PR #${prInfo.number} ${reviewDataSelectorLabel(reviewDataSelector)}`,
    );
    return {
      result: "applicable changes applied",
      sessionId: agentRun.sessionId,
      prUrl: prInfo.url,
      prNumber: prInfo.number,
      reviewDataId: reviewData.id,
      reviewDataKind: reviewData.kind,
      reviewDataUrl: reviewData.htmlUrl,
      pushed: true,
      model: agentRun.model,
      totalTokens: agentRun.totalTokens,
      usage: agentRun.usage,
      totalCostUsd: agentRun.totalCostUsd,
    };
  } catch (err) {
    if (isSupersededPullRequestRun(run.signal)) {
      log("reviewExecutor", `request stopped: PR ${input.pr} executor superseded by a newer request`);
      return {
        result: "Review executor stopped because a newer run was requested for this PR.",
        stopped: true,
      };
    }
    if (run.signal.aborted) {
      log("reviewExecutor", `request cancelled: PR ${input.pr} executor cancelled`);
      throw err;
    }

    if (prHeadBranchCwd) {
      const dirtyStatus = await getWorktreeStatus(prHeadBranchCwd).catch(() => "");
      preserveWorktree ||= Boolean(dirtyStatus);
    }

    const message = err instanceof Error ? (err.stack ?? err.message) : String(err);
    log("reviewExecutor", `request failed:\n${message}`);
    await commentOnPR(project, input.pr, buildFailureComment(message)).catch((commentErr) =>
      log("reviewExecutor", "failed to post error comment:", commentErr),
    );
    throw err;
  } finally {
    if (preserveWorktree) {
      log(
        "reviewExecutor",
        `preserving PR head worktree after failure: ${prHeadBranchCwd ?? "(unknown)"}`,
      );
    } else {
      await cleanupPRHeadBranchCwd().catch((cleanupErr) =>
        log("reviewExecutor", "failed to clean up PR head branch worktree:", cleanupErr),
      );
    }
    run.finish();
  }
}
