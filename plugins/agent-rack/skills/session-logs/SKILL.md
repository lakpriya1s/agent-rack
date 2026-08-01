---
name: session-logs
description: Read the raw stdout/stderr event stream from a background agent-rack session
argument-hint: '<sessionId> [--offset <n>] [--limit <n>]'
allowed-tools: mcp__plugin_agent-rack_agent-rack__agent_session_logs
disable-model-invocation: true
---

Read paginated raw events from a session through agent-rack's `agent_session_logs` MCP tool.

Raw slash-command arguments:
`$ARGUMENTS`

## Parsing

First word is `sessionId`. Recognized flags: `--offset <n>` (skip this many events from the
start, default `0`), `--limit <n>` (max events to return, default all remaining).

## Execution

Call `mcp__plugin_agent-rack_agent-rack__agent_session_logs` with `sessionId` and any given `offset`/`limit`.

## Output

The result is a raw array of `ParsedAgentEvent` objects (`type`, `content`, and for tool events
`toolName`/`input`/`output`, each with a `timestamp`). This is lower-level than
`/agent-rack:session-status` — use it when the user wants to see the actual event-by-event
stream (e.g. debugging why a session behaved a certain way), not just the final summary. Present
it as a readable timeline rather than dumping raw JSON when there are more than a handful of
events.
