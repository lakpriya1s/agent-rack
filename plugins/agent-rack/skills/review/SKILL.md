---
name: review
description: Run a structured, read-only code review through agent-rack's agent_review tool
argument-hint: '<agent> [--base <ref>] [--adversarial] [--focus <text>] [--background] [--timeout <seconds>]'
allowed-tools: mcp__plugin_agent-rack_agent-rack__agent_review, mcp__plugin_agent-rack_agent-rack__agent_session_status, mcp__plugin_agent-rack_agent-rack__agent_list_available
disable-model-invocation: true
---

Run a read-only structured review through agent-rack's `agent_review` MCP tool.

Raw slash-command arguments:
`$ARGUMENTS`

## Core constraint

This command is review-only. Do not fix issues, apply patches, or make any file changes based
on the findings. Your only job is to run the review and present the results.

## Parsing

The first word is the agent id (e.g. `claude`, `codex`, `opencode`, `agy`). If omitted, call
`mcp__plugin_agent-rack_agent-rack__agent_list_available` and ask the user which one to use.

Recognized flags:
- `--base <ref>` → sets `scope: "branch"` and `baseRef: <ref>` (reviews the branch diff against
  that ref instead of the working tree)
- `--adversarial` → `adversarial: true` (skeptical, ship/no-ship stance)
- `--focus <text>` → `focus: <text>` (only meaningful with `--adversarial`)
- `--background` → `background: true` (see Background handling below)
- `--timeout <seconds>` → `timeoutSeconds: <seconds>`

With no flags, this reviews the current working-tree changes in the foreground.

## Execution

Call `mcp__plugin_agent-rack_agent-rack__agent_review` with `agent` and the parsed parameters.

### Background handling

If `background` is set, the tool returns session info immediately (a `sessionId`, `status:
"running"`). Tell the user the review started in the background and that they can check
`/agent-rack:session-status <sessionId>` for the parsed result once it completes — do not poll
or wait yourself.

## Output rules

- Present the `verdict` and `summary` first, then `findings` ordered by `severity`
  (critical → high → medium → low), then `next_steps`.
- Use the `file`/`line_start`/`line_end` exactly as returned; `0` means whole-file or
  architectural, not a real line number.
- If `parseError: true`, say the agent's reply couldn't be validated as structured JSON and show
  the `raw` text instead of inventing a verdict.
- If the tool reports `"Nothing to review."`, say so plainly — do not spawn a review of
  unrelated files to have something to report.
- CRITICAL: after presenting findings, stop. Do not make any code changes. Explicitly ask the
  user which findings, if any, they want addressed before touching a single file.
