---
name: gitshot
description: Upload a local screenshot or image with gitshot and return a GitHub Markdown image link. Use when Codex needs to attach screenshots to GitHub issues, pull requests, review comments, release notes, or any other GitHub Markdown context, especially when the user asks to upload a screenshot, convert an image path to GitHub Markdown, or mimic the gitshot upload_screenshot MCP tool.
---

# Gitshot

## Overview

Upload a local image by running `npx gitshot <path>` and return the resulting Markdown image tag. This mirrors an `upload_screenshot` MCP tool that accepts a `path` argument and reports `Markdown image: ...`.

## Workflow

1. Resolve the image path to an existing local file.
2. Run the bundled wrapper:

```bash
python3 /Users/maxbuzzarellomaul/.codex/skills/gitshot/scripts/upload_screenshot.py /absolute/path/to/image.png
```

3. Return the script output to the user. The output is already formatted as:

```text
Markdown image: ![...](...)
```
