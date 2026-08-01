---
name: session-status
description: Check the status and summary of a background agent-rack session
argument-hint: '<sessionId>'
allowed-tools: mcp__plugin_agent-rack_agent-rack__agent_session_status
disable-model-invocation: true
---

Check a background session's status through agent-rack's `agent_session_status` MCP tool.

Raw slash-command arguments:
`$ARGUMENTS`

## Execution

The argument is a `sessionId` (from `/agent-rack:session-start` or a background
`/agent-rack:review`). Call `mcp__plugin_agent-rack_agent-rack__agent_session_status` with it.

## Output

Report `status` (`running` | `idle` | `completed` | `failed` | `cancelled`) plainly. If
`status: "completed"`, show the `summary`. If this was a background review session, a `review`
field will also be present — present it the same way `/agent-rack:review` does (verdict,
findings by severity, next steps), and stop after presenting it without making any changes. If
`status: "running"`, tell the user it's still going and to check back later rather than waiting
in a loop.
