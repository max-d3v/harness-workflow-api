# Coding Harness API 🦹

Use your Claude or Codex subscription plan through an HTTP wrapper to run autonomous coding agents and automations (code reviews, QA agents) for one-fifth of the price.

# Prerequisites

- Bun
- Either a logged-in Claude CLI or a logged-in Codex CLI
- A logged-in GitHub CLI
- [Gitshot](https://github.com/vipulgupta2048/gitshot), via `npx`, for uploading QA screenshots to a dedicated image repo on the logged-in GitHub account so they can be embedded in PR comments

# Modes

## Prompt

Given your prompt, project, and origin branch, it creates a worktree, chosen harness runs and applies changes then a draft PR is opened with them

## Code review

Given a PR and project, the harness you choose performs a review with Cursor's internal team code review prompt (the best I have used by far) and adds it as a comment on the PR.

## QA

Given a PR and a project, the harness spawns two agents: one starts the dev server related to the change, and the other uses Playwright or browser MCP, the diff context, and any optional login information you passed to access the application and test it.
At the end, the QA dev server is killed.
It adds comments to the PR with its findings as it goes, so if it gets stuck or throws an error, the things it already tested will remain.

# Examples

## POST /prompt

request:
```json
{
  "prompt": "Implement a simple readme change - add a smiling face somewhere",
  "project": "code/nextjs-boilerplate",
  "originBranch": "main",
  "cli": "codex"
}
```

response:
```json
{
  "result": "Done! I added a 😊 smiling face to the main heading of `README.md`, so it now reads **# Orion Kit 😊**.",
  "sessionId": "b837e493-007b-4102-8adc-0a33b67bb99a",
  "prUrl": "https://github.com/max-d3v/orion-kit/pull/2",
  "branch": "agent/main-38092eb7"
}
```

## POST /mode/code-review

request:
```json
{
  "pr": 2,
  "project": "code/nextjs-boilerplate"
}
```

response:
```json
{
  "result": "## PR Review: Add smiling face to README heading\n\nThis diff is clean. The change is a single-character emoji addition to the README title — no code, logic, security, or performance concerns apply.\n\n**One minor note:** Adding an emoji to a project heading (`# Orion Kit 😊`) is a stylistic/branding choice. If this is intentional and agreed upon by the team, it's fine to merge. Just confirm it aligns with the project's tone and that no downstream tooling (e.g., scripts that parse the README title, or `package.json` `name` field comparisons) depends on the exact heading text.\n\nNo issues to block this PR.",
  "sessionId": "7207f92b-d5a3-4162-949c-90a25d26e737",
  "prUrl": "https://github.com/max-d3v/orion-kit/pull/2",
  "prNumber": 2
}
```

## POST /mode/code-test

Warning: automated QA does not currently work with Codex. Use the default Claude provider for code-test until Codex QA support is fixed.

request:
```json
{
  "pr": 2,
  "project": "code/nextjs-boilerplate",
  "loginInstructions": "email: automation@gmail.com, senha: automationPassword, username: automation" // This is a dummy profile I created in my app's auth for the agent to access.
}
```

response:
```json
{
  "result": "## Automated QA complete\n\nTested the README change and confirmed the application still starts successfully. No issues found.",
  "sessionId": "7207f92b-d5a3-4162-949c-90a25d26e737",
  "prUrl": "https://github.com/max-d3v/orion-kit/pull/2",
  "prNumber": 2,
  "model": "claude-opus-4-6",
  "usage": {
    "input_tokens": 15210,
    "output_tokens": 2310,
    "cache_creation_input_tokens": 900,
    "cache_read_input_tokens": 0
  },
  "totalTokens": 18420,
  "totalCostUsd": 0.42
}
```

# Defaults and more details

Claude Code is the default CLI. Pass `"cli": "codex"` (or `"provider": "codex"`) to use `codex exec` instead. Mode calls resolve `model` and `effort` from `provider_defaults` in `src/config.ts` unless the request overrides them.

Code testing uses `qa` defaults for the tester agent and `qa_dev_server` defaults for the dev-server starter. Pass `"serverModel"` in a code-test request to override only the dev-server starter model.

Provider runs print streamed model actions to the server terminal when `show_model_actions` is enabled in `src/config.ts`. Turn it off there to keep only request start, success, cancellation, and error logs.

If a provider or mode has no configured defaults, requests must pass the missing values explicitly or the API will throw.

Each mode has its own set of tools: prompt mode has all tools, and code-review mode has read-only tools.

You can persist sessions, but I’m against it. If you have a problem big enough that Opus with high reasoning can’t one-shot, just use your t3code locally and go at it.

# Why?
You might be asking, why not use CodeRabbit or something?

Like I already said, this makes autonomous coding agents way cheaper for two reasons:

1. **Using your own computer to run queries**  
   Instead of paying for compute at a premium, use your PC to run the harness. Most agents are light, and you are already paying for the model.

2. **Using a Subscription rather than APIs**  
   APIs from Anthropic, OpenAI, etc. are usage-cost-based, so depending on your plan, they can be 5x–10x more expensive per token than your subscription.

This also makes code reviewers better for one reason:

I know people say Claude Code is not the best harness, but it’s still made by the creators of the model, so even with high token spending, I deem it a good harness.

SaaS code reviewers (like CodeRabbit, Greptile, etc.) use their own harnesses (unreliable), worse models (you can use the best models here, like Opus 4.8 or GPT-5.5, which are significantly better), and because these third parties pay full API price, they have super expensive monthly plans.

# How I will use it

First, keep in mind that all git actions taken from this API are done as the logged-in user running this API.

I’ll expose this via ngrok for integrations with Linear and GitHub.

I am using `/prompt` for small, well-described Linear problems that I think Opus can one-shot. You can use your own information hub, like Jira or some other BS.

I am using `/mode/code-review` for every PR opened in the projects I choose, via GitHub Actions calling this API with the necessary info. (see /examples; it is the exact one I use)

I am still experimenting with `/mode/code-test`, since I am not sure it is worth its tokens for most use cases, so I am just calling it manually for some PRs.

# Will this get DMCA'd?

Anthropic or OpenAI, if you are seeing this, please hire me. I’ll nuke this repo. Please Anthropic.
