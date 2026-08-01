---
name: session-cancel
description: Cancel a running background agent-rack session
argument-hint: '<sessionId>'
allowed-tools: mcp__agent-rack__agent_session_cancel
disable-model-invocation: true
---

Stop a running session through agent-rack's `agent_session_cancel` MCP tool.

Raw slash-command arguments:
`$ARGUMENTS`

## Execution

Call `mcp__agent-rack__agent_session_cancel` with the given `sessionId`. This sends `SIGINT` to
the underlying process, then `SIGKILL` after a 3-second grace period if it hasn't exited.

## Output

Confirm the session's new status. If the session had already finished (`completed`/`failed`)
before this call, say that cancelling had no effect rather than implying it was stopped mid-run.
