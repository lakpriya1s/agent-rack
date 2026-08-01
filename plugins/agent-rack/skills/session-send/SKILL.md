---
name: session-send
description: Send follow-up input to a running background agent-rack session
argument-hint: '<sessionId> <message>'
allowed-tools: mcp__agent-rack__agent_session_send
disable-model-invocation: true
---

Send follow-up text to a running session's stdin via agent-rack's `agent_session_send` MCP tool.

Raw slash-command arguments:
`$ARGUMENTS`

## Parsing

The first word is the `sessionId`; everything after it is the `message` to send verbatim — do
not rephrase or add to it.

## Execution

Call `mcp__agent-rack__agent_session_send` with `sessionId` and `message`. This only works while
the session's status is `running`; if it errors because the session isn't running, tell the
user to check `/agent-rack:session-status <sessionId>` instead.

## Output

Confirm the message was sent. This does not return the sub-agent's reply — use
`/agent-rack:session-status` or `/agent-rack:session-logs` to see how it responded.
