---
name: session-send
description: Send follow-up input to a running background agent-rack session
argument-hint: '<sessionId> <message>'
allowed-tools: mcp__plugin_agent-rack_agent-rack__agent_session_send
disable-model-invocation: true
---

Send follow-up text to a running session via agent-rack's `agent_session_send` MCP tool.

Raw slash-command arguments:
`$ARGUMENTS`

## Parsing

The first word is the `sessionId`; everything after it is the `message` to send verbatim — do
not rephrase or add to it.

## Important: only interactive agents can receive follow-up input

Follow-up input requires an agent whose transport keeps an input channel open — today that means
the interactive/PTY transport (`opencode`). The one-shot CLIs (`claude`, `codex`, `agy`) take
their prompt as a command-line argument and exit when the turn ends, so there is no second turn
to send anything to.

Check `supportsFollowUp` on the session (via `/agent-rack:session-status`) before calling this. If
it is `false`, do not retry or try to work around it — tell the user that this agent cannot take
follow-up input, and offer to start a new session with the follow-up as its prompt instead.

## Execution

Call `mcp__plugin_agent-rack_agent-rack__agent_session_send` with `sessionId` and `message`. This
also requires the session's status to be `running`; if it errors because the session isn't
running, tell the user to check `/agent-rack:session-status <sessionId>` instead.

## Output

Confirm the message was sent. This does not return the sub-agent's reply — use
`/agent-rack:session-status` or `/agent-rack:session-logs` to see how it responded.
