---
name: session-start
description: Start a background sub-agent session via agent-rack for a long-running task
argument-hint: '<agent> <prompt> [--workspace <path>] [--mode <mode>]'
allowed-tools: mcp__plugin_agent-rack_agent-rack__agent_session_create, mcp__plugin_agent-rack_agent-rack__agent_list_available
disable-model-invocation: true
---

Start a background sub-agent session through agent-rack's `agent_session_create` MCP tool.

Raw slash-command arguments:
`$ARGUMENTS`

## Parsing

Same shape as `/agent-rack:run`: first word is the agent id, the rest (minus flags) is the
prompt. Recognized flags: `--workspace <path>`, `--mode <mode>`.

If no agent id is given, call `mcp__plugin_agent-rack_agent-rack__agent_list_available` and ask rather than
guessing.

## When to prefer this over `/agent-rack:run`

Use this instead of the synchronous `/agent-rack:run` when the task is long-running, or the
user wants to keep working while it runs in the background, or they'll want to send follow-up
input mid-task.

## Execution

Call `mcp__plugin_agent-rack_agent-rack__agent_session_create` with `agent` and `prompt`, plus `workspace`/`mode`
if given. It returns immediately with a `sessionId` and `status: "running"` — it does not block.

## Output

Report the `sessionId` clearly and tell the user how to follow up:
- `/agent-rack:session-status <sessionId>` for current status/summary
- `/agent-rack:session-logs <sessionId>` to tail the raw event stream
- `/agent-rack:session-send <sessionId> <message>` to send follow-up input
- `/agent-rack:session-cancel <sessionId>` to stop it early

Do not poll status yourself in this command — starting the session is the entire job.
