#!/usr/bin/env bash
# PostToolUse hook: when an agent-rack MCP tool call spawns a background sub-agent session
# (agent_session_create, a *_run shortcut, or agent_review — the latter two only when called
# with background:true), inject a reminder to start a plain background shell that waits for the
# session to finish — so the result is collected without depending on the model remembering to
# poll, and without a streaming Monitor pushing every status change back into the context window.
#
# Stays silent (exit 0, no output) for anything that isn't a fresh, still-running session: a
# synchronous agent_run call, an unrelated tool, or malformed input all fall through harmlessly.

input=$(cat)
tool=$(echo "$input" | jq -r '.tool_name // empty' 2>/dev/null)
inner=$(echo "$input" | jq -r '.tool_response[0].text // empty' 2>/dev/null)

if [ -z "$inner" ]; then
  exit 0
fi

sid=$(echo "$inner" | jq -r '.sessionId // empty' 2>/dev/null)
status=$(echo "$inner" | jq -r '.status // empty' 2>/dev/null)

if [ -z "$sid" ] || [ "$status" != "running" ]; then
  exit 0
fi

# Placeholders rather than direct interpolation: the template is a quoted heredoc so that the
# loop's own $cur/$prev survive into the instruction instead of being expanded here.
#
# `read -d ''` rather than `$(cat <<'EOF')`: bash 3.2 (still /bin/bash on macOS) re-parses a
# heredoc inside command substitution, where a stray apostrophe reads as an unterminated quote
# and the whole hook dies with a syntax error. `read` returns non-zero at EOF, hence `|| true`.
read -r -d '' template <<'TEMPLATE' || true
A background agent-rack session was just created via __TOOL__ (sessionId=__SID__,
status=running). Start a plain background shell watching it now, before anything else, so the
session is tracked without you having to remember to poll it.

Use an ordinary background shell (Bash with run_in_background), NOT a streaming Monitor. A Monitor
turns every status change into a conversation message, so a long session floods the context window
with a rising event count that says nothing about what the sub-agent is doing — and a chatty
monitor can get rate-limited and dropped, losing the watch entirely. A background shell stays
silent and notifies you exactly once, when the session reaches a terminal state:

ID=__SID__
LOG="${TMPDIR:-/tmp}/agent-rack-$ID.log"
until agent-rack session status "$ID" 2>&1 | grep -qE 'status=(completed|failed|cancelled)'; do
  sleep 15
done
agent-rack session status "$ID" > "$LOG" 2>&1
agent-rack session tail --count 200 "$ID" >> "$LOG" 2>&1
echo "session $ID reached a terminal state; full output in $LOG"

When the completion notification arrives, Read that log to get the result: the status line embeds
the session summary, which on completion is the sub-agent's entire reply.

Then tell the user they can follow along live themselves, at no context cost, with:
  watch -n5 'agent-rack session status __SID__ | cut -c1-160; agent-rack session tail --count 5 __SID__'

If `agent-rack` is not on PATH, use `npx -y agent-rack` or a local `node bin/agent-rack.js`.
TEMPLATE

ctx=${template//__SID__/$sid}
ctx=${ctx//__TOOL__/$tool}

jq -n --arg ctx "$ctx" '{hookSpecificOutput: {hookEventName: "PostToolUse", additionalContext: $ctx}}'
