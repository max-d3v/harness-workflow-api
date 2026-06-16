# Coding Harness API 🦹

Get a better and customizable code rabbit for free!

Use your Claude or Codex subscription plan through an HTTP wrapper to run autonomous coding agents and automations (code reviews, QA agents) for one-fifth of the price.

# Prerequisites

- Bun and Node/npm available on the machine running the API. QA mode uses `npx` for Playwright MCP, GitHub MCP, and Gitshot.
- A local git checkout for each project you pass in requests.
- A logged-in GitHub CLI (`gh auth login`). The API uses `gh` to read PRs, post reviews/comments, create PRs, and push branches.
- [Gitshot](https://github.com/vipulgupta2048/gitshot), via `npx`, for uploading QA screenshots to a dedicated image repo on the logged-in GitHub account so they can be embedded in PR comments.
- A reachable running app URL for QA runs. The QA endpoint is URL-only: it does not build, boot, or deploy the app for the agent.

# Setup

Install dependencies:

```bash
bun install
```

Create `.env`:

```bash
cp .env.example .env
```

Generate the API token:

```bash
RAW_TOKEN="$(openssl rand -hex 32)"
printf '%s\n' "$RAW_TOKEN"
TOKEN="$RAW_TOKEN" perl -0pi -e 's/^CODING_HARNESS_API_TOKEN=.*/CODING_HARNESS_API_TOKEN=$ENV{TOKEN}/m' .env
```

The printed `RAW_TOKEN` is the value clients send in the `Authorization` header. If GitHub Actions calls this API, save the same token as a repository secret named `coding_harness_api_token`.

For QA mode, add a GitHub personal access token to `.env`:

```env
GITHUB_TOKEN_USER=github_pat_...
```

Start the API:

```bash
bun run start
```

# Auth

Protected endpoints require bearer-token auth:

```bash
curl -X POST "http://localhost:3000/mode/code-review" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $RAW_TOKEN" \
  -d '{"pr":2,"project":"code/nextjs-boilerplate"}'
```

`GET /health` is public so health checks can run without a token. All other endpoints return `401 Unauthorized` when the token is missing or invalid. If `CODING_HARNESS_API_TOKEN` is not set on the server, protected endpoints return `500` until it is configured.

The example GitHub Action in `src/examples/repository-code-review-action.yaml` expects:

- repository variable `claude_harness_api_url`
- repository variable `project_local_path`
- repository secret `coding_harness_api_token`

# Modes

## Prompt

Given your prompt, project, and origin branch, it creates a worktree, chosen harness runs and applies changes then a draft PR is opened with them

## Code review

Given a PR and project, the harness you choose performs a review with Cursor's internal team code review prompt (the best I have used by far) and adds it as a comment on the PR.

## QA

Given a PR, a project, and one or more functional app URLs, the harness creates a temporary PR-head worktree for read-only context, passes the PR diff/stat to a tester agent, and tells the agent to exercise only the changed user-facing behavior through the provided URL(s).

QA is URL-only. The app must already be running at the supplied absolute `http://` or `https://` URL(s), such as a Vercel preview deployment, staging URL, or local tunnel. The harness does not run `bun dev`, start services, seed data, or infer routes on its own.

The QA agent reports as it goes. For every functional section it tests, it takes a screenshot, uploads it through Gitshot, and posts a scoped PR comment with the result. Working sections get a confirmation comment; broken sections get reproduction steps, expected vs. actual behavior, a likely cause or fix, and the screenshot. The agent's final response is only returned in the API response; the useful QA record lives in the PR comments already posted during the run.

QA runs are read-only against the repository. The tester can inspect files for context, but it is not allowed to edit code.

### QA MCP servers

`/mode/code-test` starts these MCP servers for the tester agent:

- `playwright`: `npx -y @playwright/mcp@latest --headless --isolated` for browser navigation and screenshots.
- `imageUploader`: an in-process MCP server exposing `upload_screenshot`, which runs `npx gitshot <path>` and returns a GitHub Markdown image string.
- `github`: `npx -y @modelcontextprotocol/server-github` with `GITHUB_PERSONAL_ACCESS_TOKEN` set from `GITHUB_TOKEN_USER`, used to post PR comments.

The tester is only allowlisted for Playwright MCP tools, `mcp__imageUploader`, and `mcp__github__add_issue_comment`.

### Codex QA provider requirements

As of 2026-06-16, Claude receives the QA `mcpServers` object directly through the Claude SDK. Codex does not. The Codex SDK only receives Codex CLI configuration overrides, so Codex QA must have the MCP server configuration wired directly in the Codex provider/config path before it can use the tester tools. This may become outdated if future Codex configs add first-class per-run MCP support.

For Codex QA, make sure the Codex provider exposes all of the same QA capabilities:

- Playwright MCP for browser navigation and screenshots.
- GitHub MCP with `GITHUB_TOKEN_USER`/`GITHUB_PERSONAL_ACCESS_TOKEN` for `add_issue_comment`.
- The image upload MCP, or an equivalent `$gitshot` skill path, so screenshots can become GitHub Markdown images.
- The local `$gitshot` skill itself. The provider-local skill definition lives at `src/providers/codex/SKILL.md`; add/install that skill into Codex through Codex plugins so the Codex runtime can actually call `$gitshot`.

Do not assume the `mcpServers` object built by `/mode/code-test` automatically reaches Codex. Until the Codex provider maps those MCP definitions into its own Codex config, Codex will only see MCPs and skills already present in the local Codex environment.

### QA request fields

- `project`: local checkout path. Relative paths resolve from the user's home directory, so `code/my-app` becomes `~/code/my-app`.
- `pr`: pull request number.
- `url` or `urls`: one absolute HTTP(S) app URL, or multiple URLs when a PR touches multiple surfaces.
- `focus`: optional narrow area to prioritize.
- `extraInstructions`: optional credentials, test data, tenant names, or other run-specific context.
- `cli` or `provider`: optional agent provider. Use the default Claude provider for QA. If you choose Codex, first wire the QA MCPs and `$gitshot` skill directly into the Codex provider/config path.
- `model` and `effort`: optional overrides for the provider defaults.

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
  "url": "https://nextjs-boilerplate-git-pr-2-example.vercel.app",
  "focus": "checkout form validation",
  "extraInstructions": "Login example: email: automation@example.com, password: automationPassword, username: automation"
}
```

Pass `"urls": ["https://preview.example.com", "https://admin-preview.example.com"]` when a QA run needs to exercise multiple surfaces. URLs must be absolute `http://` or `https://` values.

response:
```json
{
  "result": "## Automated QA complete\n\nTested the preview URL and confirmed the changed flow still works. No issues found.",
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

Code testing uses `qa` defaults for the tester agent. A code-test request must include `"url"` or `"urls"` with reachable HTTP(S) app URLs.

Provider runs print streamed model actions to the server terminal when `show_model_actions` is enabled in `src/config.ts`. Turn it off there to keep only request start, success, cancellation, and error logs.

If a provider or mode has no configured defaults, requests must pass the missing values explicitly or the API will throw.

Agent access is controlled with the optional `"access"` field: `"all-access"` enables editing tools, while `"read-only"` limits the agent to repository inspection. Prompt mode defaults to all-access; review and QA tester runs pass read-only access explicitly.

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
