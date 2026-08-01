---
name: run
description: Run a one-shot task synchronously with a named CLI sub-agent via agent-rack
argument-hint: '<agent> <prompt> [--workspace <path>] [--mode <mode>] [--timeout <seconds>]'
allowed-tools: mcp__plugin_agent-rack_agent-rack__agent_run, mcp__plugin_agent-rack_agent-rack__agent_list_available
disable-model-invocation: true
---

Run a synchronous sub-agent task through agent-rack's `agent_run` MCP tool.

Raw slash-command arguments:
`$ARGUMENTS`

## Parsing

The first word is the agent id (e.g. `claude`, `codex`, `opencode`, `agy` for Antigravity, or a
custom agent from the user's config). Everything after it, up to any `--flag` tokens, is the
prompt. Recognized flags:

- `--workspace <path>` → `workspace` parameter
- `--mode <mode>` → `mode` parameter (e.g. `plan`, `acceptEdits`, `auto` for claude)
- `--timeout <seconds>` → `timeoutSeconds` parameter

If no agent id is given, or you're unsure which ids are configured, call
`mcp__plugin_agent-rack_agent-rack__agent_list_available` first and ask the user to pick one rather than guessing.

## Execution

Call `mcp__plugin_agent-rack_agent-rack__agent_run` with `agent` and `prompt` (both required), plus any of
`workspace`, `mode`, `timeoutSeconds` the user supplied. Do not add extra instructions to the
prompt text beyond what the user wrote.

## Output

Return the tool's response as-is. It already includes a "### Tool Calls Executed" manifest if
the sub-agent used tools — do not strip or summarize it away. Do not perform any follow-up
edits yourself; this command only delegates the task to the sub-agent.
