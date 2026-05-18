import { queryAgentReadOnly, resolvePath } from "../agent.js";
import { getPRInfo, getPRDiff, getPRDiffStat, commentOnPR } from "../git.js";

interface CodeReviewInput {
  project: string;
  pr: string | number;
  focus?: string;
}

const READ_ONLY_TOOLS = ["Read", "Glob", "Grep", "ComputerUse"];

const SYSTEM_PROMPT = `You are a senior code reviewer. You have READ-ONLY access — do not attempt to edit any files.

You will receive a git diff from a pull request. Analyze it for:

1. **Bugs & correctness** — logic errors, off-by-ones, null/undefined risks
2. **Security** — injection, auth gaps, secrets in code, unsafe dependencies
3. **Performance** — unnecessary allocations, N+1 queries, missing caching
4. **Readability** — naming, structure, dead code, missing types
5. **Best practices** — error handling, testing gaps, API design

For each finding:
- Reference the file path and line number from the diff
- Explain what's wrong and why
- Suggest a concrete fix (as a code snippet)

Format your review as a structured markdown comment suitable for posting on the PR.
Keep it concise — skip praise, lead with the most impactful findings.
If the diff is clean, say so briefly.`;

export async function codeReview(input: CodeReviewInput, _signal?: AbortSignal) {
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

  const focus = input.focus ? `\nFocus area: ${input.focus}` : "";
  const prompt = `Review PR #${prInfo.number}: "${prInfo.title}" (${prInfo.headBranch} → ${prInfo.baseBranch}).${focus}

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
    systemPrompt: SYSTEM_PROMPT,
    tools: READ_ONLY_TOOLS,
    model: "claude-sonnet-4-6",
    effort: "high",
    loadProjectSettings: true,
  });

  await commentOnPR(project, input.pr, result);

  return { result, sessionId, prUrl: prInfo.url, prNumber: prInfo.number };
}
