---
name: tool-selection
description: Internal guidance for choosing between agent-rack's sync and background execution tools, and when to use per-agent shortcuts. Use whenever delegating a task to a claude/codex/opencode/Antigravity/custom sub-agent through agent-rack.
user-invocable: false
---

# Choosing an agent-rack execution mode

agent-rack exposes two execution models for the same underlying sub-agents. Pick deliberately,
don't default to one out of habit.

## Synchronous (`agent_run`, or `<agentId>_run` shortcuts)

Use for short, one-shot tasks where blocking until it finishes is fine: quick edits,
single-file fixes, small investigations. This is the simplest path — prefer it unless there's a
specific reason to go async.

If the agent id is already known and fixed for the task (e.g. the user explicitly said "use
codex"), prefer the shortcut tool (`mcp__plugin_agent-rack_agent-rack__codex_run`, `mcp__plugin_agent-rack_agent-rack__claude_run`,
`mcp__plugin_agent-rack_agent-rack__opencode_run`, `mcp__plugin_agent-rack_agent-rack__agy_run`) over `agent_run` with an `agent`
parameter — it's the same call with less to get wrong.

## Background (`agent_session_create` + `agent_session_status`/`_logs`/`_send`/`_cancel`)

Use when:
- the task is likely long-running (large refactors, broad migrations, anything that could
  plausibly run past a couple of minutes),
- the user wants to keep working while it runs,
- the user might want to send follow-up input mid-task (`agent_session_send`), or
- the task should be cancelable (`agent_session_cancel`) if it goes off track.

Once started, poll `agent_session_status` for the summary rather than `agent_session_logs`
unless the user specifically wants the raw event-by-event stream (e.g. to debug unexpected
behavior). Don't poll in a tight loop — check once, report status, and let the user decide
whether to check again.

## `agent_review` specifically

`agent_review` has its own `background` parameter rather than going through
`agent_session_create` directly — set `background: true` on the `agent_review` call itself for
long reviews (e.g. a large branch diff), then poll `agent_session_status` for the parsed
`review` field. See the `review-handling` skill for how to present the result once it's back.
