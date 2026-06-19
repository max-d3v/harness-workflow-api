import { $ } from "bun";
import { randomBytes } from "crypto";
import path from "path";
import { copyFile, realpath, rm, stat } from "fs/promises";
import { z } from "zod";
import { log } from "./logging.ts";

export interface WorktreeContext {
  worktreePath: string;
  branch: string;
  originBranch: string;
  project: string;
  cleanup: () => Promise<void>;
}

export async function createWorktree(
  project: string,
  originBranch: string,
  branchPrefix = "agent",
): Promise<WorktreeContext> {
  const id = randomBytes(4).toString("hex");
  const branch = `${branchPrefix}/${originBranch}-${id}`;
  const worktreePath = path.join(project, ".worktrees", branch.replace(/\//g, "-"));

  await $`git -C ${project} fetch origin ${originBranch}`.quiet();
  await $`git -C ${project} worktree add -b ${branch} ${worktreePath} origin/${originBranch}`.quiet();

  const cleanup = async () => {
    try {
      await $`git -C ${project} worktree remove --force ${worktreePath}`.quiet();
    } catch {
      await rm(worktreePath, { recursive: true, force: true });
      await $`git -C ${project} worktree prune`.quiet();
    }
    try {
      await $`git -C ${project} branch -D ${branch}`.quiet();
    } catch {}
  };

  try {
    await copyRootEnvToWorktree(project, worktreePath);
  } catch (err) {
    await cleanup().catch((cleanupErr) =>
      log("git", "failed to clean up new worktree after .env copy error:", cleanupErr),
    );
    throw err;
  }

  return { worktreePath, branch, originBranch, project, cleanup };
}

async function copyRootEnvToWorktree(root: string, worktreePath: string): Promise<void> {
  const source = path.join(root, ".env");
  const exists = await stat(source)
    .then((file) => file.isFile())
    .catch(() => false);
  if (!exists) return;

  await copyFile(source, path.join(worktreePath, ".env"));
}

export async function commitAndPush(ctx: WorktreeContext, message: string): Promise<boolean> {
  const cwd = ctx.worktreePath;
  const status = await $`git -C ${cwd} status --porcelain`.text();
  if (!status.trim()) return false;

  await $`git -C ${cwd} add -A`.quiet();
  await $`git -C ${cwd} commit -m ${message}`.quiet();
  await $`git -C ${cwd} push -u origin ${ctx.branch}`.quiet();
  return true;
}

async function createPullRequest(
  ctx: WorktreeContext,
  title: string,
  body: string,
): Promise<string> {
  const result = await $`gh pr create \
    --head ${ctx.branch} \
    --base ${ctx.originBranch} \
    --title ${title} \
    --body ${body} \
    --draft`.cwd(ctx.worktreePath).text();
  return result.trim();
}

export async function openPR(
  ctx: WorktreeContext,
  title: string,
  body: string,
): Promise<string | undefined> {
  const committed = await commitAndPush(ctx, title);
  if (!committed) return undefined;
  return createPullRequest(ctx, title, body);
}

export async function getDiff(project: string, originBranch: string): Promise<string> {
  const diff = await $`git -C ${project} diff origin/${originBranch}`.text();
  return diff.trim();
}

export async function getDiffStat(project: string, originBranch: string): Promise<string> {
  const stat = await $`git -C ${project} diff --stat origin/${originBranch}`.text();
  return stat.trim();
}

export interface PRInfo {
  number: number;
  title: string;
  baseBranch: string;
  headBranch: string;
  url: string;
  authorLogin: string | null;
  owner: string;
  repo: string;
  headRepositoryOwnerLogin: string | null;
  headRepositoryName: string | null;
  isCrossRepository: boolean;
  maintainerCanModify: boolean;
}

export interface PRHeadBranchCwd {
  prHeadBranchCwd: string;
  worktreePath: string | null;
  createdWorktreePath: string | null;
  cleanup: () => Promise<void>;
}

const GitHubPullRequestViewSchema = z.object({
  number: z.number(),
  title: z.string(),
  baseRefName: z.string(),
  headRefName: z.string(),
  url: z.string(),
  author: z
    .object({
      login: z.string().nullable().optional(),
    })
    .nullable()
    .optional(),
  headRepositoryOwner: z
    .object({
      login: z.string().nullable().optional(),
    })
    .nullable()
    .optional(),
  headRepository: z
    .object({
      name: z.string().nullable().optional(),
      nameWithOwner: z.string().nullable().optional(),
    })
    .nullable()
    .optional(),
  isCrossRepository: z.boolean().optional(),
  maintainerCanModify: z.boolean().optional(),
});

export async function getPRInfo(project: string, pr: string | number): Promise<PRInfo> {
  const json = await $`gh pr view ${pr} --json number,title,baseRefName,headRefName,url,author,headRepositoryOwner,headRepository,isCrossRepository,maintainerCanModify`.cwd(project).text();
  const raw: unknown = JSON.parse(json);
  const data = GitHubPullRequestViewSchema.parse(raw);
  // gh returns the canonical PR URL: https://<host>/<owner>/<repo>/pull/<n>
  const [owner, repo] = new URL(data.url).pathname.split("/").filter(Boolean);
  if (!owner || !repo) {
    throw new Error(`Could not parse owner/repo from PR url: ${data.url}`);
  }
  const headRepositoryName =
    data.headRepository?.name
    ?? data.headRepository?.nameWithOwner?.split("/").at(-1)
    ?? repo;
  return {
    number: data.number,
    title: data.title,
    baseBranch: data.baseRefName,
    headBranch: data.headRefName,
    url: data.url,
    authorLogin: data.author?.login ?? null,
    owner,
    repo,
    headRepositoryOwnerLogin: data.headRepositoryOwner?.login ?? owner,
    headRepositoryName,
    isCrossRepository: data.isCrossRepository ?? false,
    maintainerCanModify: data.maintainerCanModify ?? false,
  };
}

export async function getCurrentBranch(project: string): Promise<string | null> {
  const branch = await $`git -C ${project} branch --show-current`.text();
  return branch.trim() || null;
}

function sanitizeBranchPart(value: string): string {
  return value.replace(/[^A-Za-z0-9._/-]+/g, "-").replace(/^-+|-+$/g, "");
}

export function resolvePullRequestWorktreeLocalBranchName(pullRequest: PRInfo): string {
  const owner = sanitizeBranchPart(pullRequest.owner);
  const repo = sanitizeBranchPart(pullRequest.repo);
  const headBranch = sanitizeBranchPart(pullRequest.headBranch).replace(/\//g, "-");
  return `pr/${owner}-${repo}-${pullRequest.number}-${headBranch}`;
}

async function localBranchExists(cwd: string, branch: string): Promise<boolean> {
  const result = await $`git -C ${cwd} rev-parse --verify --quiet refs/heads/${branch}`.nothrow().quiet();
  return result.exitCode === 0;
}

async function canonicalizeExistingPath(filePath: string): Promise<string> {
  return realpath(filePath);
}

async function pruneStaleWorktrees(cwd: string): Promise<void> {
  await $`git -C ${cwd} worktree prune`.quiet().catch(() => {});
}

async function findExistingHeadBranchWorktree(
  cwd: string,
  rootWorktreePath: string,
  pullRequest: PRInfo,
  localPullRequestBranch: string,
): Promise<string | null> {
  await pruneStaleWorktrees(cwd);

  const format = "%(refname:short)%00%(worktreepath)";
  const refs = await $`git -C ${cwd} for-each-ref --format=${format} refs/heads`.text();
  for (const line of refs.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const [name, worktreePath] = line.split("\0");
    if (!name || !worktreePath) continue;
    if (name !== localPullRequestBranch && name !== pullRequest.headBranch) continue;

    const canonical = await canonicalizeExistingPath(worktreePath).catch(async () => {
      await pruneStaleWorktrees(cwd);
      return null;
    });
    if (!canonical) continue;

    if (canonical !== rootWorktreePath) {
      return worktreePath;
    }
  }
  return null;
}

async function materializePullRequestHeadBranch(
  cwd: string,
  pullRequest: PRInfo,
  localPullRequestBranch: string,
): Promise<void> {
  await $`git -C ${cwd} fetch origin +refs/pull/${pullRequest.number}/head:refs/heads/${localPullRequestBranch}`.quiet();
}

async function nextAvailableWorktreePath(cwd: string, branch: string): Promise<string> {
  const baseName = branch.replace(/[^A-Za-z0-9._-]+/g, "-");
  const basePath = path.join(cwd, ".worktrees", baseName);
  for (let i = 0; i < 100; i++) {
    const candidate = i === 0 ? basePath : `${basePath}-${i}`;
    const exists = await stat(candidate)
      .then(() => true)
      .catch(() => false);
    if (!exists) return candidate;
  }
  return `${basePath}-${randomBytes(4).toString("hex")}`;
}

async function removeReviewWorktree(
  cwd: string,
  worktreePath: string,
  localBranch: string,
  deleteLocalBranch: boolean,
): Promise<void> {
  try {
    await $`git -C ${cwd} worktree remove --force ${worktreePath}`.quiet();
  } catch {
    await rm(worktreePath, { recursive: true, force: true });
    await $`git -C ${cwd} worktree prune`.quiet();
  }

  if (deleteLocalBranch) {
    await $`git -C ${cwd} branch -D ${localBranch}`.quiet().catch(() => {});
  }
}

function onceCleanup(cleanup: () => Promise<void>): () => Promise<void> {
  let cleanupPromise: Promise<void> | null = null;
  return () => {
    cleanupPromise ??= cleanup();
    return cleanupPromise;
  };
}

export async function getOrCreatePRHeadBranchCwd(input: {
  cwd: string;
  pullRequest: PRInfo;
}): Promise<PRHeadBranchCwd> {
  const localPullRequestBranch = resolvePullRequestWorktreeLocalBranchName(input.pullRequest);
  const rootWorktreePath = await canonicalizeExistingPath(input.cwd);
  const hadLocalPullRequestBranch = await localBranchExists(input.cwd, localPullRequestBranch);

  const existing = await findExistingHeadBranchWorktree(
    input.cwd,
    rootWorktreePath,
    input.pullRequest,
    localPullRequestBranch,
  );
  if (existing) {
    return { prHeadBranchCwd: existing, worktreePath: existing, createdWorktreePath: null, cleanup: async () => {} };
  }

  await materializePullRequestHeadBranch(input.cwd, input.pullRequest, localPullRequestBranch);

  const afterFetch = await findExistingHeadBranchWorktree(
    input.cwd,
    rootWorktreePath,
    input.pullRequest,
    localPullRequestBranch,
  );
  if (afterFetch) {
    return { prHeadBranchCwd: afterFetch, worktreePath: afterFetch, createdWorktreePath: null, cleanup: async () => {} };
  }

  const worktreePath = await nextAvailableWorktreePath(input.cwd, localPullRequestBranch);
  try {
    await $`git -C ${input.cwd} worktree add ${worktreePath} ${localPullRequestBranch}`.quiet();
    await copyRootEnvToWorktree(input.cwd, worktreePath);
  } catch (err) {
    await removeReviewWorktree(input.cwd, worktreePath, localPullRequestBranch, !hadLocalPullRequestBranch).catch(
      () => {},
    );
    if (!hadLocalPullRequestBranch) {
      await $`git -C ${input.cwd} branch -D ${localPullRequestBranch}`.quiet().catch(() => {});
    }
    throw err;
  }

  return {
    prHeadBranchCwd: worktreePath,
    worktreePath,
    createdWorktreePath: worktreePath,
    cleanup: onceCleanup(() =>
      removeReviewWorktree(input.cwd, worktreePath, localPullRequestBranch, !hadLocalPullRequestBranch),
    ),
  };
}

export async function getPRDiff(project: string, pr: string | number): Promise<string> {
  const diff = await $`gh pr diff ${pr}`.cwd(project).text();
  return diff.trim();
}

export async function getPRDiffStat(project: string, pr: string | number): Promise<string> {
  const stat = await $`gh pr diff ${pr} --name-only`.cwd(project).text();
  return stat.trim();
}

export type PullRequestReviewDataKind = "review" | "top_level_comment";

export interface PullRequestReviewThreadComment {
  id: number;
  body: string;
  htmlUrl: string | null;
  authorLogin: string | null;
  path?: string;
  line?: number;
  diffHunk?: string;
}

export interface PullRequestReviewData {
  id: number;
  kind: PullRequestReviewDataKind;
  body: string;
  htmlUrl: string | null;
  authorLogin: string | null;
  reviewComments?: PullRequestReviewThreadComment[];
}

const GitHubCommentUserSchema = z
  .object({
    login: z.string().nullable().optional(),
  })
  .nullable()
  .optional();

const GitHubPullRequestReviewCommentSchema = z.object({
  id: z.number(),
  body: z.string().nullable().optional(),
  html_url: z.string().nullable().optional(),
  pull_request_url: z.string(),
  user: GitHubCommentUserSchema,
  path: z.string().nullable().optional(),
  line: z.number().nullable().optional(),
  diff_hunk: z.string().nullable().optional(),
});

const GitHubPullRequestReviewSchema = z.object({
  id: z.number(),
  body: z.string().nullable().optional(),
  html_url: z.string().nullable().optional(),
  pull_request_url: z.string(),
  user: GitHubCommentUserSchema,
});

const GitHubIssueCommentSchema = z.object({
  id: z.number(),
  body: z.string().nullable().optional(),
  html_url: z.string().nullable().optional(),
  issue_url: z.string(),
  user: GitHubCommentUserSchema,
});

async function getPullRequestReviewComments(
  project: string,
  pullRequest: PRInfo,
  reviewId: string | number,
): Promise<PullRequestReviewThreadComment[]> {
  const endpoint = `repos/${pullRequest.owner}/${pullRequest.repo}/pulls/${pullRequest.number}/reviews/${reviewId}/comments`;
  const json = await $`gh api ${endpoint} --paginate --slurp`.cwd(project).text();
  const pages = z.array(z.array(GitHubPullRequestReviewCommentSchema)).parse(JSON.parse(json));
  return pages.flat().map((comment) => ({
    id: comment.id,
    body: comment.body ?? "",
    htmlUrl: comment.html_url ?? null,
    authorLogin: comment.user?.login ?? null,
    path: comment.path ?? undefined,
    line: comment.line ?? undefined,
    diffHunk: comment.diff_hunk ?? undefined,
  }));
}

async function getPullRequestReviewDataByReviewId(
  project: string,
  pullRequest: PRInfo,
  reviewId: string | number,
): Promise<PullRequestReviewData> {
  const endpoint = `repos/${pullRequest.owner}/${pullRequest.repo}/pulls/${pullRequest.number}/reviews/${reviewId}`;
  const json = await $`gh api ${endpoint}`.cwd(project).text();
  const data = GitHubPullRequestReviewSchema.parse(JSON.parse(json));
  const reviewComments = await getPullRequestReviewComments(project, pullRequest, data.id);
  return {
    id: data.id,
    kind: "review",
    body: data.body ?? "",
    htmlUrl: data.html_url ?? null,
    authorLogin: data.user?.login ?? null,
    reviewComments,
  };
}

async function getPullRequestComment(
  project: string,
  pullRequest: PRInfo,
  commentId: string | number,
): Promise<PullRequestReviewData> {
  const endpoint = `repos/${pullRequest.owner}/${pullRequest.repo}/issues/comments/${commentId}`;
  const json = await $`gh api ${endpoint}`.cwd(project).text();
  const data = GitHubIssueCommentSchema.parse(JSON.parse(json));
  return {
    id: data.id,
    kind: "top_level_comment",
    body: data.body ?? "",
    htmlUrl: data.html_url ?? null,
    authorLogin: data.user?.login ?? null,
  };
}

export async function getPullRequestReviewData(
  project: string,
  pullRequest: PRInfo,
  input: { commentId?: string | number; reviewId?: string | number },
): Promise<PullRequestReviewData> {
  if (input.commentId && input.reviewId) {
    throw new Error("Pass either commentId or reviewId, not both.");
  }
  if (input.reviewId) {
    return getPullRequestReviewDataByReviewId(project, pullRequest, input.reviewId);
  }
  if (input.commentId) {
    return getPullRequestComment(project, pullRequest, input.commentId);
  }
  throw new Error("Missing required field: commentId or reviewId");
}

export async function getWorktreeStatus(cwd: string): Promise<string> {
  const status = await $`git -C ${cwd} status --porcelain`.text();
  return status.trim();
}

export async function fastForwardPullRequestHeadWorktree(
  cwd: string,
  pullRequest: PRInfo,
): Promise<void> {
  await $`git -C ${cwd} fetch origin refs/pull/${pullRequest.number}/head`.quiet();
  await $`git -C ${cwd} merge --ff-only FETCH_HEAD`.quiet();
}

function resolvePullRequestHeadPushRemote(pullRequest: PRInfo): string {
  if (!pullRequest.isCrossRepository) return "origin";
  if (!pullRequest.headRepositoryOwnerLogin || !pullRequest.headRepositoryName) {
    throw new Error(`Cannot resolve head repository for cross-repository PR #${pullRequest.number}.`);
  }
  return `https://github.com/${pullRequest.headRepositoryOwnerLogin}/${pullRequest.headRepositoryName}.git`;
}

export async function commitAndPushToPullRequestHead(input: {
  cwd: string;
  pullRequest: PRInfo;
  message: string;
}): Promise<boolean> {
  const status = await getWorktreeStatus(input.cwd);
  if (!status) return false;

  await $`git -C ${input.cwd} add -A`.quiet();
  await $`git -C ${input.cwd} commit -m ${input.message}`.quiet();

  const remote = resolvePullRequestHeadPushRemote(input.pullRequest);
  await $`git -C ${input.cwd} push ${remote} HEAD:${input.pullRequest.headBranch}`.quiet();
  return true;
}

export type PullRequestReviewAction = "comment" | "request_changes";

export function canRequestChangesForPullRequest(
  prAuthorLogin: string | null | undefined,
  reviewerLogin: string | null | undefined,
): boolean {
  if (!prAuthorLogin || !reviewerLogin) return true;
  return prAuthorLogin.toLowerCase() !== reviewerLogin.toLowerCase();
}

export async function getAuthenticatedGitHubLogin(project: string): Promise<string | null> {
  const login = await $`gh api user --jq .login`.cwd(project).text();
  return login.trim() || null;
}

export async function resolvePullRequestReviewAction(input: {
  project: string;
  requestedAction: PullRequestReviewAction;
  prAuthorLogin: string | null;
}): Promise<PullRequestReviewAction> {
  if (input.requestedAction !== "request_changes") return input.requestedAction;

  const reviewerLogin = await getAuthenticatedGitHubLogin(input.project).catch((err) => {
    log("github", "failed to determine authenticated GitHub user before requesting changes:", err);
    return null;
  });

  if (canRequestChangesForPullRequest(input.prAuthorLogin, reviewerLogin)) {
    return "request_changes";
  }

  log(
    "github",
    `downgrading request_changes to comment because PR author and reviewer are both ${reviewerLogin}`,
  );
  return "comment";
}

export async function commentOnPR(
  project: string,
  pr: string | number,
  body: string,
  action: PullRequestReviewAction = "comment",
): Promise<void> {
  if (action === "request_changes") {
    await $`gh pr review ${pr} --request-changes --body ${body}`.cwd(project).quiet();
  } else {
    await $`gh pr review ${pr} --comment --body ${body}`.cwd(project).quiet();
  }
  log("github", `PR review posted: pr=${pr} action=${action} chars=${body.length}`);
}
