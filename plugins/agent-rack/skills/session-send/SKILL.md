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

## Important: how follow-up works differs per agent, and so does when you may send

Check `followUpMode` on the session (via `/agent-rack:session-status`) first — it decides the
required status, and the two modes are opposites:

| `followUpMode` | Agents | Send when the session is | What happens |
| --- | --- | --- | --- |
| `live` | `opencode` (PTY) | **running** | Text is written to the still-running process. |
| `resume` | `claude`, `codex` | **finished** (`completed`) | The agent is restarted with its own resume flag, continuing the same conversation as a new turn. Status returns to `running` and `turnCount` increases. |
| `none` | `agy` | never | No way to rejoin that specific conversation. |

So for `claude` and `codex`, "the session isn't running any more" is not a failure — it is the
precondition. Do not treat a `completed` session as the end of the road; you can keep the
conversation going. Conversely, sending to a `resume` agent mid-turn is refused: poll
`/agent-rack:session-status` until it is no longer running, then send.

If `followUpMode` is `none`, do not retry or try to work around it — tell the user that this agent
cannot continue a conversation, and offer to start a new session with the follow-up as its prompt.

## Execution

Call `mcp__plugin_agent-rack_agent-rack__agent_session_send` with `sessionId` and `message`. If it
errors about status, re-read the table above rather than retrying — a `live` agent needs a running
session and a `resume` agent needs a finished one.

## Output

Confirm the message was sent. This does not return the sub-agent's reply — use
`/agent-rack:session-status` or `/agent-rack:session-logs` to see how it responded.
