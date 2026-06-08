import { $ } from "bun";
import { randomBytes } from "crypto";
import path from "path";
import { realpath, rm, stat } from "fs/promises";

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

  return { worktreePath, branch, originBranch, project, cleanup };
}

export async function commitAndPush(ctx: WorktreeContext, message: string): Promise<void> {
  const cwd = ctx.worktreePath;
  const status = await $`git -C ${cwd} status --porcelain`.text();
  if (!status.trim()) return;

  await $`git -C ${cwd} add -A`.quiet();
  await $`git -C ${cwd} commit -m ${message}`.quiet();
  await $`git -C ${cwd} push -u origin ${ctx.branch}`.quiet();
}

export async function openPR(
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
  owner: string;
  repo: string;
}

export interface ReviewCwd {
  reviewCwd: string;
  worktreePath: string | null;
}

export async function getPRInfo(project: string, pr: string | number): Promise<PRInfo> {
  const json = await $`gh pr view ${pr} --json number,title,baseRefName,headRefName,url`.cwd(project).text();
  const data = JSON.parse(json);
  // gh returns the canonical PR URL: https://<host>/<owner>/<repo>/pull/<n>
  const [owner, repo] = new URL(data.url).pathname.split("/").filter(Boolean);
  if (!owner || !repo) {
    throw new Error(`Could not parse owner/repo from PR url: ${data.url}`);
  }
  return {
    number: data.number,
    title: data.title,
    baseBranch: data.baseRefName,
    headBranch: data.headRefName,
    url: data.url,
    owner,
    repo,
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

async function canonicalizeExistingPath(filePath: string): Promise<string> {
  return realpath(filePath);
}

async function findExistingHeadBranchWorktree(
  cwd: string,
  rootWorktreePath: string,
  pullRequest: PRInfo,
  localPullRequestBranch: string,
): Promise<string | null> {
  const format = "%(refname:short)%00%(worktreepath)";
  const refs = await $`git -C ${cwd} for-each-ref --format=${format} refs/heads`.text();
  for (const line of refs.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const [name, worktreePath] = line.split("\0");
    if (!name || !worktreePath) continue;
    if (name !== localPullRequestBranch && name !== pullRequest.headBranch) continue;

    const canonical = await canonicalizeExistingPath(worktreePath);
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

export async function resolveReviewCwd(input: {
  cwd: string;
  initialBranch: string | null;
  pullRequest: PRInfo;
}): Promise<ReviewCwd> {
  if (input.initialBranch === input.pullRequest.headBranch) {
    return { reviewCwd: input.cwd, worktreePath: null };
  }

  const localPullRequestBranch = resolvePullRequestWorktreeLocalBranchName(input.pullRequest);
  const rootWorktreePath = await canonicalizeExistingPath(input.cwd);

  const existing = await findExistingHeadBranchWorktree(
    input.cwd,
    rootWorktreePath,
    input.pullRequest,
    localPullRequestBranch,
  );
  if (existing) {
    return { reviewCwd: existing, worktreePath: existing };
  }

  await materializePullRequestHeadBranch(input.cwd, input.pullRequest, localPullRequestBranch);

  const afterFetch = await findExistingHeadBranchWorktree(
    input.cwd,
    rootWorktreePath,
    input.pullRequest,
    localPullRequestBranch,
  );
  if (afterFetch) {
    return { reviewCwd: afterFetch, worktreePath: afterFetch };
  }

  const worktreePath = await nextAvailableWorktreePath(input.cwd, localPullRequestBranch);
  await $`git -C ${input.cwd} worktree add ${worktreePath} ${localPullRequestBranch}`.quiet();
  return { reviewCwd: worktreePath, worktreePath };
}

export async function getPRDiff(project: string, pr: string | number): Promise<string> {
  const diff = await $`gh pr diff ${pr}`.cwd(project).text();
  return diff.trim();
}

export async function getPRDiffStat(project: string, pr: string | number): Promise<string> {
  const stat = await $`gh pr diff ${pr} --name-only`.cwd(project).text();
  return stat.trim();
}

export async function commentOnPR(project: string, pr: string | number, body: string): Promise<void> {
  await $`gh pr review ${pr} --comment --body ${body}`.cwd(project).quiet();
}
