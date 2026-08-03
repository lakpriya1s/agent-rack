---
name: session-logs
description: Read the raw stdout/stderr event stream from a background agent-rack session
argument-hint: '<sessionId> [--cursor <n>] [--tail <n>] [--limit <n>]'
allowed-tools: mcp__plugin_agent-rack_agent-rack__agent_session_logs
disable-model-invocation: true
---

Read paginated raw events from a session through agent-rack's `agent_session_logs` MCP tool.

Raw slash-command arguments:
`$ARGUMENTS`

## Parsing

First word is `sessionId`. Recognized flags: `--cursor <n>` (return only events at or after this
cursor, default `0`), `--tail <n>` (instead of a cursor, return only the most recent N events),
`--limit <n>` (max events to return, default all remaining).

## Execution

Call `mcp__plugin_agent-rack_agent-rack__agent_session_logs` with `sessionId` and any given
`cursor`/`tail`/`limit`.

## Output

The result is a page object, not a bare array:

- `events` — the `ParsedAgentEvent` objects (`type`, `content`, and for tool events
  `toolName`/`input`/`output`, each with a `timestamp`).
- `nextCursor` — pass this as `--cursor` on a follow-up call to fetch only what is new. Use this
  when watching a session over several calls instead of re-reading the whole log each time.
- `droppedCount` — non-zero means older events aged out of the retained log before you read them.
  Say so rather than presenting the timeline as complete.
- `totalEvents` / `oldestCursor` — the monotonic total produced, and the oldest still retained.

This is lower-level than `/agent-rack:session-status` — use it when the user wants the actual
event-by-event stream (e.g. debugging why a session behaved a certain way), not just the final
summary. Present it as a readable timeline rather than dumping raw JSON when there are more than a
handful of events.
