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
- the user wants to keep working while it runs, or
- the task should be cancelable (`agent_session_cancel`) if it goes off track.

**Follow-up input works, but not the same way for every agent.** Read `followUpMode` on the
session info (or in `agent_list_available`) before promising anything:

- `live` (`opencode`) — write to the running process; the session must still be **running**.
- `resume` (`claude`, `codex`) — the agent is restarted with its own resume flag to continue the
  same conversation, so the current turn must have **finished**. A `completed` session is still
  continuable; that is the precondition, not a dead end.
- `none` (`agy`) — no continuation; the equivalent is a new session with the follow-up as its
  prompt.

The practical consequence: only `opencode` can be steered *mid-flight*. For `claude` and `codex`,
follow-up means "another turn once this one lands", so don't tell the user they can interrupt a
running turn.

Once started, tell the user it's running and give them the `sessionId` — a background session
has no persistent UI signal of its own (no status-line badge, no expandable details panel) the
way a native Monitor task does, so narrating it is the only visibility the user gets unless you
set up one of the following.

For anything that will run more than a couple of minutes, don't just wait for the user to ask —
proactively surface progress:

- **Tell the user they can follow it themselves**, in any terminal, with `agent-rack watch` (no
  session id needed — it picks the newest session) or `agent-rack watch <sessionId>`. This is the
  cheapest option by far and usually the right first answer: it streams live output in *their*
  terminal and costs this conversation nothing.
- **If you can run a background shell**, pair `agent_session_create` with one that waits for the
  session to reach a terminal state and then writes the result to a log file for you to read.
  Prefer that over a streaming monitor: a monitor turns every status change into a conversation
  message, so a long session floods the context with a rising event count that says nothing about
  what the sub-agent is doing, and a chatty one risks being rate-limited and dropped. A background
  shell costs one notification. Either way, a shell can only reach agent-rack over `sse` transport
  with a known URL — a subprocess can't use a `stdio`-registered server, since that connection is
  private to this conversation. When it applies, use the CLI (not raw MCP calls, which a shell
  script can't make):
  - `agent-rack watch <sessionId> [--connect <url>]` — follows the session and exits when it
    finishes. In a background shell, redirect it to a log and read that once it exits.
  - `agent-rack session status <sessionId> [--connect <url>]` — one diffable line (status,
    event count, summary). Cheap; use this as the change-detection trigger, same role `gh pr
    view` plays in a PR-babysitting loop.
  - `agent-rack session tail <sessionId> [--count N] [--connect <url>]` — the most recent
    text/tool-call content, i.e. what the sub-agent is actually generating, not just a status
    word. Call this once `status` shows a change, and put its output in the report to the user.
- **Otherwise (the common default `stdio` registration)**, there's no external process that can
  poll the session, so do it yourself from the main loop: periodically call `agent_session_status`
  (and `agent_session_logs` if you want the content, not just the summary) and post a one-line
  update to the user when something changes. Still don't poll in a tight loop with no delay
  between checks.

## `agent_review` specifically

`agent_review` has its own `background` parameter rather than going through
`agent_session_create` directly — set `background: true` on the `agent_review` call itself for
long reviews (e.g. a large branch diff), then poll `agent_session_status` for the parsed
`review` field. See the `review-handling` skill for how to present the result once it's back.
