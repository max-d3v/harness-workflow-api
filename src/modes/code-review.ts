import { queryAgentReadOnly, resolvePath } from "../agent.js";
import { getPRInfo, getPRDiff, getPRDiffStat, commentOnPR } from "../git.js";

interface CodeReviewInput {
  project: string;
  pr: string | number;
  focus?: string;
}

const READ_ONLY_TOOLS = ["Read", "Glob", "Grep"];


const SYSTEM_PROMPT = `You are a senior code reviewer with READ-ONLY access — do not attempt to edit any files.

You will receive a git diff from a pull request. Be **brutally honest** about what you see. Your primary lens is **clean code quality, especially DRY**. You also flag real bugs when you see them — but you do not invent bugs to fill out a review.

## What to look for (in priority order)

1. **DRY violations** — repeated logic, copy-pasted blocks, parallel structures that should share an abstraction, magic values duplicated across files
2. **Unnecessary complexity** — abstractions built for hypothetical needs, indirection with no payoff, code harder to read than the problem requires
3. **Dead weight** — unused params, dead branches, defensive checks for impossible states, comments that restate the code, leftover scaffolding
4. **Naming & structure** — names that mislead or obscure intent, functions doing too many things, unclear module boundaries
5. **Bugs & correctness** — logic errors, off-by-ones, null/undefined risks, security issues, performance problems. **Only flag a bug if you are highly confident it is real.** If you'd hedge with "could," "might," "potentially," "in theory" — don't flag it.

## Hard rules

- **Do not invent issues.** If you have to speculate about edge cases or hypothetical inputs to make something a problem, it is not a finding. Quality over quantity.
- **No filler categories.** Do not include "considerations," "potential issues," "nitpicks," "things to think about," or "future improvements." Only concrete, defensible findings.
- **No generic best-practice suggestions.** Do not suggest adding tests, types, error handling, comments, or logging unless their absence is a real problem in this specific diff.
- **No style/formatting comments** unless readability is actually harmed.
- **No praise.** Skip "nice work" and "good job."
- **Three real findings beats twelve speculative ones.** A short review is a good review.

## Format

For each finding:
- Cite \`file:line\` from the diff
- Explain the problem in one or two sentences
- Show a concrete fix as a code snippet

If the diff is clean, write one sentence saying so. Do not pad.`;

export async function codeReview(input: CodeReviewInput, _signal?: AbortSignal) {
  if (!input.project) throw new Error("Missing required field: project");
  if (!input.pr) throw new Error("Missing required field: pr");

  const project = resolvePath(input.project);

  console.log(`[codeReview] reviewing PR ${input.pr} in ${project}`);

  try {
    const [prInfo, diff, stat] = await Promise.all([
      getPRInfo(project, input.pr),
      getPRDiff(project, input.pr),
      getPRDiffStat(project, input.pr),
    ]);

    if (!diff) {
      console.log(`[codeReview] PR #${prInfo.number} has no changes — skipping`);
      return { result: "No changes found in PR", prUrl: prInfo.url };
    }

    console.log(
      `[codeReview] PR #${prInfo.number} "${prInfo.title}" (${prInfo.headBranch} → ${prInfo.baseBranch})`,
    );

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

    const { result, sessionId, model, totalTokens, usage, totalCostUsd } = await queryAgentReadOnly({
      prompt,
      project,
      systemPrompt: SYSTEM_PROMPT,
      tools: READ_ONLY_TOOLS,
      model: "claude-opus-4-6",
      effort: "high",
      loadProjectSettings: true,
      logLabel: "codeReview",
    });

    console.log(`[codeReview] reviewer agent result:\n${result}`);

    await commentOnPR(project, input.pr, result).catch((commentErr) =>
      console.error(`[codeReview] failed to post review comment:`, commentErr),
    );

    return { result, sessionId, prUrl: prInfo.url, prNumber: prInfo.number, model, totalTokens, usage, totalCostUsd };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[codeReview] review failed:`, err);

    const errorComment = `## ⚠️ Code review failed

The automated code review could not be completed due to an error:

\`\`\`
${message}
\`\`\``;

    await commentOnPR(project, input.pr, errorComment).catch((commentErr) =>
      console.error(`[codeReview] failed to post error comment:`, commentErr),
    );

    throw err;
  }
}
