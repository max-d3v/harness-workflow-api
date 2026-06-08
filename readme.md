# Claude Harness API 🦹


Use your Claude subscription plan through an HTTP wrapper to make autonomous coding agents for 1/5 of the price.

# Prerequisites

- Bun
- Logged-in Claude CLI
- Logged-in Codex CLI (optional, for `cli: "codex"`)
- Logged-in GitHub CLI

# Modes

## Prompt

Given your prompt, project, and origin branch, it will create a worktree, apply changes, and open a draft PR.

## Code review

Given a PR and project, it will analyze the PR with my code review prompt and add a comment with the review.

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

# Defaults and more details

Claude Code is the default CLI. Pass `"cli": "codex"` (or `"provider": "codex"`) to use `codex exec` instead. Mode calls resolve `model` and `effort` from `provider_defaults` in `src/config.ts` unless the request overrides them.

If a provider or mode has no configured defaults, requests must pass the missing values explicitly or the API will throw.

Each mode has their set of tools, prompt with all and code-review with read-only tools.

You can persist sessions, but I’m against it. If you have a problem big enough that Opus with high reasoning can’t one shot, just use your t3code locally and go at it.

# Why?

Like I already said, this makes autonomous coding agents way cheaper for 2 reasons:

1. **Using your own computer to run queries**  
   Since all this does is use Claude Code, which is not heavy, there’s no heavy load.

2. **Using a Claude Code plan**  
   APIs from Anthropic, OpenAI, etc. are usage-cost based, so depending on your plan, they can be 5x–10x more expensive per token than your subscription.

This also makes code reviewers better for one reason:

I know people say Claude Code is not the best harness, but it’s still made by the creators of the model, so even with high token spendage, I deem it a good harness.

SaaS code reviewers (like code rabbit, greptile etc.) use their own harnesses (unreliable), worst models (You can use opus here which i deem the best model for coding) and super expensive monthly plans (obviously, they have to pay usage-based tokens for their model inference). Their only advantage is maybe that they have better code review prompts, which are a small part of the results.

# How I will use it

First, keep in mind that all git actions taken from this API are done as the logged-in user running this API.

I’ll expose this via ngrok for integrations with Linear and GitHub.

I’ll use `/prompt` for small, well-described Linear problems that i think opus can one-shot. You can use your own information hub like jira or sum other bs.

I’ll use `/mode/code-review` for every PR opened in the projects I choose, via GitHub Actions just calling this API with the necessary info.

# Will this get DMCA'd?

Anthropic, if you are seeing this, please hire me. I’ll nuke this repo. Please Anthropic.
